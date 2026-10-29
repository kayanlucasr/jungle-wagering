import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/infrastructure/config/environment';
import { ormOptions } from '../src/infrastructure/persistence/orm-options';
import { provisionAccess } from '../src/infrastructure/persistence/provision-access';

// Explicit administrative command, not an application startup action.
if (process.env['ALLOW_DATABASE_BOOTSTRAP'] !== '1') throw new Error('DatabaseBootstrapRequiresOptIn');
const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`Missing ${key}`); return value; };
const migrations = { name: required('MIGRATION_DB_USER'), password: required('MIGRATION_DB_PASSWORD') };
const runtime = { name: required('RUNTIME_DB_USER'), password: required('RUNTIME_DB_PASSWORD') };
const config = loadConfig({ ...process.env, DB_USER: required('ADMIN_DB_USER'), DB_PASSWORD: required('ADMIN_DB_PASSWORD') });
const admin = await MikroORM.init({ ...ormOptions(config), connect: true });
try {
  // Foundation must precede ownership transfer. Never run financial migration as admin.
  const migrator = admin.getMigrator();
  const executed = await migrator.getExecutedMigrations();
  if (!executed.some((migration) => migration.name === 'Migration20261028000100')) {
    await migrator.up({ to: 'Migration20261028000100' });
  }
  await provisionAccess(admin, migrations, runtime);
  console.log(JSON.stringify({ event: 'database_access_provisioned' }));
} catch (error: unknown) {
  // Driver DDL errors can contain PASSWORD literals. Do not emit raw errors.
  console.error(JSON.stringify({ event: 'database_bootstrap_failed',
    errorName: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
} finally { await admin.close(true); }
