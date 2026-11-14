import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';
import { nodeTraits, relationshipKindContract, inspectRelationshipShape,
  sourceCapabilityCoverage, nodeKindsForFacet } from '../src/intelligence/graphKnowledge.js';
import { buildCanonicalQueryArtifacts, materializeQueryBuckets,
  queryBucketForSource } from '../src/intelligence/queryArtifacts.js';
import { reachMechanism } from '../src/intelligence/reach.js';

const go: GraphNode = {
  id: 'symbol:gin.go#method:gin.Engine.ServeHTTP', sourceId: 'repo:gin.go',
  kind: 'method', locator: 'gin.go:691', name: 'ServeHTTP',
  value: 'ServeHTTP', raw: 'ServeHTTP', layer: 'structural',
};
const other: GraphNode = {
  id: 'symbol:gin.go#method:gin.Engine.handleHTTPRequest', sourceId: 'repo:gin.go',
  kind: 'method', locator: 'gin.go:640', name: 'handleHTTPRequest',
  value: 'handleHTTPRequest', raw: 'handleHTTPRequest', layer: 'structural',
};
function specimen(): IntelligenceGraph {
  return {
    schemaVersion: 2, analyzerVersion: 'fixture', graphId: 'repo-fixture',
    project: 'gin', role: 'W', createdAt: new Date(0).toISOString(),
    repositoryRevision: 'a'.repeat(40), sourceFingerprint: 'source',
    topologyFingerprint: 'topology', evidenceFingerprint: 'evidence',
    sources: [], nodes: [go, other], edges: [], evidence: [{
      id: 'evidence:1', sourceId: 'repo:gin.go', kind: 'test',
      locator: 'gin.go:691',
    }], namingDivergences: [], explicitValueConflicts: [],
    unmatchedNodeIds: [], unavailableSourceIds: [], coverage: {
      trackedFiles: 1, eligibleFiles: 1, analyzedFiles: 1, completeFiles: 1,
      partialFiles: 0, unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0,
      skippedOversizedFiles: 0, skippedNonRegularFiles: 0, skippedFileLimitFiles: 0,
      files: [{ path: 'gin.go', status: 'complete' }],
    },
  };
}
test('a complete Go structural file does not imply call emission or absence', () => {
  const graph = specimen();
  const capabilities = sourceCapabilityCoverage(graph);
  const calls = capabilities.find(x => x.language === 'go' && x.family === 'calls');
  assert.equal(calls?.emitter, 'not-emitted');
  assert.equal(calls?.completeFiles, 1);
  assert.equal(calls?.exhaustiveForNegativeClaims, false);
  assert.equal(graph.edges.length, 0);
  const csharp: IntelligenceGraph = {
    ...graph, coverage: { ...graph.coverage!, files: [{ path: 'Scripts/Controller.cs', status: 'complete' }] },
  };
  assert.equal(sourceCapabilityCoverage(csharp).find(x => x.language === 'csharp' && x.family === 'calls')?.emitter, 'supported-partial');
});
test('one vocabulary is used for reach and proof, not name-pattern guesses', () => {
  assert.ok(nodeTraits('method').includes('callable'));
  assert.deepEqual(nodeTraits('toString'), []);
  assert.deepEqual(nodeTraits('__proto__'), []);
  assert.ok(nodeKindsForFacet('implementation').includes('method'));
  assert.equal(relationshipKindContract('callback-argument').family, 'reference');
  assert.equal(relationshipKindContract('callback-argument').proof, 'syntax');
  assert.equal(relationshipKindContract('callback-argument').realizationEligible, false);
  assert.equal(relationshipKindContract('calls').family, 'invocation');
  assert.equal(relationshipKindContract('calls').proof, 'bound-source');
  assert.equal(relationshipKindContract('uses_classes').proof, 'syntax');
  for (const kind of ['imports-file', 'targets-module', 'declares-module',
    'has-component', 'attached-to', 'child-of', 'uses-script', 'references',
    'used-by-unity-asset']) {
    assert.equal(relationshipKindContract(kind).realizationEligible, true,
      kind + ' keeps source-backed technical reach without runtime implications');
    assert.notEqual(relationshipKindContract(kind).proof, 'observation');
  }
  assert.equal(relationshipKindContract('constructs').family, 'invocation');
  assert.equal(reachMechanism('calls'), 'execution');
  assert.equal(relationshipKindContract('same_observed_name').realizationEligible, false);
  assert.equal(relationshipKindContract('connected-to').realizationEligible, true);
  for (const kind of ['references-symbol', 'depends-on', 'links_to',
    'declares-state', 'binds_to', 'bound_by', 'uses_classes', 'styled_by',
    'composes', 'uses-feature', 'handles-method', 'registered-as']) {
    assert.equal(relationshipKindContract(kind).realizationEligible, true,
      kind + ' must retain established proof reach');
    assert.notEqual(relationshipKindContract(kind).proof, 'not-established');
  }
  assert.equal(relationshipKindContract('contains').realizationEligible, false);
  assert.equal(relationshipKindContract('mysterious-project-relation').realizationEligible, false);
});
test('typed domain and range require real graph identities without inventing execution', () => {
  const graph = specimen();
  const good: GraphEdge = {
    id: 'go-call', from: go.id, to: other.id, kind: 'calls', status: 'resolved',
    strategy: 'compiler', confidence: 1, evidence: ['gin.go:691'],
  };
  const bad = { ...good, to: 'missing' };
  const nodes = new Map(graph.nodes.map(x => [x.id, x]));
  assert.equal(inspectRelationshipShape(good, nodes).status, 'valid');
  assert.equal(inspectRelationshipShape(bad, nodes).status, 'missing-endpoint');
  assert.equal(relationshipKindContract(good.kind).proof === 'observation', false);
});
test('revision-bound query artifacts address specific evidence by ID without duplicating graph authority', () => {
  const graph = specimen();
  const artifact = buildCanonicalQueryArtifacts(graph);
  const record = artifact.index.evidenceBucketById?.find(([id]) => id === 'evidence:1');
  assert.deepEqual(record, ['evidence:1', queryBucketForSource('repo:gin.go')]);
  const bucket = record?.[1]!;
  assert.ok(materializeQueryBuckets(artifact, [bucket]).evidence.some(x => x.id === 'evidence:1'));
  assert.equal(artifact.index.graphId, graph.graphId);
});
