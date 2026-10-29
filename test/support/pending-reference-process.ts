import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/infrastructure/config/environment';
import { ormOptions } from '../../src/infrastructure/persistence/orm-options';
import { PostgresFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial-unit-of-work';
import type { FinancialUnitOfWork } from '../../src/application/financial/ports';
import { FinancialService } from '../../src/application/financial/financial-service';
import { ReferenceScheduler } from '../../src/infrastructure/pending-reference/reference-scheduler';
import { PendingReferenceMetrics } from '../../src/infrastructure/observability/pending-reference-metrics';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';

const config = loadConfig();
if (config.nodeEnv !== 'test' || !/^jungle_wagering_test_pending_/.test(config.database.name)) throw new Error('IsolatedPendingTestRequired');
const mode = process.argv[2] ?? 'normal';
const orm = await MikroORM.init({ ...ormOptions(config), connect: true });
const real = new PostgresFinancialUnitOfWork(orm);
const announce = (event: string, fields = {}) => process.stdout.write(JSON.stringify({ event, ...fields }) + '\n');
const injected: FinancialUnitOfWork = {
  readSnapshot: (work) => real.readSnapshot(work),
  write: async (work) => {
    const result = await real.write(async (session) => {
      const value = await work({ ...session, pendingReferences: {
        activeCount: () => session.pendingReferences.activeCount(),
        claim: async (at, timeout) => {
          const claim = await session.pendingReferences.claim(at, timeout);
          if (claim && ['crash-claim', 'pause-claim'].includes(mode)) {
            announce('claimed', { transactionId: claim.transaction.id });
            if (mode === 'crash-claim') process.kill(process.pid, 'SIGKILL');
            await new Promise<void>(() => {});
          }
          return claim;
        },
      } });
      if (value !== undefined && mode === 'crash-before') { announce('before_commit'); process.kill(process.pid, 'SIGKILL'); }
      return value;
    });
    if (result !== undefined && mode === 'crash-after') { announce('after_commit'); process.kill(process.pid, 'SIGKILL'); }
    return result;
  },
};
const metrics = new PendingReferenceMetrics();
const worker = new ReferenceScheduler(new FinancialService(injected, config.pendingReference), config.pendingReference,
  metrics, new JsonLogger('info'));
let begin!: () => void;
const gate = new Promise<void>((resolve) => { begin = resolve; });
process.once('SIGTERM', () => { begin(); worker.stop(); });
void (async () => {
  for await (const chunk of Bun.stdin.stream()) {
    if (new TextDecoder().decode(chunk).trim() === 'start') begin();
    else { begin(); worker.stop(); break; }
  }
})();
const backend = await orm.em.fork().execute<Array<{ pid: number }>>('select pg_backend_pid() as pid');
announce('ready', { pid: process.pid, backendPid: backend[0]!.pid });
try {
  if (process.env['PENDING_TEST_START_PAUSED'] === '1') await gate;
  await worker.run();
} finally { await orm.close(true); announce('stopped', { metrics: metrics.snapshot() }); process.exit(0); }
