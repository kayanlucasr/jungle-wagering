import type { MikroORM } from '@mikro-orm/postgresql';
import type { ClaimedEvent, OutboxStore } from '../../application/messaging/ports';
import type { EventEnvelope } from '../../application/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';

interface EventRow { id: string; transaction_id: string; aggregate_id: string; event_type: string; event_version: number;
  payload: EventEnvelope; occurred_at: Date | string; attempts: number; next_attempt_at: Date | string | null;
  published_at: Date | string | null; observed_at: Date | string }
const date = (value: Date | string): Date => new Date(value instanceof Date ? value.getTime() : value);

export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}
  private async owned(event: ClaimedEvent): Promise<{ message: OutboxMessage<EventEnvelope>; at: Date } | undefined> {
    const rows = await this.orm.em.fork().execute<EventRow[]>(`select *, clock_timestamp() as observed_at
      from wagering.outbox_messages where id = ? and lease_owner = ? and attempts = ? and published_at is null
      and lease_until > clock_timestamp()`, [event.id, event.owner, event.attempts]);
    const row = rows[0];
    if (!row) return undefined;
    return { message: OutboxMessage.rehydrate({ id: row.id, transactionId: row.transaction_id, aggregateId: row.aggregate_id,
      eventType: row.event_type, version: row.event_version, payload: row.payload, occurredAt: date(row.occurred_at),
      attempts: row.attempts, nextAttemptAt: row.next_attempt_at === null ? null : date(row.next_attempt_at),
      publishedAt: row.published_at === null ? null : date(row.published_at) }), at: date(row.observed_at) };
  }
  async claim(owner: string, limit: number, leaseSeconds: number, maxAttempts: number): Promise<readonly ClaimedEvent[]> {
    return this.orm.em.fork().transactional(async (em) => {
      const rows = await em.execute<Array<{ id: string; aggregate_id: string; payload: EventEnvelope; attempts: number }>>(`
        with candidates as (
          select o.id from wagering.outbox_messages o where o.published_at is null
            and o.attempts < ? and (o.next_attempt_at is null or o.next_attempt_at <= clock_timestamp())
            and (o.lease_until is null or o.lease_until <= clock_timestamp())
            and not exists (select 1 from wagering.outbox_messages previous
              where previous.aggregate_id = o.aggregate_id and previous.published_at is null
                and previous.position < o.position)
          order by o.position for update skip locked limit ?
        ) update wagering.outbox_messages o set lease_owner = ?,
          lease_until = clock_timestamp() + (? * interval '1 second'), attempts = o.attempts + 1
          from candidates c where o.id = c.id returning o.id, o.aggregate_id, o.payload, o.attempts`,
      [maxAttempts, limit, owner, leaseSeconds]);
      return rows.map((r) => ({ id: r.id, aggregateId: r.aggregate_id, payload: r.payload, attempts: r.attempts, owner }));
    });
  }
  async published(event: ClaimedEvent): Promise<boolean> {
    const current = await this.owned(event);
    if (!current) return false;
    const published = current.message.markPublished(new Date(Math.max(current.at.getTime(), current.message.occurredAt.getTime())));
    const rows = await this.orm.em.fork().execute<Array<{ id: string }>>(`update wagering.outbox_messages
      set published_at = ?, lease_owner = null, lease_until = null,
      last_error_code = null where id = ? and lease_owner = ? and attempts = ? and published_at is null
      and lease_until > clock_timestamp() returning id`, [published.publishedAt, event.id, event.owner, event.attempts]);
    return rows.length === 1;
  }
  async retry(event: ClaimedEvent, delaySeconds: number, errorCode: string): Promise<boolean> {
    const current = await this.owned(event);
    if (!current) return false;
    const retry = current.message.scheduleRetry(current.at, delaySeconds);
    const rows = await this.orm.em.fork().execute<Array<{ id: string }>>(`update wagering.outbox_messages
      set next_attempt_at = ?,
      last_error_code = ?, lease_owner = null, lease_until = null
      where id = ? and lease_owner = ? and attempts = ? and published_at is null
      and lease_until > clock_timestamp() returning id`, [retry.nextAttemptAt, errorCode, event.id, event.owner, event.attempts]);
    return rows.length === 1;
  }
  async pending(maxAttempts = 20): Promise<{ count: number; exhausted: number; oldestAgeMs: number }> {
    const rows = await this.orm.em.fork().execute<Array<{ count: string; exhausted: string; age: string | null }>>(`
      select count(*)::text as count, count(*) filter(where attempts >= ?)::text as exhausted,
      (extract(epoch from (clock_timestamp() - min(occurred_at))) * 1000)::text as age
      from wagering.outbox_messages where published_at is null`, [maxAttempts]);
    return { count: Number(rows[0]!.count), exhausted: Number(rows[0]!.exhausted), oldestAgeMs: Number(rows[0]!.age ?? 0) };
  }
}
