import { expect, test } from 'bun:test';
import { createApplication } from '../../src/bootstrap';
import { NoopProviderIdentityGuard } from '../../src/interfaces/http/noop-provider-identity.guard';
import { fixtureConfig } from '../support/config';

test('identity extension is wired on every financial route while health remains public', async () => {
  const app = await createApplication(fixtureConfig());
  const guard = app.get(NoopProviderIdentityGuard);
  let evaluations = 0;
  // Override the real registered extension, not a separate unused mock provider.
  guard.canActivate = () => { evaluations += 1; return false; };
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    for (const [method, path] of [['POST', '/wallets'], ['GET', '/wallets/w'], ['GET', '/wallets/w/ledger'],
      ['POST', '/wallets/w/reconciliation'], ['POST', '/wagering/transactions'],
      ['GET', '/wagering/transactions/t'], ['GET', '/providers/p/wagering/transactions/t']] as const) {
      expect((await fetch(base + path, { method })).status).toBe(403);
    }
    expect(evaluations).toBe(7);
    expect((await fetch(base + '/health/live')).status).toBe(200);
    expect((await fetch(base + '/health/ready')).status).toBe(503); // Dependencies unavailable, no guard denial.
    expect(evaluations).toBe(7);
  } finally { await app.close(); }
});
