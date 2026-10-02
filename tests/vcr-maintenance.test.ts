import assert from 'node:assert/strict';
import test from 'node:test';
import type { Server } from 'node:http';
import { createDevelopmentIntelligenceServer } from '../src/http.js';
import { applyVcrRetentionMaintenance } from '../src/intelligence/vcrMaintenance.js';

test('scheduled VCR maintenance deletes exact planned image ids and verifies post-delete inventory', async () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const currentSha = '1'.repeat(40);
  const oldSha = '2'.repeat(40);
  let images: any[] = [
    { id: 'image-current', tags: [currentSha.slice(0, 12)], createdAt: '2026-09-20T00:00:00Z', sizeInBytes: 100 },
    { id: 'image-old', tags: [oldSha.slice(0, 12)], createdAt: '2026-09-20T00:00:00Z', sizeInBytes: 200 },
  ];
  const deployments = [
    { uid: 'prod-current', state: 'READY', target: 'production', created: now - 1000, meta: { githubCommitSha: currentSha, githubCommitRef: 'main' } },
    { uid: 'prod-old', state: 'ERROR', target: 'production', created: now - 10 * 24 * 60 * 60 * 1000, meta: { githubCommitSha: oldSha, githubCommitRef: 'main' } },
  ];
  const deleted: string[] = [];
  const authorizations: Array<string | null> = [];
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    authorizations.push(new Headers(init?.headers).get('authorization'));
    const url = new URL(input);
    if (url.pathname.endsWith('/images') && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ images, pagination: { next: null } }), { status: 200 });
    }
    if (url.pathname === '/v6/deployments') {
      return new Response(JSON.stringify({ deployments, pagination: { next: null } }), { status: 200 });
    }
    const match = url.pathname.match(/\/images\/([^/]+)$/u);
    if (match && init?.method === 'DELETE') {
      deleted.push(decodeURIComponent(match[1]!));
      images = images.filter(item => item.id !== decodeURIComponent(match[1]!));
      return new Response('{}', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };

  const result = await applyVcrRetentionMaintenance({
    accessToken: 'access-test-token',
    projectId: 'prj_test',
    teamId: 'team_test',
    fetcher,
    now,
  }) as any;
  assert.deepEqual(deleted, ['image-old']);
  assert.equal(result.before.images, 2);
  assert.equal(result.deleted.images, 1);
  assert.equal(result.deleted.knownBytes, 200);
  assert.equal(result.after.images, 1);
  assert.equal(result.after.verified, true);
  assert.ok(authorizations.length > 0);
  assert.ok(authorizations.every(value => value === 'Bearer access-test-token'));
});

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

function fakeVercelOidcToken(): string {
  const payload = Buffer.from(JSON.stringify({
    project_id: 'prj_test',
    owner_id: 'team_test',
  })).toString('base64url');
  return `e30.${payload}.signature`;
}

test('scheduled VCR maintenance never treats deployment OIDC identity as a management access token', async () => {
  const previousCron = process.env.CRON_SECRET;
  const previousManagement = process.env.DEVINT_VERCEL_VCR_TOKEN;
  const oidcToken = fakeVercelOidcToken();
  const { server, origin } = await startServer();
  try {
    process.env.CRON_SECRET = 'cron-test-secret';
    delete process.env.DEVINT_VERCEL_VCR_TOKEN;

    const missing = await fetch(`${origin}/internal/vcr-retention`, {
      headers: {
        authorization: 'Bearer cron-test-secret',
        'x-vercel-oidc-token': oidcToken,
      },
    });
    assert.equal(missing.status, 503);
    assert.match(String((await missing.json() as any).error), /management access token is not configured/u);

    process.env.DEVINT_VERCEL_VCR_TOKEN = oidcToken;
    const reused = await fetch(`${origin}/internal/vcr-retention`, {
      headers: {
        authorization: 'Bearer cron-test-secret',
        'x-vercel-oidc-token': oidcToken,
      },
    });
    assert.equal(reused.status, 503);
    assert.match(String((await reused.json() as any).error), /must not reuse the Vercel deployment OIDC identity token/u);
  } finally {
    await close(server);
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
    if (previousManagement === undefined) delete process.env.DEVINT_VERCEL_VCR_TOKEN;
    else process.env.DEVINT_VERCEL_VCR_TOKEN = previousManagement;
  }
});


test('vercel schedules bounded VCR retention maintenance independently of other cron jobs', async () => {
  const { promises: fs } = await import('node:fs');
  const config = JSON.parse(await fs.readFile('vercel.json', 'utf8')) as any;
  assert.deepEqual(
    config.crons.find((item: any) => item.path === '/internal/vcr-retention'),
    { path: '/internal/vcr-retention', schedule: '17 */6 * * *' },
  );
});
