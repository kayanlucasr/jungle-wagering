import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

// Keep historical evidence when a later audit reruns the same validation.
const evidenceFlag = process.argv.indexOf('--evidence-dir');
const requestedDirectory = evidenceFlag < 0 ? 'docs/stage-7' : process.argv[evidenceFlag + 1];
if (!requestedDirectory || requestedDirectory.startsWith('--')) throw new Error('EvidenceDirectoryRequired');
const evidenceDirectory = resolve(requestedDirectory);
const relativeDirectory = relative(process.cwd(), evidenceDirectory);
if (!relativeDirectory || relativeDirectory === '..' || relativeDirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  || isAbsolute(relativeDirectory)) throw new Error('EvidenceDirectoryMustBeInsideWorkspace');

const project = `jungle-distributed-test-${crypto.randomUUID().slice(0, 8)}`;
const base = ['compose', '-p', project, '-f', 'docker-compose.distributed-test.yml'];
const roles = ['app1', 'app2', 'app3', 'consumer', 'publisher', 'pending-reference'];
const scale = ['--scale', 'consumer=3', '--scale', 'publisher=2', '--scale', 'pending-reference=3'];
const loadOnly = process.argv.includes('--load-only');
const evidence: Record<string, unknown> = { project, startedAt: new Date().toISOString(), loadOnly };
const observations: unknown[] = [];
function run(args: string[], capture = false): string {
  const result = spawnSync('docker', [...base, ...args], capture ? { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    : { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    if (capture) { process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); }
    throw new Error(`DockerCommandFailed:${args.slice(0, 3).join(':')}:${result.status}`);
  }
  return result.stdout?.toString() ?? '';
}
function state() {
  const rows = run(['ps', '--format', 'json'], true).trim().split('\n').filter(Boolean).map((s) => JSON.parse(s) as { ID: string; Service: string; Health: string; State: string });
  const states = rows.filter((r) => roles.includes(r.Service)).map((r) => {
    const details = JSON.parse(spawnSync('docker', ['inspect', '--format',
      '{"hostname":"{{.Config.Hostname}}","pid":{{.State.Pid}},"startedAt":"{{.State.StartedAt}}"}', r.ID], { encoding: 'utf8' }).stdout) as object;
    return { id: r.ID, service: r.Service, health: r.Health, state: r.State, ...details };
  });
  assert.equal(states.length, 11);
  assert.ok(states.every((s) => s.health === 'healthy' && s.state === 'running'));
  return states;
}
function phase(script: string, args: string[] = [], instances = '') {
  const output = run(['run', '--rm', '--no-deps', '-e', `API_INSTANCE_IDS=${instances}`, 'tests', 'bun', script, ...args], true);
  process.stdout.write(output);
  const lines = output.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as unknown);
  observations.push(...lines);
}
const available = spawnSync('docker', ['info'], { stdio: 'ignore' });
if (available.error || available.status !== 0) throw new Error('DockerEngineRequiredNoTestsRun');
try {
  run(['config', '--quiet']);
  run(['build', 'tests']);
  run(['up', '-d', '--no-build', '--wait', '--wait-timeout', '180', ...scale, ...roles]);
  const initial = state(); evidence['initialInstances'] = initial;
  const instanceIds = () => run(['ps', '--format', 'json'], true).trim().split('\n').filter(Boolean)
    .map((s) => JSON.parse(s) as { Service: string; ID: string }).filter((r) => ['app1', 'app2', 'app3'].includes(r.Service))
    .sort((a, b) => a.Service.localeCompare(b.Service)).map((r) => spawnSync('docker', ['inspect', '--format', '{{.Config.Hostname}}', r.ID], { encoding: 'utf8' }).stdout.trim()).join(',');
  if (!loadOnly) {
    phase('test/distributed/scenarios.ts', [], instanceIds());
    // Metrics are volatile and emitted every 10s. Observe the conflict counter
    // before SIGKILL resets it; a fast financial suite can finish within that interval.
    const metricDeadline = Date.now() + 25000;
    let observedConflict = false;
    while (Date.now() < metricDeadline) {
      const apiLogs = run(['logs', '--no-color', 'app1', 'app2', 'app3'], true);
      const metrics = apiLogs.split('\n').flatMap((line) => {
        const start = line.indexOf('{'); if (start < 0) return [];
        try { return [JSON.parse(line.slice(start)) as { event: string; metrics?: Record<string, number> }]; }
        catch { return []; }
      });
      if (metrics.some((r) => r.event === 'financial_metrics' && (r.metrics?.['idempotencyConflicts'] ?? 0) > 0)) {
        observedConflict = true; break;
      }
      await Bun.sleep(1000);
    }
    assert.ok(observedConflict, 'ConflictMetricsNotObservedBeforeCrash');
    evidence['preCrashConflictMetricObserved'] = true;
    // Abruptly kill every application/worker process; never stop the database/broker.
    run(['kill', '-s', 'SIGKILL', ...roles]);
    const killed = run(['ps', '--all', '--format', 'json'], true).trim().split('\n').filter(Boolean)
      .map((s) => JSON.parse(s) as { Service: string; State: string; ExitCode: number }).filter((r) => roles.includes(r.Service));
    assert.equal(killed.length, 11); assert.ok(killed.every((r) => r.State === 'exited' && r.ExitCode === 137));
    evidence['abruptExit'] = killed.map(({ Service, ExitCode }) => ({ service: Service, exitCode: ExitCode }));
    phase('test/distributed/restart.ts', ['seed']);
    run(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120', ...scale, ...roles]);
    const restarted = state(); evidence['restartedInstances'] = restarted;
    for (const previous of initial) {
      const next = restarted.find((r) => r.id === previous.id)!;
      assert.ok(next); assert.notEqual((next as { startedAt?: string }).startedAt, (previous as { startedAt?: string }).startedAt);
    }
    phase('test/distributed/restart.ts', ['recover'], instanceIds());
  }
  phase('test/distributed/load.ts', [], instanceIds());
  await Bun.sleep(11000); // Receive a fresh metrics heartbeat after the workload.
  const logs = run(['logs', '--no-color', ...roles], true);
  if (evidenceFlag >= 0) await mkdir(evidenceDirectory, { recursive: true });
  await Bun.write(evidenceFlag < 0 ? '.cache-stage7-distributed-runtime.log'
    : join(evidenceDirectory, `${loadOnly ? 'load' : 'distributed'}-runtime.log`), logs);
  const records = logs.split('\n').flatMap((line) => {
    const start = line.indexOf('{'); if (start < 0) return [];
    try { return [JSON.parse(line.slice(start)) as { event: string; instanceId: string; metrics?: Record<string, number>;
      timestamp?: string; level?: string; service?: string; operation?: string; errorCode?: string; eventId?: string; messageId?: string;
      transactionId?: string; durationMs?: number; result?: string }]; }
    catch { return []; }
  });
  const snapshots = records.filter((r) => ['financial_metrics', 'messaging_metrics', 'http_metrics'].includes(r.event));
  assert.ok(snapshots.some((s) => s.event === 'financial_metrics' && (s.metrics?.['processed'] ?? 0) > 0));
  assert.ok(snapshots.some((s) => s.event === 'financial_metrics' && (s.metrics?.['rejected'] ?? 0) > 0));
  if (!loadOnly) assert.ok(snapshots.some((s) => s.event === 'financial_metrics' && (s.metrics?.['idempotencyConflicts'] ?? 0) > 0));
  assert.ok(snapshots.some((s) => (s.metrics?.['duplicates'] ?? 0) > 0));
  assert.ok(snapshots.some((s) => (s.metrics?.['published'] ?? 0) > 0));
  const completedMessages = records.filter((r) => r.event === 'consumer_message_completed' && ['PROCESSED', 'REJECTED', 'duplicate'].includes(r.result ?? ''));
  assert.ok(completedMessages.length > 0);
  assert.ok(completedMessages.every((r) => r.transactionId && r.operation && typeof r.durationMs === 'number'));
  const published = records.filter((r) => r.event === 'outbox_published');
  assert.ok(published.length > 0);
  assert.ok(published.every((r) => r.eventId && r.messageId && r.eventId !== r.messageId && r.operation && typeof r.durationMs === 'number'));
  assert.ok(records.filter((r) => r.event === 'http_request_failed').every((r) => r.errorCode));
  assert.ok(records.every((r) => r.timestamp && r.level && r.service && r.instanceId));
  evidence['logValidation'] = { jsonRecords: records.length, committedConsumerLogs: completedMessages.length, publishedLogs: published.length, status: 'PASS' };
  evidence['metricSnapshots'] = snapshots;
  evidence['representativeLogs'] = ['http_request_completed', 'http_request_failed', 'consumer_message_completed', 'outbox_published', 'pending_reference_evaluated']
    .map((event) => records.find((r) => r.event === event)).filter(Boolean);
  evidence['finalInstances'] = state();
  evidence['status'] = 'PASS';
} catch (error) {
  evidence['status'] = 'FAIL'; evidence['error'] = error instanceof Error ? error.message : 'UnknownError';
  console.error(error); process.exitCode = 1;
} finally {
  evidence['observations'] = observations;
  evidence['finishedAt'] = new Date().toISOString();
  try { run(['down', '--remove-orphans']); evidence['cleanup'] = 'PASS'; }
  catch { evidence['cleanup'] = 'FAIL'; process.exitCode = 1; }
  await mkdir(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, `${loadOnly ? 'load' : 'distributed'}-evidence.json`);
  await Bun.write(path, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ evidence: path, project, status: evidence['status'], cleanup: evidence['cleanup'] }));
}
