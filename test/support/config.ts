import { loadConfig } from '../../src/infrastructure/config/environment';

export const testEnvironment: Readonly<Record<string, string>> = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'error',
  DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'jungle_wagering_test',
  DB_USER: 'test', DB_PASSWORD: 'do_not_log_this_password', DB_POOL_MAX: '2',
  DEPENDENCY_TIMEOUT_MS: '300', AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'do_not_log_this_secret',
  SQS_ENDPOINT: 'http://127.0.0.1:1',
};

export function fixtureConfig(overrides: Record<string, string> = {}) {
  return loadConfig({ ...testEnvironment, ...overrides });
}
