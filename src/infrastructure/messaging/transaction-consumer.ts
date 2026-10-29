import { createHash, randomUUID } from 'node:crypto';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueUrlCommand,
  ReceiveMessageCommand, SendMessageCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import { FinancialService, type SubmissionResult } from '../../application/financial/financial-service';
import { FinancialError } from '../../application/financial/errors';
import { commandHash, parseCommand, walletGroup, type CommandEnvelope } from '../../application/messaging/command-envelope';
import { MessageConflict } from '../../application/messaging/ports';
import { DomainError } from '../../domain/errors/domain-error';
import type { AppConfig } from '../config/environment';
import { JsonLogger } from '../observability/json-logger';
import { MessagingMetrics } from '../observability/messaging-metrics';
import { backoffSeconds, pause } from './retry';

export const CONSUMER_NAME = 'wager-transactions-v1';
export interface ConsumerHooks { readonly afterCommit?: (message: CommandEnvelope, result: SubmissionResult) => Promise<void> }

export class TransactionConsumer {
  private readonly polling = new AbortController();
  private sourceUrl = '';
  private dlqUrl = '';
  constructor(private readonly config: AppConfig, private readonly client: SQSClient,
    private readonly financial: FinancialService, readonly metrics = new MessagingMetrics(),
    private readonly logger = new JsonLogger(config.logLevel), private readonly hooks: ConsumerHooks = {}) {}

  stop(): void { this.polling.abort(); }
  async run(): Promise<void> {
    await Promise.all(Array.from({ length: this.config.messaging.concurrency }, () => this.loop()));
  }
  private async resolve(): Promise<void> {
    const options = { abortSignal: this.polling.signal };
    const [source, dlq] = await Promise.all([
      this.client.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.queueName }), options),
      this.client.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.dlqName }), options),
    ]);
    if (!source.QueueUrl || !dlq.QueueUrl) throw new Error('QueueMissing');
    this.sourceUrl = source.QueueUrl; this.dlqUrl = dlq.QueueUrl;
  }
  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.polling.signal.aborted) {
      try {
        if (!this.sourceUrl) await this.resolve();
        // One in-flight message per receive avoids processing later messages of a failed FIFO batch.
        const response = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.sourceUrl,
          MaxNumberOfMessages: 1, WaitTimeSeconds: this.config.messaging.waitSeconds,
          VisibilityTimeout: this.config.sqs.visibilityTimeoutSeconds,
          ReceiveRequestAttemptId: randomUUID(), MessageSystemAttributeNames: ['All'], MessageAttributeNames: ['All'],
        }), { abortSignal: this.polling.signal });
        failures = 0;
        for (const message of response.Messages ?? []) {
          if (this.polling.signal.aborted) {
            if (message.ReceiptHandle) await this.visibility(message, 0);
          } else await this.process(message);
        }
      } catch {
        if (this.polling.signal.aborted) break;
        failures += 1;
        this.metrics.transientFailures += 1;
        this.logger.write('warn', 'consumer_poll_retry', { consumerName: CONSUMER_NAME,
          attempt: failures, errorCode: 'SQS_UNAVAILABLE' });
        await pause(backoffSeconds(failures, this.config.messaging.retryBaseSeconds,
          this.config.messaging.retryCapSeconds) * 1000, this.polling.signal);
      }
    }
  }
  private async visibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.sourceUrl,
      ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: seconds }),
    { abortSignal: AbortSignal.timeout(this.config.dependencyTimeoutMs) });
  }
  private async remove(message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.sourceUrl, ReceiptHandle: message.ReceiptHandle! }),
      { abortSignal: AbortSignal.timeout(this.config.dependencyTimeoutMs) });
  }
  private async process(message: Message): Promise<void> {
    if (!message.ReceiptHandle) throw new Error('ReceiptMissing');
    this.metrics.received += 1;
    const started = performance.now();
    const attempt = Math.max(1, Number(message.Attributes?.['ApproximateReceiveCount'] ?? 1));
    let envelope: CommandEnvelope | undefined;
    let committed = false;
    let outcome = 'invalid';
    let code = 'INVALID_ENVELOPE';
    let transactionId: string | undefined;
    // Visibility is an optimization. PostgreSQL remains safe if extension fails or the process dies.
    let extending: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (!extending) extending = this.visibility(message, this.config.sqs.visibilityTimeoutSeconds)
        .catch(() => { this.logger.write('warn', 'consumer_visibility_failed', {
          consumerName: CONSUMER_NAME, errorCode: 'VISIBILITY_UNAVAILABLE' }); })
        .finally(() => { extending = undefined; });
    }, Math.max(250, this.config.sqs.visibilityTimeoutSeconds * 1000 / 3));
    try {
      envelope = parseCommand(message.Body);
      if (message.Attributes?.['MessageGroupId'] !== walletGroup(envelope.data.walletId)) {
        code = 'INVALID_MESSAGE_GROUP'; throw new Error(code);
      }
      outcome = 'temporary'; code = 'PROCESSING_UNAVAILABLE';
      const hash = commandHash(envelope);
      let result: SubmissionResult;
      try {
        result = await this.financial.submit(envelope.data, { correlationId: envelope.correlationId,
          causationId: envelope.messageId, inbox: { consumerName: CONSUMER_NAME, messageId: envelope.messageId, payloadHash: hash } });
      } catch (error) {
        if (!(error instanceof FinancialError) || error.code !== 'PERSISTENCE_UNAVAILABLE') throw error;
        const confirmed = await this.financial.confirmedMessage(CONSUMER_NAME, envelope.messageId, hash);
        if (!confirmed) throw error;
        result = confirmed;
      }
      committed = true; transactionId = result.transactionId;
      await this.hooks.afterCommit?.(envelope, result);
      await this.remove(message);
      outcome = result.replay ? 'duplicate' : result.status;
      code = '';
      this.metrics.processed += 1;
      if (result.replay) this.metrics.duplicates += 1;
    } catch (error) {
      if (committed) {
        // ACK failure must never route an already committed command to the DLQ here.
        code = 'ACK_UNAVAILABLE'; outcome = 'temporary'; this.metrics.transientFailures += 1;
        await this.visibility(message, backoffSeconds(attempt, this.config.messaging.retryBaseSeconds,
          this.config.messaging.retryCapSeconds)).catch(() => {});
      } else {
        if (error instanceof FinancialError) {
          code = error.code; outcome = error.code === 'PERSISTENCE_UNAVAILABLE' ? 'temporary' : 'permanent';
        } else if (error instanceof MessageConflict) { code = 'MESSAGE_ID_CONFLICT'; outcome = 'permanent'; }
        else if (error instanceof DomainError) { code = error.code; outcome = 'permanent'; }
        if (outcome === 'temporary') this.metrics.transientFailures += 1;
        else if (outcome === 'invalid') this.metrics.invalid += 1;
        else this.metrics.permanentFailures += 1;
        if (attempt >= this.config.sqs.maxReceiveCount) {
          // Durable DLQ copy before removing source; stable dedup ID also handles uncertain send/ACK.
          const dedup = createHash('sha256').update(`${this.config.sqs.queueName}:${message.MessageId}`).digest('hex');
          await this.client.send(new SendMessageCommand({ QueueUrl: this.dlqUrl, MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.['MessageGroupId'] ?? 'invalid', MessageDeduplicationId: dedup,
            MessageAttributes: { ErrorCode: { DataType: 'String', StringValue: code },
              ConsumerName: { DataType: 'String', StringValue: CONSUMER_NAME },
              OriginalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
              Attempt: { DataType: 'Number', StringValue: String(attempt) } },
          }), { abortSignal: AbortSignal.timeout(this.config.dependencyTimeoutMs) });
          await this.remove(message);
          this.metrics.dlqForwarded += 1; outcome = 'dlq';
        } else await this.visibility(message, backoffSeconds(attempt, this.config.messaging.retryBaseSeconds,
          this.config.messaging.retryCapSeconds));
      }
    } finally {
      clearInterval(heartbeat);
      await extending;
      const durationMs = Math.round(performance.now() - started);
      this.metrics.processingDurationMs += durationMs; this.metrics.processingCount += 1;
      this.logger.write(outcome === 'temporary' || outcome === 'dlq' ? 'warn' : 'info', 'consumer_message_completed', {
        consumerName: CONSUMER_NAME, operation: 'consume', attempt, durationMs, result: outcome, errorCode: code,
        ...(envelope ? { correlationId: envelope.correlationId, messageId: envelope.messageId,
          walletId: envelope.data.walletId, providerId: envelope.data.providerId } : {}),
        ...(transactionId ? { transactionId } : {}),
      });
    }
  }
}
