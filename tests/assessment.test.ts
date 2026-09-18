import assert from 'node:assert/strict';
import test from 'node:test';
import { assessGraph, auditGraph } from '../src/intelligence/assessment.js';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';

const source = { id: 'repository', kind: 'repository', locator: 'fixture', revision: 'abc', observedAt: new Date(0).toISOString(), available: true };
const node = (id: string, kind: string, layer: NonNullable<GraphNode['layer']>, name = id, evidenceIds: string[] = []): GraphNode => ({ id, sourceId: source.id, kind, layer, name, locator: `src/${id}.ts:1`, value: name, raw: name, checkpoint: layer === 'semantic', evidenceIds });
const edge = (id: string, from: string, to: string | null, kind: string, status: GraphEdge['status'] = 'resolved', evidenceIds: string[] = []): GraphEdge => ({ id, from, to, kind, status, strategy: 'fixture', confidence: status === 'resolved' ? 1 : null, evidence: ['fixture'], layer: 'representation', checkpoint: false, evidenceIds });

function graph(complete = true): IntelligenceGraph {
  const evidence = [
    { id: 'proof:capability', sourceId: source.id, kind: 'fixture', locator: 'src/capability.ts:1' },
    { id: 'proof:path', sourceId: source.id, kind: 'fixture', locator: 'src/path.ts:1' },
  ];
  return {
    schemaVersion: 2, analyzerVersion: 'fixture', graphId: 'fixture', project: 'Fixture', role: 'W', createdAt: new Date(0).toISOString(), repositoryRevision: 'abc', sourceFingerprint: 'source', topologyFingerprint: 'topology', evidenceFingerprint: 'evidence',
    sources: [source], evidence,
    nodes: [
      node('capability:checkout', 'capability', 'semantic', 'Checkout', ['proof:capability']),
      node('surface:web', 'surface', 'semantic', 'Web'),
      node('mcp:checkout', 'mcp', 'semantic', 'checkout'),
      node('api:/checkout', 'api', 'semantic', '/checkout'),
      node('function:checkout', 'function', 'structural', 'checkout'),
      node('sql-table:orders', 'sql-table', 'structural', 'orders'),
    ],
    edges: [
      edge('e1', 'capability:checkout', 'surface:web', 'exposed-on', 'resolved', ['proof:path']),
      edge('e2', 'capability:checkout', 'mcp:checkout', 'automated-by'),
      edge('e3', 'capability:checkout', 'api:/checkout', 'connected-to'),
      edge('e4', 'api:/checkout', 'function:checkout', 'implemented-by'),
      edge('e5', 'function:checkout', 'sql-table:orders', 'writes'),
      edge('e6', 'capability:checkout', null, 'integrates-with', 'unresolved'),
    ],
    namingDivergences: [], explicitValueConflicts: [], unmatchedNodeIds: [], unavailableSourceIds: [],
    coverage: { trackedFiles: 2, eligibleFiles: 2, analyzedFiles: complete ? 2 : 1, completeFiles: complete ? 2 : 1, partialFiles: complete ? 0 : 1, unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0, skippedOversizedFiles: 0, skippedNonRegularFiles: 0, skippedFileLimitFiles: 0, files: [] },
  };
}

test('assessment produces deterministic revision-bound claims, proof, realization, and findings', () => {
  const first = assessGraph(graph(), 'How is Checkout realized?', ['human', 'agent', 'transport', 'implementation', 'persistence', 'provider']) as any;
  const second = assessGraph(graph(), 'How is Checkout realized?', ['human', 'agent', 'transport', 'implementation', 'persistence', 'provider']) as any;
  assert.equal(first.answerStatus, 'contradicted');
  assert.deepEqual(first.claims.map((item: any) => item.id), second.claims.map((item: any) => item.id));
  assert.equal(first.realization.facets.human.observed, true);
  assert.equal(first.realization.facets.agent.observed, true);
  assert.equal(first.realization.facets.persistence.observed, true);
  assert.equal(first.realization.facets.provider.observed, false);
  assert.ok(first.claims.some((item: any) => item.type === 'contract-facet' && item.status === 'contradicted' && item.statement.startsWith('provider')));
  assert.ok(first.claims.some((item: any) => item.proof.evidenceIds.includes('proof:capability')));
  assert.ok(first.findings.some((item: any) => item.ruleId === 'relationship.unresolved'));
  assert.equal(first.revision, 'abc');
  assert.equal(first.analyzerVersion, 'fixture');
});

test('incomplete coverage keeps absent expectations unproven and emits a coverage finding', () => {
  const result = assessGraph(graph(false), 'How is Checkout capability realized?', ['provider']) as any;
  assert.equal(result.answerStatus, 'unproven');
  assert.ok(result.claims.some((item: any) => item.type === 'contract-facet' && item.status === 'unproven'));
  assert.ok(auditGraph(graph(false)).some(item => item.ruleId === 'coverage.incomplete'));
});

test('unavailable coverage keeps the overall required-facet answer indeterminate', () => {
  const fixture = graph();
  delete fixture.coverage;
  const result = assessGraph(fixture, 'How is Checkout realized?', ['provider']) as any;
  assert.equal(result.answerStatus, 'indeterminate');
  assert.ok(result.claims.some((item: any) => item.type === 'contract-facet' && item.status === 'indeterminate'));
});

test('uncontracted unobserved facets are not manufactured into missing claims', () => {
  const result = assessGraph(graph(), 'How is Checkout capability realized?') as any;
  assert.equal(result.claims.some((item: any) => item.type === 'contract-facet'), false);
  assert.equal(result.realization.facets.provider.observed, false);
});

test('assessment remains part of a capability name and unmatched questions do not dump unrelated findings', () => {
  const fixture = graph();
  fixture.nodes.push(node('capability:assessment-intelligence', 'capability', 'semantic', 'Evidence-backed assessment intelligence'));
  const matched = assessGraph(fixture, 'How is assessment intelligence realized?') as any;
  assert.equal(matched.realization.root.id, 'capability:assessment-intelligence');

  const unmatched = assessGraph(fixture, 'Prove a capability that does not exist') as any;
  assert.equal(unmatched.answerStatus, 'contradicted');
  assert.deepEqual(unmatched.findings, []);
});
