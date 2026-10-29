import { randomUUID } from 'node:crypto';
import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { ClaimedEvent, OutboxStore } from '../../application/messaging/ports';
import { walletGroup } from '../../application/messaging/command-envelope';
import type { AppConfig } from '../config/environment';
import { JsonLogger } from '../observability/json-logger';
import { MessagingMetrics } from '../observability/messaging-metrics';
import { backoffSeconds, pause } from './retry';

export interface PublisherHooks { readonly afterSend?: (event: ClaimedEvent) => Promise<void> }
export class OutboxPublisher {
  private readonly stopping = new AbortController();
  readonly owner = randomUUID();
  private queueUrl = '';
  constructor(private readonly config: AppConfig, private readonly client: SQSClient,
    private readonly store: OutboxStore, readonly metrics = new MessagingMetrics(),
    private readonly logger = new JsonLogger(config.logLevel), private readonly hooks: PublisherHooks = {}) {}
  stop(): void { this.stopping.abort(); }
  async run(): Promise<void> {
    let failures = 0;
    while (!this.stopping.signal.aborted) {
      try {
        await this.tick(); failures = 0;
        await pause(this.config.messaging.outboxPollMs, this.stopping.signal);
      } catch {
        this.logger.write('warn', 'publisher_poll_retry', { errorCode: 'PUBLISHER_UNAVAILABLE', attempt: ++failures });
        await pause(backoffSeconds(failures, this.config.messaging.retryBaseSeconds,
          this.config.messaging.retryCapSeconds) * 1000, this.stopping.signal);
      }
    }
  }
  async tick(): Promise<number> {
    if (!this.queueUrl) {
      const result = await this.client.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.eventsQueueName }),
        { abortSignal: AbortSignal.timeout(this.config.dependencyTimeoutMs) });
      if (!result.QueueUrl) throw new Error('EventsQueueMissing');
      this.queueUrl = result.QueueUrl;
    }
    if (this.stopping.signal.aborted) return 0;
    const events = await this.store.claim(this.owner, this.config.messaging.outboxBatchSize,
      this.config.messaging.outboxLeaseSeconds, this.config.messaging.outboxMaxAttempts);
    // Network runs after claim transaction commits. Parallel sends keep batch work within its lease.
    await Promise.all(events.map(async (event) => {
      const started = performance.now();
      try {
        const result = await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(event.payload), MessageGroupId: walletGroup(event.aggregateId),
          MessageDeduplicationId: event.id }), { abortSignal: AbortSignal.timeout(this.config.dependencyTimeoutMs) });
        if (!result.MessageId) throw new Error('SendUnconfirmed');
        await this.hooks.afterSend?.(event);
        if (await this.store.published(event)) {
          this.metrics.published += 1;
          this.logger.write('info', 'outbox_published', { eventId: event.id, messageId: result.MessageId, operation: 'publish',
            correlationId: event.payload.correlationId, transactionId: event.payload.transactionId,
            walletId: event.aggregateId, attempt: event.attempts, result: 'published', durationMs: Math.round(performance.now() - started) });
        }
      } catch {
        this.metrics.publicationFailures += 1;
        const code = event.attempts >= this.config.messaging.outboxMaxAttempts ? 'ATTEMPTS_EXHAUSTED' : 'SEND_UNAVAILABLE';
        await this.store.retry(event, backoffSeconds(event.attempts, this.config.messaging.retryBaseSeconds,
          this.config.messaging.retryCapSeconds), code);
        this.logger.write('warn', 'outbox_publication_failed', { eventId: event.id, errorCode: code, operation: 'publish', result: 'retry',
          correlationId: event.payload.correlationId, transactionId: event.payload.transactionId,
          walletId: event.aggregateId, attempt: event.attempts, durationMs: Math.round(performance.now() - started) });
      }
    }));
    const pending = await this.store.pending(this.config.messaging.outboxMaxAttempts);
    this.metrics.outboxPending = pending.count; this.metrics.outboxExhausted = pending.exhausted;
    this.metrics.outboxOldestAgeMs = pending.oldestAgeMs;
    return events.length;
  }
}
