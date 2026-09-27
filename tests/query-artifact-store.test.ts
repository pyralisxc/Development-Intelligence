import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GraphNode, IntelligenceGraph } from '../src/types.js';
import {
  canonicalDerivedObjectFilePath,
  writeCanonicalDerivedObject,
} from '../src/intelligence/canonicalStore.js';
import {
  loadCanonicalQueryArtifactPointer,
  loadCanonicalQueryArtifacts,
  loadCanonicalQueryArtifactsFromPointer,
  persistPreparedCanonicalQueryArtifacts,
  prepareCanonicalQueryArtifactGeneration,
  publishCanonicalQueryArtifactPointer,
  publishCanonicalQueryArtifacts,
  QUERY_ARTIFACT_SLOT_COUNT,
} from '../src/intelligence/queryArtifactStore.js';
import { candidateQueryBuckets } from '../src/intelligence/queryArtifacts.js';

function node(id: string, sourceId: string, name: string): GraphNode {
  return { id, sourceId, kind: 'symbol', locator: `${sourceId}:${name}`, name, value: name, raw: name, layer: 'structural' };
}

function graph(revision: string, suffix = ''): IntelligenceGraph {
  return {
    schemaVersion: 2,
    analyzerVersion: '2.6.0-behavior-observations',
    graphId: `repo-${revision}-fixture0000`,
    project: 'fixture/query-artifacts',
    role: 'W',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: revision,
    sourceFingerprint: `source-${suffix}`,
    topologyFingerprint: `topology-${suffix}`,
    evidenceFingerprint: `evidence-${suffix}`,
    sources: [],
    evidence: [],
    nodes: [
      node('node:primary', 'repo:src/primary.ts', `NeedleService${suffix}`),
      node('node:outlier', 'repo:src/outlier.ts', `NeedleOutlier${suffix}`),
      node('node:other', 'repo:src/other.ts', 'Other'),
    ],
    edges: [],
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
    coverage: {
      trackedFiles: 3,
      eligibleFiles: 3,
      analyzedFiles: 3,
      completeFiles: 3,
      partialFiles: 0,
      unsupportedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0,
      skippedFileLimitFiles: 0,
      files: [
        { path: 'src/primary.ts', status: 'complete' },
        { path: 'src/outlier.ts', status: 'complete' },
        { path: 'src/other.ts', status: 'complete' },
      ],
    },
  };
}

test('query artifact generations publish manifest last and keep previous slot readable during interruption', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-query-generation-'));
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  try {
    const first = graph('1111111111111111111111111111111111111111', 'a');
    const firstPublish = await publishCanonicalQueryArtifacts(first);
    assert.equal(firstPublish.state, 'stored');
    assert.ok(firstPublish.ref);
    assert.equal(firstPublish.ref!.slot, 0);

    const firstLoad = await loadCanonicalQueryArtifacts(first, firstPublish.ref);
    assert.equal(firstLoad.state, 'hit');

    const second = graph('2222222222222222222222222222222222222222', 'b');
    const prepared = prepareCanonicalQueryArtifactGeneration(second, firstPublish.ref);
    assert.equal(prepared.ref.slot, 1);
    await persistPreparedCanonicalQueryArtifacts(second.project, prepared, { publishManifest: false });

    const previousStillReadable = await loadCanonicalQueryArtifacts(first, firstPublish.ref);
    assert.equal(previousStillReadable.state, 'hit');
    const interrupted = await loadCanonicalQueryArtifacts(second, prepared.ref);
    assert.equal(interrupted.state, 'miss');

    await persistPreparedCanonicalQueryArtifacts(second.project, prepared);
    const secondLoad = await loadCanonicalQueryArtifacts(second, prepared.ref);
    assert.equal(secondLoad.state, 'hit');
  } finally {
    delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('query artifact corruption fails closed instead of returning a partial generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-query-corrupt-'));
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  try {
    const value = graph('3333333333333333333333333333333333333333', 'c');
    const published = await publishCanonicalQueryArtifacts(value);
    assert.equal(published.state, 'stored');
    const full = await loadCanonicalQueryArtifacts(value, published.ref);
    assert.equal(full.state, 'hit');
    const buckets = candidateQueryBuckets(full.index!, 'needle');
    assert.ok(buckets.length > 0);
    const bucket = buckets[0]!;

    const manifestPath = `query-slots/${published.ref!.slot}/manifest.json`;
    const manifestFile = canonicalDerivedObjectFilePath(value.project, manifestPath)!;
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const shardPath = manifest.shards[bucket].path as string;
    await writeCanonicalDerivedObject(value.project, shardPath, new Uint8Array([1, 2, 3, 4]), 'application/gzip');

    const corrupted = await loadCanonicalQueryArtifacts(value, published.ref, [bucket]);
    assert.equal(corrupted.state, 'invalid');
    assert.match(corrupted.error ?? '', /integrity validation|size is invalid|incorrect header/i);
  } finally {
    delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('query artifact publication uses a fixed four-slot ring', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-query-ring-'));
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  try {
    let previous = null;
    const slots: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const digit = String((index + 4) % 10);
      const revision = digit.repeat(40);
      const published = await publishCanonicalQueryArtifacts(graph(revision, String(index)), previous);
      assert.equal(published.state, 'stored');
      assert.ok(published.ref);
      slots.push(published.ref!.slot);
      previous = published.ref;
    }
    assert.deepEqual(slots, [0, 1, 2, 3, 0, 1, 2]);

    const firstObject = canonicalDerivedObjectFilePath('fixture/query-artifacts', 'query-slots/0/manifest.json')!;
    const slotsRoot = path.dirname(path.dirname(firstObject));
    const entries = (await fs.readdir(slotsRoot, { withFileTypes: true }))
      .filter((entry: any) => entry.isDirectory())
      .map((entry: any) => entry.name)
      .sort();
    assert.deepEqual(entries, Array.from({ length: QUERY_ARTIFACT_SLOT_COUNT }, (_, index) => String(index)));
  } finally {
    delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('query artifact publication omits logically empty detail buckets', async () => {
  const value = graph('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sparse');
  const prepared = prepareCanonicalQueryArtifactGeneration(value);
  assert.ok(prepared.manifest.bucketIds.length > 0);
  assert.ok(prepared.manifest.bucketIds.length < 64);
  assert.equal(Object.keys(prepared.manifest.shards).length, prepared.manifest.bucketIds.length);
  assert.equal(prepared.ref.objectCount, prepared.manifest.bucketIds.length + 1, 'index + populated shards only');
});


test('current query pointer loads an exact generation without a full graph object', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-query-pointer-'));
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  try {
    const value = graph('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'pointer');
    const published = await publishCanonicalQueryArtifacts(value);
    assert.equal(published.state, 'stored');
    assert.ok(published.ref);

    const pointerPublish = await publishCanonicalQueryArtifactPointer(value, 'file:///fixture.git', published.ref!);
    assert.equal(pointerPublish.state, 'stored');
    assert.ok(pointerPublish.pointer);

    const pointerLoad = await loadCanonicalQueryArtifactPointer({
      project: value.project,
      repository: 'file:///fixture.git',
      revision: value.repositoryRevision!,
    });
    assert.equal(pointerLoad.state, 'hit');
    assert.equal(pointerLoad.pointer?.graphId, value.graphId);

    const indexLoad = await loadCanonicalQueryArtifactsFromPointer(pointerLoad.pointer!);
    assert.equal(indexLoad.state, 'hit');
    assert.ok(indexLoad.index);
    const buckets = candidateQueryBuckets(indexLoad.index!, 'needle');
    assert.ok(buckets.length > 0);

    const detailLoad = await loadCanonicalQueryArtifactsFromPointer(pointerLoad.pointer!, buckets);
    assert.equal(detailLoad.state, 'hit');
    assert.ok(Object.keys(detailLoad.shards ?? {}).length > 0);

    const stale = await loadCanonicalQueryArtifactPointer({
      project: value.project,
      repository: 'file:///fixture.git',
      revision: 'cccccccccccccccccccccccccccccccccccccccc',
    });
    assert.equal(stale.state, 'stale');
  } finally {
    delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});
