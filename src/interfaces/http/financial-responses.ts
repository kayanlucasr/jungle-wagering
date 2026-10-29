import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { SubmissionResult } from '../../application/financial/financial-service';
import type { ReconciliationResult } from '../../application/financial/reconciliation';

export function walletResponse(wallet: Wallet) {
  return { id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
    balance: wallet.balance.toJSON(), version: wallet.version.toString(),
    createdAt: wallet.createdAt.toISOString(), updatedAt: wallet.updatedAt.toISOString() };
}
export function ledgerEntryResponse(entry: WalletLedgerEntry) {
  return { id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
    walletVersion: entry.walletVersion.toString(), direction: entry.direction, money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), createdAt: entry.createdAt.toISOString() };
}
export function transactionResponse(tx: WagerTransaction) {
  return { id: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
    playerId: tx.playerId, walletId: tx.walletId, roundId: tx.roundId, gameId: tx.gameId,
    kind: tx.kind, money: tx.money.toJSON(), status: tx.status,
    referenceExternalTransactionId: tx.referenceExternalTransactionId, referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode, result: tx.terminalResult,
    createdAt: tx.createdAt.toISOString(), completedAt: tx.terminalResult?.completedAt };
}
export function submissionResponse(result: SubmissionResult) {
  return { transactionId: result.transactionId, status: result.status,
    ...(result.terminalResult === undefined ? {} : {
      balance: result.terminalResult.balance, walletVersion: result.terminalResult.walletVersion,
      completedAt: result.terminalResult.completedAt,
      ...(result.terminalResult.referenceTransactionId === undefined ? {} : { referenceTransactionId: result.terminalResult.referenceTransactionId }),
      ...(result.terminalResult.failureCode === undefined ? {} : { failureCode: result.terminalResult.failureCode }),
    }), idempotentReplay: result.replay };
}
export function submissionStatus(result: SubmissionResult): number {
  return result.status === 'PROCESSED' ? 200 : result.status === 'REJECTED' ? 422
    : result.status === 'FAILED' ? 500 : 202;
}
export function reconciliationResponse(result: ReconciliationResult) {
  const checkedEntries = Number(result.entryCount); // Non-financial count; exactness checked explicitly.
  if (!Number.isSafeInteger(checkedEntries)) throw new Error('EntryCountOutsideHttpRange');
  return { walletId: result.walletId,
    storedBalance: { amount: result.storedBalance, currency: result.currency },
    calculatedBalance: { amount: result.reconstructedBalance, currency: result.currency },
    difference: { amount: result.difference, currency: result.currency },
    consistent: result.consistent, checkedEntries, storedVersion: result.storedVersion,
    lastLedgerVersion: result.lastLedgerVersion, totalCredits: { amount: result.totalCredits, currency: result.currency },
    totalDebits: { amount: result.totalDebits, currency: result.currency }, issues: result.issues };
}
