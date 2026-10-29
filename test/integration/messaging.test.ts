import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueUrlCommand, ReceiveMessageCommand,
  SendMessageCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig, type AppConfig } from '../../src/infrastructure/config/environment';
import { ormOptions } from '../../src/infrastructure/persistence/orm-options';
import { provisionAccess } from '../../src/infrastructure/persistence/provision-access';
import { PostgresFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial-unit-of-work';
import { FinancialService } from '../../src/application/financial/financial-service';
import type { SubmitTransaction } from '../../src/application/financial/payload-hash';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/wager-transaction-status';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.service';
import { initializeQueues } from '../../src/infrastructure/messaging/queue-setup';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { PostgresOutboxStore } from '../../src/infrastructure/persistence/outbox-store';
import { CONSUMER_NAME } from '../../src/infrastructure/messaging/transaction-consumer';
import { walletGroup, type CommandEnvelope, commandHash } from '../../src/application/messaging/command-envelope';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { PostgresInboxRepository } from '../../src/infrastructure/persistence/repositories/message-repositories';
import { createHash } from 'node:crypto';

const id = () => crypto.randomUUID();
interface Notice { event: string; pid?: number; backendPid?: number; eventId?: string; metrics?: Record<string, number> }
interface Replica { child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>; notices: Notice[];
  output: Promise<void>; stderr: Promise<string>; ready: Notice; stopped: boolean }

describe('Stage 5 distributed messaging on PostgreSQL and LocalStack FIFO', () => {
  let admin: MikroORM; let databaseAdmin: MikroORM; let owner: MikroORM; let runtime: MikroORM;
  let databaseName: string; let config: AppConfig; let client: SQSClient; let service: FinancialService;
  let sourceUrl: string; let eventsUrl: string; let dlqUrl: string;
  let store: PostgresOutboxStore;
  const replicas: Replica[] = [];
  const log = new JsonLogger('error');
  const login = { name: 'stage5_runtime', password: 'isolated_stage5_runtime' };
  const migrator = { name: 'stage5_migrator', password: 'isolated_stage5_migrator' };

  test('stage7 real FIFO deduplication, long polling, visibility and redelivery attributes', async () => {
    const created = await client.send(new CreateQueueCommand({ QueueName: `stage7-protocol-${id()}.fifo`,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '2', ReceiveMessageWaitTimeSeconds: '1' } }));
    const QueueUrl = created.QueueUrl!; const group = walletGroup(id()); const dedup = id();
    try {
      const input = { QueueUrl, MessageBody: 'protocol fixture', MessageGroupId: group, MessageDeduplicationId: dedup };
      const first = await client.send(new SendMessageCommand(input)); const duplicate = await client.send(new SendMessageCommand(input));
      expect(first.MessageId).toBe(duplicate.MessageId);
      const received = await client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['All'] }));
      expect(received.Messages).toHaveLength(1); const message = received.Messages![0]!;
      expect(message.Attributes?.['MessageGroupId']).toBe(group); expect(message.Attributes?.['MessageDeduplicationId']).toBe(dedup);
      expect(message.Attributes?.['ApproximateReceiveCount']).toBe('1');
      const hidden = await client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }));
      expect(hidden.Messages ?? []).toHaveLength(0);
      await Bun.sleep(1100);
      const redelivery = await client.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['All'] }));
      expect(redelivery.Messages).toHaveLength(1); expect(redelivery.Messages![0]!.MessageId).toBe(message.MessageId);
      expect(redelivery.Messages![0]!.Attributes?.['ApproximateReceiveCount']).toBe('2');
      await client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: redelivery.Messages![0]!.ReceiptHandle! }));
      const started = performance.now();
      const empty = await client.send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 1 }));
      expect(empty.Messages ?? []).toHaveLength(0); expect(performance.now() - started).toBeGreaterThanOrEqual(800);
      console.log(JSON.stringify({ scenario: 'fifo_protocol', deduplication: true, visibility: true, redeliveryCount: 2, longPolling: true }));
    } finally { await client.send(new DeleteQueueCommand({ QueueUrl })); }
  });

  async function until<T>(fn: () => Promise<T | undefined | false>, timeout = 15000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await fn(); if (value !== undefined && value !== false) return value;
      await Bun.sleep(30);
    }
    throw new Error('MessagingConditionTimedOut');
  }
  async function scalar(sql: string, values: unknown[] = []): Promise<string> {
    const rows = await runtime.em.fork().execute<Array<{ value: string }>>(sql, values);
    return rows[0]!.value;
  }
  async function wallet(balance = '100.00') {
    const w = { walletId: id(), playerId: id() };
    await service.openWallet({ id: w.walletId, playerId: w.playerId, initialBalance: { amount: balance, currency: 'BRL' } });
    return w;
  }
  function command(w: { walletId: string; playerId: string }, overrides: Partial<SubmitTransaction> = {}): CommandEnvelope {
    return { messageId: id(), type: 'WagerTransactionRequested', version: 1, occurredAt: new Date().toISOString(),
      correlationId: id(), data: { ...w, providerId: 'provider-a', externalTransactionId: id(), idempotencyKey: id(),
        roundId: 'round-a', gameId: 'game-a', kind: Kind.Bet, money: { amount: '10.00', currency: 'BRL' }, ...overrides } };
  }
  async function send(e: CommandEnvelope, dedup = id()): Promise<void> {
    await client.send(new SendMessageCommand({ QueueUrl: sourceUrl, MessageBody: JSON.stringify(e),
      MessageGroupId: walletGroup(e.data.walletId), MessageDeduplicationId: dedup }));
  }
  async function done(e: CommandEnvelope): Promise<void> {
    await until(async () => (await scalar(`select count(*)::text as value from wagering.inbox_messages
      where consumer_name = ? and message_id = ? and processed_at is not null`, [CONSUMER_NAME, e.messageId])) === '1');
  }
  async function balance(walletId: string, amount: string, debits: string): Promise<void> {
    const result = await service.reconcile(walletId);
    expect(result.consistent).toBe(true); expect(result.storedBalance).toBe(amount);
    expect(await scalar(`select count(*)::text as value from wagering.wallet_ledger_entries
      where wallet_id = ? and direction = 'DEBIT'`, [walletId])).toBe(debits);
  }
  async function spawn(mode = 'consumer', overrides: Record<string, string> = {}): Promise<Replica> {
    const production = mode.startsWith('production-');
    const child = Bun.spawn(production ? [process.execPath, 'dist/src/workers/main.js', mode.slice('production-'.length)]
      : [process.execPath, 'test/support/messaging-process.ts', mode], {
      env: { ...process.env, DB_NAME: databaseName, DB_USER: login.name, DB_PASSWORD: login.password,
        SQS_QUEUE_NAME: config.sqs.queueName, SQS_DLQ_NAME: config.sqs.dlqName,
        SQS_EVENTS_QUEUE_NAME: config.sqs.eventsQueueName, SQS_EVENTS_DLQ_NAME: config.sqs.eventsDlqName,
        SQS_WAIT_SECONDS: '1', SQS_VISIBILITY_TIMEOUT_SECONDS: '2', SQS_MAX_RECEIVE_COUNT: '3',
        CONSUMER_CONCURRENCY: '1', MESSAGING_RETRY_BASE_SECONDS: '1', MESSAGING_RETRY_CAP_SECONDS: '2',
        OUTBOX_LEASE_SECONDS: '3', OUTBOX_POLL_MS: '50', DEPENDENCY_TIMEOUT_MS: '1000',
        LOG_LEVEL: production ? 'info' : 'error', ...overrides },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const notices: Notice[] = [];
    const output = (async () => {
      const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let pending = '';
      try {
        while (true) {
          const value = await reader.read(); if (value.done) break;
          pending += decoder.decode(value.value, { stream: true });
          let end: number;
          while ((end = pending.indexOf('\n')) >= 0) {
            notices.push(JSON.parse(pending.slice(0, end)) as Notice); pending = pending.slice(end + 1);
          }
        }
      } finally { reader.releaseLock(); }
    })();
    const replica: Replica = { child, notices, output, stderr: new Response(child.stderr).text(), ready: { event: 'pending' }, stopped: false };
    replicas.push(replica);
    replica.ready = await until(async () => notices.find((notice) => notice.event === 'ready' || notice.event === 'worker_started'));
    return replica;
  }
  async function stop(replica: Replica): Promise<void> {
    if (replica.stopped) return;
    replica.stopped = true;
    replica.child.kill('SIGTERM');
    const timer = setTimeout(() => replica.child.kill('SIGKILL'), 5000);
    try {
      expect(await replica.child.exited).toBe(0); await replica.output;
      expect(await replica.stderr).toBe('');
    } finally { clearTimeout(timer); }
  }
  async function receive(url: string): Promise<Message | undefined> {
    const result = await client.send(new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 1,
      MaxNumberOfMessages: 1, MessageSystemAttributeNames: ['All'], MessageAttributeNames: ['All'] }));
    return result.Messages?.[0];
  }
  async function drain(): Promise<void> {
    const publisher = new OutboxPublisher(config, client, store, undefined, log);
    for (let iteration = 0; iteration < 200; iteration += 1) { if (await publisher.tick() === 0) break; }
  }

  beforeAll(async () => {
    const initial = loadConfig();
    if (initial.nodeEnv !== 'test' || !/^jungle_wagering_test(?:_|$)/.test(initial.database.name)) throw new Error('IsolatedDatabaseRequired');
    databaseName = `jungle_wagering_test_messaging_${id().replaceAll('-', '')}`;
    admin = await MikroORM.init({ ...ormOptions(initial), connect: true });
    await admin.em.execute(`create database "${databaseName}"`);
    const configAdmin = loadConfig({ ...process.env, DB_NAME: databaseName });
    databaseAdmin = await MikroORM.init({ ...ormOptions(configAdmin), connect: true });
    await databaseAdmin.getMigrator().up({ to: 'Migration20261028000100' });
    await provisionAccess(databaseAdmin, migrator, login);
    owner = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: databaseName,
      DB_USER: migrator.name, DB_PASSWORD: migrator.password }), true), connect: true });
    await owner.getMigrator().up();
    expect(await owner.getMigrator().getPendingMigrations()).toHaveLength(0);
    runtime = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: databaseName,
      DB_USER: login.name, DB_PASSWORD: login.password })), connect: true });
    service = new FinancialService(new PostgresFinancialUnitOfWork(runtime)); store = new PostgresOutboxStore(runtime);
  }, 30000);
  beforeEach(async () => {
    const suffix = id();
    config = loadConfig({ ...process.env, DB_NAME: databaseName, DB_USER: login.name, DB_PASSWORD: login.password,
      SQS_QUEUE_NAME: `commands-${suffix}.fifo`, SQS_DLQ_NAME: `commands-dlq-${suffix}.fifo`,
      SQS_EVENTS_QUEUE_NAME: `events-${suffix}.fifo`, SQS_EVENTS_DLQ_NAME: `events-dlq-${suffix}.fifo`,
      SQS_WAIT_SECONDS: '1', SQS_VISIBILITY_TIMEOUT_SECONDS: '2', SQS_MAX_RECEIVE_COUNT: '3', OUTBOX_LEASE_SECONDS: '3',
      DEPENDENCY_TIMEOUT_MS: '1000', MESSAGING_RETRY_CAP_SECONDS: '2' });
    client = createSqsClient(config, true); await initializeQueues(client, config);
    const url = async (name: string) => (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
    sourceUrl = await url(config.sqs.queueName); eventsUrl = await url(config.sqs.eventsQueueName); dlqUrl = await url(config.sqs.dlqName);
  });
  afterEach(async () => {
    for (const replica of replicas.splice(0)) await stop(replica);
    if (client && runtime) {
      await drain();
      for (const queue of [config.sqs.queueName, config.sqs.dlqName, config.sqs.eventsQueueName, config.sqs.eventsDlqName]) {
        const response = await client.send(new GetQueueUrlCommand({ QueueName: queue }));
        await client.send(new DeleteQueueCommand({ QueueUrl: response.QueueUrl! }));
      }
      client.destroy();
    }
  }, 30000);
  afterAll(async () => {
    await runtime?.close(true); await owner?.close(true); await databaseAdmin?.close(true);
    if (admin && /^jungle_wagering_test_messaging_[a-f0-9]{32}$/.test(databaseName)) await admin.em.execute(`drop database "${databaseName}"`);
    await admin?.close(true);
  });

  test('A: 50 deliveries bypassing broker dedup still produce one debit, one inbox and two command events', async () => {
    const w = await wallet(); const e = command(w); const replica = await spawn();
    await Promise.all(Array.from({ length: 50 }, () => send(e)));
    await until(async () => {
      const count = await scalar(`select count(*)::text as value from wagering.wager_transactions
        where provider_id = ? and external_transaction_id = ?`, [e.data.providerId, e.data.externalTransactionId]);
      return count === '1';
    });
    await done(e);
    await until(async () => {
      // FIFO source must empty after all 50 ACKs, then stop to collect final counters.
      const { GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
      const r = await client.send(new GetQueueAttributesCommand({ QueueUrl: sourceUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
      return r.Attributes?.['ApproximateNumberOfMessages'] === '0' && r.Attributes?.['ApproximateNumberOfMessagesNotVisible'] === '0';
    });
    await stop(replica); await balance(w.walletId, '90.00', '1');
    const metrics = replica.notices.find((notice) => notice.event === 'stopped')!.metrics!;
    expect(metrics['processed']).toBe(50); expect(metrics['duplicates']).toBe(49);
    expect(await scalar(`select count(*)::text as value from wagering.outbox_messages o join wagering.wager_transactions t
      on t.id = o.transaction_id where t.external_transaction_id = ?`, [e.data.externalTransactionId])).toBe('2');
    console.log(JSON.stringify({ scenario: 'sqs_50_duplicates', deliveries: 50, duplicates: metrics['duplicates'], debits: 1, balance: '90.00' }));
  }, 30000);

  test('B: SIGKILL after PostgreSQL commit before ACK redelivers and resolves through persistent inbox', async () => {
    const w = await wallet(); const e = command(w); const crashed = await spawn('crash-consumer');
    await send(e); expect(await crashed.child.exited).not.toBe(0); crashed.stopped = true; await crashed.output;
    expect(crashed.notices.some((notice) => notice.event === 'after_commit_crash')).toBe(true);
    await done(e); await balance(w.walletId, '90.00', '1');
    const recovered = await spawn();
    await until(async () => (await scalar(`select count(*)::text as value from wagering.inbox_messages where message_id = ?`, [e.messageId])) === '1');
    // Receive count/duplicate metric confirms redelivery; wait until queue is ACKed.
    await Bun.sleep(2500); await stop(recovered);
    expect(recovered.notices.find((notice) => notice.event === 'stopped')!.metrics!['duplicates']).toBe(1);
    await balance(w.walletId, '90.00', '1');
    console.log(JSON.stringify({ scenario: 'consumer_sigkill_after_commit', inbox: 1, debits: 1, redeliveryDuplicate: 1 }));
  }, 30000);

  test('C: failure after outbox/ledger writes rolls back everything; retry on a new process applies once', async () => {
    const w = await wallet(); const e = command(w); const failed = await spawn('rollback-consumer'); await send(e);
    await until(async () => failed.notices.some((notice) => notice.event === 'before_commit_failure'));
    await stop(failed); await balance(w.walletId, '100.00', '0');
    expect(await scalar('select count(*)::text as value from wagering.inbox_messages where message_id = ?', [e.messageId])).toBe('0');
    expect(await scalar('select count(*)::text as value from wagering.wager_transactions where external_transaction_id = ?', [e.data.externalTransactionId])).toBe('0');
    const recovered = await spawn(); await done(e); await stop(recovered); await balance(w.walletId, '90.00', '1');
  });

  test('D: two independent publishers safely claim and publish events in wallet order', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => wallet()));
    for (const w of wallets) await service.submit(command(w).data);
    const first = await spawn('publisher', { MESSAGING_TEST_START_PAUSED: '1' });
    const second = await spawn('publisher', { MESSAGING_TEST_START_PAUSED: '1' });
    first.child.stdin.write('start\n'); second.child.stdin.write('start\n');
    await until(async () => (await store.pending()).count === 0);
    await stop(first); await stop(second);
    expect(first.ready.pid).not.toBe(second.ready.pid); expect(first.ready.backendPid).not.toBe(second.ready.backendPid);
    const total = [first, second].reduce((sum, r) => sum + (r.notices.find((n) => n.event === 'stopped')!.metrics!['published'] ?? 0), 0);
    expect(total).toBe(32);
    expect([first, second].every((r) => (r.notices.find((n) => n.event === 'stopped')!.metrics!['published'] ?? 0) > 0)).toBe(true);
    const seen = new Set<string>(); const positions = new Map<string, number>();
    for (let index = 0; index < 32; index += 1) {
      const message = await receive(eventsUrl); expect(message).toBeDefined();
      const event = JSON.parse(message!.Body!) as { eventId: string; aggregateId: string };
      expect(seen.has(event.eventId)).toBe(false); seen.add(event.eventId);
      const position = Number(await scalar('select position::text as value from wagering.outbox_messages where id = ?', [event.eventId]));
      expect(position).toBeGreaterThan(positions.get(event.aggregateId) ?? 0); positions.set(event.aggregateId, position);
      await client.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: message!.ReceiptHandle! }));
    }
    expect(seen.size).toBe(32);
    console.log(JSON.stringify({ scenario: 'two_publishers', processIds: [first.ready.pid, second.ready.pid], published: total, uniqueEvents: seen.size }));
  }, 30000);

  test('E: publisher SIGKILL after send recovers expired lease with same event ID and fenced claim', async () => {
    const w = await wallet(); const crashed = await spawn('crash-publisher');
    expect(await crashed.child.exited).not.toBe(0); crashed.stopped = true; await crashed.output;
    const eventId = crashed.notices.find((notice) => notice.event === 'after_send_crash')!.eventId!;
    expect(await scalar('select count(*)::text as value from wagering.outbox_messages where id = ? and published_at is null', [eventId])).toBe('1');
    const firstDelivery = await receive(eventsUrl); expect(JSON.parse(firstDelivery!.Body!).eventId).toBe(eventId);
    // Same destination preserves SQS dedup state; redelivery after a crash still uses the original event ID.
    await client.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: firstDelivery!.ReceiptHandle! }));
    await Bun.sleep(3200);
    const replacement = await spawn('publisher');
    await until(async () => (await store.pending()).count === 0); await stop(replacement);
    expect(await scalar('select attempts::text as value from wagering.outbox_messages where id = ?', [eventId])).toBe('2');
    const replay = await runtime.em.fork().execute<Array<{ payload: unknown }>>('select payload from wagering.outbox_messages where id = ?', [eventId]);
    expect(replay[0]!.payload).toEqual(JSON.parse(firstDelivery!.Body!));
    console.log(JSON.stringify({ scenario: 'publisher_sigkill_after_send', eventId, attempts: 2, recoveredByNewProcess: true }));
  }, 30000);

  test('F: three consumer processes handle independent wallets while a locked wallet cannot advance', async () => {
    const locked = await wallet(); const independent = await Promise.all(Array.from({ length: 9 }, () => wallet()));
    const workers = await Promise.all([spawn(), spawn(), spawn()]);
    expect(new Set(workers.map((r) => r.ready.pid)).size).toBe(3);
    expect(new Set(workers.map((r) => r.ready.backendPid)).size).toBe(3);
    let release!: () => void; let acquired!: () => void;
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = owner.em.fork().transactional(async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [locked.walletId]); acquired(); await gate;
    });
    await held;
    const a = command(locked); const other = independent.map((w) => command(w));
    try {
      await send(a); await Promise.all(other.map((e) => send(e)));
      await Promise.all(other.map((e) => done(e)));
      expect(await scalar('select balance::text as value from wagering.wallets where id = ?', [locked.walletId])).toBe('100.00');
    } finally { release(); await holding; }
    await done(a);
    for (const worker of workers) await stop(worker);
    for (const w of [locked, ...independent]) await balance(w.walletId, '90.00', '1');
    expect(workers.every((r) => (r.notices.find((n) => n.event === 'stopped')!.metrics!['processed'] ?? 0) > 0)).toBe(true);
    console.log(JSON.stringify({ scenario: 'three_sqs_consumers', processes: workers.map((r) => r.ready.pid),
      backendPids: workers.map((r) => r.ready.backendPid), independentWallets: 9, lockedWalletPreserved: true }));
  }, 30000);

  test('G: repeated infrastructure failure reaches real FIFO DLQ without financial or inbox effects', async () => {
    const w = await wallet(); const e = command(w); const failed = await spawn('rollback-consumer'); await send(e);
    const message = await until(() => receive(dlqUrl), 15000);
    expect(JSON.parse(message.Body!)).toEqual(e);
    expect(message.MessageAttributes?.['ErrorCode']?.StringValue).toBe('PERSISTENCE_UNAVAILABLE');
    await stop(failed); await balance(w.walletId, '100.00', '0');
    expect(await scalar('select count(*)::text as value from wagering.inbox_messages where message_id = ?', [e.messageId])).toBe('0');
  }, 30000);

  test('H: restart consumer and publisher with pending work recovers all events and preserves financial integrity', async () => {
    const w = await wallet(); const e = command(w);
    const before = await spawn(); await stop(before); await send(e);
    const publisherBefore = await spawn('publisher'); await stop(publisherBefore);
    const consumerAfter = await spawn(); const publisherAfter = await spawn('publisher');
    await done(e); await until(async () => (await store.pending()).count === 0);
    await stop(consumerAfter); await stop(publisherAfter); await balance(w.walletId, '90.00', '1');
    expect(await scalar('select count(*)::text as value from wagering.outbox_messages where aggregate_id = ? and published_at is not null', [w.walletId])).toBe('4');
  });

  test('invalid envelopes and conflicting message IDs reach DLQ, while valid financial rejection is ACKed', async () => {
    const w = await wallet(); const e = command(w, { money: { amount: '200.00', currency: 'BRL' } });
    const consumer = await spawn(); await send(e); await done(e);
    const bad = { ...e, data: { ...e.data, money: { amount: '1.00', currency: 'BRL' } } };
    await send(bad);
    const conflict = await until(() => receive(dlqUrl));
    expect(conflict.MessageAttributes?.['ErrorCode']?.StringValue).toBe('MESSAGE_ID_CONFLICT');
    await client.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: conflict.ReceiptHandle! }));
    const invalid = { ...command(w), data: { ...e.data, money: { amount: 5, currency: 'BRL' } } };
    await client.send(new SendMessageCommand({ QueueUrl: sourceUrl, MessageBody: JSON.stringify(invalid),
      MessageGroupId: walletGroup(w.walletId), MessageDeduplicationId: id() }));
    const invalidDlq = await until(() => receive(dlqUrl));
    expect(invalidDlq.MessageAttributes?.['ErrorCode']?.StringValue).toBe('INVALID_ENVELOPE');
    await stop(consumer); await balance(w.walletId, '100.00', '0');
    expect(await scalar(`select count(*)::text as value from wagering.outbox_messages where aggregate_id = ?
      and event_type = 'WalletBalanceChanged'`, [w.walletId])).toBe('1'); // opening only
  }, 30000);

  test('LOSS and PENDING_REFERENCE emit their typed events without WalletBalanceChanged; uncertain commit is confirmed read-only', async () => {
    const w = await wallet();
    const loss = command(w, { kind: Kind.Loss, money: { amount: '0.00', currency: 'BRL' } });
    const pending = command(w, { kind: Kind.Refund, referenceExternalTransactionId: 'missing-reference' });
    const consumer = await spawn(); await send(loss); await send(pending); await done(loss); await done(pending); await stop(consumer);
    expect(await scalar(`select count(*)::text as value from wagering.outbox_messages where aggregate_id = ?
      and event_type = 'WagerTransactionPendingReference'`, [w.walletId])).toBe('1');
    expect(await scalar(`select count(*)::text as value from wagering.outbox_messages where aggregate_id = ?
      and event_type = 'WalletBalanceChanged'`, [w.walletId])).toBe('1');
    const confirmed = await service.confirmedMessage(CONSUMER_NAME, pending.messageId, commandHash(pending));
    expect(confirmed?.status).toBe(Status.PendingReference); expect(confirmed?.replay).toBe(true);
    await balance(w.walletId, '100.00', '0');
  });

  test('event consumer persists dedup even when duplicate event delivery bypasses SQS deduplication', async () => {
    const w = await wallet(); await drain();
    const original = await receive(eventsUrl); expect(original).toBeDefined();
    const event = JSON.parse(original!.Body!) as { eventId: string; transactionId: string };
    await client.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: original!.ReceiptHandle! }));
    await owner.em.execute('create table public.stage5_projection (event_id text not null)');
    await owner.em.execute('grant select, insert on public.stage5_projection to wagering_runtime');
    const consume = async (message: Message) => runtime.em.fork().transactional(async (em) => {
      const inbox = new PostgresInboxRepository(em);
      const digest = createHash('sha256').update(message.Body!).digest('hex');
      const record = await inbox.receive('stage5-event-projection', event.eventId, digest, new Date());
      if (record.processedAt) return;
      await em.execute('insert into public.stage5_projection(event_id) values (?)', [event.eventId]);
      await inbox.complete('stage5-event-projection', event.eventId, event.transactionId);
    });
    // Different transport IDs simulate the duplicate observable outside the broker dedup window.
    for (let i = 0; i < 2; i += 1) await client.send(new SendMessageCommand({ QueueUrl: eventsUrl,
      MessageBody: original!.Body!, MessageGroupId: 'duplicate-event-test', MessageDeduplicationId: id() }));
    const deliveries: Message[] = [];
    while (deliveries.length < 2) {
      const message = await until(() => receive(eventsUrl));
      if (JSON.parse(message.Body!).eventId === event.eventId) { deliveries.push(message); await consume(message); }
      await client.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: message.ReceiptHandle! }));
    }
    // Both handlers, including a direct concurrent replay, use SQL uniqueness rather than projection uniqueness.
    await Promise.all(deliveries.map(consume));
    expect(await scalar('select count(*)::text as value from public.stage5_projection where event_id = ?', [event.eventId])).toBe('1');
    await balance(w.walletId, '100.00', '0');
  }, 30000);

  test('expired outbox lease fences stale publishers and bounded attempts keep exhausted events durable', async () => {
    const w = await wallet();
    const claimed = await store.claim('old-owner', 1, 3, 1); expect(claimed).toHaveLength(1);
    await Bun.sleep(3100);
    expect(await store.published(claimed[0]!)).toBe(false);
    expect(await store.claim('new-owner', 1, 3, 1)).toHaveLength(0);
    expect((await store.pending(1)).exhausted).toBe(1);
    expect(await scalar('select count(*)::text as value from wagering.outbox_messages where aggregate_id = ?', [w.walletId])).toBe('2');
    // Higher configured budget makes recovery explicit; the durable event keeps its original ID.
    const recovery = await store.claim('new-owner', 1, 3, 20);
    expect(recovery[0]!.id).toBe(claimed[0]!.id);
    expect(await store.retry(claimed[0]!, 1, 'SEND_UNAVAILABLE')).toBe(false);
    expect(await store.retry(recovery[0]!, 1, 'SEND_UNAVAILABLE')).toBe(true);
    await Bun.sleep(1100);
  }, 30000);

  test('lost commit response is resolved from persistent inbox before ACK, without repeating financial work', async () => {
    const w = await wallet(); const e = command(w); const consumer = await spawn('uncertain-consumer');
    await send(e); await done(e); await stop(consumer);
    expect(consumer.notices.find((notice) => notice.event === 'stopped')!.metrics!['duplicates']).toBe(1);
    await balance(w.walletId, '90.00', '1');
  });

  test('SIGTERM drains a locked in-flight operation and stops fetching the next command', async () => {
    const w = await wallet(); const current = command(w); const next = command(w);
    const consumer = await spawn();
    let release!: () => void; let acquired!: () => void;
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lock = owner.em.fork().transactional(async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [w.walletId]); acquired(); await gate;
    });
    await held;
    try {
      await send(current); await send(next);
      await until(async () => (await scalar(`select count(*)::text as value from pg_stat_activity
        where datname = ? and wait_event_type = 'Lock' and usename = ?`, [databaseName, login.name])) !== '0');
      consumer.child.kill('SIGTERM');
    } finally { release(); await lock; }
    expect(await consumer.child.exited).toBe(0); consumer.stopped = true; await consumer.output;
    await done(current); await balance(w.walletId, '90.00', '1');
    expect(await scalar('select count(*)::text as value from wagering.inbox_messages where message_id = ?', [next.messageId])).toBe('0');
  });

  test('compiled production worker entrypoints validate dependencies, process real work and shut down cleanly', async () => {
    const w = await wallet(); const e = command(w);
    const consumer = await spawn('production-consumer'); const publisher = await spawn('production-publisher');
    await send(e); await done(e); await until(async () => (await store.pending()).count === 0);
    await stop(consumer); await stop(publisher); await balance(w.walletId, '90.00', '1');
    expect(consumer.notices.some((notice) => notice.event === 'worker_stopped')).toBe(true);
    expect(publisher.notices.some((notice) => notice.event === 'worker_stopped')).toBe(true);
  });
});
