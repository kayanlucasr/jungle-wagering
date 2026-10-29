import type { MikroORM } from '@mikro-orm/postgresql';
import type { ClaimedEvent, OutboxStore } from '../../application/messaging/ports';
import type { EventEnvelope } from '../../application/messaging/integration-event';

export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}
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
    const rows = await this.orm.em.fork().execute<Array<{ id: string }>>(`update wagering.outbox_messages
      set published_at = greatest(occurred_at, clock_timestamp()), lease_owner = null, lease_until = null,
      last_error_code = null where id = ? and lease_owner = ? and attempts = ? and published_at is null
      and lease_until > clock_timestamp() returning id`, [event.id, event.owner, event.attempts]);
    return rows.length === 1;
  }
  async retry(event: ClaimedEvent, delaySeconds: number, errorCode: string): Promise<boolean> {
    const rows = await this.orm.em.fork().execute<Array<{ id: string }>>(`update wagering.outbox_messages
      set next_attempt_at = clock_timestamp() + (? * interval '1 second'),
      last_error_code = ?, lease_owner = null, lease_until = null
      where id = ? and lease_owner = ? and attempts = ? and published_at is null
      and lease_until > clock_timestamp() returning id`, [delaySeconds, errorCode, event.id, event.owner, event.attempts]);
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
