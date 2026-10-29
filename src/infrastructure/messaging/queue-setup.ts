import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/environment';

export async function initializeQueues(client: SQSClient, config: AppConfig): Promise<void> {
  for (const [name, dlq] of [[config.sqs.queueName, config.sqs.dlqName],
    [config.sqs.eventsQueueName, config.sqs.eventsDlqName]]) {
    const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: dlq!, Attributes: {
      FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600' } }));
    if (!QueueUrl) throw new Error('DlqNotCreated');
    const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
    if (!Attributes?.['QueueArn']) throw new Error('DlqArnMissing');
    await client.send(new CreateQueueCommand({ QueueName: name!, Attributes: {
      FifoQueue: 'true', ContentBasedDeduplication: 'false',
      VisibilityTimeout: String(config.sqs.visibilityTimeoutSeconds),
      ReceiveMessageWaitTimeSeconds: String(config.messaging.waitSeconds), MessageRetentionPeriod: '345600',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes['QueueArn'],
        maxReceiveCount: String(config.sqs.maxReceiveCount) }),
    } }));
  }
}
