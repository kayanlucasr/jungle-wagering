import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand, DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { loadConfig, type AppConfig } from '../../src/infrastructure/config/environment';
import { ormOptions } from '../../src/infrastructure/persistence/orm-options';
import { provisionAccess } from '../../src/infrastructure/persistence/provision-access';
import { PostgresFinancialUnitOfWork, sqlState } from '../../src/infrastructure/persistence/financial-unit-of-work';
import { FinancialService } from '../../src/application/financial/financial-service';
import type { SubmitTransaction } from '../../src/application/financial/payload-hash';
import { payloadHash } from '../../src/application/financial/payload-hash';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/wager-transaction-status';
import { FailureCode } from '../../src/domain/errors/domain-error';
import { defaultPendingReferencePolicy, type PendingReferencePolicy } from '../../src/application/pending-reference/policy';
import { ReferenceScheduler } from '../../src/infrastructure/pending-reference/reference-scheduler';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.service';
import { initializeQueues } from '../../src/infrastructure/messaging/queue-setup';
import { TransactionConsumer } from '../../src/infrastructure/messaging/transaction-consumer';
import { walletGroup } from '../../src/application/messaging/command-envelope';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { PostgresOutboxStore } from '../../src/infrastructure/persistence/outbox-store';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { createApplication } from '../../src/bootstrap';

const id = () => crypto.randomUUID();
interface Notice { event: string; pid?: number; backendPid?: number; metrics?: Record<string, number> }
interface Replica { child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>; notices: Notice[];
  output: Promise<void>; stderr: Promise<string>; ready: Notice; stopped: boolean }
interface Metadata { status: string; processing_attempts: number; next_attempt_at: Date | null;
  reference_deadline_at: Date | null; last_attempt_at: Date | null }

describe('Stage 6 persistent pending-reference resolution', () => {
  let admin: MikroORM; let databaseAdmin: MikroORM; let owner: MikroORM; let runtime: MikroORM;
  let name: string; let config: AppConfig; let client: SQSClient; let service: FinancialService;
  let now: number; let policy: PendingReferencePolicy; let legacyId: string;
  const replicas: Replica[] = [];
  const login = { name: 'stage6_runtime', password: 'isolated_pending_runtime' };
  const migration = { name: 'stage6_migrator', password: 'isolated_pending_migrator' };
  const logger = new JsonLogger('error');

  async function until<T>(work: () => Promise<T | undefined | false>, timeout = 15000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await work(); if (value !== undefined && value !== false) return value;
      await Bun.sleep(30);
    }
    throw new Error('PendingConditionTimedOut');
  }
  function configure(overrides: Partial<PendingReferencePolicy> = {}) {
    policy = { ...defaultPendingReferencePolicy, baseSeconds: 1, capSeconds: 1, pollMs: 50, ...overrides };
    service = new FinancialService(new PostgresFinancialUnitOfWork(runtime), policy, () => new Date(now), () => 0);
  }
  async function wallet(amount = '100.00', currency = 'BRL') {
    const w = { walletId: id(), playerId: id() };
    await service.openWallet({ id: w.walletId, playerId: w.playerId, initialBalance: { amount, currency } });
    return w;
  }
  function command(w: { walletId: string; playerId: string }, overrides: Partial<SubmitTransaction> = {}): SubmitTransaction {
    return { ...w, providerId: 'provider-a', externalTransactionId: id(), idempotencyKey: id(),
      roundId: 'round-a', gameId: 'game-a', kind: Kind.Bet, money: { amount: '10.00', currency: 'BRL' }, ...overrides };
  }
  async function metadata(transactionId: string): Promise<Metadata> {
    const rows = await runtime.em.fork().execute<Metadata[]>(`select status, processing_attempts, next_attempt_at,
      reference_deadline_at, last_attempt_at from wagering.wager_transactions where id = ?`, [transactionId]);
    const row = rows[0]!;
    return { ...row, next_attempt_at: row.next_attempt_at ? new Date(row.next_attempt_at) : null,
      reference_deadline_at: row.reference_deadline_at ? new Date(row.reference_deadline_at) : null,
      last_attempt_at: row.last_attempt_at ? new Date(row.last_attempt_at) : null };
  }
  async function scalar(sql: string, args: unknown[] = []): Promise<string> {
    return (await runtime.em.fork().execute<Array<{ value: string }>>(sql, args))[0]!.value;
  }
  async function balance(walletId: string, expected: string, entries?: string): Promise<void> {
    const result = await service.reconcile(walletId); expect(result.consistent).toBe(true); expect(result.storedBalance).toBe(expected);
    if (entries !== undefined) expect(result.entryCount).toBe(entries);
  }
  async function terminal(tx: string): Promise<void> {
    await until(async () => (await metadata(tx)).status !== 'PENDING_REFERENCE');
  }
  async function spawn(mode = 'normal', overrides: Record<string, string> = {}): Promise<Replica> {
    const production = mode === 'production';
    const child = Bun.spawn([process.execPath, ...(production ? ['dist/src/workers/main.js', 'pending-reference']
      : ['test/support/pending-reference-process.ts', mode])], {
      env: { ...process.env, DB_NAME: name, DB_USER: login.name, DB_PASSWORD: login.password,
        DEPENDENCY_TIMEOUT_MS: '1000', PENDING_REFERENCE_POLL_MS: '50', PENDING_REFERENCE_BASE_SECONDS: '1',
        PENDING_REFERENCE_CAP_SECONDS: '1', PENDING_REFERENCE_BATCH_SIZE: '20',
        PENDING_REFERENCE_MAX_ATTEMPTS: '20', LOG_LEVEL: 'info', ...overrides },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const notices: Notice[] = [];
    const output = (async () => {
      const reader = child.stdout.getReader(); let buffer = ''; const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true }); let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            notices.push(JSON.parse(buffer.slice(0, end)) as Notice); buffer = buffer.slice(end + 1);
          }
        }
      } finally { reader.releaseLock(); }
    })();
    const replica: Replica = { child, notices, output, stderr: new Response(child.stderr).text(), ready: { event: 'pending' }, stopped: false };
    replicas.push(replica);
    replica.ready = await until(async () => notices.find((n) => n.event === 'ready' || n.event === 'worker_started'));
    return replica;
  }
  async function stop(replica: Replica) {
    if (replica.stopped) return;
    replica.stopped = true; replica.child.kill('SIGTERM');
    const timer = setTimeout(() => replica.child.kill('SIGKILL'), 5000);
    try { expect(await replica.child.exited).toBe(0); await replica.output; expect(await replica.stderr).toBe(''); }
    finally { clearTimeout(timer); }
  }
  async function killed(replica: Replica, notice: string) {
    expect(await replica.child.exited).not.toBe(0); replica.stopped = true; await replica.output;
    expect(replica.notices.some((n) => n.event === notice)).toBe(true);
  }

  beforeAll(async () => {
    const initial = loadConfig();
    if (initial.nodeEnv !== 'test' || !/^jungle_wagering_test(?:_|$)/.test(initial.database.name)) throw new Error('IsolatedDatabaseRequired');
    name = `jungle_wagering_test_pending_${id().replaceAll('-', '')}`;
    admin = await MikroORM.init({ ...ormOptions(initial), connect: true }); await admin.em.execute(`create database "${name}"`);
    databaseAdmin = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: name })), connect: true });
    await databaseAdmin.getMigrator().up({ to: 'Migration20261028000100' }); await provisionAccess(databaseAdmin, migration, login);
    owner = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: name,
      DB_USER: migration.name, DB_PASSWORD: migration.password }), true), connect: true });
    await owner.getMigrator().up({ to: 'Migration20261029000100' });
    // Genuine pre-upgrade pending row, created before the new column exists, without touching development data.
    const w = { walletId: id(), playerId: id() }; const legacy = command(w, { kind: Kind.Refund, referenceExternalTransactionId: 'legacy-missing' });
    legacyId = id(); const created = new Date(Date.now() - 172800000);
    await owner.em.fork().transactional(async (em) => {
      await em.execute(`insert into wagering.wallets(id,player_id,currency,balance,version,created_at,updated_at)
        values (?,?,'BRL',0,1,?,?)`, [w.walletId, w.playerId, created, created]);
      await em.execute(`insert into wagering.wager_transactions(id,provider_id,external_transaction_id,idempotency_key,
        payload_hash,payload_schema_version,wallet_id,player_id,currency,round_id,game_id,kind,amount,
        reference_external_transaction_id,created_at,updated_at) values (?,?,?,?,?,1,?,?,'BRL',?,?,'REFUND',10,?,?,?)`,
      [legacyId, legacy.providerId, legacy.externalTransactionId, legacy.idempotencyKey, payloadHash(legacy),
        w.walletId, w.playerId, legacy.roundId, legacy.gameId, legacy.referenceExternalTransactionId, created, created]);
      await em.execute(`update wagering.wager_transactions set status = 'PENDING_REFERENCE', processing_attempts = 1,
        last_attempt_at = ? where id = ?`, [created, legacyId]);
    });
    await owner.getMigrator().up(); expect(await owner.getMigrator().getPendingMigrations()).toHaveLength(0);
    const suffix = id();
    config = loadConfig({ ...process.env, DB_NAME: name, DB_USER: login.name, DB_PASSWORD: login.password,
      SQS_QUEUE_NAME: `pending-${suffix}.fifo`, SQS_DLQ_NAME: `pending-dlq-${suffix}.fifo`,
      SQS_EVENTS_QUEUE_NAME: `pending-events-${suffix}.fifo`, SQS_EVENTS_DLQ_NAME: `pending-events-dlq-${suffix}.fifo`,
      SQS_WAIT_SECONDS: '1', SQS_VISIBILITY_TIMEOUT_SECONDS: '2', PENDING_REFERENCE_BASE_SECONDS: '1',
      PENDING_REFERENCE_CAP_SECONDS: '1', DEPENDENCY_TIMEOUT_MS: '1000' });
    runtime = await MikroORM.init({ ...ormOptions(config), connect: true });
    client = createSqsClient(config, true); await initializeQueues(client, config);
  }, 30000);
  beforeEach(() => { now = Date.now(); configure(); });
  afterEach(async () => {
    for (const replica of replicas.splice(0)) await stop(replica);
    // Close any deliberately unresolved test references by the real expiration path, not by editing balances/history.
    now += 259200000;
    for (let i = 0; i < 100; i += 1) if (!await service.resolveNextPendingReference()) break;
  });
  afterAll(async () => {
    if (client) {
      for (const queue of [config.sqs.queueName, config.sqs.dlqName, config.sqs.eventsQueueName, config.sqs.eventsDlqName]) {
        const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: queue }));
        await client.send(new DeleteQueueCommand({ QueueUrl: QueueUrl! }));
      }
      client.destroy();
    }
    await runtime?.close(true); await owner?.close(true); await databaseAdmin?.close(true);
    if (admin && /^jungle_wagering_test_pending_[a-f0-9]{32}$/.test(name)) await admin.em.execute(`drop database "${name}"`);
    await admin?.close(true);
  });

  test('approved migration backfills legacy deadline, protects it and refuses history-erasing rollback', async () => {
    const row = await metadata(legacyId); expect(row.status).toBe('PENDING_REFERENCE');
    expect(row.reference_deadline_at!.getTime() - row.next_attempt_at!.getTime()).toBe(86400000);
    const due = await service.resolveNextPendingReference(); expect(due?.result).toBe('expired_ttl');
    expect(due?.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await scalar('select count(*)::text as value from wagering.wallet_ledger_entries where transaction_id = ?', [legacyId])).toBe('0');
    await expect(owner.getMigrator().down({ migrations: ['Migration20261029000200'] })).rejects.toThrow();
    expect(await owner.getMigrator().getPendingMigrations()).toHaveLength(0);
  });

  test('A: REFUND before BET is ACKed by SQS while pending and resolves automatically after BET', async () => {
    const w = await wallet(); const bet = command(w); const refund = command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    const messageId = id(); const source = (await client.send(new GetQueueUrlCommand({ QueueName: config.sqs.queueName }))).QueueUrl!;
    const consumer = new TransactionConsumer(config, client, service, undefined, logger); const running = consumer.run();
    try {
      await client.send(new SendMessageCommand({ QueueUrl: source, MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested',
        version: 1, correlationId: 'stage6-refund-trace', occurredAt: new Date().toISOString(), data: refund }),
      MessageGroupId: walletGroup(w.walletId), MessageDeduplicationId: id() }));
      const txId = await until(async () => {
        const rows = await runtime.em.fork().execute<Array<{ transaction_id: string }>>(`select transaction_id
          from wagering.inbox_messages where message_id = ? and processed_at is not null`, [messageId]);
        return rows[0]?.transaction_id;
      });
      expect((await metadata(txId)).status).toBe('PENDING_REFERENCE');
      await until(async () => {
        const r = await client.send(new GetQueueAttributesCommand({ QueueUrl: source,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
        return r.Attributes?.['ApproximateNumberOfMessages'] === '0' && r.Attributes?.['ApproximateNumberOfMessagesNotVisible'] === '0';
      });
      await service.submit(bet); now += 1000;
      const result = await service.resolveNextPendingReference(); expect(result?.result).toBe('PROCESSED');
      expect(result?.correlationId).toBe('stage6-refund-trace'); await balance(w.walletId, '100.00', '3');
      expect(await scalar(`select count(*)::text as value from wagering.outbox_messages where transaction_id = ?
        and event_type = 'WagerTransactionPendingReference'`, [txId])).toBe('1');
      console.log(JSON.stringify({ scenario: 'refund_before_bet', pendingAck: true, result: result?.result, balance: '100.00', ledger: 3 }));
    } finally { consumer.stop(); await running; }
  });

  test('B: ROLLBACK before WIN performs the inverse movement using the original transaction', async () => {
    const w = await wallet(); const win = command(w, { kind: Kind.Win });
    const rollback = command(w, { kind: Kind.Rollback, referenceExternalTransactionId: win.externalTransactionId });
    const accepted = await service.submit(rollback); expect(accepted.status).toBe(Status.PendingReference);
    await service.submit(win); now += 1000;
    expect((await service.resolveNextPendingReference())?.transactionId).toBe(accepted.transactionId);
    expect((await service.submit(rollback)).status).toBe(Status.Processed); await balance(w.walletId, '100.00', '3');
  });

  test('C: incompatible player, wallet, currency, round, amount and kind are rejected without an extra ledger', async () => {
    for (const mismatch of ['player', 'wallet', 'currency', 'round', 'amount', 'kind']) {
      const w = await wallet(); const target = mismatch === 'wallet' ? await wallet() : mismatch === 'currency' ? await wallet('100.00', 'USD') : w;
      const reference = command(target, {
        ...(mismatch === 'player' ? { playerId: id() } : {}), ...(mismatch === 'currency' ? { money: { amount: '10.00', currency: 'USD' } } : {}),
        ...(mismatch === 'round' ? { roundId: 'other-round' } : {}), ...(mismatch === 'amount' ? { money: { amount: '5.00', currency: 'BRL' } } : {}),
        ...(mismatch === 'kind' ? { kind: Kind.Win } : {}),
      });
      const pending = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: reference.externalTransactionId }));
      await service.submit(reference); const before = await service.reconcile(w.walletId); now += 1000;
      const result = await service.resolveNextPendingReference(); expect(result?.transactionId).toBe(pending.transactionId); expect(result?.result).toBe('REJECTED');
      expect(result?.failureCode).toBe(mismatch === 'amount' ? 'REFERENCE_AMOUNT_MISMATCH' : mismatch === 'kind' ? 'REFERENCE_KIND_NOT_ALLOWED' : 'REFERENCE_CONTEXT_MISMATCH');
      await balance(w.walletId, before.storedBalance, before.entryCount);
    }
  });

  test('provider namespace never resolves a foreign transaction with the same external ID', async () => {
    const w = await wallet(); const bet = command(w, { providerId: 'provider-b' });
    const source = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    await service.submit(bet); now += 1000;
    expect((await service.resolveNextPendingReference())?.result).toBe('PENDING_REFERENCE');
    now += 86400000; expect((await service.resolveNextPendingReference())?.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect((await metadata(source.transactionId)).status).toBe('REJECTED'); await balance(w.walletId, '90.00', '2');
  });

  test('D: a rejected reference terminates its pending reversal with REFERENCE_NOT_PROCESSED', async () => {
    const w = await wallet(); const bet = command(w, { money: { amount: '200.00', currency: 'BRL' } });
    await service.submit(command(w, { kind: Kind.Refund, money: bet.money, referenceExternalTransactionId: bet.externalTransactionId }));
    expect((await service.submit(bet)).status).toBe(Status.Rejected); now += 1000;
    const result = await service.resolveNextPendingReference(); expect(result?.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    await balance(w.walletId, '100.00', '1');
  });

  test('a reference that exists but is still pending is rescheduled and an entire reference chain later resolves', async () => {
    const w = await wallet(); const bet = command(w);
    const refund = command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    const rollback = command(w, { kind: Kind.Rollback, referenceExternalTransactionId: refund.externalTransactionId });
    const rollbackResult = await service.submit(rollback); const refundResult = await service.submit(refund); now += 1000;
    expect((await service.resolveNextPendingReference())?.result).toBe('PENDING_REFERENCE');
    expect((await service.resolveNextPendingReference())?.result).toBe('PENDING_REFERENCE');
    await balance(w.walletId, '100.00', '1'); await service.submit(bet);
    for (let i = 0; i < 5; i += 1) { now += 1000; await service.resolveNextPendingReference(); }
    expect((await metadata(refundResult.transactionId)).status).toBe('PROCESSED');
    expect((await metadata(rollbackResult.transactionId)).status).toBe('PROCESSED');
    expect(await scalar(`select count(*)::text as value from wagering.outbox_messages where transaction_id = ?
      and event_type = 'WagerTransactionPendingReference'`, [rollbackResult.transactionId])).toBe('1');
    await balance(w.walletId, '90.00', '4');
  });

  test('a reference arriving after the persisted deadline cannot revive an expired reversal', async () => {
    configure({ ttlSeconds: 1 }); const w = await wallet(); const bet = command(w);
    const refund = command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    await service.submit(refund); now += 1000; await service.submit(bet);
    expect((await service.resolveNextPendingReference())?.result).toBe('expired_ttl');
    expect((await service.submit(refund)).status).toBe(Status.Rejected); await balance(w.walletId, '90.00', '2');
  });

  test('E: TTL and attempt exhaustion persist REJECTED snapshots without a movement or duplicate pending event', async () => {
    configure({ ttlSeconds: 1 }); const w = await wallet(); const missing = command(w, { kind: Kind.Refund, referenceExternalTransactionId: id() });
    const accepted = await service.submit(missing); const deadline = (await metadata(accepted.transactionId)).reference_deadline_at!;
    now += 1000; configure({ ttlSeconds: 86400 });
    const expired = await service.resolveNextPendingReference(); expect(expired?.result).toBe('expired_ttl');
    expect((await metadata(accepted.transactionId)).reference_deadline_at).toEqual(deadline);
    expect((await service.submit(missing)).terminalResult?.failureCode).toBe(FailureCode.ReferenceNotFound);
    configure({ maxAttempts: 3 }); const second = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: id() }));
    now += 1000; expect((await service.resolveNextPendingReference())?.result).toBe('PENDING_REFERENCE');
    now += 1000; expect((await service.resolveNextPendingReference())?.result).toBe('expired_attempts');
    const final = await metadata(second.transactionId); expect(final.processing_attempts).toBe(3); expect(final.next_attempt_at).toBeNull();
    expect(await scalar(`select count(*)::text as value from wagering.outbox_messages where transaction_id = ?
      and event_type = 'WagerTransactionPendingReference'`, [second.transactionId])).toBe('1');
    await balance(w.walletId, '100.00', '1');
  });

  test('F: three independent scheduler processes racing one pending operation produce one conclusion', async () => {
    const w = await wallet(); const bet = command(w); const pending = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    await service.submit(bet);
    const workers = await Promise.all(Array.from({ length: 3 }, () => spawn('normal', { PENDING_TEST_START_PAUSED: '1' })));
    expect(new Set(workers.map((r) => r.ready.pid)).size).toBe(3); expect(new Set(workers.map((r) => r.ready.backendPid)).size).toBe(3);
    workers.forEach((r) => r.child.stdin.write('start\n')); await terminal(pending.transactionId);
    for (const r of workers) await stop(r);
    expect((await metadata(pending.transactionId)).processing_attempts).toBe(2);
    expect(workers.reduce((sum, r) => sum + r.notices.find((n) => n.event === 'stopped')!.metrics!['resolved']!, 0)).toBe(1);
    await balance(w.walletId, '100.00', '3');
    console.log(JSON.stringify({ scenario: 'three_pending_workers', processes: workers.map((r) => r.ready.pid),
      backendPids: workers.map((r) => r.ready.backendPid), resolutions: 1, refundLedger: 1 }));
  }, 30000);

  test('G: SIGKILL before commit rolls back wallet, ledger, status, attempts and outbox', async () => {
    const w = await wallet(); const bet = command(w); const pending = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    await service.submit(bet); const crashed = await spawn('crash-before'); await killed(crashed, 'before_commit');
    expect((await metadata(pending.transactionId)).status).toBe('PENDING_REFERENCE'); expect((await metadata(pending.transactionId)).processing_attempts).toBe(1);
    expect(await scalar('select count(*)::text as value from wagering.outbox_messages where transaction_id = ?', [pending.transactionId])).toBe('1');
    await balance(w.walletId, '90.00', '2');
    const recovered = await spawn(); await terminal(pending.transactionId); await stop(recovered); await balance(w.walletId, '100.00', '3');
  });

  test('H: SIGKILL after commit and restart never repeat the credit or terminal event', async () => {
    const w = await wallet(); const bet = command(w); const pending = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    await service.submit(bet); const crashed = await spawn('crash-after'); await killed(crashed, 'after_commit');
    const recovered = await spawn(); await stop(recovered); await balance(w.walletId, '100.00', '3');
    expect((await metadata(pending.transactionId)).processing_attempts).toBe(2);
    expect(await scalar(`select count(*)::text as value from wagering.outbox_messages where transaction_id = ?
      and event_type = 'WagerTransactionProcessed'`, [pending.transactionId])).toBe('1');
    console.log(JSON.stringify({ scenario: 'pending_crash_after_commit', status: 'PROCESSED', attempts: 2, refundLedger: 1 }));
  });

  test('I: HTTP pending replay does not retry; terminal replay retains historical balance after later credit', async () => {
    const w = await wallet(); const bet = command(w); const refund = command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    const app = await createApplication(config);
    try {
      await app.listen(0, '127.0.0.1'); const address = app.getHttpServer().address() as { port: number };
      const { idempotencyKey, ...body } = refund;
      const post = async (payload: unknown = body) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/wagering/transactions`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey, 'x-correlation-id': 'stage6-http-trace' }, body: JSON.stringify(payload) });
        return { status: response.status, body: await response.json() as { transactionId: string; balance?: { amount: string }; idempotentReplay: boolean } };
      };
      const first = await post(); expect(first.status).toBe(202);
      expect((await post()).status).toBe(202); expect((await metadata(first.body.transactionId)).processing_attempts).toBe(1);
      await service.submit(bet); now += 2000; await service.resolveNextPendingReference();
      await service.submit(command(w, { kind: Kind.Win, money: { amount: '50.00', currency: 'BRL' } }));
      const replay = await post(); expect(replay.status).toBe(200); expect(replay.body.idempotentReplay).toBe(true); expect(replay.body.balance?.amount).toBe('100.00');
      expect((await post({ ...body, money: { amount: '11.00', currency: 'BRL' } })).status).toBe(409);
      await balance(w.walletId, '150.00', '4');
      console.log(JSON.stringify({ scenario: 'pending_http_historical_replay', terminalBalance: '100.00', currentBalance: '150.00', ledger: 4 }));
    } finally { await app.close(); }
  });

  test('J: restarting all workers resumes several persistent pending references without HTTP replays', async () => {
    const pending: Array<{ walletId: string; transactionId: string; bet: SubmitTransaction }> = [];
    for (let i = 0; i < 6; i += 1) {
      const w = await wallet(); const bet = command(w); const result = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
      pending.push({ walletId: w.walletId, transactionId: result.transactionId, bet });
    }
    const old = await Promise.all(Array.from({ length: 3 }, () => spawn('normal', { PENDING_TEST_START_PAUSED: '1' })));
    for (const r of old) await stop(r);
    const restarted = await Promise.all(Array.from({ length: 3 }, () => spawn()));
    for (const p of pending) await service.submit(p.bet);
    await Promise.all(pending.map((p) => terminal(p.transactionId)));
    for (const r of restarted) await stop(r);
    for (const p of pending) await balance(p.walletId, '100.00', '3');
  }, 30000);

  test('K: concurrent pending REFUND and ROLLBACK over one BET obey the approved single compensation policy', async () => {
    const w = await wallet(); const bet = command(w);
    const refund = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    const rollback = await service.submit(command(w, { kind: Kind.Rollback, referenceExternalTransactionId: bet.externalTransactionId }));
    await service.submit(bet); now += 1000;
    const outcomes = await Promise.all([service.resolveNextPendingReference(), service.resolveNextPendingReference(), service.resolveNextPendingReference()]);
    // SKIP LOCKED may skip the wallet while the first transaction is in flight; drain the remaining candidate explicitly.
    await service.resolveNextPendingReference();
    expect([(await metadata(refund.transactionId)).status, (await metadata(rollback.transactionId)).status].sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(outcomes.filter(Boolean).length).toBeGreaterThan(0); await balance(w.walletId, '100.00', '3');
  });

  test('claim is recovered after SIGKILL and after a live abandoned session exceeds idle timeout', async () => {
    for (const mode of ['crash-claim', 'pause-claim']) {
      const w = await wallet(); const bet = command(w); const pending = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
      await service.submit(bet); const abandoned = await spawn(mode, { PENDING_REFERENCE_IDLE_TIMEOUT_MS: '300' });
      if (mode === 'crash-claim') await killed(abandoned, 'claimed');
      else await until(async () => abandoned.notices.some((n) => n.event === 'claimed'));
      const recovered = await spawn(); await terminal(pending.transactionId); await stop(recovered);
      if (mode === 'pause-claim') { expect(abandoned.child.exitCode).toBeNull(); abandoned.child.kill('SIGKILL'); await killed(abandoned, 'claimed'); }
      expect((await metadata(pending.transactionId)).processing_attempts).toBe(2); await balance(w.walletId, '100.00', '3');
    }
  }, 30000);

  test('a locked wallet is skipped while an independent pending wallet advances', async () => {
    const a = await wallet(); const b = await wallet(); const betA = command(a); const betB = command(b);
    await service.submit(command(a, { kind: Kind.Refund, referenceExternalTransactionId: betA.externalTransactionId }));
    await service.submit(command(b, { kind: Kind.Refund, referenceExternalTransactionId: betB.externalTransactionId }));
    await service.submit(betA); await service.submit(betB); now += 1000;
    let release!: () => void; let announce!: () => void;
    const held = new Promise<void>((resolve) => { announce = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const locking = owner.em.fork().transactional(async (em) => { await em.execute('select id from wagering.wallets where id = ? for update', [a.walletId]); announce(); await gate; });
    await held;
    try { expect((await service.resolveNextPendingReference())?.walletId).toBe(b.walletId); await balance(b.walletId, '100.00', '3'); }
    finally { release(); await locking; }
    await service.resolveNextPendingReference(); await balance(a.walletId, '100.00', '3');
  });

  test('real PostgreSQL lock timeout does not consume a financial attempt or reject a valid reference', async () => {
    const w = await wallet(); const bet = command(w); const pending = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    await service.submit(bet); now += 1000;
    const limited = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: name,
      DB_USER: login.name, DB_PASSWORD: login.password, DEPENDENCY_TIMEOUT_MS: '100' })), connect: true });
    let release!: () => void; let announce!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const held = new Promise<void>((resolve) => { announce = resolve; });
    const locking = owner.em.fork().transactional(async (em) => { await em.execute('lock table wagering.wager_transactions in access exclusive mode'); announce(); await gate; });
    await held;
    try {
      const constrained = new FinancialService(new PostgresFinancialUnitOfWork(limited), policy, () => new Date(now));
      await expect(constrained.resolveNextPendingReference()).rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
    } finally { release(); await locking; await limited.close(true); }
    expect((await metadata(pending.transactionId)).processing_attempts).toBe(1);
    expect((await service.resolveNextPendingReference())?.result).toBe('PROCESSED'); await balance(w.walletId, '100.00', '3');
  });

  test('scheduler commits with SQS unavailable and the publisher later delivers its durable events', async () => {
    const w = await wallet(); const bet = command(w); const pending = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    await service.submit(bet); const scheduler = await spawn('production', { SQS_ENDPOINT: 'http://127.0.0.1:1' });
    await terminal(pending.transactionId); await stop(scheduler); await balance(w.walletId, '100.00', '3');
    const store = new PostgresOutboxStore(runtime);
    const broken = createSqsClient(loadConfig({ ...process.env, SQS_ENDPOINT: 'http://127.0.0.1:1' }));
    try { await expect(new OutboxPublisher(config, broken, store, undefined, logger).tick()).rejects.toThrow(); }
    finally { broken.destroy(); }
    expect(await scalar('select count(*)::text as value from wagering.outbox_messages where transaction_id = ? and published_at is null', [pending.transactionId])).toBe('3');
    const publisher = new OutboxPublisher(config, client, store, undefined, logger);
    for (let i = 0; i < 200; i += 1) if (await publisher.tick() === 0) break;
    expect(await scalar('select count(*)::text as value from wagering.outbox_messages where transaction_id = ? and published_at is not null', [pending.transactionId])).toBe('3');
  }, 30000);

  test('deadline is immutable, terminal work is excluded and metadata updates retain existing privileges', async () => {
    const w = await wallet(); const pending = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: id() }));
    let error: unknown;
    try { await runtime.em.fork().transactional(async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [w.walletId]);
      await em.execute("update wagering.wager_transactions set reference_deadline_at = reference_deadline_at + interval '1 hour' where id = ?", [pending.transactionId]);
    }); } catch (caught) { error = caught; }
    expect(sqlState(error)).toBe('23514');
    const privileges = await runtime.em.fork().execute<Array<{ deadline: boolean; ledger: boolean; ddl: boolean }>>(`select
      has_column_privilege(current_user, 'wagering.wager_transactions', 'reference_deadline_at', 'UPDATE') as deadline,
      has_table_privilege(current_user, 'wagering.wallet_ledger_entries', 'UPDATE') as ledger,
      has_schema_privilege(current_user, 'wagering', 'CREATE') as ddl`);
    expect(privileges[0]).toEqual({ deadline: true, ledger: false, ddl: false });
    now += 86400000; await service.resolveNextPendingReference();
    expect(await service.resolveNextPendingReference()).toBeUndefined(); await balance(w.walletId, '100.00', '1');
  });
});
