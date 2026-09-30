import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import test from 'node:test';
import { canonicalReconcileCronAuthorized, createDevelopmentIntelligenceServer } from '../src/http.js';
import { canonicalPortfolioRotationIndex } from '../src/intelligence/canonicalPortfolio.js';

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function startServer(): Promise<{ server: Server; origin: string }> {
  const server = createDevelopmentIntelligenceServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test('canonical reconcile cron authorization is exact and fails closed', () => {
  assert.equal(canonicalReconcileCronAuthorized({}, undefined), false);
  assert.equal(canonicalReconcileCronAuthorized({ authorization: 'Bearer wrong' }, 'expected-secret'), false);
  assert.equal(canonicalReconcileCronAuthorized({ authorization: 'Bearer expected-secret' }, 'expected-secret'), true);
});

test('canonical portfolio rotation deterministically assigns one repository per minute', () => {
  const minute = 60_000;
  assert.equal(canonicalPortfolioRotationIndex(0, 3), 0);
  assert.equal(canonicalPortfolioRotationIndex(minute, 3), 1);
  assert.equal(canonicalPortfolioRotationIndex(2 * minute, 3), 2);
  assert.equal(canonicalPortfolioRotationIndex(3 * minute, 3), 0);
  assert.equal(canonicalPortfolioRotationIndex(5 * minute, 3), 2);
});

test('canonical reconcile cron route rejects unconfigured and invalid callers before update-plane work', async () => {
  const previous = process.env.CRON_SECRET;
  const { server, origin } = await startServer();
  try {
    delete process.env.CRON_SECRET;
    const unconfigured = await fetch(`${origin}/internal/reconcile-canonical`);
    assert.equal(unconfigured.status, 503);

    process.env.CRON_SECRET = 'cron-test-secret';
    const missing = await fetch(`${origin}/internal/reconcile-canonical`);
    assert.equal(missing.status, 401);

    const wrong = await fetch(`${origin}/internal/reconcile-canonical`, {
      headers: { authorization: 'Bearer not-the-secret' },
    });
    assert.equal(wrong.status, 401);
  } finally {
    await close(server);
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('vercel schedules one rotating canonical reconciliation every minute', async () => {
  const config = JSON.parse(await fs.readFile('vercel.json', 'utf8')) as any;
  assert.deepEqual(
    config.crons.find((item: any) => item.path === '/internal/reconcile-canonical'),
    { path: '/internal/reconcile-canonical', schedule: '* * * * *' },
  );
});
