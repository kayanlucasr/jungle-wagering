import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../config/environment';
import { Migration20261028000100 } from './migrations/Migration20261028000100';
import { Migration20261028000200 } from './migrations/Migration20261028000200';
import { financialEntities } from './entities/financial-records';

export function ormOptions(config: AppConfig, migrationOwner = false) {
  return defineConfig({
    host: config.database.host,
    port: config.database.port,
    dbName: config.database.name,
    user: config.database.user,
    password: config.database.password,
    entities: financialEntities,
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    connect: false,
    ensureDatabase: false,
    debug: false,
    pool: { min: 0, max: config.database.poolMax, acquireTimeoutMillis: config.dependencyTimeoutMs },
    driverOptions: { connection: {
      connectionTimeoutMillis: config.dependencyTimeoutMs,
      statement_timeout: config.dependencyTimeoutMs,
      lock_timeout: config.dependencyTimeoutMs,
      application_name: 'jungle-wagering',
      ...(migrationOwner ? { options: '-c role=wagering_owner' } : {}),
    } },
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: [Migration20261028000100, Migration20261028000200],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      disableForeignKeys: false,
    },
  });
}
