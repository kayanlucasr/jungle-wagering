import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { TransactionRepository } from '../../../application/financial/ports';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { TransactionRecord } from '../entities/financial-records';
import { transactionFromRecord, transactionToRecord } from '../mappers/financial-mappers';
import { FinancialError } from '../../../application/financial/errors';
import { WagerTransactionKind as Kind } from '../../../domain/wagering/wager-transaction-kind';
import type { ReferenceSchedule } from '../../../application/pending-reference/ports';

export class PostgresTransactionRepository implements TransactionRepository {
  constructor(private readonly em: EntityManager) {}
  async findIdentities(providerId: string, externalId: string, key: string) {
    return (await this.em.find(TransactionRecord, { $or: [
      { providerId, externalTransactionId: externalId }, { idempotencyKey: key },
    ] }, { refresh: true })).map(transactionFromRecord);
  }
  async findExternal(providerId: string, externalTransactionId: string) {
    const row = await this.em.findOne(TransactionRecord, { providerId, externalTransactionId }, { refresh: true });
    return row === null ? undefined : transactionFromRecord(row);
  }
  async find(id: string, lock = false) {
    const row = await this.em.findOne(TransactionRecord, { id }, { refresh: true,
      ...(lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {}) });
    return row === null ? undefined : transactionFromRecord(row);
  }
  async findReversals(referenceTransactionId: string) {
    return (await this.em.find(TransactionRecord, { referenceTransactionId,
      kind: { $in: [Kind.Refund, Kind.Rollback] } }, { refresh: true })).map(transactionFromRecord);
  }
  async findByWallet(walletId: string) {
    return (await this.em.find(TransactionRecord, { walletId }, { refresh: true,
      orderBy: { createdAt: 'asc', id: 'asc' } })).map(transactionFromRecord);
  }
  async insertPending(tx: WagerTransaction): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>(`insert into wagering.wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, payload_schema_version,
       wallet_id, player_id, currency, round_id, game_id, kind, amount,
       reference_external_transaction_id, created_at, updated_at)
      values (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict do nothing returning id`, [tx.id, tx.providerId, tx.externalTransactionId,
      tx.idempotencyKey, tx.payloadHash, tx.walletId, tx.playerId, tx.money.currency,
      tx.roundId, tx.gameId, tx.kind, tx.money.toString(), tx.referenceExternalTransactionId ?? null,
      tx.createdAt, tx.createdAt]);
    return rows.length === 1;
  }
  async insertOpening(tx: WagerTransaction): Promise<void> {
    await this.em.insert(TransactionRecord, transactionToRecord(tx));
  }
  async save(tx: WagerTransaction, attemptedAt: Date, schedule?: ReferenceSchedule): Promise<void> {
    const row = transactionToRecord(tx);
    const changed = await this.em.execute<Array<{ id: string }>>(`update wagering.wager_transactions set
      status = ?, reference_transaction_id = ?, failure_code = ?, result_balance = ?, result_currency = ?,
      result_wallet_version = ?, result_schema_version = ?, terminal_result = ?::jsonb,
      processing_attempts = processing_attempts + 1, last_attempt_at = ?, updated_at = ?, completed_at = ?,
      next_attempt_at = ?, reference_deadline_at = coalesce(reference_deadline_at, ?)
      where id = ? returning id`, [row.status, row.referenceTransactionId, row.failureCode,
      row.resultBalance, row.resultCurrency, row.resultWalletVersion?.toString() ?? null,
      row.resultSchemaVersion, row.terminalResult === null ? null : JSON.stringify(row.terminalResult),
      attemptedAt, row.completedAt ?? attemptedAt, row.completedAt,
      tx.status === 'PENDING_REFERENCE' ? schedule?.nextAttemptAt ?? null : null,
      schedule?.deadline ?? null, row.id]);
    if (changed.length !== 1) throw new FinancialError('PERSISTENCE_INTEGRITY');
  }
}
