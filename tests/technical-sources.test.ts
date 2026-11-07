import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRegistry } from '../src/config/registry.js';
import { listTechnicalSources, queryTechnicalSource } from '../src/intelligence/technicalSources.js';
import { sanitizeExternalPayload } from '../src/intelligence/externalSanitization.js';
import { clearGraphCache, scanGraph } from '../src/intelligence/service.js';
import { runChecked } from '../src/util/process.js';

test('external technical evidence normalizes deployment and database sources without becoming graph authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-external-evidence-'));
  const previousRegistry = process.env.DEVINT_PROJECTS_JSON;
  const originalFetch = globalThis.fetch;

  await runChecked('git', ['init', '--initial-branch=main', root]);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'provider.ts'), "import { waitUntil } from '@vercel/functions';\nexport const provider = waitUntil;\n");
  await fs.writeFile(path.join(root, 'schema.sql'), 'create table public.users (id bigint primary key);\n');
  await fs.mkdir(path.join(root, 'supabase', 'migrations'), { recursive: true });
  await fs.mkdir(path.join(root, 'supabase', 'functions', 'cleanup'), { recursive: true });
  await fs.writeFile(path.join(root, 'supabase', 'migrations', '202605220001_initial.sql'), '-- source migration identity\n');
  await fs.writeFile(path.join(root, 'supabase', 'functions', 'cleanup', 'index.ts'), 'export const cleanup = true;\n');
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
          tables: [
            { name: 'users', rls_enabled: true,
              columns: [{ name: 'id', data_type: 'bigint' }, { name: 'group_id', data_type: 'uuid' }],
              primary_keys: ['id'],
              foreign_key_constraints: [{ name: 'users_group_fk', source_table: 'public.users',
                source_columns: ['group_id'], target_table: 'public.groups', target_columns: ['id'] }] },
            { name: 'groups', columns: [{ name: 'id', data_type: 'uuid' }] }
          ],
          functions: [{ name: 'refresh_users' }]
        }],
        migrations: [{ version: '202605220001' }],
        edge_functions: [{ slug: 'cleanup' }]
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

    clearGraphCache('ExternalEvidence');
    await scanGraph('ExternalEvidence');

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
    assert.equal(database.data.schemas[0].tables[0]?.name, 'users', 'safe schema metadata remains inspectable without unsafe prototypes');
    assert.ok(database.evidence.observations.some((x: any) =>
      x.kind === 'database-table' && x.name === 'public.users' && x.value.rlsEnabled === true));
    assert.ok(database.evidence.observations.some((x: any) =>
      x.kind === 'database-column' && x.name === 'public.users.id' && x.value.dataType === 'bigint'));
    assert.ok(database.evidence.relationships.some((x: any) =>
      x.kind === 'foreign-key' && x.status === 'resolved'
      && x.from === 'database-table:public.users' && x.to === 'database-table:public.groups'));
    assert.ok(database.evidence.observations.some((x: any) =>
      x.kind === 'database-migration' && x.value.version === '202605220001'));
    assert.ok(database.evidence.observations.some((x: any) =>
      x.kind === 'edge-function' && x.name === 'cleanup'));
    assert.ok(database.evidence.correlations.some((x: any) =>
      x.kind === 'matches-entity' && x.repositoryTarget === 'file:supabase/migrations/202605220001_initial.sql'));
    assert.ok(database.evidence.correlations.some((x: any) =>
      x.kind === 'matches-entity' && x.repositoryTarget === 'file:supabase/functions/cleanup/index.ts'));
    assert.equal(deployment.evidence.sanitization.policy, 'sanitized-v1');
    assert.equal(database.evidence.sanitization.policy, 'sanitized-v1');
  } finally {
    clearGraphCache('ExternalEvidence');
    globalThis.fetch = originalFetch;
    if (previousRegistry === undefined) delete process.env.DEVINT_PROJECTS_JSON;
    else process.env.DEVINT_PROJECTS_JSON = previousRegistry;
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('external evidence recursively redacts secrets and personal identifiers before mapping', () => {
  const secret = 'sk-proj-EXAMPLE_SECRET_1234567890';
  const input = {
    id: 'dep-safe', gitSource: { sha: 'a'.repeat(40), ref: 'preview' }, status: 'READY',
    url: 'https://deployment.example.test/path?token=hidden&email=test@example.com',
    metadata: {
      authorization: 'Bearer ' + secret, email: 'private@example.com',
      ip_address: '203.0.113.45', nested: {
        service_role: secret, request_body: { password: secret },
        message: 'contact private@example.com',
      },
    },
    event: 'Bearer ' + secret + ' for private@example.com',
    rows: [{ password: secret, owner: 'private@example.com' }],
  };
  const out = sanitizeExternalPayload(input);
  const rendered = JSON.stringify(out.value);
  assert.equal(out.redaction.policy, 'sanitized-v1');
  assert.ok(out.redaction.redactedFields >= 4);
  assert.ok(out.redaction.redactedValues >= 2);
  for (const forbidden of [secret, 'private@example.com', '203.0.113.45', 'token=hidden'])
    assert.equal(rendered.includes(forbidden), false, 'sensitive payload must never leave the adapter');
  assert.ok(rendered.includes('dep-safe'));
  assert.ok(rendered.includes('a'.repeat(40)), 'exact technical revision survives');
  assert.deepEqual(out.value, sanitizeExternalPayload(input).value, 'same input must sanitize deterministically');
});

test('query_source returns sanitized data and graph evidence, never raw provider rows or query credentials', async () => {
  const originalFetch = globalThis.fetch;
  const previousRegistry = process.env.DEVINT_PROJECTS_JSON;
  const secret = 'sk-proj-REALISTIC_TEST_SECRET_1234567890';
  try {
    process.env.DEVINT_PROJECTS_JSON = JSON.stringify({
      RedactionProof: {
        repository: 'https://github.com/example/repo.git', defaultRef: 'refs/heads/main',
        allowedRefs: ['refs/heads/main'], credential: { type: 'none' },
        technicalSources: [{
          id: 'external', type: 'read-only-http', adapter: 'generic-json',
          endpoint: 'https://provider.example.test/schema?api_key=private-value',
          capabilities: ['query'],
        }],
      },
    });
    globalThis.fetch = async (_input: any, init?: any) => {
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      return new Response(JSON.stringify({
        revision: 'b'.repeat(40), secret_key: secret,
        rows: [{ email: 'someone@example.com', access_token: secret }],
        headers: { authorization: 'Bearer ' + secret },
        misc: 'contact someone@example.com',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const sources = await listTechnicalSources('RedactionProof');
    assert.equal(sources[1]?.endpoint, 'https://provider.example.test',
      'discovery must not expose configured endpoint credential query');
    const result = await queryTechnicalSource({
      project: 'RedactionProof', sourceId: 'external', query: 'metadata',
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [secret, 'someone@example.com', 'private-value']) {
      assert.equal(serialized.includes(forbidden), false, 'secret and PII absent from all output planes');
    }
    assert.ok(serialized.includes('b'.repeat(40)), 'source revision remains visible');
    assert.equal((result.evidence as any).sanitization.policy, 'sanitized-v1');
    assert.ok((result.evidence as any).sanitization.redactedFields > 0);
    assert.equal((result.evidence as any).policy, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousRegistry === undefined) delete process.env.DEVINT_PROJECTS_JSON;
    else process.env.DEVINT_PROJECTS_JSON = previousRegistry;
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
