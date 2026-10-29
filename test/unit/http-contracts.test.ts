import { describe, expect, test } from 'bun:test';
import { createWalletDto, submitTransactionDto, ledgerQuery, identifier, type SubmitTransactionDto } from '../../src/interfaces/http/financial-dtos';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../src/application/financial/ledger-cursor';
import { reconciliationResponse, submissionResponse, submissionStatus, walletResponse } from '../../src/interfaces/http/financial-responses';
import { HttpMetrics } from '../../src/interfaces/http/http-metrics';
import { Book, money } from '../support/domain';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/wager-transaction-status';
import { reconcile } from '../../src/application/financial/reconciliation';
import type { SubmissionResult } from '../../src/application/financial/financial-service';

describe('HTTP DTO validation and exact response contracts', () => {
  const valid: SubmitTransactionDto = { providerId: 'provider', externalTransactionId: 'external', playerId: 'player', walletId: 'wallet',
    roundId: 'round', gameId: 'game', kind: Kind.Bet, money: { amount: '10.00', currency: 'BRL' } };

  test('accepts domain-compatible non-UUID identifiers and canonical monetary strings', () => {
    expect(identifier('provider-a:wallet-123', 'walletId')).toBe('provider-a:wallet-123');
    expect(submitTransactionDto(valid)).toEqual(valid);
    expect(createWalletDto({ playerId: 'player', initialBalance: valid.money }).initialBalance).toEqual(valid.money);
  });
  test('rejects unknown top-level/nested fields and a body-supplied idempotency key/hash', () => {
    for (const value of [{ ...valid, idempotencyKey: 'key' }, { ...valid, payloadHash: 'ab'.repeat(32) },
      { ...valid, money: { ...valid.money, hidden: true } }]) expect(() => submitTransactionDto(value)).toThrow();
  });
  test('rejects numeric amounts, missing/null references, OPENING and malformed identifiers', () => {
    for (const value of [{ ...valid, money: { amount: 10, currency: 'BRL' } }, { ...valid, kind: 'OPENING' },
      { ...valid, kind: 'REFUND' }, { ...valid, referenceExternalTransactionId: null }, { ...valid, playerId: ' ' }]) {
      expect(() => submitTransactionDto(value)).toThrow();
    }
    for (const value of ['bad\u0000id', 'bad\ud800id', 'bad\udfffid']) expect(() => identifier(value, 'playerId')).toThrow();
  });
  test('pagination size is bounded and repeated/nested/unknown query parameters are rejected', () => {
    expect(ledgerQuery({})).toEqual({ limit: 50 });
    for (const query of [{ limit: '0' }, { limit: '101' }, { limit: ['1', '2'] }, { cursor: {} }, { offset: '10' }]) {
      expect(() => ledgerQuery(query)).toThrow();
    }
  });
  test('wallet response preserves financial precision and serializes bigint versions as strings', () => {
    const book = new Book('999999999999999999.99');
    const response = walletResponse(book.wallet);
    expect(response.balance.amount).toBe('999999999999999999.99');
    expect(response.version).toBe('1');
    expect(() => JSON.stringify(response)).not.toThrow();
  });
  test('reconciliation uses original HTTP field names and an exact signed difference', () => {
    const book = new Book();
    const result = reconcile(book.wallet, [], []);
    const response = reconciliationResponse(result);
    expect(response.calculatedBalance.amount).toBe('0.00');
    expect(response.storedBalance.amount).toBe('100.00');
    expect(response.difference.amount).toBe('100.00');
    expect(response.checkedEntries).toBe(0);
  });
  test('HTTP submission statuses distinguish pending, rejection, success and permanent failure', () => {
    for (const [status, expected] of [[Status.Pending, 202], [Status.PendingReference, 202], [Status.Processed, 200],
      [Status.Rejected, 422], [Status.Failed, 500]] as const) {
      const result: SubmissionResult = { transactionId: 'transaction', status, replay: true, terminalResult: undefined };
      expect(submissionStatus(result)).toBe(expected);
      expect(submissionResponse(result)).not.toHaveProperty('balance');
    }
  });
  test('replay maps the historical terminal result and excludes idempotency/hash/ORM fields', () => {
    const book = new Book(); const bet = book.submit(Kind.Bet, '20.00');
    book.submit(Kind.Win, '50.00');
    const response = submissionResponse({ transactionId: bet.transaction.id, status: bet.transaction.status,
      replay: true, terminalResult: bet.transaction.terminalResult });
    expect(response.balance!.amount).toBe('80.00');
    expect(book.wallet.balance.equals(money('130.00'))).toBe(true);
    expect(response.idempotentReplay).toBe(true);
    expect(response).not.toHaveProperty('payloadHash');
  });
});

describe('Opaque ledger cursor and HTTP metrics', () => {
  test('cursor preserves bigint precision, upper bound and wallet binding across processes', () => {
    const token = encodeLedgerCursor('wallet', 9007199254740993n, 9007199254740994n);
    expect(decodeLedgerCursor(token, 'wallet')).toEqual({ afterVersion: 9007199254740993n, upperVersion: 9007199254740994n });
    expect(() => decodeLedgerCursor(token, 'other-wallet')).toThrow();
    const escapedId = `a${'\u0001'.repeat(254)}b`;
    expect(decodeLedgerCursor(encodeLedgerCursor(escapedId, 1n, 2n), escapedId)).toEqual({ afterVersion: 1n, upperVersion: 2n });
  });
  test('malformed/out-of-range/empty cursor state is rejected', () => {
    for (const token of ['', '%%%!', encodeLedgerCursor('wallet', 3n, 2n), encodeLedgerCursor('wallet', 0n, 2n),
      encodeLedgerCursor('wallet', 1n, 9223372036854775808n), Buffer.from('{"v":2}').toString('base64url')]) {
      expect(() => decodeLedgerCursor(token, 'wallet')).toThrow();
    }
  });
  test('metrics count reconciliation inconsistencies independently of financial processing', () => {
    const metrics = new HttpMetrics();
    metrics.requestCompleted(12); metrics.reconciliationCompleted(true); metrics.reconciliationCompleted(false);
    expect(metrics.snapshot()).toEqual({ requests: 1, requestDurationMs: 12, reconciliationChecks: 2, reconciliationInconsistencies: 1 });
  });
});
