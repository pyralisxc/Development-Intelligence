import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphNode, IntelligenceGraph } from '../src/types.js';
import { deriveQueryCorrelations, resolveCrossSource } from '../src/intelligence/resolver.js';
import {
  buildCanonicalQueryArtifacts,
  candidateQueryBuckets,
  materializeQueryBuckets,
} from '../src/intelligence/queryArtifacts.js';

function observation(id: string, sourceId: string, name: string, value: string): GraphNode {
  return {
    id,
    sourceId,
    kind: 'declaration',
    locator: `${sourceId.slice('repo:'.length)}:1`,
    name,
    value,
    raw: value,
    layer: 'structural',
  };
}

function graph(nodes: GraphNode[]): IntelligenceGraph {
  return {
    schemaVersion: 2,
    analyzerVersion: 'fixture',
    graphId: 'fixture-query-correlation',
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
    edges: [],
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
    coverage: {
      trackedFiles: nodes.length,
      eligibleFiles: nodes.length,
      analyzedFiles: nodes.length,
      completeFiles: nodes.length,
      partialFiles: 0,
      unsupportedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0,
      skippedFileLimitFiles: 0,
      files: nodes.map(node => ({ path: node.sourceId.slice('repo:'.length), status: 'complete' as const })),
    },
  };
}

test('canonical cross-source resolution does not persist weak lexical correlations', () => {
  const nodes = [
    observation('node:snake', 'repo:src/snake.ts', 'project_overview', 'snake'),
    observation('node:camel', 'repo:src/camel.ts', 'projectOverview', 'camel'),
  ];

  assert.deepEqual(resolveCrossSource(nodes, []), []);
  const derived = deriveQueryCorrelations(nodes, 10);
  assert.equal(derived.total, 1);
  assert.equal(derived.returned, 1);
  assert.equal(derived.truncated, false);
  assert.equal(derived.items[0]?.kind, 'similar_identifier');
  assert.equal(derived.items[0]?.status, 'candidate');
  assert.equal(derived.items[0]?.strategy, 'identifier-match');
});

test('query-time correlations preserve useful value hypotheses without cross-source noise becoming topology', () => {
  const nodes = [
    observation('node:left', 'repo:src/left.ts', 'LeftThing', 'shared-marker'),
    observation('node:right', 'repo:src/right.ts', 'RightThing', 'shared-marker'),
    observation('node:same-source', 'repo:src/left.ts', 'OtherThing', 'shared-marker'),
    observation('node:generic-a', 'repo:src/a.ts', 'GenericA', 'true'),
    observation('node:generic-b', 'repo:src/b.ts', 'GenericB', 'true'),
  ];

  const derived = deriveQueryCorrelations(nodes, 10);
  const valueEdges = derived.items.filter(edge => edge.kind === 'same_observed_value');
  assert.equal(valueEdges.length, 2, 'only cross-source non-generic value pairs should correlate');
  assert.ok(valueEdges.every(edge => edge.status === 'candidate'));
  assert.equal(derived.items.some(edge => edge.evidence.some(item => item.includes('"true"'))), false);
});

test('adaptive query artifacts find normalized identifier variants without persisted fuzzy edges', () => {
  const nodes = [
    observation('node:snake', 'repo:src/snake.ts', 'project_overview', 'snake'),
    observation('node:camel', 'repo:src/camel.ts', 'projectOverview', 'camel'),
    observation('node:unrelated', 'repo:src/other.ts', 'OtherThing', 'other'),
  ];
  const artifacts = buildCanonicalQueryArtifacts(graph(nodes));
  const buckets = candidateQueryBuckets(artifacts.index, 'project overview');
  const detail = materializeQueryBuckets(artifacts, buckets);
  const ids = new Set(detail.nodes.map(node => node.id));

  assert.ok(ids.has('node:snake'));
  assert.ok(ids.has('node:camel'));
  assert.equal(artifacts.index.edgeSearch.length, 0, 'query discovery must not require persisted fuzzy relationship records');
});
