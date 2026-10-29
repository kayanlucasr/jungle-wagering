import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/errors/domain-error';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { FinancialPolicy } from '../../../src/domain/wagering/financial-policy';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind as Kind, type ExternalTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import { AT, Book, expectCode, money, transaction } from '../../support/domain';

describe('FinancialPolicy opening and basic movements', () => {
  test('positive opening bundles OPENING and CREDIT at wallet version one', () => {
    const book = new Book('100.00');
    expect(book.wallet.version).toBe(1n);
    expect(book.entries).toHaveLength(1);
    expect(book.entries[0]?.walletVersion).toBe(1n);
    expect(book.entries[0]?.balanceBefore.toString()).toBe('0.00');
    expect(book.transactions.get('opening-1')?.status).toBe(Status.Processed);
    expect(book.transactions.get('opening-1')?.providerId).toBeUndefined();
  });

  test('zero opening has no transaction/ledger, reconciles to zero and starts at version one', () => {
    const book = new Book('0.00');
    expect(book.wallet.version).toBe(1n);
    expect(book.transactions.size).toBe(0);
    expect(book.entries).toHaveLength(0);
    const win = book.submit(Kind.Win, '0.10');
    expect(win.wallet.version).toBe(2n);
    expect(win.ledgerEntry?.balanceBefore.toString()).toBe('0.00');
    expect(win.ledgerEntry?.walletVersion).toBe(2n);
  });

  test('requires deterministic IDs for a positive opening', () => {
    expectCode(() => FinancialPolicy.openWallet({ walletId: 'w', playerId: 'p', initialBalance: money('1.00'), at: AT }),
      FailureCode.InvalidIdentifier);
  });

  test('BET debits once in the decision, while original objects remain unchanged', () => {
    const book = new Book();
    const originalWallet = book.wallet;
    const pending = transaction({ money: money('80.00') });
    const decision = book.apply(pending);
    expect(decision.wallet.balance.toString()).toBe('20.00');
    expect(decision.transaction.status).toBe(Status.Processed);
    expect(decision.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(originalWallet.balance.toString()).toBe('100.00');
    expect(pending.status).toBe(Status.Pending);
    expectCode(() => book.apply(decision.transaction), FailureCode.InvalidTransactionState);
    expect(book.entries).toHaveLength(2);
  });

  test('rejects insufficient BET with no ledger, version change or balance change', () => {
    const book = new Book();
    const original = book.wallet;
    const result = book.submit(Kind.Bet, '100.01');
    expect(result.transaction.status).toBe(Status.Rejected);
    expect(result.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.wallet).toBe(original);
    expect(result.ledgerEntry).toBeUndefined();
    expect(book.entries).toHaveLength(1);
  });

  test('WIN credits and LOSS has no movement or version increment', () => {
    const book = new Book();
    expect(book.submit(Kind.Win, '0.10').wallet.balance.toString()).toBe('100.10');
    const previous = book.wallet;
    const loss = book.submit(Kind.Loss, '0.00');
    expect(loss.transaction.status).toBe(Status.Processed);
    expect(loss.wallet).toBe(previous);
    expect(loss.ledgerEntry).toBeUndefined();
  });

  test('reconciles a sequence including opening, debit, credit and loss', () => {
    const book = new Book('100.00');
    book.submit(Kind.Bet, '25.00');
    book.submit(Kind.Win, '0.10');
    book.submit(Kind.Win, '0.20');
    book.submit(Kind.Loss, '25.00');
    book.submit(Kind.Bet, '0.30');
    expect(book.wallet.balance.toString()).toBe('75.00');
    expect(book.wallet.version).toBe(5n);
    book.assertReconciled();
  });

  test('credit overflow is rejected without changing the wallet', () => {
    const book = new Book('999999999999999999.99');
    const original = book.wallet;
    const result = book.submit(Kind.Win, '0.01');
    expect(result.transaction.failureCode).toBe(FailureCode.AmountOutOfRange);
    expect(result.wallet).toBe(original);
    expect(result.ledgerEntry).toBeUndefined();
  });

  test('wallet ownership and operation currency are checked before movement', () => {
    const book = new Book();
    expect(book.submit(Kind.Bet, '1.00', { playerId: 'other-player' }).transaction.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    const result = book.submit(Kind.Bet, '1.00', { money: money('1.00', 'USD') });
    expect(result.transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(result.transaction.terminalResult?.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(book.entries).toHaveLength(1);
  });

  test('missing/wrong wallet is an explicit domain error without partial changes', () => {
    const book = new Book();
    const tx = transaction();
    expectCode(() => FinancialPolicy.process({ wallet: undefined, transaction: tx, reference: undefined,
      reversals: [], ledgerEntryId: 'entry', at: AT }), FailureCode.WalletNotFound);
    expectCode(() => book.apply(transaction({ walletId: 'other-wallet' })), FailureCode.WalletNotFound);
    expect(tx.status).toBe(Status.Pending);
    book.assertReconciled();
  });

  test('identical supplied state, IDs and time produce identical decisions', () => {
    const book = new Book();
    const tx = transaction();
    const input = { wallet: book.wallet, transaction: tx, reference: undefined, reversals: [], ledgerEntryId: 'entry', at: AT };
    const first = FinancialPolicy.process(input);
    const second = FinancialPolicy.process(input);
    expect(first.transaction.terminalResult).toEqual(second.transaction.terminalResult);
    expect(first.wallet.balance.equals(second.wallet.balance)).toBe(true);
    expect(first.ledgerEntry?.id).toBe(second.ledgerEntry?.id);
    expect(first.ledgerEntry?.createdAt).toEqual(second.ledgerEntry?.createdAt);
  });
});

describe('FinancialPolicy reversals', () => {
  for (const kind of [Kind.Refund, Kind.Rollback] as const) {
    test(`${kind} credits a processed BET`, () => {
      const book = new Book();
      const bet = book.submit(Kind.Bet, '10.00').transaction;
      const result = book.submit(kind, '10.00', { referenceExternalTransactionId: bet.externalTransactionId! });
      expect(result.transaction.status).toBe(Status.Processed);
      expect(result.transaction.referenceTransactionId).toBe(bet.id);
      expect(result.wallet.balance.toString()).toBe('100.00');
      expect(result.ledgerEntry?.delta.toString()).toBe('10.00');
      expect(bet.status).toBe(Status.Processed);
    });
  }

  for (const [first, second] of [[Kind.Refund, Kind.Refund], [Kind.Rollback, Kind.Rollback],
    [Kind.Refund, Kind.Rollback], [Kind.Rollback, Kind.Refund]] as const) {
    test(`blocks double compensation ${first} followed by ${second} on the same BET`, () => {
      const book = new Book();
      const bet = book.submit(Kind.Bet, '10.00').transaction;
      book.submit(first, '10.00', { referenceExternalTransactionId: bet.externalTransactionId! });
      const original = book.wallet;
      const secondResult = book.submit(second, '10.00', { referenceExternalTransactionId: bet.externalTransactionId! });
      expect(secondResult.transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expect(secondResult.transaction.status).toBe(Status.Rejected);
      expect(secondResult.wallet).toBe(original);
      expect(secondResult.ledgerEntry).toBeUndefined();
      expect(book.entries).toHaveLength(3);
    });
  }

  test('ROLLBACK of WIN debits the credited amount', () => {
    const book = new Book();
    const win = book.submit(Kind.Win, '10.00').transaction;
    const result = book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: win.externalTransactionId! });
    expect(result.ledgerEntry?.delta.toString()).toBe('-10.00');
    expect(result.wallet.balance.toString()).toBe('100.00');
  });

  test('ROLLBACK of REFUND is allowed, but does not reopen direct reversal rights on the original BET', () => {
    const book = new Book();
    const bet = book.submit(Kind.Bet, '10.00').transaction;
    const refund = book.submit(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId! }).transaction;
    const cancelledRefund = book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: refund.externalTransactionId! });
    expect(cancelledRefund.transaction.status).toBe(Status.Processed);
    expect(cancelledRefund.ledgerEntry?.delta.toString()).toBe('-10.00');
    expect(book.wallet.balance.toString()).toBe('90.00');
    expect(book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId! })
      .transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test('a rejected reversal for lack of funds does not consume reversal rights', () => {
    const book = new Book('0.00');
    const win = book.submit(Kind.Win, '10.00').transaction;
    book.submit(Kind.Bet, '10.00');
    const rejected = book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: win.externalTransactionId! });
    expect(rejected.transaction.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rejected.ledgerEntry).toBeUndefined();
    expect(book.wallet.balance.toString()).toBe('0.00');
    book.submit(Kind.Win, '10.00');
    const success = book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: win.externalTransactionId! });
    expect(success.transaction.status).toBe(Status.Processed);
    expect(book.wallet.balance.toString()).toBe('0.00');
  });

  test('ROLLBACK of REFUND also obeys the nonnegative balance invariant', () => {
    const book = new Book('10.00');
    const bet = book.submit(Kind.Bet, '10.00').transaction;
    const refund = book.submit(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId! }).transaction;
    book.submit(Kind.Bet, '10.00');
    expect(book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: refund.externalTransactionId! })
      .transaction.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
  });

  test('rejected amount mismatch also leaves reversal rights available', () => {
    const book = new Book();
    const bet = book.submit(Kind.Bet, '10.00').transaction;
    expect(book.submit(Kind.Refund, '11.00', { referenceExternalTransactionId: bet.externalTransactionId! })
      .transaction.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    expect(book.submit(Kind.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId! })
      .transaction.status).toBe(Status.Processed);
  });

  test('a FAILED reversal does not consume the right to reverse the BET', () => {
    const book = new Book();
    const bet = book.submit(Kind.Bet, '10.00').transaction;
    const failed = transaction({ id: 'failed-reversal', kind: Kind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId! })
      .fail(FailureCode.PermanentProcessingFailure, { balance: book.wallet.balance, walletVersion: book.wallet.version, at: AT });
    book.transactions.set(failed.id, failed);
    expect(book.submit(Kind.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId! })
      .transaction.status).toBe(Status.Processed);
  });

  test('an internal OPENING cannot be reversed', () => {
    const book = new Book();
    const opening = book.transactions.get('opening-1')!;
    const result = book.apply(transaction({ kind: Kind.Rollback, money: money('100.00'),
      referenceExternalTransactionId: 'opening-1' }), opening);
    expect(result.transaction.status).toBe(Status.Rejected);
    expect(result.ledgerEntry).toBeUndefined();
    expect(book.entries).toHaveLength(1);
  });

  for (const kind of [Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback] as const) {
    test(`REFUND cannot reference ${kind}`, () => {
      const book = new Book();
      const reference = kind === Kind.Refund || kind === Kind.Rollback
        ? transaction({ id: 'ref', kind, referenceExternalTransactionId: 'original' })
          .markProcessed({ balance: money('100.00'), walletVersion: 1n, at: AT, referenceTransactionId: 'original-id' })
        : transaction({ id: 'ref', kind }).markProcessed({ balance: money('100.00'), walletVersion: 1n, at: AT });
      const result = book.apply(transaction({ id: 'refund', kind: Kind.Refund,
        referenceExternalTransactionId: reference.externalTransactionId! }), reference);
      expect(result.transaction.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
      expect(result.ledgerEntry).toBeUndefined();
    });
  }

  for (const kind of [Kind.Loss, Kind.Rollback] as const) {
    test(`ROLLBACK cannot reference ${kind}`, () => {
      const book = new Book();
      const reference = kind === Kind.Rollback
        ? transaction({ id: 'ref', kind, referenceExternalTransactionId: 'original' })
          .markProcessed({ balance: money('100.00'), walletVersion: 1n, at: AT, referenceTransactionId: 'original-id' })
        : transaction({ id: 'ref', kind }).markProcessed({ balance: money('100.00'), walletVersion: 1n, at: AT });
      expect(book.apply(transaction({ id: 'rollback', kind: Kind.Rollback,
        referenceExternalTransactionId: reference.externalTransactionId! }), reference)
        .transaction.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });
  }
});

describe('FinancialPolicy reference resolution and snapshots', () => {
  for (const kind of [Kind.Refund, Kind.Rollback] as const) {
    test(`${kind} before reference waits without effect and processes once the BET arrives`, () => {
      const book = new Book();
      const waiting = book.submit(kind, '10.00', { referenceExternalTransactionId: 'future-bet' });
      expect(waiting.transaction.status).toBe(Status.PendingReference);
      expect(waiting.wallet.version).toBe(1n);
      expect(waiting.ledgerEntry).toBeUndefined();
      book.submit(Kind.Bet, '10.00', { externalTransactionId: 'future-bet' });
      const applied = book.apply(waiting.transaction);
      expect(applied.transaction.status).toBe(Status.Processed);
      expect(applied.wallet.balance.toString()).toBe('100.00');
      expect(book.entries).toHaveLength(3);
    });
  }

  test('waits for a reference that exists but is still pending', () => {
    const book = new Book();
    const reference = transaction({ id: 'pending-bet' });
    const result = book.apply(transaction({ kind: Kind.Refund, referenceExternalTransactionId: reference.externalTransactionId! }), reference);
    expect(result.transaction.status).toBe(Status.PendingReference);
    expect(result.ledgerEntry).toBeUndefined();
  });

  for (const status of [Status.Rejected, Status.Failed]) {
    test(`rejects a ${status} reference`, () => {
      const book = new Book();
      const pending = transaction({ id: 'reference' });
      const context = { balance: book.wallet.balance, walletVersion: 1n, at: AT };
      const reference = status === Status.Rejected ? pending.reject(FailureCode.InsufficientFunds, context) :
        pending.fail(FailureCode.PermanentProcessingFailure, context);
      const result = book.apply(transaction({ kind: Kind.Refund, referenceExternalTransactionId: reference.externalTransactionId! }), reference);
      expect(result.transaction.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    });
  }

  for (const [field, value] of [
    ['providerId', 'other-provider'], ['playerId', 'other-player'], ['walletId', 'other-wallet'],
    ['roundId', 'other-round'], ['externalTransactionId', 'other-external'],
  ] as const) {
    test(`rejects a reference with different ${field}`, () => {
      const book = new Book();
      const reference = transaction({ id: 'reference', [field]: value })
        .markProcessed({ balance: money('100.00'), walletVersion: 1n, at: AT });
      const result = book.apply(transaction({ id: 'refund', kind: Kind.Refund, referenceExternalTransactionId: 'external-1' }), reference);
      expect(result.transaction.failureCode).toBe(FailureCode.ReferenceContextMismatch);
      expect(result.ledgerEntry).toBeUndefined();
    });
  }

  test('rejects a reference in another currency', () => {
    const book = new Book();
    const reference = transaction({ id: 'reference', money: money('10.00', 'USD') })
      .markProcessed({ balance: money('100.00', 'USD'), walletVersion: 1n, at: AT });
    expect(book.apply(transaction({ kind: Kind.Refund, referenceExternalTransactionId: 'external-1' }), reference)
      .transaction.failureCode).toBe(FailureCode.ReferenceContextMismatch);
  });

  test('WIN may reference a BET with a different amount and gameId', () => {
    const book = new Book();
    const bet = book.submit(Kind.Bet, '10.00').transaction;
    const win = book.submit(Kind.Win, '15.00', { referenceExternalTransactionId: bet.externalTransactionId!, gameId: 'other-game' });
    expect(win.transaction.status).toBe(Status.Processed);
    expect(book.wallet.balance.toString()).toBe('105.00');
  });

  for (const kind of [Kind.Bet, Kind.Win] as ExternalTransactionKind[]) {
    test(`${kind} terminal snapshot retains the historical balance after later movements`, () => {
      const book = new Book();
      const original = book.submit(kind, '10.00').transaction;
      const snapshot = JSON.stringify(original.terminalResult);
      const restored = WagerTransaction.rehydrate(original.toState());
      book.submit(Kind.Win, '50.00');
      expect(JSON.stringify(restored.terminalResult)).toBe(snapshot);
      expect(restored.terminalResult?.balance.amount).not.toBe(book.wallet.balance.toString());
    });
  }

  test('REJECTED terminal snapshot is likewise stable after wallet changes', () => {
    const book = new Book();
    const rejected = book.submit(Kind.Bet, '200.00').transaction;
    book.submit(Kind.Win, '20.00');
    expect(rejected.terminalResult?.balance.amount).toBe('100.00');
    expect(rejected.terminalResult?.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('invalid processing timestamp leaves both original objects unchanged', () => {
    const book = new Book();
    const tx = transaction();
    expectCode(() => FinancialPolicy.process({ wallet: book.wallet, transaction: tx, reference: undefined,
      reversals: [], ledgerEntryId: 'entry', at: new Date('2026-10-27') }), FailureCode.InvalidTimestamp);
    expect(tx.status).toBe(Status.Pending);
    expect(book.wallet.balance.toString()).toBe('100.00');
    book.assertReconciled();
  });
});
