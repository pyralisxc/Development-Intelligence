import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { canonicalGraphFilePath } from '../src/intelligence/canonicalStore.js';
import { clearGraphCache, graphStatus } from '../src/intelligence/service.js';
import { runChecked } from '../src/util/process.js';

async function commit(repo: string, message: string): Promise<string> {
  await runChecked('git', ['-C', repo, 'add', '.']);
  await runChecked('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message]);
  return (await runChecked('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-canonical-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const scratch = path.join(root, 'scratch');
  const canonical = path.join(root, 'canonical');
  const project = 'CanonicalFixture';
  await fs.mkdir(scratch, { recursive: true });
  await runChecked('git', ['init', '--bare', '--initial-branch=main', remote]);
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'value.ts'), "export const value = 1;\n");
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
  process.env.DEVINT_PROJECTS_FILE = config;
  process.env.DEVINT_SCRATCH_DIR = scratch;
  process.env.DEVINT_CANONICAL_GRAPH_DIR = canonical;
  process.env.DEVINT_GRAPH_CACHE_SIZE = '1';
  clearGraphCache();
  return { root, project, canonical };
}

function cleanupEnv() {
  clearGraphCache();
  delete process.env.DEVINT_PROJECTS_FILE;
  delete process.env.DEVINT_SCRATCH_DIR;
  delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
  delete process.env.DEVINT_GRAPH_CACHE_SIZE;
}

test('default revision persists exact canonical graph and reloads it after process-cache eviction', async () => {
  const item = await fixture();
  try {
    const first = await graphStatus(item.project) as any;
    assert.equal(first.observability.graphAccess.cacheState, 'miss');
    assert.equal(first.observability.persistence.mode, 'canonical-file');
    assert.equal(first.observability.persistence.durable, true);
    assert.equal(first.observability.persistence.loadState, 'miss');
    assert.equal(first.observability.persistence.saveState, 'stored');
    assert.ok(first.observability.coldBuild);

    const target = canonicalGraphFilePath(item.project, first.revision);
    assert.ok(target);
    assert.equal((await fs.stat(target!)).isFile(), true);

    clearGraphCache(item.project);
    const second = await graphStatus(item.project) as any;
    assert.equal(second.observability.graphAccess.cacheState, 'miss');
    assert.equal(second.observability.persistence.loadState, 'hit');
    assert.equal(second.observability.persistence.saveState, 'skipped');
    assert.equal(second.observability.coldBuild, null);
    assert.equal(second.revision, first.revision);
    assert.equal(second.working.graphId, first.working.graphId);
    assert.equal(second.working.sourceFingerprint, first.working.sourceFingerprint);
  } finally {
    cleanupEnv();
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('corrupt canonical state is rejected and repaired from Git instead of becoming graph authority', async () => {
  const item = await fixture();
  try {
    const first = await graphStatus(item.project) as any;
    const target = canonicalGraphFilePath(item.project, first.revision)!;
    await fs.writeFile(target, '{"formatVersion":1,"project":"tampered"}');
    clearGraphCache(item.project);

    const repaired = await graphStatus(item.project) as any;
    assert.equal(repaired.observability.persistence.loadState, 'invalid');
    assert.equal(repaired.observability.persistence.saveState, 'stored');
    assert.ok(repaired.observability.coldBuild, 'invalid durable state must fall back to an actual Git build');
    assert.equal(repaired.revision, first.revision);
    assert.equal(repaired.working.topologyFingerprint, first.working.topologyFingerprint);

    const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.equal(parsed.project, item.project);
    assert.equal(parsed.revision, first.revision);
  } finally {
    cleanupEnv();
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('historical exact-SHA requests do not create durable canonical artifacts', async () => {
  const item = await fixture();
  try {
    const current = await graphStatus(item.project) as any;
    const historicalPath = canonicalGraphFilePath(item.project, current.revision)!;
    await fs.rm(historicalPath, { force: true });
    clearGraphCache(item.project);

    const historical = await graphStatus(item.project, `commit:${current.revision}`) as any;
    assert.equal(historical.observability.persistence.mode, 'process-only');
    assert.equal(historical.observability.persistence.durable, false);
    assert.equal(historical.observability.persistence.loadState, 'not-configured');
    await assert.rejects(fs.stat(historicalPath), /ENOENT/);
  } finally {
    cleanupEnv();
    await fs.rm(item.root, { recursive: true, force: true });
  }
});
