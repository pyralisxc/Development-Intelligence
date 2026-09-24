import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { IntelligenceGraph } from '../src/types.js';
import { AsyncGate, graphRecordWeight, positiveIntegerSetting, retentionEvictions } from '../src/intelligence/capacity.js';
import { clearGraphCache, graphCacheDiagnostics, scanGraph } from '../src/intelligence/service.js';
import { runChecked } from '../src/util/process.js';

function graph(): IntelligenceGraph {
  return {
    schemaVersion: 2,
    analyzerVersion: 'test',
    graphId: 'test',
    project: 'test',
    role: 'W',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: 'revision',
    sourceFingerprint: 'source',
    topologyFingerprint: 'topology',
    evidenceFingerprint: 'evidence',
    sources: [{ id: 'source', kind: 'repository', locator: 'repo', revision: 'revision', observedAt: new Date(0).toISOString(), available: true }],
    evidence: [{ id: 'evidence', sourceId: 'source', kind: 'syntax', locator: 'a.ts' }],
    nodes: [{ id: 'node', sourceId: 'source', kind: 'file', locator: 'a.ts', value: 'a.ts', raw: 'a.ts' }],
    edges: [{ id: 'edge', from: 'node', to: null, kind: 'unresolved', strategy: 'test', confidence: null, status: 'unresolved', evidence: [] }],
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: ['node'],
    unavailableSourceIds: [],
    coverage: {
      trackedFiles: 1,
      eligibleFiles: 1,
      analyzedFiles: 1,
      completeFiles: 1,
      partialFiles: 0,
      unsupportedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0,
      skippedFileLimitFiles: 0,
      files: [{ path: 'a.ts', status: 'complete' }],
    },
  };
}

test('graph capacity uses record weight instead of pretending every graph costs one unit', () => {
  assert.equal(graphRecordWeight(graph()), 6);
  assert.equal(positiveIntegerSetting(undefined, 3, 'limit'), 3);
  assert.throws(() => positiveIntegerSetting('0', 3, 'limit'), /positive integer/);
});

test('retention evicts least-recently-used graphs by count and record budget while preserving the active graph', () => {
  const items = [
    { id: 'old-small', records: 20, touchedAt: 1 },
    { id: 'old-large', records: 80, touchedAt: 2 },
    { id: 'active', records: 90, touchedAt: 3, protected: true },
  ];
  assert.deepEqual(retentionEvictions(items, { maxEntries: 2, maxRecords: 120 }), ['old-small', 'old-large']);
  assert.deepEqual(retentionEvictions([{ id: 'active', records: 200, touchedAt: 1, protected: true }], { maxEntries: 1, maxRecords: 100 }), []);
});

test('cold-build gate serializes expensive work', async () => {
  const gate = new AsyncGate(() => 1);
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  const order: string[] = [];
  const first = gate.run(async () => {
    order.push('first-start');
    firstStarted();
    await release;
    order.push('first-end');
  });
  await started;
  const second = gate.run(async () => { order.push('second'); });
  await Promise.resolve();
  assert.deepEqual(gate.status(), { active: 1, queued: 1, limit: 1 });
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.deepEqual(gate.status(), { active: 0, queued: 0, limit: 1 });
});

async function makeRepository(parent: string, name: string): Promise<string> {
  const root = path.join(parent, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'index.ts'), `export const ${name} = '${name}';\n`);
  await runChecked('git', ['init', '--initial-branch=main', root]);
  await runChecked('git', ['-C', root, 'config', 'user.name', 'Capacity Test']);
  await runChecked('git', ['-C', root, 'config', 'user.email', 'capacity-test@example.invalid']);
  await runChecked('git', ['-C', root, 'add', '.']);
  await runChecked('git', ['-C', root, 'commit', '-m', 'fixture']);
  return pathToFileURL(root).href;
}

test('service shares identical cold builds and prunes settled graphs through the combined record budget', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-capacity-service-'));
  const previous = {
    projects: process.env.DEVINT_PROJECTS_JSON,
    records: process.env.DEVINT_GRAPH_CACHE_MAX_RECORDS,
    builds: process.env.DEVINT_GRAPH_BUILD_CONCURRENCY,
  };
  try {
    const [firstRepository, secondRepository] = await Promise.all([
      makeRepository(root, 'first'),
      makeRepository(root, 'second'),
    ]);
    process.env.DEVINT_PROJECTS_JSON = JSON.stringify({
      First: { repository: firstRepository, defaultRef: 'refs/heads/main', allowedRefs: ['refs/heads/main'], credential: { type: 'none' } },
      Second: { repository: secondRepository, defaultRef: 'refs/heads/main', allowedRefs: ['refs/heads/main'], credential: { type: 'none' } },
    });
    process.env.DEVINT_GRAPH_CACHE_MAX_RECORDS = '1';
    process.env.DEVINT_GRAPH_BUILD_CONCURRENCY = '1';
    clearGraphCache();

    const [first, shared] = await Promise.all([scanGraph('First'), scanGraph('First')]);
    assert.equal(first, shared, 'one immutable project/SHA shares one in-flight graph build');
    assert.equal((graphCacheDiagnostics().repository as any).entries, 1);

    await scanGraph('Second');
    const diagnostics = graphCacheDiagnostics() as any;
    assert.equal(diagnostics.repository.entries, 1, 'the active graph survives and the older graph is evicted');
    assert.ok(diagnostics.retainedRecords > diagnostics.maxRetainedRecords, 'one active graph may exceed the shared budget without being discarded');
  } finally {
    clearGraphCache();
    if (previous.projects === undefined) delete process.env.DEVINT_PROJECTS_JSON;
    else process.env.DEVINT_PROJECTS_JSON = previous.projects;
    if (previous.records === undefined) delete process.env.DEVINT_GRAPH_CACHE_MAX_RECORDS;
    else process.env.DEVINT_GRAPH_CACHE_MAX_RECORDS = previous.records;
    if (previous.builds === undefined) delete process.env.DEVINT_GRAPH_BUILD_CONCURRENCY;
    else process.env.DEVINT_GRAPH_BUILD_CONCURRENCY = previous.builds;
    await fs.rm(root, { recursive: true, force: true });
  }
});
