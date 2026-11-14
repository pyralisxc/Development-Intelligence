import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntelligenceGraph } from '../src/types.js';
import { graphQueryContext } from '../src/intelligence/queryContext.js';
import { auditGraph } from '../src/intelligence/assessment.js';

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
  assert.equal(first.edgesById.get('e2'), input.edges[1]);
  assert.equal(first.edgesById.get('e3')?.status, 'unresolved');
  assert.deepEqual(first.nodes('function').map(node => node.id), ['a', 'b']);
  assert.deepEqual(first.incoming('b').map(edge => edge.id), ['e1', 'e2']);
  assert.deepEqual(first.outgoing('b').map(edge => edge.id), ['e3']);
  assert.deepEqual(first.incident('b').map(edge => edge.id), ['e1', 'e2', 'e3']);
  assert.deepEqual(first.edgesByStatus.get('resolved')?.map(edge => edge.id), ['e1', 'e2']);
});


test('Graphology query adjacency preserves parallel, loop, unresolved and half-edge provenance', () => {
  const input = graph();
  input.edges.push(
    { id: 'e4', from: 'a', to: 'b', kind: 'calls', strategy: 'bound', confidence: 1,
      status: 'resolved', evidence: ['second callsite'], layer: 'structural' },
    { id: 'e5', from: 'b', to: 'b', kind: 'calls', strategy: 'recursive', confidence: 1,
      status: 'resolved', evidence: [], layer: 'structural' },
    { id: 'e6', from: null, to: 'a', kind: 'unknown', strategy: 'partial', confidence: null,
      status: 'unresolved', evidence: [], layer: 'structural' },
    { id: 'e7', from: 'not-in-graph', to: 'a', kind: 'unknown', strategy: 'partial',
      confidence: null, status: 'unresolved', evidence: [], layer: 'structural' },
  );
  const context = graphQueryContext(input);
  assert.deepEqual(context.incoming('b').map(edge => edge.id), ['e1', 'e2', 'e4', 'e5']);
  assert.deepEqual(context.outgoing('b').map(edge => edge.id), ['e3', 'e5']);
  assert.deepEqual(context.incident('b').map(edge => edge.id), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(context.incoming('a').map(edge => edge.id), ['e6', 'e7']);
  assert.deepEqual(context.outgoing('a').map(edge => edge.id), ['e1', 'e4']);
  assert.deepEqual(context.incident('a').map(edge => edge.id), ['e1', 'e4', 'e6', 'e7']);
  assert.equal(context.incoming('b')[2], input.edges[3],
    'native traversal must preserve canonical edge object/evidence identity');
  assert.deepEqual(context.incident('absent'), []);
  assert.equal(graphQueryContext(input), context, 'exact revision context is cached once');
});

test('repository realization census reads source facts without traversal-only authority', () => {
  const input = graph();
  input.nodes.push(
    { id: 'feature:cap', sourceId: 'repo:cap.ts', kind: 'capability', locator: 'cap.ts:1',
      name: 'cap', value: 'cap', raw: 'cap', layer: 'semantic' },
    { id: 'feature:unused', sourceId: 'repo:unused.ts', kind: 'action', locator: 'unused.ts:1',
      name: 'unused', value: 'unused', raw: 'unused', layer: 'semantic' },
  );
  input.edges.push(
    { id: 'e8', from: 'feature:cap', to: 'a', kind: 'implemented-by',
      strategy: 'source', confidence: 1, status: 'resolved',
      evidence: [], layer: 'semantic' },
    { id: 'e9', from: 'feature:unused', to: null, kind: 'invokes',
      strategy: 'unresolved', confidence: null, status: 'unresolved',
      evidence: ['unknown receiver'], layer: 'semantic' },
  );
  const before = input.edges.map(edge => edge.id);
  const findings = auditGraph(input, undefined, new Set(['realization']));
  assert.deepEqual(findings.map(item => item.affectedIds), [['feature:unused']],
    'only the capability without a proven realization relation is disconnected');
  assert.deepEqual(findings[0]?.proof.edgeIds, ['e9'],
    'unproven source edges remain visible as audit evidence without being realization proof');
  assert.deepEqual(input.edges.map(edge => edge.id), before,
    'auditing must not mutate canonical source order');
});
