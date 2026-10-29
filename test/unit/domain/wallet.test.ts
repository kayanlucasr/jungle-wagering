import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/errors/domain-error';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { AT, expectCode, money } from '../../support/domain';

const open = () => Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00'), at: AT });
const context = { transactionId: 'transaction-1', ledgerEntryId: 'entry-1', at: AT };

describe('Wallet', () => {
  test('opens with initial balance and version one', () => {
    const wallet = open();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1n);
    expect(wallet.currency).toBe('BRL');
  });

  test('debits and returns the paired ledger without mutating original', () => {
    const wallet = open();
    const result = wallet.debit(money('80.00'), context);
    expect(result.wallet.balance.toString()).toBe('20.00');
    expect(result.wallet.version).toBe(2n);
    expect(result.ledgerEntry?.delta.toString()).toBe('-80.00');
    expect(result.ledgerEntry?.balanceBefore.toString()).toBe('100.00');
    expect(result.ledgerEntry?.balanceAfter.equals(result.wallet.balance)).toBe(true);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1n);
  });

  test('credits exactly and increments version', () => {
    const result = open().credit(money('0.01'), context);
    expect(result.wallet.balance.toString()).toBe('100.01');
    expect(result.wallet.version).toBe(2n);
    expect(result.ledgerEntry?.delta.toString()).toBe('0.01');
  });

  test('allows debit of the exact balance', () => {
    expect(open().debit(money('100.00'), context).wallet.balance.toString()).toBe('0.00');
  });

  test('rejects insufficient funds while preserving state', () => {
    const wallet = open();
    expectCode(() => wallet.debit(money('100.01'), context), FailureCode.InsufficientFunds);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1n);
  });

  for (const method of ['credit', 'debit'] as const) {
    test(`${method} of zero is a no-op with no ledger/version/timestamp change`, () => {
      const wallet = open();
      const result = wallet[method](money('0.00'), { ...context, at: new Date('2026-10-28T13:00:00Z') });
      expect(result.wallet).toBe(wallet);
      expect(result.ledgerEntry).toBeUndefined();
      expect(result.wallet.updatedAt.toISOString()).toBe(AT.toISOString());
    });
    test(`${method} rejects negative values and a different currency`, () => {
      const wallet = open();
      expectCode(() => wallet[method](money('1.00').negate(), context), FailureCode.InvalidAmount);
      expectCode(() => wallet[method](money('1.00', 'USD'), context), FailureCode.CurrencyMismatch);
      expect(wallet.balance.toString()).toBe('100.00');
    });
  }

  test('rejects negative opening, bad version and backwards timestamps', () => {
    expectCode(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('1.00').negate(), at: AT }), FailureCode.InvalidWallet);
    expectCode(() => Wallet.rehydrate({ id: 'w', playerId: 'p', balance: money('0.00'), currency: 'BRL',
      version: 0n, createdAt: AT, updatedAt: AT }), FailureCode.InvalidWallet);
    expectCode(() => open().credit(money('1.00'), { ...context, at: new Date('2026-10-27') }), FailureCode.InvalidTimestamp);
    expectCode(() => open().credit(money('1.00'), { ...context, at: new Date('invalid') }), FailureCode.InvalidTimestamp);
  });

  test('copies dates and prevents public property mutation', () => {
    const at = new Date(AT);
    const wallet = Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('0.00'), at });
    at.setUTCFullYear(2000);
    wallet.createdAt.setUTCFullYear(2001);
    wallet.updatedAt.setUTCFullYear(2002);
    expect(wallet.createdAt.toISOString()).toBe(AT.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(AT.toISOString());
    expect(() => Object.assign(wallet, { version: 999n })).toThrow();
  });

  test('rehydrates without incrementing version or generating a movement', () => {
    const wallet = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: money('3.00'),
      version: 42n, createdAt: AT, updatedAt: AT });
    expect(wallet.version).toBe(42n);
    expect(wallet.balance.toString()).toBe('3.00');
  });
});
