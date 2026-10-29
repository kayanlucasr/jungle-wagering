import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/infrastructure/config/environment';
import { ormOptions } from '../src/infrastructure/persistence/orm-options';
import { JsonLogger } from '../src/infrastructure/observability/json-logger';

const logger = new JsonLogger();
const action = process.argv[2];
if (!['up', 'down', 'status'].includes(action ?? '')) {
  throw new Error('Usage: bun scripts/migrate.ts up|down|status');
}
const config = loadConfig({ ...process.env,
  DB_USER: process.env['MIGRATION_DB_USER'] ?? process.env['DB_USER'],
  DB_PASSWORD: process.env['MIGRATION_DB_PASSWORD'] ?? process.env['DB_PASSWORD'] });
if (action === 'down' && (process.env['ALLOW_MIGRATION_DOWN'] !== '1' ||
    config.nodeEnv !== 'test' || !/^jungle_wagering_test(?:_|$)/.test(config.database.name))) {
  throw new Error('Rollback requires ALLOW_MIGRATION_DOWN=1, NODE_ENV=test and an isolated jungle_wagering_test database');
}
const orm = await MikroORM.init({ ...ormOptions(config, true), connect: true });
try {
  const migrator = orm.getMigrator();
  if (action === 'up') {
    await migrator.up();
    logger.write('info', 'migrations_applied');
  } else if (action === 'down') {
    await migrator.down();
    logger.write('info', 'migration_reverted');
  } else {
    const pending = await migrator.getPendingMigrations();
    console.log(JSON.stringify({ pending: pending.map((migration) => migration.name) }));
  }
} finally {
  await orm.close(true);
}
