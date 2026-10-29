import { DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/environment';
import { DatabaseService } from './infrastructure/persistence/database.service';
import { SqsService } from './infrastructure/messaging/sqs.service';
import { HealthController } from './interfaces/http/health.controller';
import { FinancialService } from './application/financial/financial-service';
import { PostgresFinancialUnitOfWork } from './infrastructure/persistence/financial-unit-of-work';
import { FinancialQueryService } from './application/financial/financial-query-service';
import { WalletsController } from './interfaces/http/wallets.controller';
import { TransactionsController } from './interfaces/http/transactions.controller';
import { HttpMetrics } from './interfaces/http/http-metrics';
import { JsonLogger } from './infrastructure/observability/json-logger';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, TransactionsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DatabaseService, useFactory: () => DatabaseService.create(config) },
        { provide: PostgresFinancialUnitOfWork, inject: [DatabaseService],
          useFactory: (database: DatabaseService) => new PostgresFinancialUnitOfWork(database.orm) },
        { provide: FinancialService, inject: [PostgresFinancialUnitOfWork],
          useFactory: (unitOfWork: PostgresFinancialUnitOfWork) => new FinancialService(unitOfWork) },
        { provide: FinancialQueryService, inject: [PostgresFinancialUnitOfWork],
          useFactory: (unitOfWork: PostgresFinancialUnitOfWork) => new FinancialQueryService(unitOfWork) },
        { provide: HttpMetrics, useFactory: () => new HttpMetrics() },
        { provide: JsonLogger, useFactory: () => new JsonLogger(config.logLevel) },
        { provide: SqsService, useFactory: () => new SqsService(config) },
      ],
    };
  }
}
