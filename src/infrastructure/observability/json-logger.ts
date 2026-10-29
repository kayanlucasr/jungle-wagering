import type { LoggerService } from '@nestjs/common';
import type { AppConfig } from '../config/environment';

type Level = AppConfig['logLevel'];
interface LogFields {
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly messageId?: string;
  readonly transactionId?: string;
  readonly walletId?: string;
  readonly providerId?: string;
  readonly context?: string;
  readonly method?: string;
  readonly statusCode?: number;
  readonly durationMs?: number;
  readonly errorName?: string;
}
const priority: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class JsonLogger implements LoggerService {
  constructor(
    private readonly level: Level = 'info',
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  write(level: Level, event: string, fields: LogFields = {}): void {
    if (priority[level] < priority[this.level]) return;
    this.sink(JSON.stringify({
      timestamp: new Date().toISOString(), level, service: 'jungle-wagering',
      instanceId: process.env['HOSTNAME'] ?? String(process.pid), event, ...fields,
    }));
  }

  log(message: unknown, context?: string): void { this.framework('info', message, context); }
  error(message: unknown, _trace?: string, context?: string): void { this.framework('error', message, context); }
  warn(message: unknown, context?: string): void { this.framework('warn', message, context); }
  debug(message: unknown, context?: string): void { this.framework('debug', message, context); }
  verbose(message: unknown, context?: string): void { this.framework('debug', message, context); }
  fatal(message: unknown, context?: string): void { this.framework('error', message, context); }

  private framework(level: Level, message: unknown, context?: string): void {
    // Framework exceptions may contain SQL, request bodies or connection credentials.
    const event = typeof message === 'string' && level !== 'error'
      ? message.replace(/\u001b\[[0-9;]*m/g, '') : 'framework_error';
    this.write(level, event, context === undefined ? {} : { context });
  }
}
