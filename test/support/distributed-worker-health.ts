try {
  const state = await Bun.file('/tmp/distributed-worker-health.json').json() as { pid: number; at: number };
  process.kill(state.pid, 0);
  if (Date.now() - state.at > 30000) throw new Error('WorkerHeartbeatStale');
} catch { process.exit(1); }
