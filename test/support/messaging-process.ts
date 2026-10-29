import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/infrastructure/config/environment';
import { ormOptions } from '../../src/infrastructure/persistence/orm-options';
import { PostgresFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial-unit-of-work';
import { FinancialService } from '../../src/application/financial/financial-service';
import { FinancialError } from '../../src/application/financial/errors';
import type { FinancialUnitOfWork } from '../../src/application/financial/ports';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.service';
import { TransactionConsumer } from '../../src/infrastructure/messaging/transaction-consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { PostgresOutboxStore } from '../../src/infrastructure/persistence/outbox-store';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { MessagingMetrics } from '../../src/infrastructure/observability/messaging-metrics';

const config = loadConfig();
if (config.nodeEnv !== 'test' || !/^jungle_wagering_test_messaging_/.test(config.database.name)) throw new Error('IsolatedMessagingTestRequired');
const mode = process.argv[2];
const orm = await MikroORM.init({ ...ormOptions(config), connect: true });
const uow = new PostgresFinancialUnitOfWork(orm);
const client = createSqsClient(config, true);
const logger = new JsonLogger('error');
const metrics = new MessagingMetrics();
const injected: FinancialUnitOfWork = {
  readSnapshot: (work) => uow.readSnapshot(work),
  write: (work) => uow.write(async (session) => {
    await work(session);
    process.stdout.write(JSON.stringify({ event: 'before_commit_failure' }) + '\n');
    throw new FinancialError('PERSISTENCE_UNAVAILABLE');
  }),
};
const uncertain: FinancialUnitOfWork = {
  readSnapshot: (work) => uow.readSnapshot(work),
  write: async (work) => { await uow.write(work); throw new FinancialError('PERSISTENCE_UNAVAILABLE'); },
};
const worker = mode?.includes('publisher')
  ? new OutboxPublisher(config, client, new PostgresOutboxStore(orm), metrics, logger,
    mode === 'crash-publisher' ? { afterSend: async (event) => {
      process.stdout.write(JSON.stringify({ event: 'after_send_crash', eventId: event.id }) + '\n');
      process.kill(process.pid, 'SIGKILL');
    } } : {})
  : new TransactionConsumer(config, client, new FinancialService(mode === 'rollback-consumer' ? injected
    : mode === 'uncertain-consumer' ? uncertain : uow),
    metrics, logger, mode === 'crash-consumer' ? { afterCommit: async (message) => {
      process.stdout.write(JSON.stringify({ event: 'after_commit_crash', messageId: message.messageId }) + '\n');
      process.kill(process.pid, 'SIGKILL');
    } } : {});
const stop = () => worker.stop();
process.on('SIGTERM', stop);
let begin!: () => void;
const started = new Promise<void>((resolve) => { begin = resolve; });
const input = (async () => {
  for await (const chunk of Bun.stdin.stream()) {
    if (new TextDecoder().decode(chunk).trim() === 'start') begin();
    else { begin(); stop(); break; }
  }
})();
void input;
const pid = await orm.em.fork().execute<Array<{ pid: number }>>('select pg_backend_pid() as pid');
process.stdout.write(JSON.stringify({ event: 'ready', pid: process.pid, backendPid: pid[0]!.pid }) + '\n');
try {
  if (process.env['MESSAGING_TEST_START_PAUSED'] === '1') await started;
  await worker.run();
}
finally {
  client.destroy(); await orm.close(true);
  process.stdout.write(JSON.stringify({ event: 'stopped', pid: process.pid, metrics: metrics.snapshot() }) + '\n');
  process.exit(0);
}
