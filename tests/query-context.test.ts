import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntelligenceGraph } from '../src/types.js';
import { graphQueryContext } from '../src/intelligence/queryContext.js';

function graph(): IntelligenceGraph {
  return {
    schemaVersion: 2,
    analyzerVersion: 'test',
    graphId: 'test-graph',
    project: 'test',
    role: 'W',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: 'abc',
    sourceFingerprint: 'source',
    topologyFingerprint: 'topology',
    evidenceFingerprint: 'evidence',
    sources: [],
    evidence: [],
    nodes: [
      { id: 'a', sourceId: 'repo:a.ts', kind: 'function', locator: 'a.ts:1', name: 'a', value: 'a', raw: 'a', layer: 'structural' },
      { id: 'b', sourceId: 'repo:b.ts', kind: 'function', locator: 'b.ts:1', name: 'b', value: 'b', raw: 'b', layer: 'structural' },
      { id: 'c', sourceId: 'repo:c.ts', kind: 'api', locator: 'c.ts', name: '/c', value: '/c', raw: '/c', layer: 'semantic' },
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b', kind: 'calls', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [], layer: 'structural' },
      { id: 'e2', from: 'c', to: 'b', kind: 'implemented-by', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [], layer: 'semantic' },
      { id: 'e3', from: 'b', to: null, kind: 'unknown', strategy: 'test', confidence: null, status: 'unresolved', evidence: [], layer: 'structural' },
    ],
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
  };
}

test('compiled query context indexes immutable graph neighborhoods without changing graph order', () => {
  const input = graph();
  const first = graphQueryContext(input);
  const second = graphQueryContext(input);
  assert.equal(first, second, 'one immutable graph reuses one compiled context');
  assert.equal(first.node('b')?.name, 'b');
  assert.deepEqual(first.nodes('function').map(node => node.id), ['a', 'b']);
  assert.deepEqual(first.incoming('b').map(edge => edge.id), ['e1', 'e2']);
  assert.deepEqual(first.outgoing('b').map(edge => edge.id), ['e3']);
  assert.deepEqual(first.incident('b').map(edge => edge.id), ['e1', 'e2', 'e3']);
  assert.deepEqual(first.edgesByStatus.get('resolved')?.map(edge => edge.id), ['e1', 'e2']);
});
