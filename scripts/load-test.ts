// Standalone reproduction uses the same disposable topology and guards as validation.
const child = Bun.spawn([process.execPath, 'scripts/distributed-test-docker.ts', '--load-only'], { stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
