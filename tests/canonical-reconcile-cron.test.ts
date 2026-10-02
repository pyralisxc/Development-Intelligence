import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import test from 'node:test';
import { canonicalReconcileCronAuthorized, createDevelopmentIntelligenceServer } from '../src/http.js';
import { canonicalPortfolioRecentActivityCandidate, canonicalPortfolioRotationIndex } from '../src/intelligence/canonicalPortfolio.js';
import { canonicalReconcileWorkerLimits, runCanonicalReconcileWorker } from '../src/intelligence/canonicalReconcileWorker.js';

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

test('canonical recent-activity selection is bounded to the current provider activity window', () => {
  const epoch = Date.parse('2026-10-02T05:30:00Z');
  const repository = (fullName: string, pushedAt: string | null) => {
    const [owner, name] = fullName.split('/');
    return {
      owner,
      name,
      fullName,
      defaultBranch: 'main',
      archived: false,
      disabled: false,
      private: false,
      fork: false,
      pushedAt,
    };
  };
  const selected = canonicalPortfolioRecentActivityCandidate([
    repository('pyralisxc/older', '2026-10-02T05:26:00Z'),
    repository('pyralisxc/newer', '2026-10-02T05:29:30Z'),
    repository('pyralisxc/stale', '2026-10-02T05:20:00Z'),
  ] as any, epoch, 5 * 60_000);
  assert.equal(selected?.fullName, 'pyralisxc/newer');
  assert.equal(canonicalPortfolioRecentActivityCandidate([
    repository('pyralisxc/stale', '2026-10-02T05:20:00Z'),
  ] as any, epoch, 5 * 60_000), null);
});

test('provider activity is only a selection hint; repository identity still carries its default branch', () => {
  const epoch = Date.parse('2026-10-02T05:30:00Z');
  const selected = canonicalPortfolioRecentActivityCandidate([{
    owner: 'pyralisxc',
    name: 'example',
    fullName: 'pyralisxc/example',
    defaultBranch: 'main',
    archived: false,
    disabled: false,
    private: false,
    fork: false,
    pushedAt: '2026-10-02T05:29:59Z',
  }] as any, epoch, 5 * 60_000);
  assert.equal(selected?.defaultBranch, 'main');
  assert.equal(selected?.pushedAt, '2026-10-02T05:29:59Z');
});

test('canonical reconcile worker limits keep one repository inside one cron slot', () => {
  const previousTimeout = process.env.DEVINT_CANONICAL_RECONCILE_WORKER_TIMEOUT_MS;
  const previousHeap = process.env.DEVINT_CANONICAL_RECONCILE_WORKER_HEAP_MB;
  try {
    delete process.env.DEVINT_CANONICAL_RECONCILE_WORKER_TIMEOUT_MS;
    delete process.env.DEVINT_CANONICAL_RECONCILE_WORKER_HEAP_MB;
    assert.deepEqual(canonicalReconcileWorkerLimits(), { timeoutMs: 45_000, maxOldGenerationSizeMb: 768 });

    process.env.DEVINT_CANONICAL_RECONCILE_WORKER_TIMEOUT_MS = '999999';
    process.env.DEVINT_CANONICAL_RECONCILE_WORKER_HEAP_MB = '9999';
    assert.deepEqual(canonicalReconcileWorkerLimits(), { timeoutMs: 55_000, maxOldGenerationSizeMb: 896 });
  } finally {
    if (previousTimeout === undefined) delete process.env.DEVINT_CANONICAL_RECONCILE_WORKER_TIMEOUT_MS;
    else process.env.DEVINT_CANONICAL_RECONCILE_WORKER_TIMEOUT_MS = previousTimeout;
    if (previousHeap === undefined) delete process.env.DEVINT_CANONICAL_RECONCILE_WORKER_HEAP_MB;
    else process.env.DEVINT_CANONICAL_RECONCILE_WORKER_HEAP_MB = previousHeap;
  }
});

test('isolated reconcile worker returns a structured repository error without failing the parent', async () => {
  const item = await runCanonicalReconcileWorker(
    { project: 'unauthorized-owner/missing-project', defaultBranch: 'main' },
    { timeoutMs: 5_000, maxOldGenerationSizeMb: 128 },
  );
  assert.equal(item.project, 'unauthorized-owner/missing-project');
  assert.equal(item.outcome, 'error');
  assert.ok(item.reason);
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

test('vercel schedules one rotating canonical reconciliation every five minutes', async () => {
  const config = JSON.parse(await fs.readFile('vercel.json', 'utf8')) as any;
  assert.deepEqual(
    config.crons.find((item: any) => item.path === '/internal/reconcile-canonical'),
    { path: '/internal/reconcile-canonical', schedule: '*/5 * * * *' },
  );
});
