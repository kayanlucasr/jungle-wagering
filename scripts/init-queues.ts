import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/infrastructure/config/environment';
import { createSqsClient } from '../src/infrastructure/messaging/sqs.service';
import { JsonLogger } from '../src/infrastructure/observability/json-logger';

const config = loadConfig();
const client = createSqsClient(config);
try {
  const { QueueUrl } = await client.send(new CreateQueueCommand({
    QueueName: config.sqs.dlqName,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600' },
  }));
  if (!QueueUrl) throw new Error('DLQ URL missing');
  const { Attributes } = await client.send(new GetQueueAttributesCommand({
    QueueUrl, AttributeNames: ['QueueArn'],
  }));
  const arn = Attributes?.['QueueArn'];
  if (!arn) throw new Error('DLQ ARN missing');
  await client.send(new CreateQueueCommand({
    QueueName: config.sqs.queueName,
    Attributes: {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: String(config.sqs.visibilityTimeoutSeconds),
      ReceiveMessageWaitTimeSeconds: '20',
      MessageRetentionPeriod: '345600',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: String(config.sqs.maxReceiveCount) }),
    },
  }));
  new JsonLogger().write('info', 'sqs_queues_initialized');
} finally {
  client.destroy();
}
