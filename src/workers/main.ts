import { FinancialService } from '../application/financial/financial-service';
import { loadConfig } from '../infrastructure/config/environment';
import { DatabaseService } from '../infrastructure/persistence/database.service';
import { PostgresFinancialUnitOfWork } from '../infrastructure/persistence/financial-unit-of-work';
import { PostgresOutboxStore } from '../infrastructure/persistence/outbox-store';
import { createSqsClient, SqsService } from '../infrastructure/messaging/sqs.service';
import { TransactionConsumer } from '../infrastructure/messaging/transaction-consumer';
import { OutboxPublisher } from '../infrastructure/messaging/outbox-publisher';
import { JsonLogger } from '../infrastructure/observability/json-logger';
import { MessagingMetrics } from '../infrastructure/observability/messaging-metrics';
import { PendingReferenceMetrics } from '../infrastructure/observability/pending-reference-metrics';
import { ReferenceScheduler } from '../infrastructure/pending-reference/reference-scheduler';

const kind = process.argv[2];
if (kind !== 'consumer' && kind !== 'publisher' && kind !== 'pending-reference') throw new Error('InvalidWorkerKind');
const config = loadConfig();
const logger = new JsonLogger(config.logLevel);
const database = await DatabaseService.create(config);
const client = kind === 'pending-reference' ? undefined : createSqsClient(config, kind === 'consumer');
const financialUnitOfWork = new PostgresFinancialUnitOfWork(database.orm);
const financial = new FinancialService(financialUnitOfWork, config.pendingReference);
const metrics = kind === 'pending-reference' ? new PendingReferenceMetrics() : new MessagingMetrics();
const worker = kind === 'consumer'
  ? new TransactionConsumer(config, client!, financial, metrics as MessagingMetrics, logger)
  : kind === 'publisher' ? new OutboxPublisher(config, client!, new PostgresOutboxStore(database.orm), metrics as MessagingMetrics, logger)
    : new ReferenceScheduler(financial, config.pendingReference, metrics as PendingReferenceMetrics, logger);
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  if (shutdownTimer) return;
  logger.write('info', 'worker_shutdown_started', { context: kind });
  worker.stop();
  // Deadline kills the process: open SQL transactions roll back and messages/leases expire.
  shutdownTimer = setTimeout(() => {
    logger.write('error', 'worker_shutdown_deadline', { context: kind, errorCode: 'DRAIN_TIMEOUT', metrics: metrics.snapshot() });
    process.exit(1);
  }, config.messaging.shutdownTimeoutMs);
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const report = setInterval(() => {
  logger.write('info', 'messaging_metrics', { context: kind, metrics: metrics.snapshot() });
  logger.write('info', 'financial_metrics', { context: kind, metrics: financialUnitOfWork.metrics.snapshot() });
}, 10000);
try {
  // Refuse unsafe roles, missing migrations or wrong queues before polling. Restart policy handles dependency recovery.
  const uow = new PostgresFinancialUnitOfWork(database.orm);
  await uow.readSnapshot(async (session) => { await session.inbox.find('__readiness', '__readiness'); });
  await database.orm.em.fork().execute('select position, last_error_code from wagering.outbox_messages limit 0');
  await database.orm.em.fork().execute('select reference_deadline_at from wagering.wager_transactions limit 0');
  if (kind !== 'pending-reference') {
    const sqs = new SqsService(config);
    try { await sqs.checkReady(); } finally { sqs.onApplicationShutdown(); }
  }
  logger.write('info', 'worker_started', { context: kind });
  await worker.run();
} catch {
  logger.write('error', 'worker_failed', { context: kind, errorCode: 'WORKER_UNAVAILABLE' });
  process.exitCode = 1;
} finally {
  clearInterval(report);
  client?.destroy();
  await database.onApplicationShutdown();
  if (shutdownTimer) clearTimeout(shutdownTimer);
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  logger.write('info', 'worker_stopped', { context: kind, metrics: metrics.snapshot() });
}
