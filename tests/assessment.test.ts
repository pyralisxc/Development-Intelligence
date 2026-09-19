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
  assert.equal(first.reach.dimensions.human.observed, true);
  assert.equal(first.reach.dimensions.agent.observed, true);
  assert.equal(first.reach.dimensions.transport.observed, true);
  assert.equal(first.reach.dimensions.implementation.observed, true);
  assert.equal(first.reach.dimensions.persistence.observed, true);
  assert.match(first.reach.policy.interpretation, /does not score severity/i);
  assert.ok(first.realization.paths.some((item: any) => item.facet === 'implementation' && item.relationshipKinds.includes('implemented-by')));
  assert.ok(first.claims.some((item: any) => item.type === 'facet-observed' && item.proof.admissibility.purpose === 'realization'));
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

  const declarationOnly = graph();
  declarationOnly.edges = [edge('declares-only', 'capability:checkout', 'function:checkout', 'declares')];
  const implementation = assessGraph(declarationOnly, 'How is Checkout capability realized?', ['implementation']) as any;
  assert.equal(implementation.realization.facets.implementation.observed, false);
  assert.equal(implementation.answerStatus, 'contradicted');
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

test('natural existence and work phrasing resolves semantic subjects without false contradiction', () => {
  const fixture = graph();
  fixture.nodes.push(node('feature:storage-management', 'feature', 'semantic', 'storage-management'));
  fixture.nodes.push(node('function:create-zone', 'function', 'structural', 'createLibraryZoneAction'));

  const feature = assessGraph(fixture, 'How is storage management implemented?') as any;
  assert.equal(feature.answerStatus, 'supported');
  assert.equal(feature.realization.root.id, 'feature:storage-management');

  const symbol = assessGraph(fixture, 'Prove createLibraryZoneAction exists') as any;
  assert.equal(symbol.answerStatus, 'supported');
  assert.equal(symbol.claims[0].subjectId, 'function:create-zone');
});

test('scoped audits do not return unrelated repository-wide relationship findings', () => {
  const fixture = graph();
  fixture.nodes.push(node('feature:storage-management', 'feature', 'semantic', 'storage-management'));
  fixture.nodes.push(node('function:unrelated', 'function', 'structural', 'unrelated'));
  fixture.edges.push(edge('unrelated-unresolved', 'function:unrelated', null, 'calls', 'unresolved'));
  fixture.edges.push(edge('selected-candidate', 'feature:storage-management', 'api:/checkout', 'integrates-with', 'candidate'));

  const scoped = assessGraph(fixture, 'Audit storage management') as any;
  assert.deepEqual(scoped.findings, []);
  assert.ok(scoped.hypotheses.items.some((item: any) => item.edgeId === 'selected-candidate'));
  assert.deepEqual(scoped.findingSummary.scope, { rootId: 'feature:storage-management', resolvedDepth: 2, nodeCount: 1 });

  const global = assessGraph(fixture, 'Audit graph') as any;
  assert.ok(global.findings.some((item: any) => item.proof.edgeIds.includes('unrelated-unresolved')));
  assert.equal(global.findings.some((item: any) => item.proof.edgeIds.includes('selected-candidate')), false);
});

test('audit summaries group underlying findings without discarding their evidence', () => {
  const fixture = graph();
  fixture.nodes.push(node('feature:storage-management', 'feature', 'semantic', 'storage-management'));
  fixture.edges.push(edge('feature-path', 'feature:storage-management', 'function:checkout', 'implemented-by'));
  fixture.edges.push(edge('unresolved-one', 'function:checkout', 'api:/checkout', 'same_observed_name', 'unresolved'));
  fixture.edges.push(edge('unresolved-two', 'function:checkout', 'mcp:checkout', 'same_observed_name', 'unresolved'));

  const result = assessGraph(fixture, 'Audit storage management') as any;
  assert.equal(result.findings.length, 2);
  assert.equal(result.findingSummary.total, result.findings.length);
  assert.deepEqual(result.findingSummary.groups.map((item: any) => [item.relationshipKind, item.count]), [['same_observed_name', 2]]);
});
