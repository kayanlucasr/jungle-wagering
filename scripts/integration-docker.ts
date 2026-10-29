import { spawnSync } from 'node:child_process';

// Every run has private containers/network and a disposable PostgreSQL filesystem.
const project = `jungle-financial-test-${crypto.randomUUID().slice(0, 8)}`;
const args = ['compose', '-p', project, '-f', 'docker-compose.test.yml'];
const available = spawnSync('docker', ['info'], { stdio: 'ignore' });
if (available.error || available.status !== 0) {
  console.error('Docker Engine unavailable. Install/start Docker Desktop with Linux containers. No tests were run.');
  process.exit(1);
}
try {
  const result = spawnSync('docker', [...args, 'run', '--build', '--rm', 'tests'], {
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} finally {
  // No shared volumes and no down -v: only this random Compose project is removed.
  const cleanup = spawnSync('docker', [...args, 'down', '--remove-orphans'], { stdio: 'inherit' });
  if (cleanup.status !== 0) process.exitCode = 1;
}
