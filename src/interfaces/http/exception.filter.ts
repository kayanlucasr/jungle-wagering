import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JsonLogger } from '../../infrastructure/observability/json-logger';
import { DomainError, FailureCode } from '../../domain/errors/domain-error';
import { FinancialError } from '../../application/financial/errors';
import { RequestValidationError } from './financial-dtos';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const mapped = mapException(exception);
    const { status, code } = mapped;
    const correlationId = response.getHeader('x-correlation-id')?.toString() ?? crypto.randomUUID();
    const requestId = response.getHeader('x-request-id')?.toString() ?? crypto.randomUUID();
    this.logger.write(status >= 500 ? 'error' : 'warn', 'http_request_failed', {
      correlationId, requestId, method: request.method, statusCode: status,
      errorName: exception instanceof Error ? exception.name : 'UnknownError',
    });
    // Health responses expose only dependency states, never raw driver exceptions.
    if (exception instanceof HttpException && request.path === '/health/ready' && status === 503) {
      response.status(status).json({ ...asRecord(exception.getResponse()), correlationId, requestId });
      return;
    }
    response.status(status).json({ statusCode: status, code, correlationId, requestId,
      ...(exception instanceof RequestValidationError ? { fields: exception.fields } : {}) });
  }
}

function mapException(exception: unknown): { status: number; code: string } {
  if (exception instanceof FinancialError) {
    if (exception.code === 'IDEMPOTENCY_CONFLICT' || exception.code === 'WALLET_ALREADY_EXISTS') return { status: 409, code: exception.code };
    if (exception.code === 'TRANSACTION_NOT_FOUND') return { status: 404, code: exception.code };
    if (exception.code === 'INVALID_CURSOR') return { status: 400, code: exception.code };
    if (exception.code === 'PERSISTENCE_UNAVAILABLE') return { status: 503, code: 'TEMPORARILY_UNAVAILABLE' };
    return { status: 500, code: 'INTERNAL_ERROR' };
  }
  if (exception instanceof DomainError) {
    if (exception.code === FailureCode.WalletNotFound) return { status: 404, code: exception.code };
    const invalid = [FailureCode.InvalidAmount, FailureCode.AmountOutOfRange, FailureCode.CurrencyMismatch,
      FailureCode.InvalidIdentifier, FailureCode.InvalidTimestamp, FailureCode.InvalidReference];
    if (invalid.includes(exception.code)) return { status: 400, code: exception.code };
    return { status: 500, code: 'INTERNAL_ERROR' };
  }
  const status = exception instanceof HttpException ? exception.getStatus() : 500;
  return { status, code: status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_REQUEST' :
    status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 503 ? 'TEMPORARILY_UNAVAILABLE' : 'INTERNAL_ERROR' };
}

function asRecord(value: string | object): Record<string, unknown> {
  return typeof value === 'object' ? value as Record<string, unknown> : {};
}
