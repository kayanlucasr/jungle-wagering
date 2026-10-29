import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/infrastructure/config/environment';
import { ormOptions } from '../../src/infrastructure/persistence/orm-options';
import { provisionAccess } from '../../src/infrastructure/persistence/provision-access';
import { PostgresFinancialUnitOfWork } from '../../src/infrastructure/persistence/financial-unit-of-work';
import { FinancialPolicy } from '../../src/domain/wagering/financial-policy';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind';
import type { SubmitTransaction } from '../../src/application/financial/payload-hash';
import { payloadHash } from '../../src/application/financial/payload-hash';
import { request as nodeRequest } from 'node:http';
import { createApplication } from '../../src/bootstrap';
import { FailureCode } from '../../src/domain/errors/domain-error';

interface HttpWallet { id: string; playerId: string; currency: string; balance: { amount: string; currency: string }; version: string }
interface HttpTransaction { transactionId: string; status: string; balance?: { amount: string; currency: string };
  walletVersion?: string; failureCode?: string; idempotentReplay: boolean }
interface HttpLedger { items: Array<{ id: string; transactionId: string; walletVersion: string;
  direction: string; money: { amount: string; currency: string } }>; nextCursor: string | null }
interface Ready { url: string; processId: number; backendPid: number }

describe('Stage 4 real HTTP API across three independent Nest processes', () => {
  let admin: MikroORM;
  let databaseAdmin: MikroORM;
  let owner: MikroORM;
  let runtime: MikroORM;
  let uow: PostgresFinancialUnitOfWork;
  let databaseName: string;
  const login = { name: 'stage4_http_runtime', password: 'isolated_http_runtime_only' };
  const migrationLogin = { name: 'stage4_http_migrator', password: 'isolated_http_migration_only' };
  const replicas: Ready[] = [];
  const children: Array<{ child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>; output: Promise<void>; stderr: Promise<string> }> = [];
  const id = () => crypto.randomUUID();

  beforeAll(async () => {
    const initial = loadConfig();
    if (initial.nodeEnv !== 'test' || !/^jungle_wagering_test(?:_|$)/.test(initial.database.name)) throw new Error('IsolatedHttpTestDatabaseRequired');
    databaseName = `jungle_wagering_test_http_${id().replaceAll('-', '')}`;
    admin = await MikroORM.init({ ...ormOptions(initial), connect: true });
    await admin.em.execute(`create database "${databaseName}"`);
    databaseAdmin = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: databaseName })), connect: true });
    await databaseAdmin.getMigrator().up({ to: 'Migration20261028000100' });
    await provisionAccess(databaseAdmin, migrationLogin, login);
    owner = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: databaseName,
      DB_USER: migrationLogin.name, DB_PASSWORD: migrationLogin.password }), true), connect: true });
    await owner.getMigrator().up();
    runtime = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: databaseName,
      DB_USER: login.name, DB_PASSWORD: login.password, DEPENDENCY_TIMEOUT_MS: '10000' })), connect: true });
    uow = new PostgresFinancialUnitOfWork(runtime);
    for (let index = 0; index < 3; index += 1) {
      const child = Bun.spawn([process.execPath, 'test/support/http-process.ts'], {
        env: { ...process.env, DB_NAME: databaseName, DB_USER: login.name, DB_PASSWORD: login.password,
          DB_POOL_MAX: '6', DEPENDENCY_TIMEOUT_MS: '10000', LOG_LEVEL: 'error' },
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      let announce!: (ready: Ready) => void;
      const ready = new Promise<Ready>((resolve) => { announce = resolve; });
      const output = (async () => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              const value = JSON.parse(line) as Ready & { event: string };
              if (value.event === 'http_test_ready') announce(value);
            }
          }
        } finally { reader.releaseLock(); }
      })();
      children.push({ child, output, stderr: new Response(child.stderr).text() });
      replicas.push(await Promise.race([ready, Bun.sleep(15000).then(() => { throw new Error('HttpReplicaNotReady'); })]));
    }
    expect(new Set(replicas.map((r) => r.processId)).size).toBe(3);
    expect(new Set(replicas.map((r) => r.backendPid)).size).toBe(3);
  }, 30000);

  afterAll(async () => {
    for (const item of children) item.child.stdin.end();
    for (const item of children) {
      const killTimer = setTimeout(() => item.child.kill(), 5000);
      try {
        expect(await item.child.exited).toBe(0);
        await item.output;
        expect(await item.stderr).toBe('');
      } finally { clearTimeout(killTimer); }
    }
    await runtime?.close(true); await owner?.close(true); await databaseAdmin?.close(true);
    if (admin && /^jungle_wagering_test_http_[a-f0-9]{32}$/.test(databaseName)) await admin.em.execute(`drop database "${databaseName}"`);
    await admin?.close(true);
  });

  async function http<T>(path: string, options: RequestInit = {}, index = 0) {
    const response = await fetch(`${replicas[index]!.url}${path}`, options);
    return { status: response.status, headers: response.headers, body: await response.json() as T };
  }
  function json(body: unknown, key?: string): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) }, body: JSON.stringify(body) };
  }
  async function wallet(amount = '100.00', playerId = id()): Promise<HttpWallet> {
    const result = await http<HttpWallet>('/wallets', json({ playerId, initialBalance: { amount, currency: 'BRL' } }));
    expect(result.status).toBe(201);
    expect(result.body.balance).toEqual({ amount, currency: 'BRL' });
    expect(result.body.version).toBe('1');
    return result.body;
  }
  function transaction(w: HttpWallet, overrides: Partial<Omit<SubmitTransaction, 'idempotencyKey'>> = {}): Omit<SubmitTransaction, 'idempotencyKey'> {
    return { providerId: 'provider-http', externalTransactionId: id(), playerId: w.playerId, walletId: w.id,
      roundId: 'round-http', gameId: 'game-http', kind: Kind.Bet, money: { amount: '10.00', currency: 'BRL' }, ...overrides };
  }
  const submit = (body: ReturnType<typeof transaction>, key = id(), index = 0) =>
    http<HttpTransaction>('/wagering/transactions', json(body, key), index);
  async function check(w: HttpWallet, expectedBalance: string, expectedEntries?: number) {
    const current = await http<HttpWallet>(`/wallets/${w.id}`);
    expect(current.status).toBe(200); expect(current.body.balance.amount).toBe(expectedBalance);
    const reconciliation = await http<{ consistent: boolean; checkedEntries: number;
      storedBalance: { amount: string }; calculatedBalance: { amount: string }; difference: { amount: string } }>(`/wallets/${w.id}/reconciliation`, { method: 'POST' });
    expect(reconciliation.status).toBe(200); expect(reconciliation.body.consistent).toBe(true);
    expect(reconciliation.body.storedBalance.amount).toBe(expectedBalance);
    expect(reconciliation.body.calculatedBalance.amount).toBe(expectedBalance);
    expect(reconciliation.body.difference.amount).toBe('0.00');
    if (expectedEntries !== undefined) expect(reconciliation.body.checkedEntries).toBe(expectedEntries);
  }

  test('all three replicas serve unchanged public health checks and safe tracing headers', async () => {
    for (let index = 0; index < replicas.length; index += 1) {
      for (const path of ['/health/live', '/health/ready']) expect((await http(path, {}, index)).status).toBe(200);
    }
    const a = await http('/health/live', { headers: { 'x-correlation-id': 'http-correlation-a', 'x-request-id': 'untrusted-request-id' } });
    const b = await http('/health/live', { headers: { 'x-correlation-id': 'http-correlation-a' } });
    expect(a.headers.get('x-correlation-id')).toBe('http-correlation-a');
    expect(a.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(a.headers.get('x-request-id')).not.toBe(b.headers.get('x-request-id'));
  });

  test('wallet opening/reading serializes exact money and string versions, including zero opening', async () => {
    const zero = await wallet('0.00');
    await check(zero, '0.00', 0);
    const w = await wallet();
    const read = await http<HttpWallet & { createdAt: string; updatedAt: string }>(`/wallets/${w.id}`);
    expect(read.body.playerId).toBe(w.playerId); expect(read.body.currency).toBe('BRL');
    expect(read.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); expect(read.body.updatedAt).toBe(read.body.createdAt);
    const ledger = await http<HttpLedger>(`/wallets/${w.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1); expect(ledger.body.items[0]!.walletVersion).toBe('1');
    expect(ledger.body.items[0]!.direction).toBe('CREDIT'); await check(w, '100.00', 1);
  });

  test('concurrent duplicate wallet opening across replicas yields 201 and 409, one wallet only', async () => {
    const playerId = id();
    const body = { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } };
    const results = await Promise.all([http<HttpWallet>('/wallets', json(body), 0), http<HttpWallet>('/wallets', json(body), 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const rows = await runtime.em.execute<Array<{ count: string }>>('select count(*)::text as count from wagering.wallets where player_id = ?', [playerId]);
    expect(rows[0]!.count).toBe('1');
  });

  test('mandatory historical replay returns 80.00 while actual balance stays 130.00 with three ledger entries', async () => {
    const w = await wallet(); const key = id();
    const bet = transaction(w, { money: { amount: '20.00', currency: 'BRL' } });
    const first = await submit(bet, key, 0); expect(first.status).toBe(200);
    expect(first.body.balance!.amount).toBe('80.00'); expect(first.body.idempotentReplay).toBe(false);
    const win = await submit(transaction(w, { kind: Kind.Win, money: { amount: '50.00', currency: 'BRL' } }), id(), 1);
    expect(win.body.balance!.amount).toBe('130.00');
    const replay = await submit(bet, key, 2);
    expect(replay.status).toBe(200); expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    await check(w, '130.00', 3);
    const byId = await http<{ id: string; result: { balance: { amount: string } } }>(`/wagering/transactions/${first.body.transactionId}`);
    const byExternal = await http(`/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`);
    expect(byId.status).toBe(200); expect(byExternal.body).toEqual(byId.body);
    expect(byId.body.result.balance.amount).toBe('80.00');
    console.log(JSON.stringify({ scenario: 'http_historical_replay', observedAfterBet: '80.00',
      currentAfterWin: '130.00', replayBalance: replay.body.balance!.amount, ledgerEntries: 3 }));
  });

  test('BET rejection is 422 with persistent snapshot; WIN/LOSS/REFUND/ROLLBACK use the original domain', async () => {
    const w = await wallet();
    const bet = transaction(w); const processed = await submit(bet); expect(processed.status).toBe(200);
    const insufficient = await submit(transaction(w, { money: { amount: '100.00', currency: 'BRL' } }));
    expect(insufficient.status).toBe(422); expect(insufficient.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    const loss = await submit(transaction(w, { kind: Kind.Loss, money: { amount: '0.00', currency: 'BRL' } }));
    expect(loss.status).toBe(200); expect(loss.body.walletVersion).toBe(processed.body.walletVersion);
    const refund = transaction(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submit(refund)).status).toBe(200);
    expect((await submit(transaction(w, { kind: Kind.Rollback, referenceExternalTransactionId: refund.externalTransactionId }))).status).toBe(200);
    const duplicate = await submit(transaction(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    expect(duplicate.status).toBe(422); expect(duplicate.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    await check(w, '90.00', 4);
  });

  test('invalid reference kind/context/amount and reversal insufficient funds are auditable 422 responses', async () => {
    const w = await wallet('0.00');
    const win = transaction(w, { kind: Kind.Win }); await submit(win);
    const invalidKind = await submit(transaction(w, { kind: Kind.Refund, referenceExternalTransactionId: win.externalTransactionId }));
    expect(invalidKind.status).toBe(422); expect(invalidKind.body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
    const bet = transaction(w); await submit(bet);
    const insufficient = await submit(transaction(w, { kind: Kind.Rollback, referenceExternalTransactionId: win.externalTransactionId }));
    expect(insufficient.status).toBe(422); expect(insufficient.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    const amount = await submit(transaction(w, { kind: Kind.Refund, money: { amount: '9.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId }));
    expect(amount.status).toBe(422); expect(amount.body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    const other = await wallet();
    const foreign = await submit(transaction(other, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    expect(foreign.status).toBe(422); expect(foreign.body.failureCode).toBe('REFERENCE_CONTEXT_MISMATCH');
    await check(w, '0.00', 2);
  });

  test('idempotency header is mandatory and the sole source; payload/key/identity conflicts are 409', async () => {
    const w = await wallet(); const body = transaction(w); const key = id();
    expect((await http('/wagering/transactions', json(body))).status).toBe(400);
    expect((await http('/wagering/transactions', json({ ...body, idempotencyKey: key }, key))).status).toBe(400);
    expect((await submit(body, key)).status).toBe(200);
    for (const [changed, header] of [[{ ...body, money: { amount: '11.00', currency: 'BRL' } }, key],
      [body, id()], [{ ...body, externalTransactionId: id() }, key]] as const) {
      const result = await submit(changed, header, 1);
      expect(result.status).toBe(409); expect((result.body as unknown as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');
    }
    await check(w, '90.00', 2);
  });

  test('duplicate Idempotency-Key header is rejected instead of silently merging identities', async () => {
    const w = await wallet();
    const body = JSON.stringify(transaction(w));
    const status = await new Promise<number>((resolve, reject) => {
      const req = nodeRequest(`${replicas[0]!.url}/wagering/transactions`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': [id(), id()] } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject); req.end(body);
    });
    expect(status).toBe(400); await check(w, '100.00', 1);
  });

  test('pending-reference replay is 202 until an internal test transaction completes it, then replays the terminal snapshot', async () => {
    const w = await wallet(); const bet = transaction(w); const key = id();
    const refund = transaction(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    const first = await submit(refund, key); expect(first.status).toBe(202); expect(first.body.balance).toBeUndefined();
    expect((await submit(refund, key, 1)).body).toEqual({ ...first.body, idempotentReplay: true });
    await submit(bet);
    // Test-only internal completion using the approved domain/lock/UoW. No worker or endpoint is introduced.
    await uow.write(async (s) => {
      const currentWallet = (await s.wallets.find(w.id, true))!;
      const current = (await s.transactions.find(first.body.transactionId, true))!;
      const reference = (await s.transactions.findExternal(bet.providerId, bet.externalTransactionId))!;
      const at = new Date();
      const decision = FinancialPolicy.process({ wallet: currentWallet, transaction: current, reference,
        reversals: await s.transactions.findReversals(reference.id), at, ledgerEntryId: id() });
      await s.wallets.save(decision.wallet); await s.transactions.save(decision.transaction, at);
      await s.ledger.insert(decision.ledgerEntry!);
    });
    const replay = await submit(refund, key, 2);
    expect(replay.status).toBe(200); expect(replay.body.status).toBe('PROCESSED');
    expect(replay.body.balance!.amount).toBe('100.00'); expect(replay.body.idempotentReplay).toBe(true);
    expect((await http<{ status: string }>(`/wagering/transactions/${first.body.transactionId}`)).body.status).toBe('PROCESSED');
    await check(w, '100.00', 3);
  });

  test('terminal rejection and permanent FAILED replay preserve status/failure/snapshot without new effects', async () => {
    const w = await wallet(); const key = id();
    const tooLarge = transaction(w, { money: { amount: '200.00', currency: 'BRL' } });
    const rejected = await submit(tooLarge, key); expect(rejected.status).toBe(422);
    await submit(transaction(w, { kind: Kind.Win, money: { amount: '50.00', currency: 'BRL' } }));
    const replay = await submit(tooLarge, key, 2);
    expect(replay.status).toBe(422); expect(replay.body).toEqual({ ...rejected.body, idempotentReplay: true });
    expect(replay.body.balance!.amount).toBe('100.00');
    const failedBody = transaction(w); const failedKey = id(); const c = { ...failedBody, idempotencyKey: failedKey };
    const pending = WagerTransaction.create({ ...c, id: id(), payloadHash: payloadHash(c), money: Money.from(c.money), at: new Date() });
    await uow.write(async (s) => {
      const current = (await s.wallets.find(w.id, true))!;
      await s.transactions.insertPending(pending);
      const at = new Date();
      await s.transactions.save(pending.fail(FailureCode.PermanentProcessingFailure,
        { balance: current.balance, walletVersion: current.version, at }), at);
    });
    const failed = await submit(failedBody, failedKey, 1);
    expect(failed.status).toBe(500); expect(failed.body.status).toBe('FAILED');
    expect(failed.body.failureCode).toBe('PERMANENT_PROCESSING_FAILURE'); expect(failed.body.idempotentReplay).toBe(true);
    expect((await http<{ status: string }>(`/wagering/transactions/${pending.id}`)).body.status).toBe('FAILED');
    const mismatch = await submit(transaction(w, { money: { amount: '10.00', currency: 'USD' } }));
    expect(mismatch.status).toBe(422); expect(mismatch.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(mismatch.body.balance).toEqual({ amount: '150.00', currency: 'BRL' });
    await check(w, '150.00', 2);
  });

  test('durably PENDING transaction returns 202 and current GET state without reprocessing', async () => {
    const w = await wallet(); const body = transaction(w); const key = id();
    const c = { ...body, idempotencyKey: key };
    const tx = WagerTransaction.create({ ...c, id: id(), payloadHash: payloadHash(c), money: Money.from(c.money), at: new Date() });
    await uow.write((s) => s.transactions.insertPending(tx));
    const replay = await submit(body, key); expect(replay.status).toBe(202); expect(replay.body.status).toBe('PENDING');
    const read = await http<{ status: string }>(`/wagering/transactions/${tx.id}`); expect(read.body.status).toBe('PENDING');
    await check(w, '100.00', 1);
  });

  test('ledger keyset pagination keeps a fixed upper version while inserts occur, across replicas', async () => {
    const w = await wallet(); await submit(transaction(w)); await submit(transaction(w));
    const first = await http<HttpLedger>(`/wallets/${w.id}/ledger?limit=1`, {}, 0);
    expect(first.body.items[0]!.walletVersion).toBe('1'); expect(first.body.nextCursor).not.toBeNull();
    await submit(transaction(w, { kind: Kind.Win }), id(), 1); // New version four is outside this traversal.
    const versions = first.body.items.map((entry) => entry.walletVersion);
    let cursor = first.body.nextCursor;
    while (cursor) {
      const page = await http<HttpLedger>(`/wallets/${w.id}/ledger?limit=1&cursor=${cursor}`, {}, 2);
      expect(page.status).toBe(200); versions.push(...page.body.items.map((entry) => entry.walletVersion)); cursor = page.body.nextCursor;
    }
    expect(versions).toEqual(['1', '2', '3']);
    expect((await http<HttpLedger>(`/wallets/${w.id}/ledger`)).body.items.map((entry) => entry.walletVersion)).toEqual(['1', '2', '3', '4']);
    const other = await wallet();
    expect((await http(`/wallets/${other.id}/ledger?cursor=${first.body.nextCursor}`)).status).toBe(400);
    for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'cursor=invalid!', 'unknown=1']) {
      expect((await http(`/wallets/${w.id}/ledger?${query}`)).status).toBe(400);
    }
  });

  test('HTTP concurrency: two 80.00 BETs over 100.00 yield 200/422 and one debit', async () => {
    const w = await wallet();
    const results = await Promise.all([0, 1].map((index) => submit(transaction(w, { money: { amount: '80.00', currency: 'BRL' } }), id(), index)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    await check(w, '20.00', 2);
  });

  test('HTTP concurrency: 50 identical requests across three replicas yield one transaction/debit', async () => {
    const w = await wallet(); const body = transaction(w); const key = id();
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(body, key, index % 3)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    const original = results.find((r) => !r.body.idempotentReplay)!.body;
    for (const result of results) expect(result.body).toEqual({ ...original, idempotentReplay: result.body.idempotentReplay });
    await check(w, '90.00', 2);
    console.log(JSON.stringify({ scenario: '50_http_duplicates_3_replicas', attempts: 50,
      processIds: replicas.map((r) => r.processId), backendPids: replicas.map((r) => r.backendPid),
      distinctTransactions: 1, debits: 1, balance: '90.00' }));
  });

  test('HTTP concurrency: global key across wallets and simultaneous REFUND/ROLLBACK never duplicate effects', async () => {
    const a = await wallet(); const b = await wallet(); const key = id();
    const shared = await Promise.all([submit(transaction(a), key, 0), submit(transaction(b), key, 1)]);
    expect(shared.map((r) => r.status).sort()).toEqual([200, 409]);
    const balances = await Promise.all([a, b].map((w) => http<HttpWallet>(`/wallets/${w.id}`)));
    expect(balances.map((r) => r.body.balance.amount).sort()).toEqual(['100.00', '90.00']);
    const w = await wallet(); const bet = transaction(w); await submit(bet);
    const reversals = await Promise.all(([Kind.Refund, Kind.Rollback] as const).map((kind, index) =>
      submit(transaction(w, { kind, referenceExternalTransactionId: bet.externalTransactionId }), id(), index + 1)));
    expect(reversals.map((r) => r.status).sort()).toEqual([200, 422]); await check(w, '100.00', 3);
  });

  test('HTTP concurrency: independent wallet commits while another wallet remains locked', async () => {
    const a = await wallet(); const b = await wallet();
    let unlock!: () => void; let lockReady!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const ready = new Promise<void>((resolve) => { lockReady = resolve; });
    const holding = runtime.em.fork().transactional(async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [a.id]); lockReady(); await gate;
    });
    await ready;
    try {
      expect((await Promise.race([submit(transaction(b), id(), 2),
        Bun.sleep(2000).then(() => { throw new Error('IndependentWalletHttpBlocked'); })])).status).toBe(200);
    } finally { unlock(); await holding; }
    await check(a, '100.00', 1); await check(b, '90.00', 2);
  });

  test('HTTP real PostgreSQL lock timeout is 503 without a permanent financial rejection', async () => {
    const w = await wallet(); const key = id(); const body = transaction(w);
    const limitedApp = await createApplication(loadConfig({ ...process.env, DB_NAME: databaseName,
      DB_USER: login.name, DB_PASSWORD: login.password, DEPENDENCY_TIMEOUT_MS: '100', LOG_LEVEL: 'error' }));
    await limitedApp.listen(0, '127.0.0.1');
    let unlock!: () => void; let announce!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const ready = new Promise<void>((resolve) => { announce = resolve; });
    const holding = runtime.em.fork().transactional(async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [w.id]); announce(); await gate;
    });
    await ready;
    try {
      const response = await fetch(`${await limitedApp.getUrl()}/wagering/transactions`, json(body, key));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
      for (const internal of ['REJECTED', 'select ', 'wagering.wallets', 'stack', login.password]) expect(text).not.toContain(internal);
    } finally { unlock(); await holding; await limitedApp.close(); }
    expect(await uow.readSnapshot((s) => s.transactions.findIdentities(body.providerId, body.externalTransactionId, key))).toHaveLength(0);
    await check(w, '100.00', 1);
  });

  test('invalid DTOs, money, kinds and unknown fields are 400 without leaking the submitted secrets', async () => {
    const w = await wallet(); const valid = transaction(w);
    const invalidBodies: unknown[] = [null, [], {}, { ...valid, secret: 'must-not-leak' }, { ...valid, kind: 'OPENING' },
      { ...valid, kind: 'REFUND' }, { ...valid, money: { amount: 10, currency: 'BRL' } },
      { ...valid, money: { amount: '1.001', currency: 'BRL' } }, { ...valid, money: { amount: '1e2', currency: 'BRL' } },
      { ...valid, money: { amount: '-1.00', currency: 'BRL' } }, { ...valid, money: { amount: '1.00', currency: 'FAKE' } },
      { ...valid, money: { ...valid.money, payloadHash: 'must-not-leak' } }, { ...valid, playerId: ' bad ' },
      { ...valid, externalTransactionId: 'bad\u0000id' }, { ...valid, externalTransactionId: 'bad\ud800id' }];
    for (const body of invalidBodies) {
      const result = await http('/wagering/transactions', json(body, id())); expect(result.status).toBe(400);
      const serialized = JSON.stringify(result.body);
      for (const secret of ['must-not-leak', 'stack', 'node_modules', 'insert into', 'isolated_http_runtime_only']) expect(serialized).not.toContain(secret);
    }
    await check(w, '100.00', 1);
  });

  test('missing resources are 404 and unknown internal/hash/idempotency data is absent from transaction GET', async () => {
    for (const path of [`/wallets/${id()}`, `/wallets/${id()}/ledger`, `/wagering/transactions/${id()}`,
      `/providers/provider-http/wagering/transactions/${id()}`]) expect((await http(path)).status).toBe(404);
    const missing = await submit(transaction(await wallet(), { walletId: id() })); expect(missing.status).toBe(404);
    const w = await wallet(); const result = await submit(transaction(w));
    const read = await http<Record<string, unknown>>(`/wagering/transactions/${result.body.transactionId}`);
    for (const field of ['payloadHash', 'idempotencyKey', 'processingAttempts', 'nextAttemptAt']) expect(read.body[field]).toBeUndefined();
  });
});
