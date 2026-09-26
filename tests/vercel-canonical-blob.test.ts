import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { canonicalGraphBlobPath } from '../src/intelligence/canonicalStore.js';
import { clearGraphCache, graphStatus } from '../src/intelligence/service.js';
import { runChecked } from '../src/util/process.js';

async function commit(repo: string, message: string): Promise<string> {
  await runChecked('git', ['-C', repo, 'add', '.']);
  await runChecked('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message]);
  return (await runChecked('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}
async function readRequestBody(request: any): Promise<string> {
  const chunks: any[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
async function startBlobServer() {
  const blobs = new Map<string, string>();
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
      assert.equal(request.headers['x-add-random-suffix'], '0');
      assert.equal(request.headers['x-allow-overwrite'], '1');
      assert.equal(request.headers['x-content-type'], 'application/json');
      blobs.set(pathname, await readRequestBody(request));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ url: `${origin}/private/${pathname}`, downloadUrl: `${origin}/private/${pathname}?download=1`, pathname, contentType: 'application/json' }));
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/private/')) {
      assert.equal(url.searchParams.get('cache'), '0');
      const pathname = decodeURIComponent(url.pathname.slice('/private/'.length));
      const value = blobs.get(pathname);
      if (value === undefined) { response.statusCode = 404; response.end('not found'); return; }
      response.setHeader('content-type', 'application/json');
      response.setHeader('content-length', String(Buffer.byteLength(value, 'utf8')));
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
    assert.equal(item.blob.blobs.size, 1);
    assert.ok(item.blob.blobs.has(canonicalGraphBlobPath(item.project)));
    clearGraphCache(item.project);
    await fs.rm(item.scratch, { recursive: true, force: true });
    await fs.writeFile(item.scratch, 'checkout must not touch this path');
    const second = await graphStatus(item.project) as any;
    assert.equal(second.observability.graphAccess.cacheState, 'miss');
    assert.equal(second.observability.persistence.mode, 'vercel-private-blob');
    assert.equal(second.observability.persistence.loadState, 'hit');
    assert.equal(second.observability.persistence.saveState, 'skipped');
    assert.equal(second.observability.coldBuild, null);
    assert.equal(second.revision, first.revision);
    assert.equal(second.working.graphId, first.working.graphId);
  } finally {
    cleanupEnv(); await item.blob.close(); await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('Main advancement overwrites one canonical Blob object and stale revision is a normal miss', async () => {
  const item = await fixture();
  try {
    const first = await graphStatus(item.project) as any;
    const pathname = canonicalGraphBlobPath(item.project);
    assert.equal(item.blob.blobs.size, 1);
    const firstStored = JSON.parse(item.blob.blobs.get(pathname)!);
    assert.equal(firstStored.revision, first.revision);
    await fs.writeFile(path.join(item.source, 'src', 'value.ts'), "export const value = 2;\n");
    const nextSha = await commit(item.source, 'advance main');
    await runChecked('git', ['-C', item.source, 'push', 'origin', 'main']);
    clearGraphCache(item.project);
    const next = await graphStatus(item.project) as any;
    assert.equal(next.revision, nextSha);
    assert.equal(next.observability.persistence.loadState, 'miss');
    assert.equal(next.observability.persistence.saveState, 'stored');
    assert.ok(next.observability.coldBuild);
    assert.equal(item.blob.blobs.size, 1);
    const nextStored = JSON.parse(item.blob.blobs.get(pathname)!);
    assert.equal(nextStored.revision, nextSha);
    assert.notEqual(nextStored.revision, firstStored.revision);
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
