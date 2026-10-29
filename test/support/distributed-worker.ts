// Test-image supervisor only. Production worker code runs unchanged in its own process.
const role = process.argv[2]!;
const child = Bun.spawn([process.execPath, 'dist/src/workers/main.js', role], {
  stdout: 'pipe', stderr: 'inherit', stdin: 'ignore',
});
let started = false;
const forward = (signal: NodeJS.Signals) => child.kill(signal);
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));
let pending = '';
for await (const chunk of child.stdout) {
  const data = new TextDecoder().decode(chunk);
  process.stdout.write(data);
  pending += data;
  let end: number;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try {
      const log = JSON.parse(line) as { event: string };
      if (log.event === 'worker_started') started = true;
      if (started && ['worker_started', 'messaging_metrics'].includes(log.event)) {
        await Bun.write('/tmp/distributed-worker-health.json', JSON.stringify({ pid: child.pid, role, at: Date.now() }));
      }
    } catch { /* Non-JSON diagnostics do not prove worker readiness. */ }
  }
}
process.exitCode = await child.exited;
