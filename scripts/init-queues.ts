import { loadConfig } from '../src/infrastructure/config/environment';
import { createSqsClient } from '../src/infrastructure/messaging/sqs.service';
import { initializeQueues } from '../src/infrastructure/messaging/queue-setup';
import { JsonLogger } from '../src/infrastructure/observability/json-logger';

const config = loadConfig();
const client = createSqsClient(config);
try {
  await initializeQueues(client, config);
  new JsonLogger().write('info', 'sqs_queues_initialized');
} finally { client.destroy(); }
