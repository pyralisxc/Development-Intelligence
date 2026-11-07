import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntelligenceGraph, GraphNode, GraphEdge } from '../src/types.js';
import { deriveCurrentSemanticTruth } from '../src/intelligence/semanticCurrentTruth.js';

const revisionA = 'a'.repeat(40);
const revisionB = 'b'.repeat(40);

function graph(revision: string, incomplete = false, declared = false): IntelligenceGraph {
  const paths = Array.from({ length: 5 }, (_, i) => 'src/features/demo/module' + i + '.ts');
  const nodes: GraphNode[] = paths.map(file => ({
    id: 'file:' + file, sourceId: 'repository', kind: 'file', locator: file,
    value: file, raw: file, layer: 'structural' as const,
  }));
  nodes.push({
    id: 'technical:api', sourceId: 'repository', kind: 'http-call',
    locator: paths[0] + ':api', value: null, raw: 'api', layer: 'structural',
  });
  nodes.push({
    id: 'technical:storage', sourceId: 'repository', kind: 'storage',
    locator: paths[1] + ':storage', value: null, raw: 'storage', layer: 'structural',
  });
  if (declared) nodes.push({
    id: 'semantic:declared', sourceId: 'repo:' + paths[0], kind: 'domain',
    locator: paths[0] + ':source-declaration', name: 'Explicit Domain',
    value: 'Explicit Domain', raw: 'source declaration', layer: 'semantic',
    tags: ['declared'], evidenceIds: [],
  });
  const edges: GraphEdge[] = Array.from({ length: 10 }, (_, i) => ({
    id: 'edge:' + i, from: 'file:' + paths[i % 5], to: 'file:' + paths[(i + 1) % 5],
    kind: 'imports', status: 'resolved', strategy: 'fixture', confidence: 1,
    evidence: [], layer: 'structural',
  }));
  return {
    schemaVersion: 2, analyzerVersion: 'fixture-v1', graphId: 'repo-' + revision,
    project: 'fixture', role: 'W', createdAt: '2026-11-06T00:00:00Z',
    repositoryRevision: revision,
    sourceFingerprint: 'source:' + revision, topologyFingerprint: 'topology:' + revision,
    evidenceFingerprint: 'evidence:' + revision,
    sources: [], evidence: [], nodes, edges, namingDivergences: [],
    explicitValueConflicts: [], unmatchedNodeIds: [], unavailableSourceIds: [],
    coverage: {
      trackedFiles: 5, eligibleFiles: 5, analyzedFiles: 5,
      completeFiles: incomplete ? 4 : 5, partialFiles: incomplete ? 1 : 0,
      unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0,
      skippedOversizedFiles: 0, skippedNonRegularFiles: 0, skippedFileLimitFiles: 0,
      files: paths.map((file, i) => ({
        path: file, status: incomplete && i === 0 ? 'partial' as const : 'complete' as const,
      })),
    },
  };
}

test('semantic technical facts are rebuilt from the exact current graph, not accepted history', () => {
  const first = deriveCurrentSemanticTruth(graph(revisionA));
  assert.equal(first.source, 'current-graph');
  assert.equal(first.revision, revisionA);
  assert.equal(first.counts.provenTechnicalScopes, 1);
  assert.equal(first.counts.supportedInterpretations, 1);
  assert.equal(first.provenTechnicalScopes[0]?.scope, 'src/features/demo');
  assert.equal(first.provenTechnicalScopes[0]?.kind, 'technical-source-scope');
  assert.equal(first.policy.historicalAcceptanceNeverInput, true);
  assert.equal(first.policy.noSemanticLedgerReadOrWrite, true);
  assert.equal(first.policy.noHumanReviewRequiredForProvenTechnicalFacts, true);
  assert.equal(first.interpretations[0]?.requiresReviewToUseTechnicalEvidence, false);
  assert.equal(first.interpretations[0]?.productIntentProven, false);
  assert.deepEqual(deriveCurrentSemanticTruth(graph(revisionA)), first, 'same graph produces same current understanding');
});

test('weak current source evidence removes a previously provable technical scope without a review gate', () => {
  const strong = deriveCurrentSemanticTruth(graph(revisionA));
  const partial = deriveCurrentSemanticTruth(graph(revisionB, true));
  assert.equal(strong.counts.provenTechnicalScopes, 1);
  assert.equal(partial.counts.provenTechnicalScopes, 0);
  assert.equal(partial.exclusions.completeForEligibleSources, false);
  assert.ok(partial.interpretations[0]?.proofBlockers.includes('candidate-scope-coverage-incomplete'));
  assert.equal(partial.counts.supportedInterpretations >= 0, true);
  assert.equal(deriveCurrentSemanticTruth(graph(revisionA)).counts.provenTechnicalScopes, 1,
    'asking about an old Git revision rederives that revision rather than preserving it as current');
});

test('source-declared concepts appear and disappear only as the selected graph changes', () => {
  const without = deriveCurrentSemanticTruth(graph(revisionA));
  const withDeclaration = deriveCurrentSemanticTruth(graph(revisionB, false, true));
  assert.equal(without.counts.sourceDeclaredConcepts, 0);
  assert.equal(withDeclaration.counts.sourceDeclaredConcepts, 1);
  assert.equal(withDeclaration.declaredConcepts[0]?.name, 'Explicit Domain');
  assert.equal(withDeclaration.declaredConcepts[0]?.status, 'source-declared');
  assert.equal(withDeclaration.policy.sourceDerivedInterpretationDoesNotProveProductIntent, true);
});

test('conflicting source evidence blocks proved technical scope without keeping the previous answer', () => {
  const clean = graph(revisionA);
  const conflicted: IntelligenceGraph = { ...graph(revisionB), explicitValueConflicts: [{
    entityId: 'technical:api', leftSourceId: 'left', rightSourceId: 'right',
    key: 'source', leftValue: 'one', rightValue: 'two',
  }] };
  assert.equal(deriveCurrentSemanticTruth(clean).counts.provenTechnicalScopes, 1);
  const current = deriveCurrentSemanticTruth(conflicted);
  assert.equal(current.counts.provenTechnicalScopes, 0);
  assert.ok(current.interpretations[0]?.proofBlockers.includes('conflicting-source-evidence'));
});
