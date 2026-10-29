import { assert, Kind, service, sql, until, command, send, envelope, check, outboxEmpty, close, http, submit,
  type Wallet, type Result } from './support';

try {
  if (process.argv[2] === 'seed') {
    for (let i = 0; i < 6; i++) {
      const id = `stage7-restart-wallet-${i}`; const playerId = `stage7-restart-player-${i}`;
      await service.openWallet({ id, playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
      const w: Wallet = { id, playerId, balance: { amount: '100.00', currency: 'BRL' }, version: '1' };
      const bet = command(w, { externalTransactionId: `stage7-restart-bet-${i}`, idempotencyKey: `stage7-restart-bet-${i}` });
      const refund = command(w, { kind: Kind.Refund, externalTransactionId: `stage7-restart-refund-${i}`,
        idempotencyKey: `stage7-restart-refund-${i}`, referenceExternalTransactionId: bet.externalTransactionId });
      assert.equal((await service.submit(refund)).status, 'PENDING_REFERENCE');
      await send(await envelope(bet));
    }
    const pending = await sql<{ count: string }>("select count(*)::text as count from wagering.wager_transactions where status = 'PENDING_REFERENCE' and player_id like 'stage7-restart-player-%'");
    assert.equal(pending[0]!.count, '6');
    const outbox = await sql<{ count: string }>('select count(*)::text as count from wagering.outbox_messages where published_at is null');
    assert.ok(Number(outbox[0]!.count) >= 18);
    console.log(JSON.stringify({ scenario: 'restart_seed_all_roles_down', status: 'PASS', pending: 6, queuedCommands: 6, outboxPending: outbox[0]!.count }));
  } else {
    const terminalWallet: Wallet = { id: 'stage7-terminal-wallet', playerId: 'stage7-terminal-player', balance: { amount: '100.00', currency: 'BRL' }, version: '1' };
    const terminal = await submit(command(terminalWallet, { externalTransactionId: 'stage7-terminal-bet', idempotencyKey: 'stage7-terminal-bet' }), 2);
    assert.equal(terminal.status, 200); assert.equal(terminal.body.idempotentReplay, true); assert.equal(terminal.body.balance?.amount, '90.00');
    await check(terminalWallet, '140.00', 3);
    await until(async () => (await sql<{ count: string }>(`select count(*)::text as count from wagering.wager_transactions
      where player_id like 'stage7-restart-player-%' and kind in ('BET','REFUND') and status = 'PROCESSED'`))[0]!.count === '12');
    for (let i = 0; i < 6; i++) {
      const w: Wallet = { id: `stage7-restart-wallet-${i}`, playerId: `stage7-restart-player-${i}`, balance: { amount: '100.00', currency: 'BRL' }, version: '1' };
      await check(w, '100.00', 3);
      const original = await http<{ result: { balance: { amount: string } } }>(`/providers/stage7/wagering/transactions/stage7-restart-refund-${i}`);
      assert.equal(original.status, 200); assert.equal(original.body.result.balance.amount, '100.00');
      await submit(command(w, { kind: Kind.Win, money: { amount: '50.00', currency: 'BRL' } }));
      const replay = await submit(command(w, { kind: Kind.Refund, externalTransactionId: `stage7-restart-refund-${i}`,
        idempotencyKey: `stage7-restart-refund-${i}`, referenceExternalTransactionId: `stage7-restart-bet-${i}` }), i);
      assert.equal(replay.status, 200); assert.equal(replay.body.idempotentReplay, true); assert.equal(replay.body.balance?.amount, '100.00');
      await check(w, '150.00', 4);
    }
    await outboxEmpty();
    console.log(JSON.stringify({ scenario: 'restart_all_roles_recovered', status: 'PASS', wallets: 6, operationsRecovered: 12,
      duplicateMovements: 0, reconciliations: 12, pendingOutbox: 0, historicalReplay: true }));
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await close(); }
