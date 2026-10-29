import { expect, test } from 'bun:test';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';

test('writes JSON and respects the configured minimum log level', () => {
  const lines: string[] = [];
  const logger = new JsonLogger('info', (line) => lines.push(line));
  logger.debug('not_emitted');
  logger.write('info', 'request_finished', { correlationId: 'request-1', statusCode: 200 });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    level: 'info', event: 'request_finished', correlationId: 'request-1', statusCode: 200,
  });
});

test('never serializes framework exception objects or traces', () => {
  const lines: string[] = [];
  const logger = new JsonLogger('debug', (line) => lines.push(line));
  logger.error(new Error('postgres://user:password@host/database'), 'sensitive trace');
  logger.error('sensitive error string');
  expect(lines.join('')).not.toContain('password');
  expect(lines.join('')).not.toContain('sensitive');
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'framework_error' });
});
