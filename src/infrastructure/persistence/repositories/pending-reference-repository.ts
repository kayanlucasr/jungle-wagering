import type { EntityManager } from '@mikro-orm/postgresql';
import type { PendingReferenceRepository, PendingReferenceClaim } from '../../../application/pending-reference/ports';
import { TransactionRecord } from '../entities/financial-records';
import { transactionFromRecord } from '../mappers/financial-mappers';
import { PostgresWalletRepository } from './wallet-repository';
import { FinancialError } from '../../../application/financial/errors';

export class PostgresPendingReferenceRepository implements PendingReferenceRepository {
  constructor(private readonly em: EntityManager) {}
  async claim(at: Date, idleTimeoutMs: number): Promise<PendingReferenceClaim | undefined> {
    await this.em.execute("select set_config('idle_in_transaction_session_timeout', ?, true)", [`${idleTimeoutMs}ms`]);
    const wallets = await this.em.execute<Array<{ id: string }>>(`select w.id from wagering.wallets w
      where exists (select 1 from wagering.wager_transactions t where t.wallet_id = w.id
        and t.status = 'PENDING_REFERENCE' and (t.next_attempt_at is null or t.next_attempt_at <= ?
          or t.reference_deadline_at <= ?))
      order by w.id limit 1 for update of w skip locked`, [at, at]);
    if (!wallets[0]) return undefined;
    // No transaction row has been locked yet. Never invert this order.
    const wallet = await new PostgresWalletRepository(this.em).find(wallets[0].id);
    if (!wallet) throw new FinancialError('PERSISTENCE_INTEGRITY');
    const candidates = await this.em.execute<Array<{ id: string }>>(`select id from wagering.wager_transactions
      where wallet_id = ? and status = 'PENDING_REFERENCE'
        and (next_attempt_at is null or next_attempt_at <= ? or reference_deadline_at <= ?)
      order by coalesce(next_attempt_at, created_at), id limit 1 for update skip locked`, [wallet.id, at, at]);
    if (!candidates[0]) return undefined;
    const row = await this.em.findOne(TransactionRecord, { id: candidates[0].id }, { refresh: true });
    if (!row || row.status !== 'PENDING_REFERENCE' || !row.referenceDeadlineAt) throw new FinancialError('PERSISTENCE_INTEGRITY');
    const contexts = await this.em.execute<Array<{ correlation_id: string; causation_id: string | null }>>(`
      select coalesce((select payload->>'correlationId' from wagering.outbox_messages where transaction_id = ?
        and event_type = 'WagerTransactionPendingReference' order by position limit 1), 'pending-' || md5(?)) as correlation_id,
        (select payload->>'causationId' from wagering.outbox_messages where transaction_id = ?
          and event_type = 'WagerTransactionPendingReference' order by position limit 1) as causation_id`, [row.id, row.id, row.id]);
    return { wallet, transaction: transactionFromRecord(row), attempts: row.processingAttempts,
      deadline: row.referenceDeadlineAt, lastAttemptAt: row.lastAttemptAt,
      context: { correlationId: contexts[0]!.correlation_id,
        ...(contexts[0]!.causation_id ? { causationId: contexts[0]!.causation_id } : {}) } };
  }
  async activeCount(): Promise<number> {
    const rows = await this.em.execute<Array<{ count: string }>>(`select count(*)::text as count
      from wagering.wager_transactions where status = 'PENDING_REFERENCE'`);
    return Number(rows[0]!.count);
  }
}
