import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { RequestContext } from '@mikro-orm/core';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { AppConfig } from '../config/environment';
import { ormOptions } from './orm-options';

export class DatabaseService implements OnApplicationShutdown {
  private constructor(readonly orm: MikroORM) {}

  static async create(config: AppConfig): Promise<DatabaseService> {
    return new DatabaseService(await MikroORM.init(ormOptions(config)));
  }

  requestContext(next: () => void): void {
    RequestContext.create(this.orm.em, next);
  }

  async transaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    // A fresh identity map per operation; financial commands use PostgresFinancialUnitOfWork.
    return this.orm.em.fork().transactional(work);
  }

  async checkReady(): Promise<void> {
    const result = await this.orm.em.fork().getConnection().execute<Array<{ ready: boolean }>>(
      "select exists(select 1 from pg_namespace where nspname = 'wagering') as ready",
    );
    if (result[0]?.ready !== true) throw new Error('SchemaNotMigrated');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
