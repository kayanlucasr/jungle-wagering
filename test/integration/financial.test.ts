import { WagerTransactionStatus as Status } from "../../src/domain/wagering/wager-transaction-status";
import { FailureCode } from "../../src/domain/errors/domain-error";
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { loadConfig, type AppConfig } from '../../src/infrastructure/config/environment';
import { ormOptions } from '../../src/infrastructure/persistence/orm-options';
import { provisionAccess } from '../../src/infrastructure/persistence/provision-access';
import { PostgresFinancialUnitOfWork, sqlState } from '../../src/infrastructure/persistence/financial-unit-of-work';
import { FinancialService, type SubmissionResult } from '../../src/application/financial/financial-service';
import type { SubmitTransaction } from '../../src/application/financial/payload-hash';
import { FinancialError } from '../../src/application/financial/errors';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind';
import type { FinancialUnitOfWork, FinancialSession } from '../../src/application/financial/ports';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { Money } from '../../src/domain/money/money';
import { PostgresTransactionRepository } from '../../src/infrastructure/persistence/repositories/transaction-repository';
import { TransactionRecord, LedgerRecord } from '../../src/infrastructure/persistence/entities/financial-records';
import { transactionToRecord, ledgerToRecord } from '../../src/infrastructure/persistence/mappers/financial-mappers';
import { payloadHash } from '../../src/application/financial/payload-hash';
import { reconcile } from '../../src/application/financial/reconciliation';

describe('Stage 3 financial integrity on real PostgreSQL', () => {
  let admin: MikroORM;
  let databaseAdmin: MikroORM;
  let owner: MikroORM;
  let runtime: MikroORM;
  let config: AppConfig;
  let service: FinancialService;
  let uow: PostgresFinancialUnitOfWork;
  let name: string;
  const login = { name: 'stage3_runtime', password: 'isolated_runtime_test_only' };
  const migrationLogin = { name: 'stage3_migrator', password: 'isolated_migration_test_only' };
  const id = () => crypto.randomUUID();

  beforeAll(async () => {
    const initial = loadConfig();
    if (initial.nodeEnv !== 'test' || !/^jungle_wagering_test(?:_|$)/.test(initial.database.name)) {
      throw new Error('Financial tests require an isolated test database');
    }
    name = `jungle_wagering_test_financial_${id().replaceAll('-', '')}`;
    admin = await MikroORM.init({ ...ormOptions(initial), connect: true });
    await admin.em.execute(`create database "${name}"`);
    const adminConfig = loadConfig({ ...process.env, DB_NAME: name });
    databaseAdmin = await MikroORM.init({ ...ormOptions(adminConfig), connect: true });
    await databaseAdmin.getMigrator().up({ to: 'Migration20261028000100' });
    await provisionAccess(databaseAdmin, migrationLogin, login);
    const ownerConfig = loadConfig({ ...process.env, DB_NAME: name,
      DB_USER: migrationLogin.name, DB_PASSWORD: migrationLogin.password, DEPENDENCY_TIMEOUT_MS: '10000' });
    owner = await MikroORM.init({ ...ormOptions(ownerConfig, true), connect: true });
    config = loadConfig({ ...process.env, DB_NAME: name, DB_USER: login.name,
      DB_PASSWORD: login.password, DB_POOL_MAX: '10', DEPENDENCY_TIMEOUT_MS: '10000' });
    runtime = await MikroORM.init({ ...ormOptions(config), connect: true });
    uow = new PostgresFinancialUnitOfWork(runtime);
    service = new FinancialService(uow);
  }, 30000);

  afterAll(async () => {
    await runtime?.close(true);
    await owner?.close(true);
    await databaseAdmin?.close(true);
    if (admin && /^jungle_wagering_test_financial_[a-f0-9]{32}$/.test(name)) {
      await admin.em.execute(`drop database "${name}"`);
    }
    await admin?.close(true);
  });

  async function wallet(balance = '100.00') {
    const walletId = id();
    const playerId = id();
    await service.openWallet({ id: walletId, playerId, initialBalance: { amount: balance, currency: 'BRL' } });
    return { walletId, playerId };
  }
  function command(w: { walletId: string; playerId: string }, overrides: Partial<SubmitTransaction> = {}): SubmitTransaction {
    return { ...w, providerId: 'provider-a', externalTransactionId: id(), idempotencyKey: id(),
      roundId: 'round-a', gameId: 'game-a', kind: Kind.Bet, money: { amount: '10.00', currency: 'BRL' }, ...overrides };
  }
  async function rejectedSql(orm: MikroORM, sql: string, params: unknown[] = [], code = '23514') {
    await rejectedWork(orm, (em) => em.execute(sql, params), code);
  }
  async function rejectedWork(orm: MikroORM, work: (em: EntityManager) => Promise<unknown>, code = '23514') {
    let caught: unknown;
    try { await orm.em.fork().transactional(work); }
    catch (error: unknown) { caught = error; }
    expect(caught).toBeDefined();
    expect(sqlState(caught)).toBe(code);
  }
  function pending(c: SubmitTransaction) {
    return WagerTransaction.create({ ...c, id: id(), at: new Date(), money: Money.from(c.money), payloadHash: payloadHash(c) });
  }
  async function assertBalance(walletId: string, balance: string, debitCount?: string) {
    const result = await service.reconcile(walletId);
    expect(result.consistent).toBe(true);
    expect(result.storedBalance).toBe(balance);
    if (debitCount !== undefined) {
      const rows = await runtime.em.execute<Array<{ count: string }>>(`select count(*)::text as count
        from wagering.wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);
      expect(rows[0]!.count).toBe(debitCount);
    }
    return result;
  }

  test('official migration up/down/up as owner; complete financial catalog restored', async () => {
    const migrator = owner.getMigrator();
    await migrator.up();
    expect(await migrator.getPendingMigrations()).toHaveLength(0);
    const catalog = () => owner.em.execute<Array<{ count: string }>>(`select count(*)::text as count
      from information_schema.tables where table_schema = 'wagering'`);
    expect((await catalog())[0]!.count).toBe('5');
    await migrator.down({ migrations: ['Migration20261028000200'] });
    expect((await catalog())[0]!.count).toBe('0');
    await migrator.up();
    expect((await catalog())[0]!.count).toBe('5');
    const triggers = await owner.em.execute<Array<{ count: string }>>(`select count(*)::text as count
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wagering' and not t.tgisinternal`);
    expect(triggers[0]!.count).toBe('20');
    const ownership = await owner.em.execute<Array<{ owner: string }>>(`select distinct tableowner as owner
      from pg_tables where schemaname = 'wagering'`);
    expect(ownership).toEqual([{ owner: 'wagering_owner' }]);
  });

  test('actual runtime role supports wallet opening, processed/rejected transactions, string NUMERIC and bigint versions', async () => {
    const identity = await runtime.em.execute<Array<{ current_user: string; superuser: boolean }>>(`select current_user,
      (select rolsuper from pg_roles where rolname = current_user) as superuser`);
    expect(identity[0]).toEqual({ current_user: login.name, superuser: false });
    const w = await wallet();
    await service.submit(command(w));
    const rejected = await service.submit(command(w, { money: { amount: '100.00', currency: 'BRL' } }));
    expect(rejected.status).toBe(Status.Rejected);
    await assertBalance(w.walletId, '90.00', '1');
    const rows = await runtime.em.execute<Array<{ balance: unknown; version: unknown }>>(
      'select balance, version from wagering.wallets where id = ?', [w.walletId]);
    expect(typeof rows[0]!.balance).toBe('string');
    expect(typeof rows[0]!.version).toBe('string');
    await expect(new FinancialService(new PostgresFinancialUnitOfWork(owner)).submit(command(w)))
      .rejects.toMatchObject({ code: 'UNSAFE_DATABASE_ROLE' });
  });

  test('zero opening has no ledger; first credit uses version two; LOSS does not advance balance/version', async () => {
    const w = await wallet('0.00');
    const zero = await assertBalance(w.walletId, '0.00');
    expect(zero.entryCount).toBe('0');
    expect(zero.storedVersion).toBe('1');
    await service.submit(command(w, { kind: Kind.Win }));
    const credited = await assertBalance(w.walletId, '10.00');
    expect(credited.storedVersion).toBe('2');
    const loss = await service.submit(command(w, { kind: Kind.Loss, money: { amount: '0.00', currency: 'BRL' } }));
    expect(loss.status).toBe(Status.Processed);
    expect((await assertBalance(w.walletId, '10.00')).entryCount).toBe('1');
  });

  test('A: simultaneous 80.00 debits against 100.00 yield one rejection and one debit', async () => {
    const w = await wallet();
    const commands = [command(w), command(w)].map((c) => ({ ...c, money: { amount: '80.00', currency: 'BRL' } }));
    const results = await Promise.all(commands.map((c) => service.submit(c)));
    expect(results.map((r) => r.status).sort()).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === 'REJECTED')!.terminalResult!.failureCode).toBe(FailureCode.InsufficientFunds);
    await assertBalance(w.walletId, '20.00', '1');
  });

  test('B: 50 duplicates across three real processes/pools have one financial effect and identical results', async () => {
    const w = await wallet();
    const c = command(w);
    const batches = [17, 17, 16].map((size) => Array.from({ length: size }, () => c));
    const children = batches.map((batch) => {
      const child = Bun.spawn([process.execPath, 'test/support/financial-process.ts'], {
        env: { ...process.env, DB_NAME: name, DB_USER: login.name, DB_PASSWORD: login.password,
          DB_POOL_MAX: '6', DEPENDENCY_TIMEOUT_MS: '10000' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      child.stdin.write(JSON.stringify(batch));
      child.stdin.end();
      return child;
    });
    const outputs = await Promise.all(children.map(async (child) => {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(),
        new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe('');
      expect(exit).toBe(0);
      return JSON.parse(stdout) as { processId: number; backendPid: number; results: SubmissionResult[] };
    }));
    expect(new Set(outputs.map((o) => o.processId)).size).toBe(3);
    expect(new Set(outputs.map((o) => o.backendPid)).size).toBe(3);
    const results = outputs.flatMap((o) => o.results);
    expect(results).toHaveLength(50);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r.terminalResult))).size).toBe(1);
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    await assertBalance(w.walletId, '90.00', '1');
    console.log(JSON.stringify({ scenario: '50_duplicates_3_processes', attempts: 50,
      processes: outputs.map((o) => o.processId), independentBackendPids: outputs.map((o) => o.backendPid),
      distinctTransactions: 1, debits: 1, balance: '90.00' }));
  }, 30000);

  test('C: wallet B commits while wallet A is explicitly locked; no global serialization', async () => {
    const a = await wallet();
    const b = await wallet();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = runtime.em.fork().transactional(async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [a.walletId]);
      acquired();
      await gate;
    });
    await ready;
    try {
      const result = await Promise.race([service.submit(command(b)),
        Bun.sleep(2000).then(() => { throw new Error('IndependentWalletBlocked'); })]);
      expect(result.status).toBe(Status.Processed);
    } finally { release(); await held; }
    await assertBalance(a.walletId, '100.00', '0');
    await assertBalance(b.walletId, '90.00', '1');
  });

  test('D: injected failure immediately after wallet update rolls back all effects; retry applies once', async () => {
    const w = await wallet();
    const c = command(w);
    const failing: FinancialUnitOfWork = { readSnapshot: (work) => uow.readSnapshot(work),
      write: (work) => uow.write((s) => work({ ...s, wallets: { ...s.wallets,
        find: (key, lock) => s.wallets.find(key, lock), insert: (value) => s.wallets.insert(value),
        save: async (value) => { await s.wallets.save(value); throw new Error('InjectedBeforeLedger'); },
      } })) };
    await expect(new FinancialService(failing).submit(c)).rejects.toThrow('InjectedBeforeLedger');
    await assertBalance(w.walletId, '100.00', '0');
    expect(await uow.readSnapshot((s) => s.transactions.findIdentities(c.providerId, c.externalTransactionId, c.idempotencyKey))).toHaveLength(0);
    await service.submit(c);
    await assertBalance(w.walletId, '90.00', '1');
  });

  test('E: concurrent REFUND/ROLLBACK over one BET produces one compensation only', async () => {
    const w = await wallet();
    const bet = command(w);
    await service.submit(bet);
    const results = await Promise.all(([Kind.Refund, Kind.Rollback] as const).map((kind) => service.submit(command(w,
      { kind, referenceExternalTransactionId: bet.externalTransactionId }))));
    expect(results.map((r) => r.status).sort()).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === 'REJECTED')!.terminalResult!.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    const result = await assertBalance(w.walletId, '100.00', '1');
    expect(result.entryCount).toBe('3');
  });

  test('terminal replay preserves original balance after later movements; conflicting payload/key/identity are explicit', async () => {
    const w = await wallet();
    const c = command(w);
    const original = await service.submit(c);
    await service.submit(command(w));
    const replay = await service.submit(c);
    expect(replay.replay).toBe(true);
    expect(replay.terminalResult).toEqual(original.terminalResult);
    expect(replay.terminalResult!.balance.amount).toBe('90.00');
    for (const conflicting of [
      { ...c, money: { amount: '11.00', currency: 'BRL' } },
      { ...c, idempotencyKey: id() }, { ...c, externalTransactionId: id() },
    ]) await expect(service.submit(conflicting)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await assertBalance(w.walletId, '80.00', '2');
  });

  test('global idempotency key conflict across independent wallets cannot produce two effects', async () => {
    const a = await wallet(); const b = await wallet(); const key = id();
    const outcomes = await Promise.allSettled([service.submit(command(a, { idempotencyKey: key })),
      service.submit(command(b, { idempotencyKey: key }))]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(FinancialError);
    expect(failed.reason.code).toBe('IDEMPOTENCY_CONFLICT');
    const balances = [(await service.reconcile(a.walletId)).storedBalance, (await service.reconcile(b.walletId)).storedBalance];
    expect(balances.sort()).toEqual(['100.00', '90.00']);
  });

  test('pending-reference replay remains pending after reference arrives; no implicit worker', async () => {
    const w = await wallet();
    const bet = command(w);
    const refund = command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await service.submit(refund);
    expect(pending.status).toBe(Status.PendingReference);
    expect(pending.terminalResult).toBeUndefined();
    await service.submit(bet);
    expect((await service.submit(refund)).status).toBe(Status.PendingReference);
    await assertBalance(w.walletId, '90.00', '1');
  });

  test('a durably PENDING record replays without processing; crossed identities are conflicts', async () => {
    const w = await wallet();
    const c = command(w);
    await runtime.em.fork().transactional((em) => new PostgresTransactionRepository(em).insertPending(pending(c)));
    const replay = await service.submit(c);
    expect(replay.status).toBe(Status.Pending);
    expect(replay.replay).toBe(true);
    expect(replay.terminalResult).toBeUndefined();
    const a = command(w); const b = command(w);
    await service.submit(a); await service.submit(b);
    await expect(service.submit({ ...a, idempotencyKey: b.idempotencyKey })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await assertBalance(w.walletId, '80.00', '2');
  });

  test('reconciliation snapshot stays consistent while another connection commits; read session rejects writes', async () => {
    const w = await wallet();
    const result = await uow.readSnapshot(async (s) => {
      const oldWallet = await s.wallets.find(w.walletId);
      await service.submit(command(w));
      return reconcile(oldWallet!, await s.ledger.findByWallet(w.walletId), await s.transactions.findByWallet(w.walletId));
    });
    expect(result.consistent).toBe(true);
    expect(result.storedBalance).toBe('100.00');
    await assertBalance(w.walletId, '90.00');
    let code: string | undefined;
    try { await uow.readSnapshot(async (s) => s.wallets.save((await s.wallets.find(w.walletId))!)); }
    catch (error: unknown) { code = sqlState(error); }
    expect(code).toBe('25006');
  });

  test('real deadlock retries the complete Unit of Work on a fresh transaction without financial effects', async () => {
    const a = await wallet(); const b = await wallet();
    let arrivals = 0;
    let attempts = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const contender = (first: string, second: string) => {
      let initial = true;
      return uow.write(async (s) => {
        attempts += 1;
        await s.wallets.find(first, true);
        if (initial) {
          initial = false;
          arrivals += 1;
          if (arrivals === 2) release();
          await barrier;
        }
        await s.wallets.find(second, true);
        return 'committed';
      });
    };
    expect(await Promise.all([contender(a.walletId, b.walletId), contender(b.walletId, a.walletId)]))
      .toEqual(['committed', 'committed']);
    expect(attempts).toBeGreaterThanOrEqual(3);
    await assertBalance(a.walletId, '100.00'); await assertBalance(b.walletId, '100.00');
  });

  test('real lock timeout returns transient unavailability and never persists a financial rejection', async () => {
    const w = await wallet(); const c = command(w);
    const limited = await MikroORM.init({ ...ormOptions(loadConfig({ ...process.env, DB_NAME: name,
      DB_USER: login.name, DB_PASSWORD: login.password, DEPENDENCY_TIMEOUT_MS: '100' })), connect: true });
    let release!: () => void; let acquired!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = runtime.em.fork().transactional(async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [w.walletId]);
      acquired(); await gate;
    });
    await ready;
    try {
      await expect(new FinancialService(new PostgresFinancialUnitOfWork(limited)).submit(c))
        .rejects.toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
    } finally { release(); await held; await limited.close(true); }
    expect(await uow.readSnapshot((s) => s.transactions.findIdentities(c.providerId, c.externalTransactionId, c.idempotencyKey))).toHaveLength(0);
    await assertBalance(w.walletId, '100.00', '0');
  });

  test('currency/player mismatch is an auditable rejection with the real wallet snapshot', async () => {
    const w = await wallet();
    for (const c of [command(w, { playerId: id() }), command(w, { money: { amount: '10.00', currency: 'USD' } })]) {
      const result = await service.submit(c);
      expect(result.status).toBe(Status.Rejected);
      expect(result.terminalResult!.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    }
    await assertBalance(w.walletId, '100.00', '0');
  });

  test('runtime ledger UPDATE/DELETE/TRUNCATE and DDL/migration-history access are denied', async () => {
    for (const sql of ['update wagering.wallet_ledger_entries set amount = amount',
      'delete from wagering.wallet_ledger_entries', 'truncate wagering.wallet_ledger_entries',
      'alter table wagering.wallet_ledger_entries disable trigger all',
      'create table wagering.forbidden (id integer)', 'select * from public.mikro_orm_migrations']) {
      await rejectedSql(runtime, sql, [], '42501');
    }
    for (const table of ['inbox_messages', 'outbox_messages']) {
      const rows = await runtime.em.execute<Array<{ allowed: boolean }>>('select has_table_privilege(current_user, ?, ?) as allowed', [`wagering.${table}`, 'INSERT']);
      expect(rows[0]!.allowed).toBe(false);
    }
  });

  test('owner cannot UPDATE/DELETE/TRUNCATE ledger without administratively disabling protection', async () => {
    const w = await wallet();
    for (const sql of ['update wagering.wallet_ledger_entries set amount = amount where wallet_id = ?',
      'delete from wagering.wallet_ledger_entries where wallet_id = ?']) await rejectedSql(owner, sql, [w.walletId]);
    await rejectedSql(owner, 'truncate wagering.wallet_ledger_entries');
    await assertBalance(w.walletId, '100.00');
  });

  test('money constraints reject negative/special/overflow/excess-scale values, including direct SQL', async () => {
    const w = await wallet();
    for (const amount of ['-0.01', 'NaN', 'Infinity', '-Infinity', '1000000000000000000.00', '1.001', '1.005']) {
      await rejectedSql(runtime, 'update wagering.wallets set balance = ?::numeric, version = version + 1 where id = ?', [amount, w.walletId]);
    }
    const max = await wallet('999999999999999999.99');
    await assertBalance(max.walletId, '999999999999999999.99');
  });

  test('wallet identity/version and terminal records are protected by SQL, not just domain', async () => {
    const w = await wallet();
    const result = await service.submit(command(w));
    await rejectedSql(owner, 'update wagering.wallets set player_id = ? where id = ?', [id(), w.walletId]);
    await rejectedSql(runtime, 'update wagering.wallets set version = version + 1 where id = ?', [w.walletId]);
    await rejectedSql(runtime, 'update wagering.wallets set balance = balance - 1, version = version + 2 where id = ?', [w.walletId]);
    for (const update of ["status = 'PENDING'", 'terminal_result = terminal_result', 'updated_at = updated_at']) {
      await rejectedSql(runtime, `update wagering.wager_transactions set ${update} where id = ?`, [result.transactionId]);
    }
    await rejectedSql(owner, 'delete from wagering.wager_transactions where id = ?', [result.transactionId]);
  });

  test('wallet mutation without ledger fails at COMMIT and restores balance/version', async () => {
    const w = await wallet();
    await rejectedSql(runtime, 'update wagering.wallets set balance = balance - 10, version = version + 1 where id = ?', [w.walletId]);
    await assertBalance(w.walletId, '100.00', '0');
  });

  test('PROCESSED transaction without its expected movement/ledger is refused at COMMIT', async () => {
    const w = await wallet();
    const tx = pending(command(w));
    await rejectedWork(runtime, async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [w.walletId]);
      const repository = new PostgresTransactionRepository(em);
      await repository.insertPending(tx);
      const at = new Date();
      await repository.save(tx.markProcessed({ balance: Money.from({ amount: '100.00', currency: 'BRL' }),
        walletVersion: 1n, at }), at);
    });
    await assertBalance(w.walletId, '100.00', '0');
  });

  test('ledger for LOSS/PENDING/REJECTED/FAILED cannot commit, even with a valid numeric equation', async () => {
    for (const status of [Status.Processed, Status.Pending, Status.Rejected, Status.Failed]) {
      const w = await wallet('0.00');
      const tx = pending(command(w, { kind: status === Status.Processed ? Kind.Loss : Kind.Bet }));
      await rejectedWork(runtime, async (em) => {
        await em.execute('select id from wagering.wallets where id = ? for update', [w.walletId]);
        const repository = new PostgresTransactionRepository(em);
        await repository.insertPending(tx);
        const at = new Date();
        const context = { balance: Money.zero('BRL'), walletVersion: 1n, at };
        if (status !== Status.Pending) {
          const completed = status === Status.Processed ? tx.markProcessed(context)
            : status === Status.Rejected ? tx.reject(FailureCode.InsufficientFunds, context)
              : tx.fail(FailureCode.PermanentProcessingFailure, context);
          await repository.save(completed, at);
        }
        await em.execute(`insert into wagering.wallet_ledger_entries
          (id,wallet_id,transaction_id,wallet_version,direction,amount,currency,balance_before,balance_after,created_at)
          select ?, id, ?, version, 'DEBIT', 10.00, currency, 10.00, balance, updated_at
          from wagering.wallets where id = ?`, [id(), tx.id, w.walletId]);
      });
      await assertBalance(w.walletId, '0.00', '0');
    }
  });

  test('ledger FK, equation, wallet currency and unique transaction/version are enforced by PostgreSQL', async () => {
    const zero = await wallet('0.00');
    await rejectedSql(runtime, `insert into wagering.wallet_ledger_entries
      (id,wallet_id,transaction_id,wallet_version,direction,amount,currency,balance_before,balance_after,created_at)
      select ?, id, ?, version, 'DEBIT', 10.00, currency, 10.00, balance, updated_at
      from wagering.wallets where id = ?`, [id(), id(), zero.walletId], '23503');
    const w = await wallet();
    const entries = await uow.readSnapshot((s) => s.ledger.findByWallet(w.walletId));
    const data = ledgerToRecord(entries[0]!);
    await rejectedWork(runtime, (em) => em.insert(LedgerRecord, { ...data, id: id() }), '23505');
    await rejectedWork(runtime, (em) => em.insert(LedgerRecord, { ...data, id: id(), balanceBefore: '1.00' }));
    await rejectedWork(runtime, (em) => em.insert(LedgerRecord, { ...data, id: id(), currency: 'USD' }));
  });

  test('external identity and global key have SQL uniqueness independently of the replay adapter', async () => {
    const w = await wallet();
    const c = command(w);
    await service.submit(c);
    for (const duplicate of [command(w, { providerId: c.providerId, externalTransactionId: c.externalTransactionId }),
      command(w, { idempotencyKey: c.idempotencyKey })]) {
      await rejectedWork(runtime, (em) => em.insert(TransactionRecord, transactionToRecord(pending(duplicate))), '23505');
    }
    await assertBalance(w.walletId, '90.00', '1');
  });

  test('SQL blocks invalid processed references, immutable identity, backward transition and forged snapshot', async () => {
    const w = await wallet();
    const original = command(w);
    const processed = await service.submit(original);
    const foreign = await wallet();
    const foreignCommand = command(foreign);
    const foreignResult = await service.submit(foreignCommand);
    for (const variant of [
      { referenceExternalTransactionId: foreignCommand.externalTransactionId, referenceId: foreignResult.transactionId },
      { referenceExternalTransactionId: original.externalTransactionId, referenceId: processed.transactionId,
        money: { amount: '9.00', currency: 'BRL' } },
    ]) {
      const tx = pending(command(w, { kind: Kind.Refund, referenceExternalTransactionId: variant.referenceExternalTransactionId,
        ...(variant.money === undefined ? {} : { money: variant.money }) }));
      await rejectedWork(runtime, async (em) => {
        const repository = new PostgresTransactionRepository(em);
        await em.execute('select id from wagering.wallets where id = ? for update', [w.walletId]);
        await repository.insertPending(tx);
        const at = new Date();
        await repository.save(tx.markProcessed({ balance: Money.from({ amount: '90.00', currency: 'BRL' }),
          walletVersion: 2n, at, referenceTransactionId: variant.referenceId }), at);
      });
    }
    const waiting = await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: id() }));
    await rejectedSql(runtime, "update wagering.wager_transactions set status = 'PENDING' where id = ?", [waiting.transactionId]);
    await rejectedSql(owner, 'update wagering.wager_transactions set amount = 11.00 where id = ?', [waiting.transactionId]);
    const tx = pending(command(w, { kind: Kind.Loss, money: { amount: '0.00', currency: 'BRL' } }));
    await rejectedWork(runtime, async (em) => {
      const repository = new PostgresTransactionRepository(em);
      await repository.insertPending(tx);
      const at = new Date();
      const completed = transactionToRecord(tx.markProcessed({ balance: Money.from({ amount: '90.00', currency: 'BRL' }), walletVersion: 2n, at }));
      await em.execute(`update wagering.wager_transactions set status = 'PROCESSED', result_balance = 90,
        result_currency = 'BRL', result_wallet_version = 2, result_schema_version = 1,
        terminal_result = ?::jsonb, completed_at = ?, updated_at = ? where id = ?`,
      [JSON.stringify({ ...completed.terminalResult, walletVersion: '999' }), at, at, tx.id]);
    });
    await assertBalance(w.walletId, '90.00', '1');
  });

  test('ROLLBACK of WIN can reject insufficient funds; ROLLBACK of REFUND does not reopen original BET', async () => {
    const w = await wallet('0.00');
    const win = command(w, { kind: Kind.Win });
    await service.submit(win);
    await service.submit(command(w));
    const insufficient = await service.submit(command(w, { kind: Kind.Rollback, referenceExternalTransactionId: win.externalTransactionId }));
    expect(insufficient.terminalResult!.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    const a = await wallet();
    const bet = command(a);
    await service.submit(bet);
    const refund = command(a, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    await service.submit(refund);
    expect((await service.submit(command(a, { kind: Kind.Rollback,
      referenceExternalTransactionId: refund.externalTransactionId }))).status).toBe(Status.Processed);
    const repeated = await service.submit(command(a, { kind: Kind.Rollback, referenceExternalTransactionId: bet.externalTransactionId }));
    expect(repeated.terminalResult!.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    await assertBalance(a.walletId, '90.00', '2');
    await assertBalance(w.walletId, '0.00', '1');
  });

  test('processed reversals have SQL uniqueness across types, and rejected/failed terminals cannot be edited', async () => {
    const w = await wallet(); const bet = command(w);
    const original = await service.submit(bet);
    await service.submit(command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }));
    const duplicate = pending(command(w, { kind: Kind.Rollback, referenceExternalTransactionId: bet.externalTransactionId }));
    await rejectedWork(runtime, async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [w.walletId]);
      const repository = new PostgresTransactionRepository(em);
      await repository.insertPending(duplicate);
      const at = new Date();
      await repository.save(duplicate.markProcessed({ balance: Money.from({ amount: '100.00', currency: 'BRL' }),
        walletVersion: 3n, at, referenceTransactionId: original.transactionId }), at);
    }, '23505');
    const rejected = await service.submit(command(w, { money: { amount: '200.00', currency: 'BRL' } }));
    await rejectedSql(runtime, 'update wagering.wager_transactions set failure_code = failure_code where id = ?', [rejected.transactionId]);
    const failed = pending(command(w));
    await runtime.em.fork().transactional(async (em) => {
      const repository = new PostgresTransactionRepository(em);
      await repository.insertPending(failed);
      const at = new Date();
      await repository.save(failed.fail(FailureCode.PermanentProcessingFailure,
        { balance: Money.from({ amount: '100.00', currency: 'BRL' }), walletVersion: 3n, at }), at);
    });
    await rejectedSql(runtime, 'update wagering.wager_transactions set status = status where id = ?', [failed.id]);
    await assertBalance(w.walletId, '100.00', '1');
  });

  test('inbox/outbox prepared structures enforce immutable identities, final states and financial references', async () => {
    const w = await wallet();
    const tx = await service.submit(command(w));
    const eventId = id(); const messageId = id();
    await owner.em.fork().transactional(async (em) => {
      await em.execute(`insert into wagering.outbox_messages
        (id,transaction_id,aggregate_id,event_type,event_version,payload,occurred_at)
        values (?, ?, ?, 'WalletBalanceChanged', 1, ?::jsonb, ?)`,
      [eventId, tx.transactionId, w.walletId, JSON.stringify({ amount: '10.00' }), new Date()]);
      await em.execute(`insert into wagering.inbox_messages
        (consumer_name,message_id,payload_hash,transaction_id,received_at,processed_at)
        values ('consumer-a', ?, ?, ?, ?, ?)`, [messageId, 'ab'.repeat(32), tx.transactionId, new Date(), new Date()]);
    });
    await rejectedSql(owner, 'update wagering.outbox_messages set payload = ?::jsonb where id = ?', ['{}', eventId]);
    await rejectedSql(owner, 'update wagering.inbox_messages set processed_at = processed_at where message_id = ?', [messageId]);
    await owner.em.execute('update wagering.outbox_messages set published_at = ? where id = ?', [new Date(), eventId]);
    await rejectedSql(owner, 'update wagering.outbox_messages set attempts = attempts + 1 where id = ?', [eventId]);
    await rejectedSql(owner, `insert into wagering.outbox_messages
      (id,transaction_id,aggregate_id,event_type,event_version,payload,occurred_at)
      values (?, ?, ?, 'WalletBalanceChanged', 1, '{}'::jsonb, ?)`, [id(), tx.transactionId, w.walletId, new Date()], '23505');
    const other = await wallet();
    await rejectedSql(owner, `insert into wagering.outbox_messages
      (id,transaction_id,aggregate_id,event_type,event_version,payload,occurred_at)
      values (?, ?, ?, 'ForeignWallet', 1, '{}'::jsonb, ?)`, [id(), tx.transactionId, other.walletId, new Date()]);
  });

  test('wallet uniqueness and down with data are refused without losing history', async () => {
    const w = await wallet();
    await expect(service.openWallet({ id: id(), playerId: w.playerId, initialBalance: { amount: '0.00', currency: 'BRL' } }))
      .rejects.toMatchObject({ code: 'WALLET_ALREADY_EXISTS' });
    await expect(owner.getMigrator().down({ migrations: ['Migration20261028000200'] })).rejects.toThrow();
    await assertBalance(w.walletId, '100.00');
    expect(await owner.getMigrator().getPendingMigrations()).toHaveLength(0);
  });
});
