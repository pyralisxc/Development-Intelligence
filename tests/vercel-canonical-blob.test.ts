import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { canonicalGraphBlobPath } from '../src/intelligence/canonicalStore.js';
import { clearGraphCache, graphStatus } from '../src/intelligence/service.js';
import { searchGraph } from '../src/intelligence/query.js';
import { runChecked } from '../src/util/process.js';
import { currentVercelOidcToken, withVercelRequestContext } from '../src/vercelRequestContext.js';

async function commit(repo: string, message: string): Promise<string> {
  await runChecked('git', ['-C', repo, 'add', '.']);
  await runChecked('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message]);
  return (await runChecked('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}
async function readRequestBody(request: any): Promise<any> {
  const chunks: any[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function startBlobServer() {
  const blobs = new Map<string, any>();
  const etags = new Map<string, string>();
  let etagSequence = 0;
  const requests: Array<{ method: string; pathname: string; query: string; headers: Record<string, string | string[] | undefined> }> = [];
  let origin = '';
  const server = http.createServer(async (request: any, response: any) => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    requests.push({ method: request.method ?? 'GET', pathname: url.pathname, query: url.search, headers: { ...request.headers } });
    if (request.headers.authorization !== 'Bearer test-oidc' || request.headers['x-vercel-blob-store-id'] !== 'test-store') {
      response.statusCode = 403; response.end('forbidden'); return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/blob') {
      const pathname = url.searchParams.get('pathname');
      if (!pathname) { response.statusCode = 400; response.end('missing pathname'); return; }
      assert.equal(request.headers['x-api-version'], '12');
      if (request.headers['x-vercel-blob-access'] !== 'private') {
        response.statusCode = 400;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: { code: 'bad_request', message: 'Cannot use public access on a private store. The store is configured with private access.' } }));
        return;
      }
      assert.equal(request.headers['x-vercel-blob-access'], 'private');
      assert.equal(request.headers['x-add-random-suffix'], '0');
      const allowOverwrite = String(request.headers['x-allow-overwrite'] ?? '');
      assert.ok(['0', '1'].includes(allowOverwrite), `unexpected overwrite mode: ${allowOverwrite}`);
      const expectedEtag = typeof request.headers['x-if-match'] === 'string' ? request.headers['x-if-match'] : null;
      const currentEtag = etags.get(pathname) ?? null;
      if (allowOverwrite === '0' && blobs.has(pathname)) {
        response.statusCode = 409;
        response.end('conflict');
        return;
      }
      if (expectedEtag !== null && expectedEtag !== currentEtag) {
        response.statusCode = 412;
        if (currentEtag) response.setHeader('etag', currentEtag);
        response.end('precondition failed');
        return;
      }
      const contentType = String(request.headers['x-content-type'] ?? '');
      assert.ok(['application/json', 'application/gzip'].includes(contentType), `unexpected Blob content type: ${contentType}`);
      blobs.set(pathname, await readRequestBody(request));
      const etag = `"mock-${++etagSequence}"`;
      etags.set(pathname, etag);
      response.setHeader('etag', etag);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ url: `${origin}/private/${pathname}`, downloadUrl: `${origin}/private/${pathname}?download=1`, pathname, contentType }));
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/private/')) {
      assert.equal(url.searchParams.get('cache'), '0');
      const pathname = decodeURIComponent(url.pathname.slice('/private/'.length));
      const value = blobs.get(pathname);
      if (value === undefined) { response.statusCode = 404; response.end('not found'); return; }
      response.setHeader('content-type', pathname.endsWith('.gz') ? 'application/gzip' : 'application/json');
      response.setHeader('content-length', String(value.byteLength));
      const etag = etags.get(pathname);
      if (etag) response.setHeader('etag', etag);
      response.end(value); return;
    }
    response.statusCode = 404; response.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as any;
  origin = `http://127.0.0.1:${address.port}`;
  return { blobs, requests, origin, close: () => new Promise<void>((resolve, reject) => server.close((error: any) => error ? reject(error) : resolve())) };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-vercel-blob-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const scratch = path.join(root, 'scratch');
  const project = 'VercelCanonicalFixture';
  const blob = await startBlobServer();
  await fs.mkdir(scratch, { recursive: true });
  await runChecked('git', ['init', '--bare', '--initial-branch=main', remote]);
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'value.ts'), "export const value = 1;\n");
  await fs.writeFile(path.join(source, 'src', 'use.ts'), "import { value } from './value.js';\nexport const doubled = value * 2;\n");
  await fs.writeFile(path.join(source, 'src', 'outlier.ts'), "export function valueOutlier() { return 7; }\n");
  const firstSha = await commit(source, 'initial');
  await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await runChecked('git', ['-C', source, 'push', '-u', 'origin', 'main']);
  await fs.writeFile(config, JSON.stringify({ [project]: {
    repository: pathToFileURL(remote).href, defaultRef: 'refs/heads/main', allowedRefs: ['refs/heads/main'],
    revisionPolicy: 'repository-history', credential: { type: 'none' }, runtimeOrigins: [],
  } }, null, 2));
  process.env.DEVINT_PROJECTS_FILE = config;
  process.env.DEVINT_SCRATCH_DIR = scratch;
  process.env.DEVINT_GRAPH_CACHE_SIZE = '1';
  process.env.BLOB_STORE_ID = 'store_test-store';
  process.env.VERCEL_OIDC_TOKEN = 'test-oidc';
  process.env.DEVINT_CANONICAL_BLOB_API_URL = `${blob.origin}/api/blob`;
  process.env.DEVINT_CANONICAL_BLOB_BASE_URL = `${blob.origin}/private`;
  delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  clearGraphCache();
  return { root, source, remote, scratch, project, firstSha, blob };
}
function cleanupEnv() {
  clearGraphCache();
  for (const key of ['DEVINT_PROJECTS_FILE','DEVINT_SCRATCH_DIR','DEVINT_GRAPH_CACHE_SIZE','DEVINT_CANONICAL_GRAPH_DIR','BLOB_STORE_ID','VERCEL_OIDC_TOKEN','BLOB_READ_WRITE_TOKEN','DEVINT_CANONICAL_BLOB_API_URL','DEVINT_CANONICAL_BLOB_BASE_URL','DEVINT_CANONICAL_BLOB_STORE_ID','DEVINT_CANONICAL_BLOB_TOKEN']) delete process.env[key];
}

test('Vercel canonical hit bypasses Git checkout after process-cache eviction', async () => {
  const item = await fixture();
  try {
    const first = await graphStatus(item.project) as any;
    assert.equal(first.observability.persistence.mode, 'vercel-private-blob');
    assert.equal(first.observability.persistence.durable, true);
    assert.equal(first.observability.persistence.loadState, 'miss');
    assert.equal(first.observability.persistence.saveState, 'stored');
    assert.ok(first.observability.coldBuild);
    assert.ok(item.blob.blobs.size > 3, 'canonical graph plus derived query artifacts should be stored');
    assert.ok(item.blob.blobs.has(canonicalGraphBlobPath(item.project)));
    const firstRecord = JSON.parse(item.blob.blobs.get(canonicalGraphBlobPath(item.project))!.toString('utf8'));
    assert.ok(firstRecord.queryArtifacts);
    assert.equal(firstRecord.queryArtifacts.slot, 0);
    const firstBlobCount = item.blob.blobs.size;
    const adaptiveSearch = await searchGraph({ project: item.project, query: 'value', limit: 100 }) as any;
    assert.equal(adaptiveSearch.queryPlane.mode, 'adaptive');
    assert.equal(adaptiveSearch.queryPlane.authoritative, true);
    assert.ok(adaptiveSearch.queryPlane.selectedBuckets >= 1);
    assert.equal(adaptiveSearch.adaptiveShadow.parity, null);
    assert.ok(adaptiveSearch.nodes.some((node: any) => String(node.id).includes('outlier')), 'adaptive answer should include disconnected outlier match');
    clearGraphCache(item.project);
    await fs.rm(item.scratch, { recursive: true, force: true });
    await fs.writeFile(item.scratch, 'checkout must not touch this path');

    const queryRequestStart = item.blob.requests.length;
    const queryOnly = await searchGraph({ project: item.project, query: 'value', limit: 100 }) as any;
    assert.equal(queryOnly.queryPlane.mode, 'adaptive');
    assert.equal(queryOnly.queryPlane.authoritative, true);
    assert.ok(queryOnly.queryPlane.selectedBuckets > 0);
    assert.ok(queryOnly.nodes.some((node: any) => String(node.id).includes('outlier')));
    const queryRequests = item.blob.requests.slice(queryRequestStart);
    assert.equal(
      queryRequests.some(request => request.pathname === `/private/${canonicalGraphBlobPath(item.project)}`),
      false,
      'authoritative narrow search must not read the full canonical graph blob',
    );

    const second = await graphStatus(item.project) as any;
    assert.equal(second.observability.graphAccess.cacheState, 'miss');
    assert.equal(second.observability.persistence.mode, 'vercel-private-blob');
    assert.equal(second.observability.persistence.loadState, 'hit');
    assert.equal(second.observability.persistence.saveState, 'skipped');
    assert.equal(second.observability.coldBuild, null);
    assert.equal(second.observability.queryArtifacts.state, 'referenced');
    assert.equal(second.revision, first.revision);
    assert.equal(second.working.graphId, first.working.graphId);
    assert.equal(second.observability.queryArtifacts.state, 'referenced');
    assert.equal(item.blob.blobs.size, firstBlobCount, 'canonical hit must not republish derived artifacts');
  } finally {
    cleanupEnv(); await item.blob.close(); await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('legacy canonical hits backfill query artifacts without rebuilding or touching checkout', async () => {
  const item = await fixture();
  try {
    const first = await graphStatus(item.project) as any;
    const pathname = canonicalGraphBlobPath(item.project);
    const legacy = JSON.parse(item.blob.blobs.get(pathname)!.toString('utf8'));
    assert.ok(legacy.queryArtifacts);

    delete legacy.queryArtifacts;
    item.blob.blobs.set(pathname, Buffer.from(JSON.stringify(legacy)));
    for (const key of [...item.blob.blobs.keys()]) {
      if (key !== pathname) item.blob.blobs.delete(key);
    }

    clearGraphCache(item.project);
    await fs.rm(item.scratch, { recursive: true, force: true });
    await fs.writeFile(item.scratch, 'checkout must not touch this path');

    const firstSearch = await searchGraph({ project: item.project, query: 'value', limit: 100 }) as any;
    assert.equal(firstSearch.queryPlane.mode, 'full', 'legacy record should fail closed for the request that discovers missing artifacts');
    assert.ok(firstSearch.nodes.some((node: any) => String(node.id).includes('outlier')));

    const migrated = JSON.parse(item.blob.blobs.get(pathname)!.toString('utf8'));
    assert.ok(migrated.queryArtifacts, 'canonical hit should be rewritten with the backfilled query generation reference');

    clearGraphCache(item.project);
    const requestStart = item.blob.requests.length;
    const secondSearch = await searchGraph({ project: item.project, query: 'value', limit: 100 }) as any;
    assert.equal(secondSearch.queryPlane.mode, 'adaptive', 'subsequent narrow reads should use the backfilled query plane');
    assert.equal(secondSearch.queryPlane.authoritative, true);
    assert.ok(secondSearch.queryPlane.selectedBuckets > 0);
    assert.ok(secondSearch.nodes.some((node: any) => String(node.id).includes('outlier')));
    const requests = item.blob.requests.slice(requestStart);
    assert.equal(
      requests.some(request => request.pathname === `/private/${pathname}`),
      false,
      'adaptive read after migration must not load the full canonical graph blob',
    );

    const status = await graphStatus(item.project) as any;
    assert.equal(status.observability.queryArtifacts.state, 'referenced');
    assert.equal(status.observability.coldBuild, null);
    assert.equal(status.revision, first.revision);
  } finally {
    cleanupEnv(); await item.blob.close(); await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('Main A->B advancement reuses a bounded dependency frontier and matches a forced full rebuild', async () => {
  const item = await fixture();
  try {
    const first = await graphStatus(item.project) as any;
    const pathname = canonicalGraphBlobPath(item.project);
    assert.ok(item.blob.blobs.size > 3);
    const firstStored = JSON.parse(item.blob.blobs.get(pathname)!.toString('utf8'));
    assert.equal(firstStored.revision, first.revision);
    assert.ok(firstStored.queryArtifacts);
    assert.equal(firstStored.queryArtifacts.slot, 0);

    await fs.writeFile(path.join(item.source, 'src', 'value.ts'), "export const value = 2;\n");
    const nextSha = await commit(item.source, 'advance main');
    await runChecked('git', ['-C', item.source, 'push', 'origin', 'main']);
    clearGraphCache(item.project);

    const next = await graphStatus(item.project) as any;
    assert.equal(next.revision, nextSha);
    assert.equal(next.observability.persistence.loadState, 'stale');
    assert.equal(next.observability.persistence.saveState, 'stored');
    assert.equal(next.observability.coldBuild.strategy, 'incremental');
    assert.equal(next.observability.coldBuild.changedFiles, 1);
    assert.equal(next.observability.coldBuild.affectedFiles, 2, 'value.ts and its importing use.ts should form the bounded frontier');
    const nextStored = JSON.parse(item.blob.blobs.get(pathname)!.toString('utf8'));
    assert.equal(nextStored.revision, nextSha);
    assert.notEqual(nextStored.revision, firstStored.revision);
    assert.ok(nextStored.queryArtifacts);
    assert.equal(nextStored.queryArtifacts.slot, 1);
    assert.notEqual(nextStored.queryArtifacts.generationId, firstStored.queryArtifacts.generationId);
    assert.equal(next.observability.queryArtifacts.state, 'stored');

    clearGraphCache(item.project);
    const full = await graphStatus(item.project, `commit:${nextSha}`) as any;
    assert.equal(full.observability.persistence.mode, 'process-only');
    assert.equal(next.working.sourceFingerprint, full.working.sourceFingerprint);
    assert.equal(next.working.topologyFingerprint, full.working.topologyFingerprint);
    assert.equal(next.working.evidenceFingerprint, full.working.evidenceFingerprint);
    assert.equal(next.working.nodes, full.working.nodes);
    assert.equal(next.working.edges, full.working.edges);
  } finally {
    cleanupEnv(); await item.blob.close(); await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('explicit historical revisions never read or write canonical Blob state', async () => {
  const item = await fixture();
  try {
    await graphStatus(item.project);
    clearGraphCache(item.project);
    const before = item.blob.requests.length;
    const historical = await graphStatus(item.project, `commit:${item.firstSha}`) as any;
    assert.equal(historical.observability.persistence.mode, 'process-only');
    assert.equal(historical.observability.persistence.durable, false);
    assert.equal(item.blob.requests.length, before);
  } finally {
    cleanupEnv(); await item.blob.close(); await fs.rm(item.root, { recursive: true, force: true });
  }
});


test('request-scoped Vercel OIDC authenticates canonical Blob without a runtime env token', async () => {
  const item = await fixture();
  delete process.env.VERCEL_OIDC_TOKEN;
  try {
    const first = await withVercelRequestContext(
      { 'x-vercel-oidc-token': 'test-oidc' },
      async () => await graphStatus(item.project) as any,
    );
    assert.equal(first.observability.persistence.mode, 'vercel-private-blob');
    assert.equal(first.observability.persistence.durable, true);
    assert.equal(first.observability.persistence.loadState, 'miss');
    assert.equal(first.observability.persistence.saveState, 'stored');
    assert.equal(first.observability.queryArtifacts.state, 'stored');
    assert.ok(first.observability.queryArtifacts.ref);

    clearGraphCache(item.project);
    const second = await withVercelRequestContext(
      { 'x-vercel-oidc-token': 'test-oidc' },
      async () => await graphStatus(item.project) as any,
    );
    assert.equal(second.observability.persistence.loadState, 'hit');
    assert.equal(second.observability.persistence.saveState, 'skipped');
    assert.equal(second.observability.coldBuild, null);
  } finally {
    cleanupEnv(); await item.blob.close(); await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('request-scoped Vercel OIDC contexts remain isolated across concurrent async work', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  const first = withVercelRequestContext(
    { 'x-vercel-oidc-token': 'first-token' },
    async () => {
      await gate;
      return currentVercelOidcToken();
    },
  );
  const second = withVercelRequestContext(
    { 'x-vercel-oidc-token': 'second-token' },
    async () => {
      assert.equal(currentVercelOidcToken(), 'second-token');
      release();
      await Promise.resolve();
      return currentVercelOidcToken();
    },
  );

  assert.deepEqual(await Promise.all([first, second]), ['first-token', 'second-token']);
  assert.equal(currentVercelOidcToken(), null);
});


test('adaptive search shadow fails closed on corrupt query artifacts while full search remains authoritative', async () => {
  const item = await fixture();
  try {
    await graphStatus(item.project);
    const pathname = canonicalGraphBlobPath(item.project);
    const record = JSON.parse(item.blob.blobs.get(pathname)!.toString('utf8'));
    assert.ok(record.queryArtifacts);
    const manifestKey = [...item.blob.blobs.keys()].find(key => key.endsWith(`/query-slots/${record.queryArtifacts.slot}/manifest.json`));
    assert.ok(manifestKey);
    item.blob.blobs.set(manifestKey!, Buffer.from('corrupt-manifest'));

    const result = await searchGraph({ project: item.project, query: 'value', limit: 100 }) as any;
    assert.ok(result.nodeTotal >= 1, 'full canonical search must still answer');
    assert.equal(result.queryPlane.mode, 'full');
    assert.equal(result.adaptiveShadow.parity, null);
    assert.ok(['invalid', 'error', 'miss'].includes(result.adaptiveShadow.state));
  } finally {
    cleanupEnv(); await item.blob.close(); await fs.rm(item.root, { recursive: true, force: true });
  }
});
