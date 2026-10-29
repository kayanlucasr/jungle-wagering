// Exercise the actual emitted production application in each independent replica.
const { createApplication } = await import(new URL('../../dist/src/bootstrap.js', import.meta.url).href) as typeof import('../../src/bootstrap');
const { DatabaseService } = await import(new URL('../../dist/src/infrastructure/persistence/database.service.js', import.meta.url).href) as typeof import('../../src/infrastructure/persistence/database.service');

// Independent Nest process for real HTTP concurrency tests. No worker/queue consumer.
const app = await createApplication();
try {
  await app.listen(0, '127.0.0.1');
  const rows = await app.get(DatabaseService).orm.em.execute<Array<{ pid: number }>>('select pg_backend_pid() as pid');
  console.log(JSON.stringify({ event: 'http_test_ready', url: await app.getUrl(), processId: process.pid, backendPid: rows[0]!.pid }));
  await Bun.stdin.text(); // Parent closes the pipe after all HTTP assertions.
} finally { await app.close(); }
