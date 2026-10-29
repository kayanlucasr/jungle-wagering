import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/errors/domain-error';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind as Kind, type ExternalTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import { AT, expectCode, money, transaction } from '../../support/domain';

const observed = { balance: money('90.00'), walletVersion: 2n, at: AT };

describe('WagerTransaction', () => {
  test('creates a pending immutable operation preserving identity', () => {
    const tx = transaction();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.providerId).toBe('provider-a');
    expect(tx.externalTransactionId).toBe('external-1');
    expect(tx.idempotencyKey).toBe('provider-a:external-1');
    expect(tx.matchesPayload('ab'.repeat(32))).toBe(true);
    expect(tx.matchesPayload('cd'.repeat(32))).toBe(false);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.terminalResult).toBeUndefined();
  });

  test('does not expose OPENING through the external factory', () => {
    expectCode(() => transaction({ kind: Kind.Opening as ExternalTransactionKind }), FailureCode.InvalidReference);
  });

  for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback] as const) {
    test(`${kind} requires strictly positive money`, () => {
      expectCode(() => transaction({ kind, money: money('0.00'), referenceExternalTransactionId: 'target' }), FailureCode.InvalidAmount);
      expectCode(() => transaction({ kind, money: money('1.00').negate(), referenceExternalTransactionId: 'target' }), FailureCode.InvalidAmount);
    });
  }

  for (const kind of [Kind.Refund, Kind.Rollback] as const) {
    test(`${kind} requires an external reference`, () => {
      expectCode(() => transaction({ kind }), FailureCode.InvalidReference);
      expect(transaction({ kind, referenceExternalTransactionId: 'target' }).requiresReference()).toBe(true);
    });
  }

  test('LOSS accepts zero, affects no balance, and rejects negative input', () => {
    expect(transaction({ kind: Kind.Loss, money: money('0.00') }).affectsBalance()).toBe(false);
    expectCode(() => transaction({ kind: Kind.Loss, money: money('1.00').negate() }), FailureCode.InvalidAmount);
  });

  test('allows PENDING to PROCESSED, REJECTED or FAILED', () => {
    const pending = transaction();
    const processed = pending.markProcessed(observed);
    expect(processed.status).toBe(Status.Processed);
    expect(processed.processedAt?.toISOString()).toBe(AT.toISOString());
    expect(pending.reject(FailureCode.InsufficientFunds, observed).status).toBe(Status.Rejected);
    expect(pending.fail(FailureCode.PermanentProcessingFailure, observed).status).toBe(Status.Failed);
    expect(pending.status).toBe(Status.Pending);
  });

  test('allows PENDING_REFERENCE to wait, process, reject or fail without a backwards transition', () => {
    const pending = transaction({ kind: Kind.Refund, referenceExternalTransactionId: 'target' }).markPendingReference();
    expect(pending.status).toBe(Status.PendingReference);
    expect(pending.markPendingReference()).toBe(pending);
    expect(pending.markProcessed({ ...observed, referenceTransactionId: 'reference-id' }).status).toBe(Status.Processed);
    expect(pending.reject(FailureCode.ReferenceNotFound, observed).status).toBe(Status.Rejected);
    expect(pending.fail(FailureCode.PermanentProcessingFailure, observed).status).toBe(Status.Failed);
  });

  test('rejects waiting without a reference and processing without its resolved ID', () => {
    expectCode(() => transaction().markPendingReference(), FailureCode.InvalidReference);
    expectCode(() => transaction({ kind: Kind.Refund, referenceExternalTransactionId: 'target' }).markProcessed(observed),
      FailureCode.InvalidReference);
    expectCode(() => transaction().markProcessed({ ...observed, referenceTransactionId: 'unexpected' }), FailureCode.InvalidReference);
    expectCode(() => transaction({ kind: Kind.Refund, referenceExternalTransactionId: 'target' })
      .markProcessed({ ...observed, referenceTransactionId: 'transaction-1' }), FailureCode.InvalidReference);
  });

  test('rejects a self-reference in the provider namespace', () => {
    expectCode(() => transaction({ kind: Kind.Refund, externalTransactionId: 'self',
      referenceExternalTransactionId: 'self' }), FailureCode.InvalidReference);
  });

  for (const terminal of [Status.Processed, Status.Rejected, Status.Failed]) {
    test(`${terminal} rejects every subsequent transition and remains unchanged`, () => {
      const initial = transaction();
      const tx = terminal === Status.Processed ? initial.markProcessed(observed) : terminal === Status.Rejected
        ? initial.reject(FailureCode.InsufficientFunds, observed) : initial.fail(FailureCode.PermanentProcessingFailure, observed);
      const result = JSON.stringify(tx.terminalResult);
      for (const action of [
        () => tx.markProcessed(observed), () => tx.markPendingReference(),
        () => tx.reject(FailureCode.InvalidReference, observed),
        () => tx.fail(FailureCode.PermanentProcessingFailure, observed),
      ]) expectCode(action, FailureCode.InvalidTransactionState);
      expect(JSON.stringify(tx.terminalResult)).toBe(result);
      expect(() => Object.assign(tx, { status: Status.Pending })).toThrow();
    });
  }

  test('terminal result is JSON-safe and deeply immutable with the original observed balance', () => {
    const processed = transaction().markProcessed(observed);
    expect(JSON.parse(JSON.stringify(processed.terminalResult))).toMatchObject({
      transactionId: 'transaction-1', status: 'PROCESSED', balance: { amount: '90.00', currency: 'BRL' },
      walletVersion: '2', completedAt: AT.toISOString(),
    });
    expect(() => Object.assign(processed.terminalResult!, { status: Status.Rejected })).toThrow();
    expect(() => Object.assign(processed.terminalResult!.balance, { amount: '1.00' })).toThrow();
  });

  test('rehydrates a persisted terminal result without running a transition', () => {
    const processed = transaction().markProcessed(observed);
    const state = processed.toState();
    const persistedResult = JSON.parse(JSON.stringify(state.terminalResult));
    const restored = WagerTransaction.rehydrate({ ...state, terminalResult: persistedResult });
    expect(restored.status).toBe(Status.Processed);
    expect(restored.terminalResult).toEqual(processed.terminalResult);
    expectCode(() => restored.markProcessed(observed), FailureCode.InvalidTransactionState);
    expectCode(() => WagerTransaction.rehydrate({ ...state, terminalResult: undefined }), FailureCode.InvalidTransactionState);
  });

  test('protects timestamps from aliases and rejects invalid instants', () => {
    const at = new Date(AT);
    const tx = transaction({ at });
    at.setUTCFullYear(2000);
    tx.createdAt.setUTCFullYear(2001);
    tx.toState().createdAt.setUTCFullYear(2002);
    expect(tx.createdAt.toISOString()).toBe(AT.toISOString());
    expectCode(() => tx.markProcessed({ ...observed, at: new Date('2026-10-27') }), FailureCode.InvalidTimestamp);
    expectCode(() => transaction({ at: new Date('invalid') }), FailureCode.InvalidTimestamp);
    const processed = tx.markProcessed(observed);
    processed.processedAt!.setUTCFullYear(2000);
    expect(processed.processedAt?.toISOString()).toBe(AT.toISOString());
  });

  test('rejects invalid identifiers, hashes, versions and processed snapshot currency', () => {
    expectCode(() => transaction({ providerId: '' }), FailureCode.InvalidIdentifier);
    expectCode(() => transaction({ payloadHash: 'invalid' }), FailureCode.InvalidIdentifier);
    expectCode(() => transaction().markProcessed({ ...observed, walletVersion: 0n }), FailureCode.InvalidWallet);
    expectCode(() => transaction().markProcessed({ ...observed, balance: money('90.00', 'USD') }), FailureCode.CurrencyMismatch);
  });
});
