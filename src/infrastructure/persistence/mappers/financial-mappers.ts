import { Money } from '../../../domain/money/money';
import { Wallet } from '../../../domain/wallet/wallet';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { FinancialError } from '../../../application/financial/errors';
import type { WalletRecord, TransactionRecord, LedgerRecord } from '../entities/financial-records';

/** Unconstrained NUMERIC can be returned with scale 0/1. Pad exactly; never round/cast to number. */
function money(value: string, currency: string): Money {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new FinancialError('PERSISTENCE_INTEGRITY');
  const [whole, fraction = ''] = value.split('.');
  return Money.rehydrate({ amount: `${whole}.${fraction.padEnd(2, '0')}`, currency });
}

export function walletFromRecord(row: WalletRecord): Wallet {
  return Wallet.rehydrate({ id: row.id, playerId: row.playerId, currency: row.currency,
    balance: money(row.balance, row.currency), version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt });
}
export function walletToRecord(wallet: Wallet): WalletRecord {
  return { id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
    balance: wallet.balance.toString(), version: wallet.version, createdAt: wallet.createdAt, updatedAt: wallet.updatedAt };
}
export function transactionFromRecord(row: TransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({ id: row.id, providerId: row.providerId ?? undefined,
    externalTransactionId: row.externalTransactionId ?? undefined, idempotencyKey: row.idempotencyKey ?? undefined,
    payloadHash: row.payloadHash ?? undefined, walletId: row.walletId, playerId: row.playerId,
    roundId: row.roundId ?? undefined, gameId: row.gameId ?? undefined, kind: row.kind,
    money: money(row.amount, row.currency), status: row.status,
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    terminalResult: row.terminalResult ?? undefined, createdAt: row.createdAt });
}
export function transactionToRecord(tx: WagerTransaction): TransactionRecord {
  const result = tx.terminalResult;
  return { id: tx.id, providerId: tx.providerId ?? null, externalTransactionId: tx.externalTransactionId ?? null,
    idempotencyKey: tx.idempotencyKey ?? null, payloadHash: tx.payloadHash ?? null,
    payloadSchemaVersion: tx.kind === 'OPENING' ? null : 1, walletId: tx.walletId, playerId: tx.playerId,
    currency: tx.money.currency, roundId: tx.roundId ?? null, gameId: tx.gameId ?? null,
    kind: tx.kind, amount: tx.money.toString(), status: tx.status,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null, failureCode: tx.failureCode ?? null,
    resultBalance: result?.balance.amount ?? null, resultCurrency: result?.balance.currency ?? null,
    resultWalletVersion: result === undefined ? null : BigInt(result.walletVersion),
    // MikroORM normalizes object parameters in-place; never hand it the frozen domain snapshot.
    resultSchemaVersion: result === undefined ? null : 1,
    terminalResult: result === undefined ? null : JSON.parse(JSON.stringify(result)) as TransactionRecord['terminalResult'],
    processingAttempts: 0, nextAttemptAt: null, lastAttemptAt: null,
    createdAt: tx.createdAt, updatedAt: result === undefined ? tx.createdAt : new Date(result.completedAt),
    completedAt: result === undefined ? null : new Date(result.completedAt) };
}
export function ledgerFromRecord(row: LedgerRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({ id: row.id, walletId: row.walletId, transactionId: row.transactionId,
    walletVersion: row.walletVersion, direction: row.direction, money: money(row.amount, row.currency),
    balanceBefore: money(row.balanceBefore, row.currency), balanceAfter: money(row.balanceAfter, row.currency), createdAt: row.createdAt });
}
export function ledgerToRecord(entry: WalletLedgerEntry): LedgerRecord {
  return { id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
    walletVersion: entry.walletVersion, direction: entry.direction, amount: entry.money.toString(), currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(), createdAt: entry.createdAt };
}
