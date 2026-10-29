import { describe, expect, test } from 'bun:test';
import { ConfigurationError, loadConfig } from '../../src/infrastructure/config/environment';
import { fixtureConfig, testEnvironment } from '../support/config';

describe('environment validation', () => {
  test('loads valid environment, defaults and immutable config', () => {
    const config = fixtureConfig();
    expect(config.sqs.queueName).toBe('wager-transactions.fifo');
    expect(config.sqs.maxReceiveCount).toBe(5);
    expect(config.database.name).toBe('jungle_wagering_test');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.sqs)).toBe(true);
  });

  test('reports variable names without their sensitive values', () => {
    try {
      loadConfig({ ...testEnvironment, DB_PASSWORD: '', SQS_ENDPOINT: 'http://user:secret@localhost' });
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const message = (error as Error).message;
      expect(message).toContain('DB_PASSWORD');
      expect(message).toContain('SQS_ENDPOINT');
      expect(message).not.toContain('secret');
      expect(message).not.toContain('do_not_log');
    }
  });

  for (const [name, value] of [
    ['NODE_ENV', 'invalid'], ['LOG_LEVEL', 'verbose'], ['DB_PORT', '1.5'],
    ['DB_POOL_MAX', '0'], ['DEPENDENCY_TIMEOUT_MS', '0'], ['PORT', '65536'],
    ['SQS_QUEUE_NAME', 'standard'], ['SQS_DLQ_NAME', 'wager-transactions.fifo'],
    ['SQS_MAX_RECEIVE_COUNT', '-1'], ['SQS_VISIBILITY_TIMEOUT_SECONDS', '43201'],
    ['AWS_REGION', ''], ['DB_NAME', 'unsafe;drop'], ['SQS_ENDPOINT', 'file:///tmp'],
    ['SQS_ENDPOINT', 'http://localhost:4566?secret=token'],
  ] as const) {
    test(`rejects invalid ${name} (${value})`, () => {
      expect(() => fixtureConfig({ [name]: value })).toThrow(ConfigurationError);
    });
  }

  test('requires connection credentials explicitly', () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
  });
});
