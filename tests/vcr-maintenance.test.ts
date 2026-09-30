import assert from 'node:assert/strict';
import test from 'node:test';
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
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
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
    token: 'oidc-test-token',
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
});


test('vercel schedules daily VCR retention maintenance independently of other cron jobs', async () => {
  const { promises: fs } = await import('node:fs');
  const config = JSON.parse(await fs.readFile('vercel.json', 'utf8')) as any;
  assert.deepEqual(
    config.crons.find((item: any) => item.path === '/internal/vcr-retention'),
    { path: '/internal/vcr-retention', schedule: '17 4 * * *' },
  );
});
