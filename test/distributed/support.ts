import assert from 'node:assert/strict';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/infrastructure/config/environment';
import { ormOptions } from '../../src/infrastructure/persistence/orm-options';
import { FinancialService } from '../../src/application/financial/financial-service';
import { PostgresFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial-unit-of-work';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.service';
import { walletGroup, type CommandEnvelope } from '../../src/application/messaging/command-envelope';
import type { SubmitTransaction } from '../../src/application/financial/payload-hash';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind';

export { assert, Kind };
export const config = loadConfig();
if (config.nodeEnv !== 'test' || config.database.name !== 'jungle_wagering_test_distributed'
  || config.database.host !== 'postgres' || process.env['DISTRIBUTED_TEST_APPROVED'] !== '1') {
  throw new Error('ExclusiveDistributedTestEnvironmentRequired');
}
export const runtime = await MikroORM.init({ ...ormOptions(config), connect: true });
export const admin = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env,
  DB_USER: process.env['ADMIN_DB_USER'], DB_PASSWORD: process.env['ADMIN_DB_PASSWORD'] })), connect: true });
export const service = new FinancialService(new PostgresFinancialUnitOfWork(runtime), config.pendingReference);
export const client = createSqsClient(config, true);
export const id = () => crypto.randomUUID();
export interface Wallet { id: string; playerId: string; balance: { amount: string; currency: string }; version: string }
export interface Result { transactionId: string; status: string; failureCode?: string; balance?: { amount: string }; idempotentReplay: boolean }
export async function sql<T extends object>(query: string, params: unknown[] = []): Promise<T[]> {
  return runtime.em.fork().execute<T[]>(query, params);
}
export async function until(fn: () => Promise<boolean>, timeout = 30000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await Bun.sleep(50); }
  throw new Error('DistributedConditionTimeout');
}
export async function http<T>(path: string, body?: unknown, key?: string, replica = 0) {
  const response = await fetch(`http://app${replica % 3 + 1}:3000${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() as T };
}
export async function wallet(amount = '100.00', replica = 0): Promise<Wallet> {
  const r = await http<Wallet>('/wallets', { playerId: id(), initialBalance: { amount, currency: 'BRL' } }, undefined, replica);
  assert.equal(r.status, 201); return r.body;
}
export function command(w: Wallet, overrides: Partial<SubmitTransaction> = {}): SubmitTransaction {
  return { providerId: 'stage7', externalTransactionId: id(), idempotencyKey: id(), walletId: w.id, playerId: w.playerId,
    roundId: 'stage7-round', gameId: 'stage7-game', kind: Kind.Bet, money: { amount: '10.00', currency: 'BRL' }, ...overrides };
}
export async function submit(c: SubmitTransaction, replica = 0) {
  const { idempotencyKey, ...body } = c;
  return http<Result>('/wagering/transactions', body, idempotencyKey, replica);
}
export async function check(w: Wallet, balance: string, ledgerCount?: number) {
  const result = await service.reconcile(w.id);
  assert.equal(result.consistent, true); assert.equal(result.storedBalance, balance);
  if (ledgerCount !== undefined) assert.equal(result.entryCount, String(ledgerCount));
  return result;
}
export async function envelope(c: SubmitTransaction): Promise<CommandEnvelope> {
  return { type: 'WagerTransactionRequested', version: 1, messageId: id(), correlationId: id(), occurredAt: new Date().toISOString(), data: c };
}
export async function send(e: CommandEnvelope, dedup = id()) {
  const queue = await client.send(new GetQueueUrlCommand({ QueueName: config.sqs.queueName }));
  const result = await client.send(new SendMessageCommand({ QueueUrl: queue.QueueUrl!, MessageBody: JSON.stringify(e),
    MessageGroupId: walletGroup(e.data.walletId), MessageDeduplicationId: dedup }));
  assert.ok(result.MessageId); return result.MessageId;
}
export async function inboxDone(messageId: string) {
  await until(async () => (await sql<{ count: string }>(`select count(*)::text as count from wagering.inbox_messages
    where consumer_name = 'wager-transactions-v1' and message_id = ? and processed_at is not null`, [messageId]))[0]!.count === '1');
}
export async function outboxEmpty() {
  await until(async () => (await sql<{ count: string }>('select count(*)::text as count from wagering.outbox_messages where published_at is null'))[0]!.count === '0');
}
export async function close() { client.destroy(); await runtime.close(true); await admin.close(true); }
