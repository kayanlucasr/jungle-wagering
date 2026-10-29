import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { loadConfig, type AppConfig } from './infrastructure/config/environment';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { DatabaseService } from './infrastructure/persistence/database.service';
import { GlobalExceptionFilter } from './interfaces/http/exception.filter';
import { HttpMetrics } from './interfaces/http/http-metrics';
import { PostgresFinancialUnitOfWork } from './infrastructure/persistence/financial-unit-of-work';

export async function createApplication(config: AppConfig = loadConfig()) {
  const logger = new JsonLogger(config.logLevel);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    logger, abortOnError: false, bodyParser: false,
  });
  app.disable('x-powered-by');
  const database = app.get(DatabaseService);
  const metrics = app.get(HttpMetrics);
  const report = setInterval(() => {
    logger.write('info', 'http_metrics', { metrics: metrics.snapshot() });
    logger.write('info', 'financial_metrics', { metrics: app.get(PostgresFinancialUnitOfWork).metrics.snapshot() });
  }, 10000);
  report.unref();
  // The Nest lifecycle also runs for app.close() in tests, not only OS signals.
  app.getHttpServer().once('close', () => clearInterval(report));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-correlation-id');
    const correlationId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
      ? incoming : crypto.randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    const requestId = crypto.randomUUID();
    res.setHeader('x-request-id', requestId);
    const startedAt = performance.now();
    res.on('finish', () => {
      const durationMs = Math.round(performance.now() - startedAt);
      metrics.requestCompleted(durationMs);
      logger.write('info', 'http_request_completed', {
        correlationId, requestId, method: req.method, operation: `${req.method} ${req.route?.path ?? 'unmatched'}`,
        result: String(res.statusCode), statusCode: res.statusCode, durationMs,
        ...res.locals['financialTrace'],
      });
    });
    database.requestContext(next);
  });
  app.useBodyParser('json', { limit: '64kb' });
  app.useGlobalFilters(new GlobalExceptionFilter(logger));
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  return app;
}
