import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { AppConfig } from '../config/environment';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: config.dependencyTimeoutMs,
      requestTimeout: config.dependencyTimeoutMs,
    }),
  });
}

export class SqsService implements OnApplicationShutdown {
  readonly client: SQSClient;
  constructor(private readonly config: AppConfig) {
    this.client = createSqsClient(config);
  }

  async checkReady(): Promise<void> {
    const signal = AbortSignal.timeout(this.config.dependencyTimeoutMs);
    const [source, dlq] = await Promise.all([
      this.attributes(this.config.sqs.queueName, signal),
      this.attributes(this.config.sqs.dlqName, signal),
    ]);
    const redrive: unknown = JSON.parse(source['RedrivePolicy'] ?? 'null');
    if (source['FifoQueue'] !== 'true' || dlq['FifoQueue'] !== 'true' ||
        source['VisibilityTimeout'] !== String(this.config.sqs.visibilityTimeoutSeconds) ||
        !isRedrive(redrive) || redrive.deadLetterTargetArn !== dlq['QueueArn'] ||
        String(redrive.maxReceiveCount) !== String(this.config.sqs.maxReceiveCount)) {
      throw new Error('QueueConfigurationMismatch');
    }
  }

  private async attributes(name: string, signal: AbortSignal): Promise<Record<string, string>> {
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal: signal });
    if (!QueueUrl) throw new Error('QueueNotFound');
    const { Attributes } = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl, AttributeNames: ['QueueArn', 'FifoQueue', 'RedrivePolicy', 'VisibilityTimeout'],
    }), { abortSignal: signal });
    return Attributes ?? {};
  }

  onApplicationShutdown(): void { this.client.destroy(); }
}

function isRedrive(value: unknown): value is { deadLetterTargetArn: string; maxReceiveCount: string | number } {
  return typeof value === 'object' && value !== null &&
    'deadLetterTargetArn' in value && typeof value.deadLetterTargetArn === 'string' &&
    'maxReceiveCount' in value && (typeof value.maxReceiveCount === 'string' || typeof value.maxReceiveCount === 'number');
}
