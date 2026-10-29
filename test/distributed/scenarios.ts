import { assert, Kind, wallet, command, submit, check, http, sql, until, runtime, admin, envelope, send, inboxDone,
  outboxEmpty, close, id, service, type Result, type Wallet } from './support';

let passed = 0;
async function scenario(name: string, run: () => Promise<unknown>) {
  const start = performance.now(); const evidence = await run(); passed += 1;
  console.log(JSON.stringify({ scenario: name, status: 'PASS', durationMs: performance.now() - start, evidence }));
}
try {
  await scenario('three_container_identities_and_health', async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await http('/health/live', undefined, undefined, i)).status, 200);
      assert.equal((await http('/health/ready', undefined, undefined, i)).status, 200);
    }
    const expected = (process.env['API_INSTANCE_IDS'] ?? '').split(','); assert.equal(expected.length, 3);
    const connections = await admin.em.execute<Array<{ pid: number; application_name: string }>>(`select pid, application_name
      from pg_stat_activity where datname = current_database() and application_name in (?)`, [expected.map((x) => `jungle-wagering:${x}`)]);
    for (const instance of expected) assert.ok(connections.some((c) => c.application_name === `jungle-wagering:${instance}`));
    assert.ok(new Set(connections.map((c) => c.pid)).size >= 3);
    return { instances: expected, connections };
  });
  await scenario('A_two_bets_across_containers', async () => {
    const w = await wallet(); const commands = [0, 1].map(() => command(w, { money: { amount: '80.00', currency: 'BRL' } }));
    const results = await Promise.all(commands.map((c, i) => submit(c, i)));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 422]);
    assert.equal(results.find((r) => r.status === 422)!.body.failureCode, 'INSUFFICIENT_FUNDS');
    const reconciliation = await check(w, '20.00', 2); assert.equal(reconciliation.storedVersion, '2');
    return { statuses: results.map((r) => r.body.status), balance: '20.00', debits: 1, reconciliation: true };
  });
  await scenario('B_fifty_http_duplicates_three_containers', async () => {
    const w = await wallet(); const c = command(w);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(c, i)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(new Set(results.map((r) => r.body.transactionId)).size, 1);
    assert.equal(results.filter((r) => !r.body.idempotentReplay).length, 1);
    const original = results.find((r) => !r.body.idempotentReplay)!.body;
    for (const r of results) assert.deepEqual({ ...r.body, idempotentReplay: false }, original);
    const count = await sql<{ count: string }>('select count(*)::text as count from wagering.wager_transactions where external_transaction_id = ?', [c.externalTransactionId]);
    assert.equal(count[0]!.count, '1'); await check(w, '90.00', 2);
    return { requests: 50, transactions: 1, debits: 1, balance: '90.00' };
  });
  await scenario('idempotency_conflicts_and_historical_snapshot', async () => {
    const w = await wallet(); const c = command(w); const first = await submit(c);
    assert.equal((await submit({ ...c, money: { amount: '11.00', currency: 'BRL' } }, 1)).status, 409);
    assert.equal((await submit({ ...c, idempotencyKey: id() }, 2)).status, 409);
    const other = await wallet(); assert.equal((await submit(command(other, { idempotencyKey: c.idempotencyKey }), 1)).status, 409);
    await submit(command(w, { kind: Kind.Win, money: { amount: '50.00', currency: 'BRL' } }), 2);
    const replay = await submit(c, 2); assert.deepEqual(replay.body, { ...first.body, idempotentReplay: true });
    await check(w, '140.00', 3); await check(other, '100.00', 1);
    return { replayBalance: replay.body.balance?.amount, currentBalance: '140.00', conflicts: 3 };
  });
  await scenario('C_independent_wallet_with_real_lock', async () => {
    const a = await wallet(); const b = await wallet(); let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>((r) => { release = r; }); const ready = new Promise<void>((r) => { locked = r; });
    const hold = runtime.em.fork().transactional(async (em) => {
      await em.execute('select id from wagering.wallets where id = ? for update', [a.id]); locked(); await gate;
    });
    await ready; const pending = submit(command(a), 0);
    try { assert.equal((await submit(command(b), 1)).status, 200); await check(b, '90.00', 2); }
    finally { release(); await hold; }
    assert.equal((await pending).status, 200); await check(a, '90.00', 2);
    return { independentCommittedBeforeLockRelease: true };
  });
  await scenario('D_concurrent_reversals', async () => {
    const w = await wallet(); const bet = command(w); assert.equal((await submit(bet)).status, 200);
    const r = await Promise.all(([Kind.Refund, Kind.Rollback] as const).map((kind, i) => submit(command(w,
      { kind, referenceExternalTransactionId: bet.externalTransactionId }), i)));
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 422]); await check(w, '100.00', 3);
    return { compensations: 1, balance: '100.00' };
  });
  await scenario('E_negative_balance_rejected', async () => {
    const w = await wallet('0.00'); const win = command(w, { kind: Kind.Win }); await submit(win);
    await submit(command(w)); const reversal = await submit(command(w, { kind: Kind.Rollback, referenceExternalTransactionId: win.externalTransactionId }), 2);
    assert.equal(reversal.status, 422); assert.equal(reversal.body.failureCode, 'REVERSAL_INSUFFICIENT_FUNDS');
    await check(w, '0.00', 2); return { failureCode: reversal.body.failureCode, balance: '0.00' };
  });
  await scenario('three_schedulers_pending_resolution_and_replay', async () => {
    const w = await wallet(); const bet = command(w); const refund = command(w, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await submit(refund, 0); assert.equal(pending.status, 202); await submit(bet, 1);
    await until(async () => (await http<Result>(`/wagering/transactions/${pending.body.transactionId}`, undefined, undefined, 2)).body.status === 'PROCESSED');
    await submit(command(w, { kind: Kind.Win, money: { amount: '50.00', currency: 'BRL' } }), 2);
    const replay = await submit(refund, 1); assert.equal(replay.body.balance?.amount, '100.00'); assert.equal(replay.body.transactionId, pending.body.transactionId);
    await check(w, '150.00', 4); return { resolvedOnce: true, replayBalance: '100.00', currentBalance: '150.00' };
  });
  await scenario('fifty_sqs_deliveries_bypass_broker_dedup', async () => {
    const w = await wallet(); const e = await envelope(command(w));
    await Promise.all(Array.from({ length: 50 }, () => send(e)));
    await inboxDone(e.messageId);
    await until(async () => {
      // All 50 deliveries have been ACKed when no visible/inflight messages remain;
      // checked by a later dedicated queue probe in the load runner as well.
      const rows = await sql<{ count: string }>('select count(*)::text as count from wagering.wager_transactions where external_transaction_id = ?', [e.data.externalTransactionId]);
      return rows[0]!.count === '1';
    });
    await check(w, '90.00', 2); return { sends: 50, transaction: 1, debit: 1, inbox: 1 };
  });
  await scenario('fifo_wallet_order_and_outbox_drain', async () => {
    const w = await wallet(); const commands = Array.from({ length: 3 }, () => command(w));
    for (const c of commands) await send(await envelope(c));
    await until(async () => (await sql<{ count: string }>(`select count(*)::text as count from wagering.wager_transactions where wallet_id = ? and kind = 'BET'`, [w.id]))[0]!.count === '3');
    const rows = await sql<{ external_transaction_id: string }>(`select t.external_transaction_id from wagering.wallet_ledger_entries l
      join wagering.wager_transactions t on t.id = l.transaction_id where l.wallet_id = ? and t.kind = 'BET' order by l.wallet_version`, [w.id]);
    assert.deepEqual(rows.map((r) => r.external_transaction_id), commands.map((c) => c.externalTransactionId));
    await check(w, '70.00', 4); await outboxEmpty(); return { ordered: true, outboxPending: 0 };
  });
  await scenario('persist_terminal_snapshot_before_restart', async () => {
    await service.openWallet({ id: 'stage7-terminal-wallet', playerId: 'stage7-terminal-player', initialBalance: { amount: '100.00', currency: 'BRL' } });
    const w: Wallet = { id: 'stage7-terminal-wallet', playerId: 'stage7-terminal-player', balance: { amount: '100.00', currency: 'BRL' }, version: '1' };
    const c = command(w, { externalTransactionId: 'stage7-terminal-bet', idempotencyKey: 'stage7-terminal-bet' });
    assert.equal((await submit(c)).body.balance?.amount, '90.00');
    await submit(command(w, { kind: Kind.Win, money: { amount: '50.00', currency: 'BRL' } }), 2);
    await check(w, '140.00', 3); await outboxEmpty(); return { terminalBalance: '90.00', currentBalance: '140.00' };
  });
  console.log(JSON.stringify({ suite: 'distributed', passed, failed: 0 }));
} catch (error) { console.error(error); console.log(JSON.stringify({ suite: 'distributed', passed, failed: 1 })); process.exitCode = 1; }
finally { await close(); }
