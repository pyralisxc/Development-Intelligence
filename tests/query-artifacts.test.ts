import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';
import { planAdaptiveQuery } from '../src/intelligence/adaptiveQueryPlanner.js';
import {
  buildCanonicalQueryArtifacts,
  hydrateGlobalQueryIndex,
  materializeQueryDetail,
  queryBucketForSource,
} from '../src/intelligence/queryArtifacts.js';

function node(id: string, sourceId: string, name: string, locator: string): GraphNode {
  return { id, sourceId, kind: 'symbol', locator, name, value: name, raw: name, layer: 'structural' };
}

function edge(id: string, from: string | null, to: string | null, evidence: string[] = []): GraphEdge {
  return { id, from, to, kind: 'depends-on', strategy: 'test', confidence: 1, status: 'resolved', evidence, layer: 'structural' };
}

function graph(): IntelligenceGraph {
  const nodes = [
    node('node:panel', 'repo:src/a.ts', 'Panel', 'src/a.ts:1'),
    node('node:panel-controller', 'repo:src/b.ts', 'PanelController', 'src/b.ts:1'),
    node('node:outlier', 'repo:src/outlier.ts', 'PanelOutlier', 'src/outlier.ts:1'),
    node('node:other', 'repo:src/other.ts', 'Other', 'src/other.ts:1'),
  ];
  return {
    schemaVersion: 2,
    analyzerVersion: 'fixture',
    graphId: 'fixture-graph',
    project: 'fixture',
    role: 'W',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: '0123456789abcdef0123456789abcdef01234567',
    sourceFingerprint: 'source',
    topologyFingerprint: 'topology',
    evidenceFingerprint: 'evidence',
    sources: [],
    evidence: [],
    nodes,
    edges: [
      edge('edge:panel-other', 'node:panel', 'node:other', ['relationship without panel in its text']),
      edge('edge:unrelated', 'node:other', null, ['unrelated']),
    ],
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
    coverage: {
      trackedFiles: 4,
      eligibleFiles: 4,
      analyzedFiles: 4,
      completeFiles: 4,
      partialFiles: 0,
      unsupportedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0,
      skippedFileLimitFiles: 0,
      files: [
        { path: 'src/a.ts', status: 'complete' },
        { path: 'src/b.ts', status: 'complete' },
        { path: 'src/outlier.ts', status: 'complete' },
        { path: 'src/other.ts', status: 'complete' },
      ],
    },
  };
}

function fullSearchEnvelope(value: IntelligenceGraph, query: string): { nodes: string[]; edges: string[] } {
  const needle = query.trim().toLowerCase();
  const nodeText = (item: GraphNode) => [item.id, item.kind, item.layer, item.locator, item.field, item.name, item.raw, JSON.stringify(item.value)]
    .filter(Boolean).join(' ').toLowerCase();
  const edgeText = (item: GraphEdge) => [item.id, item.kind, item.layer, item.strategy, item.status, ...item.evidence].join(' ').toLowerCase();
  const nodes = value.nodes.filter(item => nodeText(item).includes(needle));
  const ids = new Set(nodes.map(item => item.id));
  const edges = value.edges.filter(item => edgeText(item).includes(needle)
    || Boolean(item.from && ids.has(item.from))
    || Boolean(item.to && ids.has(item.to)));
  return { nodes: nodes.map(item => item.id), edges: edges.map(item => item.id) };
}

test('query artifact global index preserves the full search answer envelope including incident edges', () => {
  const value = graph();
  const artifacts = buildCanonicalQueryArtifacts(value);
  const plan = planAdaptiveQuery(hydrateGlobalQueryIndex(artifacts.index), { mode: 'search', query: 'panel' });
  const oracle = fullSearchEnvelope(value, 'panel');
  assert.deepEqual(plan.candidateNodeIds, oracle.nodes);
  assert.deepEqual(plan.candidateEdgeIds, oracle.edges);
  assert.ok(plan.candidateNodeIds.includes('node:panel-controller'), 'exact-name match must not hide substring matches');
  assert.ok(plan.candidateNodeIds.includes('node:outlier'), 'disconnected outlier must remain globally discoverable');
  assert.ok(plan.candidateEdgeIds.includes('edge:panel-other'), 'incident edge must remain in search envelope even when edge text does not match');
});

test('fixed source buckets remain stable and selected detail materializes every globally selected candidate', () => {
  const value = graph();
  const artifacts = buildCanonicalQueryArtifacts(value);
  assert.equal(Object.keys(artifacts.shards).length, 16);
  assert.equal(artifacts.index.sourceBuckets['repo:src/a.ts'], queryBucketForSource('repo:src/a.ts'));

  const plan = planAdaptiveQuery(hydrateGlobalQueryIndex(artifacts.index), { mode: 'search', query: 'panel' });
  const detail = materializeQueryDetail(artifacts, plan.selectedSourceIds);
  const nodeIds = new Set(detail.nodes.map(item => item.id));
  const edgeIds = new Set(detail.edges.map(item => item.id));
  for (const id of plan.candidateNodeIds) assert.ok(nodeIds.has(id), `selected shards lost candidate node ${id}`);
  for (const id of plan.candidateEdgeIds) assert.ok(edgeIds.has(id), `selected shards lost candidate edge ${id}`);

  const changed = graph();
  changed.nodes.push(node('node:new', 'repo:src/new.ts', 'New', 'src/new.ts:1'));
  const changedArtifacts = buildCanonicalQueryArtifacts(changed);
  assert.equal(
    changedArtifacts.index.sourceBuckets['repo:src/a.ts'],
    artifacts.index.sourceBuckets['repo:src/a.ts'],
    'existing source shard assignment must not move when unrelated sources are added',
  );
});
