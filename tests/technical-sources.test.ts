import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRegistry } from '../src/config/registry.js';
import { listTechnicalSources, queryTechnicalSource } from '../src/intelligence/technicalSources.js';
import { runChecked } from '../src/util/process.js';

test('external technical evidence normalizes deployment and database sources without becoming graph authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-external-evidence-'));
  const previousRegistry = process.env.DEVINT_PROJECTS_JSON;
  const originalFetch = globalThis.fetch;

  await runChecked('git', ['init', '--initial-branch=main', root]);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'provider.ts'), "import { waitUntil } from '@vercel/functions';\nexport const provider = waitUntil;\n");
  await fs.writeFile(path.join(root, 'schema.sql'), 'create table public.users (id bigint primary key);\n');
  await runChecked('git', ['-C', root, 'add', '.']);
  await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
  const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const now = new Date().toISOString();

  process.env.DEVINT_PROJECTS_JSON = JSON.stringify({
    ExternalEvidence: {
      repository: pathToFileURL(path.join(root, '.git')).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      credential: { type: 'none' },
      technicalSources: [
        {
          id: 'deploy',
          label: 'Deployment state',
          type: 'read-only-http',
          adapter: 'deployment-state',
          providerId: 'vercel',
          endpoint: 'https://deployment.example.test/state',
          capabilities: ['query'],
          freshnessMs: 60000
        },
        {
          id: 'database',
          label: 'Database schema',
          type: 'read-only-http',
          adapter: 'database-schema',
          endpoint: 'https://database.example.test/schema',
          capabilities: ['query'],
          freshnessMs: 60000
        }
      ]
    }
  });

  globalThis.fetch = async (input: any, init?: any) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('capability'), 'query');
    assert.equal(url.searchParams.get('q'), 'current');

    if (url.hostname === 'deployment.example.test') {
      return new Response(JSON.stringify({
        id: 'dep-1',
        state: 'READY',
        url: 'https://app.example.test',
        gitSource: { sha: revision, ref: 'main' },
        updatedAt: now
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"deployment-1"' }
      });
    }

    if (url.hostname === 'database.example.test') {
      return new Response(JSON.stringify({
        revision: 'schema-7',
        observedAt: now,
        schemas: [{
          name: 'public',
          tables: [{ name: 'users' }],
          functions: [{ name: 'refresh_users' }]
        }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    throw new Error(`Unexpected technical source request: ${url}`);
  };

  try {
    const registry = await loadRegistry();
    assert.equal(registry.ExternalEvidence?.technicalSources?.[0]?.adapter, 'deployment-state');

    const sources = await listTechnicalSources('ExternalEvidence');
    assert.ok(sources.some(item => item.id === 'deploy' && item.adapter === 'deployment-state' && item.providerId === 'vercel'));
    assert.ok(sources.some(item => item.id === 'database' && item.adapter === 'database-schema'));

    const deployment = await queryTechnicalSource({ project: 'ExternalEvidence', sourceId: 'deploy', query: 'current' }) as any;
    assert.equal(deployment.policy.readOnly, true);
    assert.equal(deployment.policy.providerStateAuthoritative, true);
    assert.equal(deployment.policy.persisted, false);
    assert.equal(deployment.policy.acceptedCheckpointAffected, false);
    assert.equal(deployment.evidence.source.adapter, 'deployment-state');
    assert.equal(deployment.evidence.snapshot.id, '"deployment-1"');
    assert.equal(deployment.evidence.snapshot.sourceRevision, revision);
    assert.equal(deployment.evidence.snapshot.freshness, 'fresh');
    assert.ok(deployment.evidence.observations.some((item: any) => item.kind === 'deployment-state'));
    assert.ok(deployment.evidence.relationships.some((item: any) => item.kind === 'deployed-from' && item.to === `git-revision:${revision}`));
    assert.ok(deployment.evidence.correlations.some((item: any) => item.kind === 'matches-revision'));
    assert.ok(deployment.evidence.correlations.some((item: any) => item.kind === 'matches-provider' && item.repositoryTarget === 'provider:vercel'));
    assert.equal(deployment.evidence.correlationStatus.available, true);

    const database = await queryTechnicalSource({ project: 'ExternalEvidence', sourceId: 'database', query: 'current' }) as any;
    assert.equal(database.evidence.source.adapter, 'database-schema');
    assert.equal(database.evidence.snapshot.sourceRevision, 'schema-7');
    assert.equal(database.evidence.snapshot.freshness, 'fresh');
    assert.ok(database.evidence.observations.some((item: any) => item.kind === 'database-table' && item.name === 'public.users'));
    assert.ok(database.evidence.observations.some((item: any) => item.kind === 'database-function' && item.name === 'public.refresh_users'));
    assert.ok(database.evidence.relationships.some((item: any) => item.kind === 'contains'));
    assert.ok(database.evidence.correlations.some((item: any) => item.kind === 'matches-entity'));
    assert.equal(database.evidence.coverage.status, 'complete');
    assert.deepEqual(database.data.schemas[0].tables, [{ name: 'users' }], 'raw provider payload remains available alongside normalized evidence');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRegistry === undefined) delete process.env.DEVINT_PROJECTS_JSON;
    else process.env.DEVINT_PROJECTS_JSON = previousRegistry;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('technical source registry rejects insecure transport and invalid adapter metadata', async () => {
  const previousRegistry = process.env.DEVINT_PROJECTS_JSON;
  try {
    process.env.DEVINT_PROJECTS_JSON = JSON.stringify({
      Bad: {
        repository: 'https://github.com/example/repo.git',
        defaultRef: 'refs/heads/main',
        allowedRefs: ['refs/heads/main'],
        credential: { type: 'none' },
        technicalSources: [{
          id: 'bad',
          type: 'read-only-http',
          endpoint: 'http://example.test/source',
          capabilities: ['query']
        }]
      }
    });
    await assert.rejects(loadRegistry(), /must use HTTPS/u);

    process.env.DEVINT_PROJECTS_JSON = JSON.stringify({
      Bad: {
        repository: 'https://github.com/example/repo.git',
        defaultRef: 'refs/heads/main',
        allowedRefs: ['refs/heads/main'],
        credential: { type: 'none' },
        technicalSources: [{
          id: 'bad',
          type: 'read-only-http',
          adapter: 'unknown-adapter',
          endpoint: 'https://example.test/source',
          capabilities: ['query']
        }]
      }
    });
    await assert.rejects(loadRegistry(), /unsupported technical source adapter/u);
  } finally {
    if (previousRegistry === undefined) delete process.env.DEVINT_PROJECTS_JSON;
    else process.env.DEVINT_PROJECTS_JSON = previousRegistry;
  }
});
