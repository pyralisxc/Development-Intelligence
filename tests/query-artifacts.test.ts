import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';
import {
  buildCanonicalQueryArtifacts,
  candidateQueryBuckets,
  materializeQueryBuckets,
  queryBucketForSource,
} from '../src/intelligence/queryArtifacts.js';

function node(id: string, sourceId: string, name: string, locator: string): GraphNode {
  return { id, sourceId, kind: 'symbol', locator, name, value: name, raw: name, layer: 'structural' };
}

function edge(id: string, from: string | null, to: string | null, evidence: string[] = []): GraphEdge {
  return { id, from, to, kind: 'depends-on', strategy: 'test', confidence: 1, status: 'resolved', evidence, layer: 'structural' };
}

function graph(): IntelligenceGraph {
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
    nodes: [
      node('node:panel', 'repo:src/a.ts', 'Panel', 'src/a.ts:1'),
      node('node:panel-controller', 'repo:src/b.ts', 'PanelController', 'src/b.ts:1'),
      node('node:outlier', 'repo:src/outlier.ts', 'PanelOutlier', 'src/outlier.ts:1'),
      node('node:other', 'repo:src/other.ts', 'Other', 'src/other.ts:1'),
    ],
    edges: [
      edge('edge:panel-other', 'node:panel', 'node:other', ['relationship without panel in its text']),
      edge('edge:outlier-other', 'node:outlier', 'node:other', ['unrelated']),
      edge('edge:direct', null, null, ['dangerous remote marker']),
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

function text(value: GraphNode): string {
  return [value.id, value.kind, value.layer, value.locator, value.field, value.name, value.raw, JSON.stringify(value.value)]
    .filter(Boolean).join(' ').toLowerCase();
}
function edgeText(value: GraphEdge): string {
  return [value.id, value.kind, value.layer, value.strategy, value.status, ...value.evidence].join(' ').toLowerCase();
}

function fullSearchEnvelope(value: IntelligenceGraph, query: string): { nodes: string[]; edges: string[] } {
  const needle = query.trim().toLowerCase();
  const nodes = value.nodes.filter(item => text(item).includes(needle));
  const ids = new Set(nodes.map(item => item.id));
  const edges = value.edges.filter(item => edgeText(item).includes(needle)
    || Boolean(item.from && ids.has(item.from))
    || Boolean(item.to && ids.has(item.to)));
  return { nodes: nodes.map(item => item.id), edges: edges.map(item => item.id) };
}

function assertEnvelopeContained(value: IntelligenceGraph, query: string): void {
  const artifacts = buildCanonicalQueryArtifacts(value);
  const buckets = candidateQueryBuckets(artifacts.index, query);
  const detail = materializeQueryBuckets(artifacts, buckets);
  const nodeIds = new Set(detail.nodes.map(item => item.id));
  const edgeIds = new Set(detail.edges.map(item => item.id));
  const oracle = fullSearchEnvelope(value, query);
  for (const id of oracle.nodes) assert.ok(nodeIds.has(id), `Trigram shard selection lost oracle node ${id} for ${query}`);
  for (const id of oracle.edges) assert.ok(edgeIds.has(id), `Trigram shard selection lost oracle edge ${id} for ${query}`);
}

test('global trigram routing preserves disconnected outlier and incident-edge search recall', () => {
  const value = graph();
  assertEnvelopeContained(value, 'panel');
  const artifacts = buildCanonicalQueryArtifacts(value);
  const buckets = candidateQueryBuckets(artifacts.index, 'panel');
  assert.ok(buckets.includes(queryBucketForSource('repo:src/outlier.ts')), 'outlier source bucket must be globally discoverable');
  assert.ok(buckets.includes(queryBucketForSource('repo:src/a.ts')), 'primary source bucket must be globally discoverable');
});

test('direct edge-text matches with no bound endpoint remain globally discoverable', () => {
  assertEnvelopeContained(graph(), 'dangerous remote marker');
});

test('short or broad substring queries conservatively load every fixed shard', () => {
  const artifacts = buildCanonicalQueryArtifacts(graph());
  assert.equal(candidateQueryBuckets(artifacts.index, 'pa').length, 16);
  assert.equal(candidateQueryBuckets(artifacts.index, '').length, 16);
});

test('source bucket assignment remains stable as unrelated sources are added', () => {
  const value = graph();
  const before = queryBucketForSource('repo:src/a.ts');
  value.nodes.push(node('node:new', 'repo:src/new.ts', 'New', 'src/new.ts:1'));
  buildCanonicalQueryArtifacts(value);
  assert.equal(queryBucketForSource('repo:src/a.ts'), before);
});
