export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly user: string;
    readonly password: string;
    readonly poolMax: number;
  };
  readonly dependencyTimeoutMs: number;
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly queueName: string;
    readonly dlqName: string;
    readonly maxReceiveCount: number;
    readonly visibilityTimeoutSeconds: number;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
type Environment = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  constructor(readonly variables: readonly string[]) {
    super(`Invalid configuration: ${variables.join(', ')}`);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(env: Environment = process.env): AppConfig {
  const invalid = new Set<string>();
  const text = (name: string, fallback?: string): string => {
    const value = env[name] ?? fallback;
    if (value === undefined || value.trim() === '') {
      invalid.add(name);
      return '';
    }
    return value;
  };
  const integer = (name: string, fallback: string, min: number, max: number): number => {
    const value = text(name, fallback);
    if (!/^\d+$/.test(value)) invalid.add(name);
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) invalid.add(name);
    return result;
  };
  const nodeEnv = text('NODE_ENV', 'development');
  if (!['development', 'test', 'production'].includes(nodeEnv)) invalid.add('NODE_ENV');
  const logLevel = text('LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) invalid.add('LOG_LEVEL');
  const endpoint = text('SQS_ENDPOINT');
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      invalid.add('SQS_ENDPOINT');
    }
  } catch { invalid.add('SQS_ENDPOINT'); }
  const queueName = text('SQS_QUEUE_NAME', 'wager-transactions.fifo');
  const dlqName = text('SQS_DLQ_NAME', 'wager-transactions-dlq.fifo');
  for (const [key, value] of [['SQS_QUEUE_NAME', queueName], ['SQS_DLQ_NAME', dlqName]]) {
    if (value === undefined || !/^[A-Za-z0-9_-]{1,75}\.fifo$/.test(value)) invalid.add(key!);
  }
  if (queueName === dlqName) invalid.add('SQS_DLQ_NAME');
  const name = text('DB_NAME');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) invalid.add('DB_NAME');
  const config: AppConfig = {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    host: text('HOST', '0.0.0.0'),
    port: integer('PORT', '3000', 0, 65535),
    logLevel: logLevel as AppConfig['logLevel'],
    database: {
      host: text('DB_HOST'), port: integer('DB_PORT', '5432', 1, 65535),
      name, user: text('DB_USER'), password: text('DB_PASSWORD'),
      poolMax: integer('DB_POOL_MAX', '10', 1, 100),
    },
    dependencyTimeoutMs: integer('DEPENDENCY_TIMEOUT_MS', '2000', 100, 10000),
    sqs: {
      endpoint, region: text('AWS_REGION'), accessKeyId: text('AWS_ACCESS_KEY_ID'),
      secretAccessKey: text('AWS_SECRET_ACCESS_KEY'), queueName, dlqName,
      maxReceiveCount: integer('SQS_MAX_RECEIVE_COUNT', '5', 1, 1000),
      visibilityTimeoutSeconds: integer('SQS_VISIBILITY_TIMEOUT_SECONDS', '30', 1, 43200),
    },
  };
  if (invalid.size > 0) throw new ConfigurationError([...invalid].sort());
  Object.freeze(config.database);
  Object.freeze(config.sqs);
  return Object.freeze(config);
}
