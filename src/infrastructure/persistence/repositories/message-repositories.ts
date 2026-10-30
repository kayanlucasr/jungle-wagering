import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRecord, InboxRepository, OutboxRepository } from '../../../application/messaging/ports';
import type { EventEnvelope } from '../../../application/messaging/integration-event';
import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';

interface InboxRow { payload_hash: string; transaction_id: string | null; received_at: Date | string;
  processed_at: Date | string | null; observed_at: Date | string }
const date = (value: Date | string): Date => new Date(value instanceof Date ? value.getTime() : value);

export class PostgresInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}
  private rehydrate(row: InboxRow, consumer: string, messageId: string): InboxMessage {
    return InboxMessage.rehydrate({ messageId, consumerName: consumer, payloadHash: row.payload_hash,
      receivedAt: date(row.received_at), transactionId: row.transaction_id,
      processedAt: row.processed_at === null ? null : date(row.processed_at) });
  }
  private record(message: InboxMessage): InboxRecord {
    return { payloadHash: message.payloadHash, transactionId: message.transactionId, processedAt: message.processedAt };
  }
  async find(consumer: string, messageId: string): Promise<InboxRecord | undefined> {
    const rows = await this.em.execute<InboxRow[]>(
      `select payload_hash, transaction_id, processed_at, received_at, clock_timestamp() as observed_at from wagering.inbox_messages
       where consumer_name = ? and message_id = ?`, [consumer, messageId]);
    const row = rows[0];
    return row ? this.record(this.rehydrate(row, consumer, messageId)) : undefined;
  }
  async receive(consumer: string, messageId: string, hash: string, at: Date): Promise<InboxRecord> {
    const proposed = InboxMessage.receive({ consumerName: consumer, messageId, payloadHash: hash, receivedAt: at });
    await this.em.execute(`insert into wagering.inbox_messages
      (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, ?)
      on conflict (consumer_name, message_id) do nothing`, [proposed.consumerName, proposed.messageId, proposed.payloadHash, proposed.receivedAt]);
    const rows = await this.em.execute<InboxRow[]>(
      `select payload_hash, transaction_id, processed_at, received_at, clock_timestamp() as observed_at from wagering.inbox_messages
       where consumer_name = ? and message_id = ? for update`, [consumer, messageId]);
    const row = rows[0];
    if (!row) throw new Error('InboxIdentityMissing');
    return this.record(this.rehydrate(row, consumer, messageId));
  }
  async complete(consumer: string, messageId: string, transactionId: string): Promise<void> {
    const rows = await this.em.execute<InboxRow[]>(`select payload_hash, transaction_id, processed_at,
      received_at, clock_timestamp() as observed_at from wagering.inbox_messages where consumer_name = ? and message_id = ? for update`, [consumer, messageId]);
    if (!rows[0]) throw new Error('InboxIdentityMissing');
    const message = this.rehydrate(rows[0], consumer, messageId);
    const processed = message.markProcessed(transactionId, new Date(Math.max(message.receivedAt.getTime(), date(rows[0].observed_at).getTime())));
    await this.em.execute(`update wagering.inbox_messages set transaction_id = ?, processed_at = ?
      where consumer_name = ? and message_id = ?`, [processed.transactionId, processed.processedAt, consumer, messageId]);
  }
}
export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}
  async enqueue(events: readonly EventEnvelope[]): Promise<void> {
    for (const event of events) {
      const message = OutboxMessage.enqueue({ id: event.eventId, transactionId: event.transactionId, aggregateId: event.aggregateId,
        eventType: event.eventType, version: event.version, payload: event, occurredAt: new Date(event.occurredAt) });
      await this.em.execute(`insert into wagering.outbox_messages
      (id, transaction_id, aggregate_id, event_type, event_version, payload, occurred_at)
      values (?, ?, ?, ?, ?, ?::jsonb, ?)`, [message.id, message.transactionId, message.aggregateId,
        message.eventType, message.version, JSON.stringify(message.payload), message.occurredAt]);
    }
  }
}
