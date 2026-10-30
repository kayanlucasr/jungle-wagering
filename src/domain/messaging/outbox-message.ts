import { assertIdentifier, instant } from '../invariants';

export interface OutboxMessageState<T extends object> {
  readonly id: string;
  readonly transactionId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly version: number;
  readonly payload: T;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly publishedAt: Date | null;
}
function freezeJson<T extends object>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
  };
  freeze(copy); return copy;
}

/** Immutable durable event state. Claim count, ordering, leases and fencing stay in SQL. */
export class OutboxMessage<T extends object> {
  private constructor(readonly id: string, readonly transactionId: string, readonly aggregateId: string,
    readonly eventType: string, readonly version: number, readonly payload: T, private readonly occurred: string,
    readonly attempts: number, private readonly next: string | null, private readonly published: string | null) { Object.freeze(this); }
  static enqueue<T extends object>(props: Omit<OutboxMessageState<T>, 'attempts' | 'nextAttemptAt' | 'publishedAt'>): OutboxMessage<T> {
    return this.rehydrate({ ...props, attempts: 0, nextAttemptAt: null, publishedAt: null });
  }
  static rehydrate<T extends object>(state: OutboxMessageState<T>): OutboxMessage<T> {
    if (!state.payload || typeof state.payload !== 'object' || Array.isArray(state.payload)) throw new Error('InvalidOutboxPayload');
    for (const id of [state.id, state.transactionId, state.aggregateId, state.eventType]) assertIdentifier(id);
    if (!Number.isInteger(state.version) || state.version < 1 || !Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new Error('InvalidOutboxState');
    }
    const occurred = instant(state.occurredAt);
    const next = state.nextAttemptAt === null ? null : instant(state.nextAttemptAt);
    const published = state.publishedAt === null ? null : instant(state.publishedAt);
    if ((next !== null && next < occurred) || (published !== null && published < occurred)) throw new Error('InvalidOutboxTimestamp');
    return new OutboxMessage(state.id, state.transactionId, state.aggregateId, state.eventType, state.version,
      freezeJson(state.payload), occurred, state.attempts, next, published);
  }
  get occurredAt(): Date { return new Date(this.occurred); }
  get nextAttemptAt(): Date | null { return this.next === null ? null : new Date(this.next); }
  get publishedAt(): Date | null { return this.published === null ? null : new Date(this.published); }
  isPending(): boolean { return this.published === null; }
  isDue(at: Date): boolean { return this.isPending() && (this.next === null || this.next <= instant(at)); }
  private state(): OutboxMessageState<T> {
    return { id: this.id, transactionId: this.transactionId, aggregateId: this.aggregateId, eventType: this.eventType,
      version: this.version, payload: this.payload, occurredAt: this.occurredAt, attempts: this.attempts,
      nextAttemptAt: this.nextAttemptAt, publishedAt: this.publishedAt };
  }
  markPublished(at: Date): OutboxMessage<T> {
    if (!this.isPending()) throw new Error('OutboxAlreadyPublished');
    return OutboxMessage.rehydrate({ ...this.state(), publishedAt: at });
  }
  /** Attempts were already incremented by the durable claim, including crashes.
   * Scheduling a retry must not increment them a second time or reset the event ID. */
  scheduleRetry(at: Date, delaySeconds: number): OutboxMessage<T> {
    if (!this.isPending()) throw new Error('OutboxAlreadyPublished');
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 43200) throw new Error('InvalidOutboxRetry');
    const next = new Date(new Date(instant(at)).getTime() + delaySeconds * 1000);
    return OutboxMessage.rehydrate({ ...this.state(), nextAttemptAt: next });
  }
}
