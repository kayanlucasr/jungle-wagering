import { expect } from 'bun:test';
import { DomainError, FailureCode } from '../../src/domain/errors/domain-error';
import { Money } from '../../src/domain/money/money';
import type { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import type { Wallet } from '../../src/domain/wallet/wallet';
import { WagerTransaction, type CreateWagerTransactionProps } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind as Kind, type ExternalTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { FinancialPolicy } from '../../src/domain/wagering/financial-policy';

export const AT = new Date('2026-10-28T12:00:00.000Z');
export const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

export function expectCode(action: () => unknown, code: FailureCode): void {
  try {
    action();
    throw new Error(`Expected domain error ${code}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

export function transaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalId = overrides.referenceExternalTransactionId === undefined ? 'external-1' : `request-${overrides.id ?? '1'}`;
  return WagerTransaction.create({ id: 'transaction-1', providerId: 'provider-a', externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`, payloadHash: 'ab'.repeat(32), walletId: 'wallet-1',
    playerId: 'player-1', roundId: 'round-1', gameId: 'game-1', kind: Kind.Bet, money: money('10.00'),
    at: AT, ...overrides });
}

/** Test ledger/history only. This fixture is not production deduplication or persistence. */
export class Book {
  wallet: Wallet;
  readonly entries: WalletLedgerEntry[] = [];
  readonly transactions = new Map<string, WagerTransaction>();
  private sequence = 0;

  constructor(initialBalance = '100.00') {
    const opened = FinancialPolicy.openWallet({ walletId: 'wallet-1', playerId: 'player-1',
      initialBalance: money(initialBalance), at: AT, openingTransactionId: 'opening-1', ledgerEntryId: 'entry-opening' });
    this.wallet = opened.wallet;
    if (opened.ledgerEntry) this.entries.push(opened.ledgerEntry);
    if (opened.transaction) this.transactions.set(opened.transaction.id, opened.transaction);
    this.assertReconciled();
  }

  submit(kind: ExternalTransactionKind, amount: string, overrides: Partial<CreateWagerTransactionProps> = {}) {
    this.sequence += 1;
    const id = `tx-${this.sequence}`;
    return this.apply(transaction({ id, kind, money: money(amount), externalTransactionId: `external-${id}`,
      idempotencyKey: `key-${id}`, ...overrides }));
  }

  apply(tx: WagerTransaction, explicitReference?: WagerTransaction) {
    const reference = explicitReference ?? [...this.transactions.values()].find((candidate) =>
      candidate.providerId === tx.providerId && candidate.externalTransactionId === tx.referenceExternalTransactionId);
    const result = FinancialPolicy.process({ wallet: this.wallet, transaction: tx, reference,
      reversals: [...this.transactions.values()], ledgerEntryId: `entry-${tx.id}`, at: AT });
    this.wallet = result.wallet;
    this.transactions.set(result.transaction.id, result.transaction);
    if (result.ledgerEntry) this.entries.push(result.ledgerEntry);
    this.assertReconciled();
    return result;
  }

  assertReconciled(): void {
    const rebuilt = this.entries.reduce((balance, entry) => balance.add(entry.delta), Money.zero(this.wallet.currency));
    expect(rebuilt.equals(this.wallet.balance)).toBe(true);
    let previous = Money.zero(this.wallet.currency);
    for (const entry of this.entries) {
      expect(entry.balanceBefore.equals(previous)).toBe(true);
      expect(entry.isBalanced()).toBe(true);
      previous = entry.balanceAfter;
    }
    expect(new Set(this.entries.map((entry) => entry.transactionId)).size).toBe(this.entries.length);
    const openingCount = [...this.transactions.values()].filter((tx) => tx.kind === Kind.Opening).length;
    expect(this.wallet.version).toBe(1n + BigInt(this.entries.length - openingCount));
  }
}
