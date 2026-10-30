// Standalone reproduction uses the same disposable topology and guards as validation.
const child = Bun.spawn([process.execPath, 'scripts/distributed-test-docker.ts', '--load-only', ...process.argv.slice(2)], { stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
