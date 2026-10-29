import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';

export interface ReconciliationIssue {
  readonly code: string;
  readonly entryId?: string;
  readonly version?: string;
  readonly transactionId?: string;
}
export interface ReconciliationResult {
  readonly walletId: string;
  readonly currency: string;
  readonly consistent: boolean;
  readonly storedBalance: string;
  readonly reconstructedBalance: string;
  readonly difference: string;
  readonly storedVersion: string;
  readonly lastLedgerVersion: string | null;
  readonly entryCount: string;
  readonly totalCredits: string;
  readonly totalDebits: string;
  readonly issues: readonly ReconciliationIssue[];
}

// Historical totals can exceed Money's per-wallet range. Never use JS number for cents.
function cents(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [whole, fraction] = amount.replace(/^-/, '').split('.');
  const value = BigInt(whole!) * 100n + BigInt(fraction!);
  return negative ? -value : value;
}
function decimal(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

/** Pure diagnostic: reports every discovered inconsistency, never mutates wallet or ledger. */
export function reconcile(wallet: Wallet, entries: readonly WalletLedgerEntry[],
  transactions: readonly WagerTransaction[]): ReconciliationResult {
  const issues: ReconciliationIssue[] = [];
  const ordered = [...entries].sort((a, b) => a.walletVersion < b.walletVersion ? -1 : a.walletVersion > b.walletVersion ? 1 : 0);
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const seenTransactions = new Set<string>();
  let balance = 0n;
  let credits = 0n;
  let debits = 0n;
  let count = 0n;
  let previousVersion: bigint | undefined;
  let previousAt = wallet.createdAt.getTime();
  for (const entry of ordered) {
    count += 1n;
    const issue = (code: string) => issues.push({ code, entryId: entry.id, version: entry.walletVersion.toString() });
    const tx = byId.get(entry.transactionId);
    if (entry.walletId !== wallet.id || entry.money.currency !== wallet.currency
      || entry.balanceBefore.currency !== wallet.currency || entry.balanceAfter.currency !== wallet.currency) issue('LEDGER_CONTEXT_MISMATCH');
    if (previousVersion === undefined) {
      if (entry.walletVersion !== 1n && entry.walletVersion !== 2n) issue('VERSION_GAP');
      if (entry.walletVersion === 1n && (tx?.kind !== 'OPENING' || entry.direction !== 'CREDIT')) issue('INVALID_OPENING');
      if (entry.walletVersion === 2n && tx?.kind === 'OPENING') issue('INVALID_OPENING');
    } else if (entry.walletVersion !== previousVersion + 1n) issue('VERSION_GAP');
    if (previousVersion !== undefined && tx?.kind === 'OPENING') issue('INVALID_OPENING');
    if (cents(entry.balanceBefore.toString()) !== balance) issue('BROKEN_BALANCE_CHAIN');
    const amount = cents(entry.money.toString());
    const delta = entry.direction === 'CREDIT' ? amount : -amount;
    if (amount <= 0n || cents(entry.balanceBefore.toString()) + delta !== cents(entry.balanceAfter.toString())) issue('INVALID_EQUATION');
    if (entry.createdAt.getTime() < previousAt) issue('TIMESTAMP_REGRESSION');
    if (seenTransactions.has(entry.transactionId)) issue('DUPLICATE_TRANSACTION_ENTRY');
    seenTransactions.add(entry.transactionId);
    const result = tx?.terminalResult;
    if (!tx || tx.status !== 'PROCESSED' || tx.kind === 'LOSS' || tx.walletId !== wallet.id
      || tx.playerId !== wallet.playerId || tx.money.currency !== entry.money.currency
      || tx.money.toString() !== entry.money.toString()
      || result?.walletVersion !== entry.walletVersion.toString()
      || result?.balance.amount !== entry.balanceAfter.toString()
      || result?.balance.currency !== wallet.currency
      || result?.completedAt !== entry.createdAt.toISOString()) issue('TRANSACTION_EFFECT_MISMATCH');
    const reference = tx?.referenceTransactionId === undefined ? undefined : byId.get(tx.referenceTransactionId);
    const direction = tx?.kind === 'BET' || (tx?.kind === 'ROLLBACK' && reference?.kind !== 'BET') ? 'DEBIT' : 'CREDIT';
    if (entry.direction !== direction) issue('DIRECTION_MISMATCH');
    if (tx?.referenceTransactionId !== undefined && (!reference || reference.status !== 'PROCESSED'
      || reference.providerId !== tx.providerId || reference.playerId !== tx.playerId
      || reference.walletId !== tx.walletId || reference.money.currency !== tx.money.currency
      || reference.roundId !== tx.roundId || reference.externalTransactionId !== tx.referenceExternalTransactionId
      || ((tx.kind === 'REFUND' || tx.kind === 'ROLLBACK') && tx.money.toString() !== reference.money.toString()))) issue('REFERENCE_MISMATCH');
    balance += delta;
    if (balance < 0n) issue('NEGATIVE_RECONSTRUCTED_BALANCE');
    if (entry.direction === 'CREDIT') credits += amount; else debits += amount;
    previousVersion = entry.walletVersion;
    previousAt = entry.createdAt.getTime();
  }
  const reversed = new Set<string>();
  for (const tx of transactions) {
    if (tx.status === 'PROCESSED' && tx.kind !== 'LOSS' && !seenTransactions.has(tx.id)) {
      issues.push({ code: 'MISSING_TRANSACTION_ENTRY', transactionId: tx.id });
    }
    if (tx.status === 'PROCESSED' && (tx.kind === 'REFUND' || tx.kind === 'ROLLBACK') && tx.referenceTransactionId) {
      if (reversed.has(tx.referenceTransactionId)) issues.push({ code: 'DUPLICATE_REVERSAL', transactionId: tx.id });
      reversed.add(tx.referenceTransactionId);
    }
  }
  if (balance !== cents(wallet.balance.toString())) issues.push({ code: 'BALANCE_MISMATCH' });
  if ((previousVersion ?? 1n) !== wallet.version) issues.push({ code: 'WALLET_VERSION_MISMATCH' });
  if (ordered.length > 0 && previousAt !== wallet.updatedAt.getTime()) issues.push({ code: 'WALLET_TIMESTAMP_MISMATCH' });
  return Object.freeze({ walletId: wallet.id, currency: wallet.currency, consistent: issues.length === 0,
    storedBalance: wallet.balance.toString(), reconstructedBalance: decimal(balance),
    difference: decimal(cents(wallet.balance.toString()) - balance),
    storedVersion: wallet.version.toString(), lastLedgerVersion: previousVersion?.toString() ?? null,
    entryCount: count.toString(), totalCredits: decimal(credits), totalDebits: decimal(debits),
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))) });
}
