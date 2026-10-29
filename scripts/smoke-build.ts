import { createServer } from 'node:net';
import { loadConfig } from '../src/infrastructure/config/environment';

// Exercises emitted JS + decorator metadata, without requiring or mutating services.
const port = await new Promise<number>((resolve, reject) => {
  const reservation = createServer();
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', () => {
    const address = reservation.address();
    if (address === null || typeof address === 'string') return reject(new Error('No TCP port'));
    reservation.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const env = {
  ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'error',
  DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'jungle_wagering_test', DB_USER: 'test',
  DB_PASSWORD: 'local_test_only', DB_POOL_MAX: '1', DEPENDENCY_TIMEOUT_MS: '300',
  AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://127.0.0.1:1', SQS_QUEUE_NAME: 'wager-transactions.fifo',
  SQS_DLQ_NAME: 'wager-transactions-dlq.fifo', SQS_MAX_RECEIVE_COUNT: '5',
  SQS_VISIBILITY_TIMEOUT_SECONDS: '30',
};
loadConfig(env);
const child = Bun.spawn([process.execPath, 'dist/src/main.js'], {
  env, stdout: 'ignore', stderr: 'pipe',
});
try {
  const deadline = Date.now() + 30000;
  let started = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Compiled application exited before liveness');
    try {
      const live = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(500) });
      if (live.status === 200) { started = true; break; }
    } catch { /* Startup polling only; bounded by deadline. */ }
    await Bun.sleep(50);
  }
  if (!started) throw new Error('Compiled application did not become live');
  const ready = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(5000) });
  if (ready.status !== 503) throw new Error('Readiness must fail without dependencies');
  console.log(JSON.stringify({ compiledBootstrap: 'passed', liveness: 200, readinessWithoutDependencies: 503 }));
} finally {
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  const exitCode = await child.exited;
  clearTimeout(deadline);
  console.log(JSON.stringify({ compiledProcessExitCode: exitCode }));
}
