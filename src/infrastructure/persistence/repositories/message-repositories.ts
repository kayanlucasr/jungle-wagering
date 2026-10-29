import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRecord, InboxRepository, OutboxRepository } from '../../../application/messaging/ports';
import type { EventEnvelope } from '../../../application/messaging/integration-event';

export class PostgresInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}
  async find(consumer: string, messageId: string): Promise<InboxRecord | undefined> {
    const rows = await this.em.execute<Array<{ payload_hash: string; transaction_id: string | null; processed_at: Date | null }>>(
      `select payload_hash, transaction_id, processed_at from wagering.inbox_messages
       where consumer_name = ? and message_id = ?`, [consumer, messageId]);
    const row = rows[0];
    return row ? { payloadHash: row.payload_hash, transactionId: row.transaction_id, processedAt: row.processed_at } : undefined;
  }
  async receive(consumer: string, messageId: string, hash: string, at: Date): Promise<InboxRecord> {
    await this.em.execute(`insert into wagering.inbox_messages
      (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, ?)
      on conflict (consumer_name, message_id) do nothing`, [consumer, messageId, hash, at]);
    const rows = await this.em.execute<Array<{ payload_hash: string; transaction_id: string | null; processed_at: Date | null }>>(
      `select payload_hash, transaction_id, processed_at from wagering.inbox_messages
       where consumer_name = ? and message_id = ? for update`, [consumer, messageId]);
    const row = rows[0];
    if (!row) throw new Error('InboxIdentityMissing');
    return { payloadHash: row.payload_hash, transactionId: row.transaction_id, processedAt: row.processed_at };
  }
  async complete(consumer: string, messageId: string, transactionId: string): Promise<void> {
    await this.em.execute(`update wagering.inbox_messages set transaction_id = ?,
      processed_at = greatest(received_at, clock_timestamp()) where consumer_name = ? and message_id = ?`,
    [transactionId, consumer, messageId]);
  }
}
export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}
  async enqueue(events: readonly EventEnvelope[]): Promise<void> {
    for (const event of events) await this.em.execute(`insert into wagering.outbox_messages
      (id, transaction_id, aggregate_id, event_type, event_version, payload, occurred_at)
      values (?, ?, ?, ?, ?, ?::jsonb, ?)`, [event.eventId, event.transactionId, event.aggregateId,
      event.eventType, event.version, JSON.stringify(event), event.occurredAt]);
  }
}
