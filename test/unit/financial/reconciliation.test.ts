import { describe, expect, test } from 'bun:test';
import { reconcile } from '../../../src/application/financial/reconciliation';
import { payloadHash, type SubmitTransaction } from '../../../src/application/financial/payload-hash';
import { WalletLedgerEntry, type LedgerEntryState } from '../../../src/domain/ledger/wallet-ledger-entry';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { Book, money } from '../../support/domain';

function state(e: WalletLedgerEntry): LedgerEntryState {
  return { id: e.id, walletId: e.walletId, transactionId: e.transactionId, walletVersion: e.walletVersion,
    direction: e.direction, money: e.money, balanceBefore: e.balanceBefore,
    balanceAfter: e.balanceAfter, createdAt: e.createdAt };
}
const codes = (result: ReturnType<typeof reconcile>) => result.issues.map((issue) => issue.code);

describe('Structured financial reconciliation diagnostics', () => {
  test('reconciles zero opening and a complete history with refund/rollback/loss/rejection', () => {
    const empty = new Book('0.00');
    expect(reconcile(empty.wallet, empty.entries, []).consistent).toBe(true);
    const book = new Book();
    const bet = book.submit(Kind.Bet, '10.00');
    const refund = book.submit(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.transaction.externalTransactionId! });
    book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: refund.transaction.externalTransactionId! });
    book.submit(Kind.Loss, '0.00');
    book.submit(Kind.Bet, '100.00');
    const result = reconcile(book.wallet, book.entries, [...book.transactions.values()]);
    expect(result.consistent).toBe(true);
    expect(result.storedBalance).toBe('90.00');
    expect(result.totalCredits).toBe('110.00');
    expect(result.totalDebits).toBe('20.00');
    expect(result.entryCount).toBe('4');
  });

  test('historical totals exceeding one wallet range remain exact decimal strings', () => {
    const max = '999999999999999999.99';
    const book = new Book(max);
    book.submit(Kind.Bet, max);
    book.submit(Kind.Win, max);
    const result = reconcile(book.wallet, book.entries, [...book.transactions.values()]);
    expect(result.consistent).toBe(true);
    expect(result.totalCredits).toBe('1999999999999999999.98');
    expect(result.reconstructedBalance).toBe(max);
  });

  test('reports version gaps and duplicate entries without repairing the original wallet', () => {
    const book = new Book();
    book.submit(Kind.Bet, '10.00');
    const gap = WalletLedgerEntry.rehydrate({ ...state(book.entries[1]!), walletVersion: 4n });
    const result = reconcile(book.wallet, [book.entries[0]!, gap], [...book.transactions.values()]);
    expect(codes(result)).toContain('VERSION_GAP');
    expect(codes(result)).toContain('WALLET_VERSION_MISMATCH');
    const duplicate = reconcile(book.wallet, [...book.entries, book.entries[1]!], [...book.transactions.values()]);
    expect(codes(duplicate)).toContain('DUPLICATE_TRANSACTION_ENTRY');
    expect(book.wallet.balance.toString()).toBe('90.00');
  });

  test('reports broken equation and balance chain', () => {
    const book = new Book();
    const broken = WalletLedgerEntry.rehydrate({ ...state(book.entries[0]!), balanceBefore: money('1.00') });
    const result = reconcile(book.wallet, [broken], [...book.transactions.values()]);
    expect(codes(result)).toContain('INVALID_EQUATION');
    expect(codes(result)).toContain('BROKEN_BALANCE_CHAIN');
  });

  test('reports mismatched currency without throwing a Money comparison error', () => {
    const book = new Book();
    const foreign = WalletLedgerEntry.rehydrate({ ...state(book.entries[0]!), money: money('100.00', 'USD') });
    expect(codes(reconcile(book.wallet, [foreign], [...book.transactions.values()]))).toContain('LEDGER_CONTEXT_MISMATCH');
  });

  test('reports missing transaction and missing entry independently', () => {
    const book = new Book();
    expect(codes(reconcile(book.wallet, book.entries, []))).toContain('TRANSACTION_EFFECT_MISMATCH');
    expect(codes(reconcile(book.wallet, [], [...book.transactions.values()]))).toContain('MISSING_TRANSACTION_ENTRY');
  });

  test('reports materialized balance mismatch', () => {
    const book = new Book();
    const wrong = Wallet.rehydrate({ id: book.wallet.id, playerId: book.wallet.playerId, currency: book.wallet.currency,
      balance: money('99.00'), version: book.wallet.version, createdAt: book.wallet.createdAt, updatedAt: book.wallet.updatedAt });
    const result = reconcile(wrong, book.entries, [...book.transactions.values()]);
    expect(result.consistent).toBe(false);
    expect(codes(result)).toContain('BALANCE_MISMATCH');
  });
});

describe('Canonical payload hash v1', () => {
  const command: SubmitTransaction = { providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key',
    walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game', kind: Kind.Bet,
    money: { amount: '10.00', currency: 'BRL' } };
  test('property order is irrelevant and absent reference is canonicalized to null', () => {
    const { money: value, ...rest } = command;
    expect(payloadHash(command)).toBe(payloadHash({ money: value, ...rest }));
    expect(payloadHash(command)).toMatch(/^[a-f0-9]{64}$/);
  });
  test('key is compared separately while financial identity/amount/reference changes alter the hash', () => {
    expect(payloadHash(command)).toBe(payloadHash({ ...command, idempotencyKey: 'another-key' }));
    for (const alternative of [{ ...command, walletId: 'another-wallet' },
      { ...command, money: { amount: '10.01', currency: 'BRL' } },
      { ...command, referenceExternalTransactionId: 'reference' }]) {
      expect(payloadHash(command)).not.toBe(payloadHash(alternative));
    }
  });
});
