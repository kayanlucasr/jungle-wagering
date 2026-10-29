import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { assert, wallet, command, submit, envelope, send, inboxDone, check, sql, outboxEmpty, close, client, config, until, type Wallet } from './support';

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]!;
const distribution = (values: number[]) => ({ count: values.length, p50: percentile(values, .50), p95: percentile(values, .95), p99: percentile(values, .99) });
try {
  const independent = await Promise.all(Array.from({ length: 24 }, (_, i) => wallet('100.00', i)));
  const hot = await wallet(); const duplicate = await wallet();
  const queued = await Promise.all(Array.from({ length: 12 }, (_, i) => wallet('100.00', i)));
  const dup = command(duplicate); const httpMs: number[] = []; const sendMs: number[] = []; const completionMs: number[] = [];
  const started = performance.now();
  const operations = [...independent.map((w) => command(w)),
    ...Array.from({ length: 20 }, () => command(hot, { money: { amount: '80.00', currency: 'BRL' } })),
    ...Array.from({ length: 50 }, () => dup)];
  const httpWork = Promise.all(operations.map(async (c, i) => {
    const at = performance.now(); const result = await submit(c, i); httpMs.push(performance.now() - at); return result;
  }));
  const messages = await Promise.all(queued.map((w) => envelope(command(w))));
  const queueWork = Promise.all(messages.map(async (e) => {
    const at = performance.now();
    await Promise.all([0, 1].map(async () => { const begin = performance.now(); await send(e); sendMs.push(performance.now() - begin); }));
    await inboxDone(e.messageId); completionMs.push(performance.now() - at);
  }));
  const [results] = await Promise.all([httpWork, queueWork]);
  const successes = results.filter((r) => r.status === 200).length;
  const rejected = results.filter((r) => r.status === 422).length;
  const errors = results.filter((r) => ![200, 422].includes(r.status)).length;
  assert.equal(successes, 75); assert.equal(rejected, 19); assert.equal(errors, 0);
  const queue = await client.send(new GetQueueUrlCommand({ QueueName: config.sqs.queueName }));
  await until(async () => {
    const attrs = await client.send(new GetQueueAttributesCommand({ QueueUrl: queue.QueueUrl!, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
    return attrs.Attributes?.['ApproximateNumberOfMessages'] === '0' && attrs.Attributes?.['ApproximateNumberOfMessagesNotVisible'] === '0';
  });
  const lag = (await sql<{ pending: string; oldest_ms: number }>(`select count(*)::text as pending,
    coalesce(extract(epoch from (clock_timestamp() - min(occurred_at))) * 1000, 0)::float8 as oldest_ms
    from wagering.outbox_messages where published_at is null`))[0]!;
  await outboxEmpty(); const elapsedMs = performance.now() - started;
  const expected: Array<[Wallet, string, number]> = [...independent.map((w): [Wallet, string, number] => [w, '90.00', 2]),
    [hot, '20.00', 2], [duplicate, '90.00', 2], ...queued.map((w): [Wallet, string, number] => [w, '90.00', 2])];
  for (const [w, balance, entries] of expected) await check(w, balance, entries);
  const ids = expected.map(([w]) => w.id);
  const count = (await sql<{ count: string }>(`select count(*)::text as count from wagering.wager_transactions where wallet_id in (?) and kind <> 'OPENING'`, [ids]))[0]!.count;
  assert.equal(count, '57');
  const events = (await sql<{ count: string; published: string }>(`select count(*)::text as count,
    count(published_at)::text as published from wagering.outbox_messages where aggregate_id in (?)`, [ids]))[0]!;
  assert.equal(events.count, events.published);
  console.log(JSON.stringify({ scenario: 'controlled_load', status: 'PASS', methodology: 'nearest-rank; one concurrent burst; no target RPS',
    httpRequests: 94, httpSuccess: successes, httpSuccessRate: successes / 94, expectedFinancialRejections: rejected,
    operationalErrors: errors, sqsSends: 24, sqsUniqueCommands: 12, distinctTransactions: 57,
    totalTransportOperations: 118, elapsedMs, observedTransportOperationsPerSecond: 118 * 1000 / elapsedMs,
    httpLatencyMs: distribution(httpMs), sqsSendLatencyMs: distribution(sendMs), sqsFirstCommittedCompletionMs: distribution(completionMs),
    outboxBeforeDrain: lag, outboxFinalPending: 0, publishedEvents: events.published, reconciledWallets: expected.length, consistent: true }));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await close(); }
