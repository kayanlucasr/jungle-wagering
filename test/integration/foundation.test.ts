import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../../src/bootstrap';
import { loadConfig, type AppConfig } from '../../src/infrastructure/config/environment';
import { ormOptions } from '../../src/infrastructure/persistence/orm-options';
import { SqsService } from '../../src/infrastructure/messaging/sqs.service';
import { Migration20261028000100 } from '../../src/infrastructure/persistence/migrations/Migration20261028000100';
import { provisionAccess } from '../../src/infrastructure/persistence/provision-access';

describe('Stage 1 with real PostgreSQL and LocalStack', () => {
  let admin: MikroORM;
  let database: MikroORM;
  let config: AppConfig;
  let isolatedName: string;

  beforeAll(async () => {
    const initial = loadConfig();
    if (initial.nodeEnv !== 'test' || !/^jungle_wagering_test(?:_|$)/.test(initial.database.name)) {
      throw new Error('Integration tests require NODE_ENV=test and an isolated jungle_wagering_test database');
    }
    isolatedName = `jungle_wagering_test_stage1_${crypto.randomUUID().replaceAll('-', '')}`;
    admin = await MikroORM.init({ ...ormOptions(initial), connect: true });
    // The generated name contains only a fixed prefix and UUID hex; no external SQL identifier.
    await admin.em.getConnection().execute(`create database "${isolatedName}"`);
    config = loadConfig({ ...process.env, DB_NAME: isolatedName });
    const options = ormOptions(config);
    // Keep the original foundation regression isolated from financial migrations/roles.
    database = await MikroORM.init({ ...options, connect: true,
      migrations: { ...options.migrations, migrationsList: [Migration20261028000100] } });
  });

  afterAll(async () => {
    await database?.close(true);
    if (admin && /^jungle_wagering_test_stage1_[a-f0-9]{32}$/.test(isolatedName)) {
      await admin.em.getConnection().execute(`drop database "${isolatedName}"`);
    }
    await admin?.close(true);
  });

  async function schemaExists(): Promise<boolean> {
    const rows = await database.em.getConnection().execute<Array<{ present: boolean }>>(
      "select exists(select 1 from pg_namespace where nspname = 'wagering') as present",
    );
    return rows[0]?.present === true;
  }

  async function probe(overrides: Record<string, string> = {}) {
    const candidate = loadConfig({ ...process.env, DB_NAME: isolatedName, ...overrides });
    const app = await createApplication(candidate);
    try {
      await app.listen(0, '0.0.0.0');
      const address = app.getHttpServer().address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
      return { status: response.status, body: await response.json() };
    } finally { await app.close(); }
  }

  test('connects to PostgreSQL and executes a real transaction', async () => {
    const result = await database.em.fork().transactional(async (em) =>
      em.getConnection().execute<Array<{ value: string }>>("select 'connected'::text as value"));
    expect(result[0]?.value).toBe('connected');
  });

  test('runs versioned migrations up/down/up on a freshly created disposable database', async () => {
    expect(await schemaExists()).toBe(false);
    const migrator = database.getMigrator();
    await migrator.up();
    expect(await schemaExists()).toBe(true);
    expect(await migrator.getPendingMigrations()).toHaveLength(0);
    await migrator.down();
    expect(await schemaExists()).toBe(false);
    await migrator.up();
    expect(await schemaExists()).toBe(true);
    const tables = await database.em.getConnection().execute<Array<{ table_name: string }>>(
      "select table_name from information_schema.tables where table_schema = 'wagering'",
    );
    expect(tables).toHaveLength(0);
  });

  test('connects to SQS and verifies FIFO, DLQ ARN, redrive and visibility timeout', async () => {
    const sqs = new SqsService(config);
    try { await sqs.checkReady(); } finally { sqs.onApplicationShutdown(); }
  });

  test('schema-only database is not financially ready while liveness and SQS remain healthy', async () => {
    const result = await probe();
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ dependencies: { postgres: 'down', sqs: 'up' } });
  });

  test('serves public liveness and readiness with fully migrated real dependencies', async () => {
    await database.getMigrator().up();
    await provisionAccess(database, { name: 'foundation_migrator', password: 'isolated_foundation_migration' },
      { name: 'foundation_runtime', password: 'isolated_foundation_runtime' });
    const owner = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: isolatedName,
      DB_USER: 'foundation_migrator', DB_PASSWORD: 'isolated_foundation_migration' }), true), connect: true });
    try { await owner.getMigrator().up(); } finally { await owner.close(true); }
    let app: NestExpressApplication | undefined;
    try {
      app = await createApplication(config);
      await app.listen(0, '0.0.0.0');
      const address = app.getHttpServer().address() as { port: number };
      const base = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    } finally { await app?.close(); }
  });

  test('readiness fails for an unreachable PostgreSQL while real SQS stays healthy', async () => {
    const result = await probe({ DB_HOST: '127.0.0.1', DB_PORT: '1' });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ dependencies: { postgres: 'down', sqs: 'up' } });
  });

  test('readiness fails for an unreachable SQS while real PostgreSQL stays healthy', async () => {
    await database.getMigrator().up();
    const result = await probe({ SQS_ENDPOINT: 'http://127.0.0.1:1' });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ dependencies: { postgres: 'up', sqs: 'down' } });
  });

  test('readiness fails if required queues do not exist', async () => {
    const result = await probe({ SQS_QUEUE_NAME: `missing-${crypto.randomUUID()}.fifo` });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ dependencies: { sqs: 'down' } });
  });
});
