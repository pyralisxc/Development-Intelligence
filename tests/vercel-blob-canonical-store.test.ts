import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { clearGraphCache, graphStatus } from '../src/intelligence/service.js';
import { runChecked } from '../src/util/process.js';

async function commit(repo: string, message: string): Promise<string> {
  await runChecked('git', ['-C', repo, 'add', '.']);
  await runChecked('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message]);
  return (await runChecked('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}

async function listen(server: any): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as any).port;
}

async function close(server: any): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-blob-canonical-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const scratch = path.join(root, 'scratch');
  const project = 'BlobCanonicalFixture';
  await fs.mkdir(scratch, { recursive: true });
  await runChecked('git', ['init', '--bare', '--initial-branch=main', remote]);
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'value.ts'), "export const value = 'blob';\n");
  await commit(source, 'initial');
  await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await runChecked('git', ['-C', source, 'push', '-u', 'origin', 'main']);
  await fs.writeFile(config, JSON.stringify({
    [project]: {
      repository: pathToFileURL(remote).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      revisionPolicy: 'repository-history',
      credential: { type: 'none' },
      runtimeOrigins: [],
    },
  }, null, 2));

  const objects = new Map<string, string>();
  const requests: Array<{ method: string; url: string; authorization: string | null; store: string | null; access: string | null }> = [];
  const server = http.createServer(async (req: any, res: any) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization ?? null,
      store: req.headers['x-vercel-blob-store-id'] ?? null,
      access: req.headers['x-access'] ?? null,
    });
    if (req.headers.authorization !== 'Bearer oidc-test-token' || req.headers['x-vercel-blob-store-id'] !== 'teststore') {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/blob/') {
      const pathname = url.searchParams.get('pathname') ?? '';
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(pathname, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pathname, url: `http://127.0.0.1/private/${pathname}` }));
      return;
    }
    const prefix = '/private/';
    if (req.method === 'GET' && url.pathname.startsWith(prefix)) {
      const pathname = decodeURIComponent(url.pathname.slice(prefix.length));
      const body = objects.get(pathname);
      if (body === undefined) {
        res.writeHead(404).end('missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    res.writeHead(404).end('unknown');
  });
  const port = await listen(server);

  process.env.DEVINT_PROJECTS_FILE = config;
  process.env.DEVINT_SCRATCH_DIR = scratch;
  process.env.DEVINT_GRAPH_CACHE_SIZE = '1';
  process.env.DEVINT_CANONICAL_GRAPH_STORE = 'vercel-blob';
  process.env.BLOB_STORE_ID = 'store_teststore';
  process.env.VERCEL_OIDC_TOKEN = 'oidc-test-token';
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${port}/api/blob`;
  process.env.DEVINT_CANONICAL_BLOB_READ_BASE_URL = `http://127.0.0.1:${port}/private`;
  delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  clearGraphCache();
  return { root, project, scratch, server, objects, requests };
}

function cleanupEnv() {
  clearGraphCache();
  for (const key of [
    'DEVINT_PROJECTS_FILE','DEVINT_SCRATCH_DIR','DEVINT_GRAPH_CACHE_SIZE',
    'DEVINT_CANONICAL_GRAPH_STORE','BLOB_STORE_ID','VERCEL_OIDC_TOKEN',
    'VERCEL_BLOB_API_URL','DEVINT_CANONICAL_BLOB_READ_BASE_URL',
    'DEVINT_CANONICAL_GRAPH_DIR','BLOB_READ_WRITE_TOKEN',
  ]) delete process.env[key];
}

test('Vercel Blob backend persists current graph and bypasses checkout on a durable exact-SHA hit', async () => {
  const item = await fixture();
  try {
    const first = await graphStatus(item.project) as any;
    assert.equal(first.observability.persistence.mode, 'vercel-blob');
    assert.equal(first.observability.persistence.durable, true);
    assert.equal(first.observability.persistence.loadState, 'miss');
    assert.equal(first.observability.persistence.saveState, 'stored');
    assert.ok(first.observability.coldBuild);
    assert.equal(item.objects.size, 1);
    assert.ok(item.requests.some(request => request.method === 'PUT' && request.access === 'private'));

    clearGraphCache(item.project);
    const blockedScratch = path.join(item.root, 'scratch-is-a-file');
    await fs.writeFile(blockedScratch, 'checkout must not touch this');
    process.env.DEVINT_SCRATCH_DIR = blockedScratch;

    const second = await graphStatus(item.project) as any;
    assert.equal(second.observability.persistence.mode, 'vercel-blob');
    assert.equal(second.observability.persistence.loadState, 'hit');
    assert.equal(second.observability.coldBuild, null, 'durable hit must bypass withResolvedProjectCheckout');
    assert.equal(second.revision, first.revision);
    assert.equal(second.working.graphId, first.working.graphId);
    assert.ok(item.requests.some(request => request.method === 'GET' && /cache=0/u.test(request.url)));
  } finally {
    cleanupEnv();
    await close(item.server);
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('Vercel Blob backend fails safe to Git when explicitly enabled without a store binding', async () => {
  const item = await fixture();
  try {
    delete process.env.BLOB_STORE_ID;
    delete process.env.VERCEL_OIDC_TOKEN;
    clearGraphCache(item.project);
    const status = await graphStatus(item.project) as any;
    assert.equal(status.observability.persistence.mode, 'vercel-blob');
    assert.equal(status.observability.persistence.durable, false);
    assert.equal(status.observability.persistence.loadState, 'error');
    assert.ok(status.observability.coldBuild, 'missing Blob binding must fall back to Git');
  } finally {
    cleanupEnv();
    await close(item.server);
    await fs.rm(item.root, { recursive: true, force: true });
  }
});
