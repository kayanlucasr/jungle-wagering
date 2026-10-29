import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/infrastructure/config/environment';
import { ormOptions } from '../../src/infrastructure/persistence/orm-options';
import { PostgresFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial-unit-of-work';
import { FinancialService } from '../../src/application/financial/financial-service';
import type { SubmitTransaction } from '../../src/application/financial/payload-hash';

// Child-process integration harness; never part of production entrypoints/build.
const orm = await MikroORM.init({ ...ormOptions(loadConfig()), connect: true });
try {
  const service = new FinancialService(new PostgresFinancialUnitOfWork(orm));
  const commands = JSON.parse(await Bun.stdin.text()) as SubmitTransaction[];
  const identity = await orm.em.execute<Array<{ pid: number }>>('select pg_backend_pid() as pid');
  const results = await Promise.all(commands.map((command) => service.submit(command)));
  console.log(JSON.stringify({ processId: process.pid, backendPid: identity[0]!.pid, results }));
} catch (error: unknown) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
} finally { await orm.close(true); }
