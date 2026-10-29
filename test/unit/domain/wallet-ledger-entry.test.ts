import { describe, expect, test } from 'bun:test';
import { WalletLedgerEntry, LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { FailureCode } from '../../../src/domain/errors/domain-error';
import { AT, expectCode, money } from '../../support/domain';

const state = () => ({ id: 'entry-1', walletId: 'wallet-1', transactionId: 'tx-1', walletVersion: 2n,
  direction: LedgerDirection.Debit, money: money('80.00'), balanceBefore: money('100.00'),
  balanceAfter: money('20.00'), createdAt: new Date(AT) });

describe('WalletLedgerEntry', () => {
  test('records exact debit and credit equations', () => {
    const debit = WalletLedgerEntry.create(state());
    expect(debit.delta.toString()).toBe('-80.00');
    expect(debit.isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create({ ...state(), direction: LedgerDirection.Credit, balanceAfter: money('180.00') });
    expect(credit.delta.toString()).toBe('80.00');
    expect(credit.isBalanced()).toBe(true);
  });

  test('rejects an unbalanced entry', () => {
    expectCode(() => WalletLedgerEntry.create({ ...state(), balanceAfter: money('20.01') }), FailureCode.InvalidLedgerEntry);
  });

  test('rejects zero, negative amount, negative balance and invalid version', () => {
    for (const moneyValue of [money('0.00'), money('1.00').negate()]) {
      expectCode(() => WalletLedgerEntry.create({ ...state(), money: moneyValue }), FailureCode.InvalidLedgerEntry);
    }
    expectCode(() => WalletLedgerEntry.create({ ...state(), balanceAfter: money('1.00').negate() }), FailureCode.InvalidLedgerEntry);
    expectCode(() => WalletLedgerEntry.create({ ...state(), walletVersion: 0n }), FailureCode.InvalidLedgerEntry);
  });

  test('rejects mixed currencies', () => {
    expectCode(() => WalletLedgerEntry.create({ ...state(), balanceAfter: money('20.00', 'USD') }), FailureCode.CurrencyMismatch);
  });

  test('protects money, fields and timestamp from mutation', () => {
    const props = state();
    const entry = WalletLedgerEntry.create(props);
    props.createdAt.setUTCFullYear(2000);
    entry.createdAt.setUTCFullYear(2001);
    expect(entry.createdAt.toISOString()).toBe(AT.toISOString());
    expect(() => Object.assign(entry, { direction: LedgerDirection.Credit })).toThrow();
    expect(Object.isFrozen(entry.money)).toBe(true);
    expect(WalletLedgerEntry.rehydrate(state()).isBalanced()).toBe(true);
  });
});
