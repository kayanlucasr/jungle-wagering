import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../../src/bootstrap';
import { fixtureConfig } from '../support/config';

describe('application bootstrap without available dependencies', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  beforeAll(async () => {
    app = await createApplication(fixtureConfig());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });

  test('starts and serves public liveness independently of PostgreSQL and SQS', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  test('propagates a safe correlation ID', async () => {
    const response = await fetch(`${baseUrl}/health/live`, { headers: { 'x-correlation-id': 'test-request-123' } });
    expect(response.headers.get('x-correlation-id')).toBe('test-request-123');
  });

  test('replaces an invalid correlation ID', async () => {
    const response = await fetch(`${baseUrl}/health/live`, { headers: { 'x-correlation-id': 'invalid request id' } });
    expect(response.headers.get('x-correlation-id')).toMatch(/^[a-f0-9-]{36}$/);
  });

  test('returns 503 when real driver connections cannot reach either dependency', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      status: 'unavailable', dependencies: { postgres: 'down', sqs: 'down' },
    });
    expect(body).not.toContain('do_not_log');
    expect(body).not.toContain('127.0.0.1');
  });

  test('maps unknown routes to a safe structured error', async () => {
    const response = await fetch(`${baseUrl}/unknown?password=sensitive`);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(body).not.toContain('sensitive');
  });

  test('maps malformed JSON to a 400 without echoing the payload', async () => {
    const response = await fetch(`${baseUrl}/unknown`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"secret":',
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(body).not.toContain('secret');
  });

  test('financial queries with unavailable PostgreSQL map infrastructure failure to 503', async () => {
    const response = await fetch(`${baseUrl}/wallets/wallet-unavailable`);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
    for (const internal of ['do_not_log', '127.0.0.1', 'stack', 'select ']) expect(body).not.toContain(internal);
  });
});
