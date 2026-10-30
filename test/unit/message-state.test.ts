import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';

const at = () => new Date('2026-10-29T12:00:00.000Z');
const inbox = () => InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'a'.repeat(64), receivedAt: at() });
const event = () => ({ id: 'e', transactionId: 't', aggregateId: 'w', eventType: 'Processed', version: 1,
  payload: { eventId: 'e', data: { amount: '10.00' } }, occurredAt: at() });

describe('Immutable inbox/outbox domain states', () => {
  test('inbox completion preserves source and identifiers, protects dates and refuses terminal transitions', () => {
    const received = at(); const original = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'a'.repeat(64), receivedAt: received });
    received.setFullYear(2000); original.receivedAt.setFullYear(2001);
    const completed = original.markProcessed('t', at());
    expect(original.isProcessed()).toBe(false); expect(completed.isProcessed()).toBe(true);
    expect(completed.receivedAt.toISOString()).toBe(at().toISOString());
    completed.processedAt!.setFullYear(2002);
    expect(completed.processedAt!.toISOString()).toBe(at().toISOString());
    expect(() => completed.markProcessed('t', at())).toThrow('InboxAlreadyProcessed');
    expect(() => completed.markProcessed('other', at())).toThrow('InboxAlreadyProcessed');
  });
  test('inbox rehydration preserves processed result without executing completion again', () => {
    const restored = InboxMessage.rehydrate({ messageId: 'm', consumerName: 'c', payloadHash: 'a'.repeat(64),
      receivedAt: at(), transactionId: 't', processedAt: at() });
    expect(restored.transactionId).toBe('t'); expect(restored.isProcessed()).toBe(true);
    expect(() => inbox().markProcessed('t', new Date(at().getTime() - 1))).toThrow('InvalidInboxState');
    expect(() => InboxMessage.rehydrate({ messageId: 'm', consumerName: 'c', payloadHash: 'a'.repeat(64),
      receivedAt: at(), transactionId: null, processedAt: at() })).toThrow('InvalidInboxState');
  });
  test('inbox refuses reassignment of a previously attached transaction and invalid identity/hash', () => {
    const received = InboxMessage.rehydrate({ messageId: 'm', consumerName: 'c', payloadHash: 'a'.repeat(64),
      receivedAt: at(), transactionId: 'first', processedAt: null });
    expect(() => received.markProcessed('second', at())).toThrow('InboxTransactionConflict');
    expect(() => InboxMessage.receive({ messageId: '', consumerName: 'c', payloadHash: 'bad', receivedAt: at() })).toThrow();
    expect(() => InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'bad', receivedAt: at() })).toThrow('InvalidInboxHash');
  });
  test('outbox owns a deep immutable JSON copy and defensive timestamps', () => {
    const source = event(); const original = OutboxMessage.enqueue(source);
    source.payload.data.amount = '999.00'; source.occurredAt.setFullYear(2000);
    expect(original.payload.data.amount).toBe('10.00');
    expect(Object.isFrozen(original.payload.data)).toBe(true);
    expect(() => { original.payload.data.amount = '999.00'; }).toThrow();
    original.occurredAt.setFullYear(2001); expect(original.occurredAt.toISOString()).toBe(at().toISOString());
    expect(original.attempts).toBe(0);
  });
  test('retry retains the durable claim attempt and event ID; due checks and publication are explicit', () => {
    const claimed = OutboxMessage.rehydrate({ ...event(), attempts: 3, nextAttemptAt: null, publishedAt: null });
    const retry = claimed.scheduleRetry(at(), 2);
    expect(claimed.nextAttemptAt).toBeNull(); expect(retry.attempts).toBe(3); expect(retry.id).toBe('e');
    expect(retry.isDue(at())).toBe(false); expect(retry.isDue(new Date(at().getTime() + 2000))).toBe(true);
    retry.nextAttemptAt!.setFullYear(2000); expect(retry.isDue(at())).toBe(false);
    const published = retry.markPublished(new Date(at().getTime() + 2000));
    expect(published.isPending()).toBe(false); expect(published.isDue(at())).toBe(false);
    expect(() => published.scheduleRetry(at(), 1)).toThrow('OutboxAlreadyPublished');
    expect(() => published.markPublished(at())).toThrow('OutboxAlreadyPublished');
  });
  test('outbox rehydrates historical publication without repeating it and rejects invalid schedule/state', () => {
    const published = OutboxMessage.rehydrate({ ...event(), attempts: 4, nextAttemptAt: at(), publishedAt: at() });
    expect(published.attempts).toBe(4); expect(published.isPending()).toBe(false);
    expect(() => OutboxMessage.enqueue(event()).scheduleRetry(at(), 0)).toThrow('InvalidOutboxRetry');
    expect(() => OutboxMessage.rehydrate({ ...event(), attempts: -1, nextAttemptAt: null, publishedAt: null })).toThrow('InvalidOutboxState');
    expect(() => OutboxMessage.enqueue(event()).markPublished(new Date(at().getTime() - 1))).toThrow('InvalidOutboxTimestamp');
  });
});
