import type { EventEnvelope } from './integration-event';

export interface InboxRecord { readonly payloadHash: string; readonly transactionId: string | null;
  readonly processedAt: Date | null }
export interface InboxRepository {
  find(consumer: string, messageId: string): Promise<InboxRecord | undefined>;
  receive(consumer: string, messageId: string, hash: string, at: Date): Promise<InboxRecord>;
  complete(consumer: string, messageId: string, transactionId: string): Promise<void>;
}
export interface OutboxRepository { enqueue(events: readonly EventEnvelope[]): Promise<void> }
export interface ClaimedEvent { readonly id: string; readonly aggregateId: string;
  readonly payload: EventEnvelope; readonly attempts: number; readonly owner: string }
export interface OutboxStore {
  claim(owner: string, limit: number, leaseSeconds: number, maxAttempts: number): Promise<readonly ClaimedEvent[]>;
  published(event: ClaimedEvent): Promise<boolean>;
  retry(event: ClaimedEvent, delaySeconds: number, errorCode: string): Promise<boolean>;
  pending(maxAttempts?: number): Promise<{ count: number; exhausted: number; oldestAgeMs: number }>;
}
export class MessageConflict extends Error { constructor() { super('MESSAGE_ID_CONFLICT'); } }
