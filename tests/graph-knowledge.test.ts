import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';
import { nodeTraits, relationshipKindContract, inspectRelationshipShape,
  sourceCapabilityCoverage, nodeKindsForFacet, reconcileCanonicalSourceFact,
  sourceDerivedTechnicalEdge, canonicalSourceFactProofEstablished } from '../src/intelligence/graphKnowledge.js';
import { buildCanonicalQueryArtifacts, materializeQueryBuckets,
  queryBucketForSource } from '../src/intelligence/queryArtifacts.js';
import { reachMechanism } from '../src/intelligence/reach.js';
import { assessGraph } from '../src/intelligence/assessment.js';
import { mergeNodes } from '../src/intelligence/repository.js';

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
  assert.equal(sourceCapabilityCoverage(csharp).find(x => x.language === 'csharp' && x.family === 'callback-arguments')?.emitter, 'not-emitted');
  const typescript: IntelligenceGraph = {
    ...graph, coverage: { ...graph.coverage!, files: [{ path: 'src/owner.ts', status: 'complete' }] },
  };
  const callbacks = sourceCapabilityCoverage(typescript).find(x =>
    x.language === 'typescript' && x.family === 'callback-arguments');
  assert.equal(callbacks?.emitter, 'supported-partial');
  assert.equal(callbacks?.exhaustiveForNegativeClaims, false);
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


test('source-derived execution is established technical truth without runtime realization', () => {
  const sourceSha256 = 'b'.repeat(64);
  const established = {
    id: 'fact:effect:one', sourceId: 'repo:src/guards.ts',
    kind: 'source-effect', name: 'Source return in guarded',
    locator: 'src/guards.ts:8:effect-offset-90',
    value: {
      functionId: 'symbol:src/guards.ts#function:guarded',
      sourceOnly: true, runtimeObserved: false, sourceSha256,
      expression: 'return route(...)', proofRule: 'typescript-source-control-graph.v1',
      derivedExecution: {
        status: 'established', proposition: 'source-conditional-effect',
        evidenceGrade: 'exact-source-derivation', sourceSha256,
        scope: 'selected-source-revision', proofRule: 'typescript-source-control-graph.v1',
        requiredConditions: [{ conditionId: 'src/guards.ts:condition:20', expectedTruth: false }],
        predicateSatisfiabilityProven: false, runtimeObserved: false,
      },
    }, raw: 'fixture', evidenceIds: ['evidence:exact'], layer: 'structural',
  } satisfies GraphNode;
  assert.equal(canonicalSourceFactProofEstablished(established), true);
  assert.equal(canonicalSourceFactProofEstablished({ ...established, evidenceIds: [] }), false);
  const lower = {
    ...established, evidenceIds: ['evidence:inferred'],
    value: {
      functionId: established.value.functionId,
      sourceOnly: true, runtimeObserved: false,
      expression: 'return unrelated(...)',
      proofRule: 'heuristic-proposal',
    },
  } satisfies GraphNode;
  assert.deepEqual(reconcileCanonicalSourceFact(lower, established), {
    outcome: 'stronger-right',
    reason: 'exact-source-derived-proof-over-unqualified-assertion',
  });
  assert.equal(reconcileCanonicalSourceFact(established, lower).outcome, 'stronger-left');
  assert.equal(canonicalSourceFactProofEstablished(lower), false);
  assert.equal(reconcileCanonicalSourceFact(established, established).outcome, 'identical');
  const opposingExact = {
    ...established,
    value: { ...established.value, expression: 'return different(...)' },
  };
  assert.equal(reconcileCanonicalSourceFact(established, opposingExact).outcome, 'contested',
    'two equally source-qualified contradictory claims must not be silently selected');
  assert.equal(canonicalSourceFactProofEstablished({
    ...established, tags: ['source-fact-contested'],
  }), false, 'a tied conflict must remain visible without claiming undisputed proof');
  const differentSourceRevision = {
    ...established,
    value: { ...established.value, sourceSha256: 'c'.repeat(64),
      derivedExecution: { ...established.value.derivedExecution, sourceSha256: 'c'.repeat(64) } },
  };
  assert.equal(reconcileCanonicalSourceFact(established, differentSourceRevision).outcome, 'contested',
    'source facts from different content identities cannot overrule one another');
  const guard: GraphEdge = {
    id: 'edge:guard', kind: 'requires-condition', from: established.id,
    to: 'condition:id', status: 'resolved', confidence: 1,
    strategy: 'source-condition-false', evidence: [established.locator],
    evidenceIds: ['evidence:guard'],
  };
  assert.equal(sourceDerivedTechnicalEdge(guard), true,
    'verified conditional source premises must be valid facts');
  assert.equal(relationshipKindContract(guard.kind).realizationEligible, false,
    'source proof must not become a runtime or product-realization assertion');
  assert.equal(sourceDerivedTechnicalEdge({ ...guard, status: 'unresolved' }), false);
  assert.equal(sourceDerivedTechnicalEdge({ ...guard, evidenceIds: [] }), false,
    'the relationship kind alone must not manufacture positive source evidence');
});


test('canonical graph construction prefers exact derived source proof while preserving contrary evidence', () => {
  const sourceSha256 = 'd'.repeat(64);
  const base: GraphNode = {
    id: 'effect:fact', sourceId: 'repo:src/run.ts',
    kind: 'source-effect', locator: 'src/run.ts:8:effect-offset-200',
    name: 'Source return in run', value: {
      functionId: 'symbol:src/run.ts#function:run',
      sourceOnly: true, runtimeObserved: false, sourceSha256,
      expression: 'return runStage(...)',
      proofRule: 'typescript-source-control-graph.v1',
      derivedExecution: {
        status: 'established', proposition: 'source-conditional-effect',
        evidenceGrade: 'exact-source-derivation', scope: 'selected-source-revision',
        sourceSha256, proofRule: 'typescript-source-control-graph.v1',
        requiredConditions: [{ conditionId: 'guard:A', expectedTruth: true }],
        predicateSatisfiabilityProven: false, runtimeObserved: false,
      },
    }, raw: 'source-value', evidenceIds: ['evidence:source'], layer: 'structural',
  };
  const weak: GraphNode = { ...base, raw: 'guess',
    evidenceIds: ['evidence:guess'],
    value: { functionId: (base.value as any).functionId, sourceOnly: true,
      runtimeObserved: false, expression: 'return otherStage(...)',
      proofRule: 'heuristic' },
  };
  for (const candidates of [[weak, base], [base, weak]]) {
    const merged = mergeNodes(candidates);
    assert.equal(merged.nodes.length, 1);
    assert.deepEqual(merged.nodes[0]?.value, base.value);
    assert.ok(merged.nodes[0]?.tags?.includes('weaker-source-assertion-overruled'));
    assert.deepEqual(merged.nodes[0]?.evidenceIds,
      ['evidence:guess', 'evidence:source'], 'both observations remain inspectable');
    assert.equal(merged.conflicts.length, 1);
    assert.equal(merged.conflicts[0]?.resolution, 'higher-source-proof-preferred');
    assert.deepEqual(merged.conflicts[0]?.preferredEvidenceIds, ['evidence:source']);
  }
  const equallyGrounded = { ...base,
    value: { ...(base.value as Record<string, unknown>),
      expression: 'return otherStage(...)' } };
  const contested = mergeNodes([base, equallyGrounded]);
  assert.equal(contested.conflicts[0]?.resolution, 'contested');
  assert.ok(contested.nodes[0]?.tags?.includes('source-fact-contested'));
  assert.ok(contested.nodes[0]?.tags?.includes('conflicted'));
  assert.deepEqual(mergeNodes([equallyGrounded, base]).nodes[0]?.value,
    contested.nodes[0]?.value,
    'tie-breaking a contested fact must be deterministic, not evidence-order dependent');
});


test('assessment phase diagnostics remain request-local and do not alter semantic results', () => {
  const graph = specimen();
  const profile = { phaseMs: {} as Record<string, number> };
  const normal = assessGraph(graph, go.id);
  const timed = assessGraph(graph, go.id, [], profile);
  assert.deepEqual(timed, normal);
  for (const phase of ['subjectAndCandidates', 'claimsTraversalAndReach',
    'auditAndCoverage', 'candidateHypotheses', 'orientationAndMotifs']) {
    assert.ok(Number.isFinite(profile.phaseMs[phase]) && profile.phaseMs[phase]! >= 0,
      'assessment must expose nonnegative stage ' + phase);
  }
  assert.equal(JSON.stringify(timed).includes('assessmentPhases'), false,
    'timing receipts cannot become semantic results');
});
