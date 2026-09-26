import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';
import { buildGlobalQueryIndex, planAdaptiveQuery } from '../src/intelligence/adaptiveQueryPlanner.js';

function node(id: string, sourceId: string, name: string, locator: string, layer: 'semantic' | 'structural' = 'structural'): GraphNode {
  return { id, sourceId, kind: layer === 'semantic' ? 'feature' : 'symbol', locator, name, value: name, raw: name, layer };
}

function edge(id: string, from: string | null, to: string | null, status: 'resolved' | 'candidate' | 'unresolved' = 'resolved'): GraphEdge {
  return { id, from, to, kind: 'depends-on', strategy: 'test', confidence: status === 'resolved' ? 1 : null, status, evidence: [id], layer: 'structural' };
}

function graph(nodes: GraphNode[], edges: GraphEdge[]): IntelligenceGraph {
  return {
    schemaVersion: 2,
    analyzerVersion: 'test',
    graphId: 'test-graph',
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
    edges,
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
        { path: 'src/a.ts', status: 'complete' },
        { path: 'src/b.ts', status: 'complete' },
        { path: 'src/outlier.ts', status: 'complete' },
      ],
    },
  };
}

test('global query index discovers disjoint outlier matches before choosing shards', () => {
  const value = graph([
    node('node:a', 'repo:src/a.ts', 'NeedleService', 'src/a.ts:1'),
    node('node:b', 'repo:src/b.ts', 'OrdinaryService', 'src/b.ts:1'),
    node('node:outlier', 'repo:src/outlier.ts', 'NeedleOutlier', 'src/outlier.ts:1'),
  ], []);
  const plan = planAdaptiveQuery(buildGlobalQueryIndex(value), { mode: 'search', query: 'needle' });
  assert.deepEqual(plan.candidateNodeIds.sort(), ['node:a', 'node:outlier']);
  assert.deepEqual(plan.selectedSourceIds, ['repo:src/a.ts', 'repo:src/outlier.ts']);
  assert.equal(plan.globallyDisjoint, true);
  assert.equal(plan.requiresFullGraph, false);
  assert.ok(plan.reasons.includes('global-index-seeded-all-lexical-candidates-before-local-materialization'));
});

test('trace planning follows global edge identities across source boundaries without relying on local blast radius', () => {
  const value = graph([
    node('node:a', 'repo:src/a.ts', 'A', 'src/a.ts:1'),
    node('node:b', 'repo:src/b.ts', 'B', 'src/b.ts:1'),
    node('node:c', 'repo:src/outlier.ts', 'C', 'src/outlier.ts:1'),
  ], [
    edge('edge:ab', 'node:a', 'node:b'),
    edge('edge:bc', 'node:b', 'node:c'),
  ]);
  const plan = planAdaptiveQuery(buildGlobalQueryIndex(value), { mode: 'trace', query: 'node:a', depth: 2 });
  assert.deepEqual(plan.selectedSourceIds, ['repo:src/a.ts', 'repo:src/b.ts', 'repo:src/outlier.ts']);
  assert.equal(plan.requiresFullGraph, false);
  assert.ok(plan.reasons.includes('trace-frontier-derived-from-global-edge-index'));
});

test('ambiguous trace can stay index-only and preserve candidates from unrelated shards', () => {
  const value = graph([
    node('node:left', 'repo:src/a.ts', 'Panel', 'src/a.ts:1'),
    node('node:right', 'repo:src/outlier.ts', 'Panel', 'src/outlier.ts:1'),
  ], []);
  const plan = planAdaptiveQuery(buildGlobalQueryIndex(value), { mode: 'trace', query: 'Panel' });
  assert.equal(plan.ambiguous, true);
  assert.equal(plan.indexOnly, true);
  assert.deepEqual(plan.candidateNodeIds.sort(), ['node:left', 'node:right']);
  assert.deepEqual(plan.selectedSourceIds, ['repo:src/a.ts', 'repo:src/outlier.ts']);
});

test('unbound matching relationships and broad questions explicitly escalate instead of silently narrowing', () => {
  const value = graph([
    node('node:a', 'repo:src/a.ts', 'A', 'src/a.ts:1'),
  ], [
    { ...edge('dangerous-outlier-edge', null, 'node:a', 'unresolved'), evidence: ['dangerous outlier contract'] },
  ]);
  const index = buildGlobalQueryIndex(value);
  const unresolved = planAdaptiveQuery(index, { mode: 'search', query: 'dangerous outlier', statuses: ['unresolved'] });
  assert.equal(unresolved.requiresFullGraph, true);
  assert.ok(unresolved.reasons.includes('matched-edge-has-unbound-endpoint'));

  const broad = planAdaptiveQuery(index, { mode: 'global', query: 'architecture' });
  assert.equal(broad.requiresFullGraph, true);
  assert.deepEqual(broad.reasons, ['broad-or-global-query-requires-complete-canonical-view']);
});

test('negative lexical result is only declared globally covered when graph coverage is complete', () => {
  const complete = graph([node('node:a', 'repo:src/a.ts', 'A', 'src/a.ts:1')], []);
  const completePlan = planAdaptiveQuery(buildGlobalQueryIndex(complete), { mode: 'search', query: 'definitely-missing' });
  assert.equal(completePlan.indexOnly, true);
  assert.equal(completePlan.coverageComplete, true);
  assert.ok(completePlan.reasons.includes('global-index-proves-no-match-across-covered-sources'));

  const incomplete = graph([node('node:a', 'repo:src/a.ts', 'A', 'src/a.ts:1')], []);
  incomplete.coverage!.partialFiles = 1;
  incomplete.coverage!.completeFiles = 2;
  incomplete.coverage!.analyzedFiles = 3;
  incomplete.coverage!.files[0] = { path: 'src/a.ts', status: 'partial', reason: 'fixture' };
  const incompletePlan = planAdaptiveQuery(buildGlobalQueryIndex(incomplete), { mode: 'search', query: 'definitely-missing' });
  assert.equal(incompletePlan.coverageComplete, false);
  assert.ok(incompletePlan.reasons.includes('global-index-found-no-match-but-source-coverage-is-incomplete'));
});
