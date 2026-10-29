import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import type { FinancialSession, FinancialUnitOfWork } from '../../application/financial/ports';
import { FinancialError } from '../../application/financial/errors';
import { PostgresWalletRepository } from './repositories/wallet-repository';
import { PostgresTransactionRepository } from './repositories/transaction-repository';
import { PostgresLedgerRepository } from './repositories/ledger-repository';
import { PostgresInboxRepository, PostgresOutboxRepository } from './repositories/message-repositories';
import { PostgresPendingReferenceRepository } from './repositories/pending-reference-repository';
import { FinancialMetrics } from '../observability/financial-metrics';

/** Driver exceptions sometimes wrap the PostgreSQL error. Never classify by message text. */
export function sqlState(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; cause?: unknown; previous?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause ?? candidate.previous;
  }
  return undefined;
}

function transient(error: unknown): boolean {
  const code = sqlState(error);
  return code === '40P01' || code === '40001' || code === '55P03' || code === '57014'
    || code === '25P03' || code === '57P01' || code === '57P02' || code === '57P03'
    || code?.startsWith('08') === true || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code ?? '')
    || (error instanceof Error && error.name === 'KnexTimeoutError');
}

export class PostgresFinancialUnitOfWork implements FinancialUnitOfWork {
  constructor(private readonly orm: MikroORM, readonly metrics = new FinancialMetrics()) {}

  async write<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    const started = performance.now();
    for (let attempt = 0; ; attempt += 1) {
      let workCompleted = false;
      const statuses: string[] = [];
      try {
        // Promise resolves only AFTER commit, including all deferred constraint triggers.
        const value = await this.orm.em.fork().transactional(async (em) => {
          await this.assertRuntime(em);
          const session = this.session(em);
          const save = session.transactions.save.bind(session.transactions);
          session.transactions.save = async (transaction, at, schedule) => {
            const previous = await session.transactions.find(transaction.id);
            await save(transaction, at, schedule);
            if (previous?.status !== transaction.status) statuses.push(transaction.status);
          };
          const result = await work(session);
          workCompleted = true;
          return result;
        }, {
          isolationLevel: IsolationLevel.READ_COMMITTED,
        });
        this.metrics.committed(statuses, performance.now() - started);
        return value;
      } catch (error: unknown) {
        const code = sqlState(error);
        if (error instanceof FinancialError && error.code === 'IDEMPOTENCY_CONFLICT') this.metrics.idempotencyConflicts += 1;
        if (code === '40P01' || code === '55P03' || code === '40001') this.metrics.lockConflicts += 1;
        if ((code === '40P01' || code === '40001') && attempt < 2) {
          this.metrics.retries += 1;
          await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
          continue;
        }
        if (transient(error)) {
          this.metrics.transientFailures += 1;
          throw new FinancialError('PERSISTENCE_UNAVAILABLE');
        }
        if (code?.startsWith('23')) throw new FinancialError('PERSISTENCE_INTEGRITY');
        // An unclassified failure after work finished may be an uncertain COMMIT.
        // Do not retry it automatically or persist REJECTED; caller repeats its identity.
        if (workCompleted) throw new FinancialError('PERSISTENCE_UNAVAILABLE');
        throw error;
      }
    }
  }

  async readSnapshot<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute('set transaction read only');
        await this.assertRuntime(em);
        return work(this.session(em));
      }, { isolationLevel: IsolationLevel.REPEATABLE_READ });
    } catch (error: unknown) {
      if (transient(error)) throw new FinancialError('PERSISTENCE_UNAVAILABLE');
      throw error;
    }
  }

  private session(em: EntityManager): FinancialSession {
    return { wallets: new PostgresWalletRepository(em), transactions: new PostgresTransactionRepository(em),
      ledger: new PostgresLedgerRepository(em), inbox: new PostgresInboxRepository(em),
      outbox: new PostgresOutboxRepository(em), pendingReferences: new PostgresPendingReferenceRepository(em) };
  }

  private async assertRuntime(em: EntityManager): Promise<void> {
    const rows = await em.execute<Array<{ allowed: boolean }>>(`select
      not (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
      and pg_has_role(current_user, 'wagering_runtime', 'member')
      and not pg_has_role(current_user, 'wagering_owner', 'member') as allowed
      from pg_roles where rolname = current_user`);
    if (rows[0]?.allowed !== true) throw new FinancialError('UNSAFE_DATABASE_ROLE');
  }
}
