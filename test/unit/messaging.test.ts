import { describe, expect, test } from 'bun:test';
import { parseCommand, commandHash, walletGroup } from '../../src/application/messaging/command-envelope';
import { backoffSeconds } from '../../src/infrastructure/messaging/retry';
import { fixtureConfig } from '../support/config';

function envelope() {
  return { messageId: 'message-1', type: 'WagerTransactionRequested', version: 1, correlationId: 'correlation-1',
    occurredAt: '2026-10-29T00:00:00.000Z', data: { providerId: 'provider-a', externalTransactionId: 'external-1',
      idempotencyKey: 'provider-a:external-1', walletId: 'wallet-1', playerId: 'player-1', roundId: 'round-1',
      gameId: 'game-1', kind: 'BET', money: { amount: '10.00', currency: 'BRL' } } };
}
describe('Messaging envelope and operational limits', () => {
  test('validates canonical command independently of property order and whitespace', () => {
    const first = parseCommand(JSON.stringify(envelope()));
    const reordered = Object.fromEntries(Object.entries(envelope()).reverse());
    expect(commandHash(first)).toBe(commandHash(parseCommand(JSON.stringify(reordered, null, 2))));
    const changed = { ...envelope(), correlationId: 'different' };
    expect(commandHash(first)).not.toBe(commandHash(parseCommand(JSON.stringify(changed))));
    const changedKey = envelope(); changedKey.data.idempotencyKey = 'another-key';
    expect(commandHash(first)).not.toBe(commandHash(parseCommand(JSON.stringify(changedKey))));
  });
  test('rejects numeric money, unsupported versions, OPENING and unknown fields', () => {
    for (const value of [null, {}, { ...envelope(), version: 2 }, { ...envelope(), secret: 'unexpected' },
      { ...envelope(), data: { ...envelope().data, kind: 'OPENING' } },
      { ...envelope(), data: { ...envelope().data, money: { amount: 10, currency: 'BRL' } } },
      { ...envelope(), data: { ...envelope().data, walletId: 'nul\u0000id' } },
      { ...envelope(), data: { ...envelope().data, walletId: '\ud800' } },
      { ...envelope(), occurredAt: '2026-02-30T00:00:00.000Z' },
      { ...envelope(), data: { ...envelope().data, kind: 'REFUND' } }]) {
      expect(() => parseCommand(JSON.stringify(value))).toThrow('INVALID_ENVELOPE');
    }
    expect(() => parseCommand('invalid json')).toThrow();
    expect(() => parseCommand(' '.repeat(65537))).toThrow();
  });
  test('wallet-scoped FIFO groups support Unicode and remain stable across processes', () => {
    expect(walletGroup('carteira-á')).toMatch(/^[a-f0-9]{64}$/);
    expect(walletGroup('carteira-á')).toBe(walletGroup('carteira-á'));
    expect(walletGroup('A')).not.toBe(walletGroup('B'));
  });
  test('backoff is bounded, exponential and never zero', () => {
    expect(backoffSeconds(1, 2, 100, () => 0)).toBe(1);
    expect(backoffSeconds(3, 2, 100, () => 1)).toBe(8);
    expect(backoffSeconds(1000, 2, 100, () => 1)).toBe(100);
  });
  test('configuration rejects unsafe leases, retry ranges and colliding queues', () => {
    expect(() => fixtureConfig({ OUTBOX_LEASE_SECONDS: '2', DEPENDENCY_TIMEOUT_MS: '1000' })).toThrow();
    expect(() => fixtureConfig({ MESSAGING_RETRY_BASE_SECONDS: '10', MESSAGING_RETRY_CAP_SECONDS: '1' })).toThrow();
    expect(() => fixtureConfig({ SQS_EVENTS_QUEUE_NAME: 'wager-transactions.fifo' })).toThrow();
    expect(() => fixtureConfig({ CONSUMER_CONCURRENCY: '0' })).toThrow();
    expect(() => fixtureConfig({ SQS_WAIT_SECONDS: '21' })).toThrow();
  });
});
