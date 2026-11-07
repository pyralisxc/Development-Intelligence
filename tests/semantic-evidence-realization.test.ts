import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSemanticCurrentEvidence } from '../src/intelligence/semanticEvidenceRealization.js';
import { applySemanticReviewAction, semanticMeaningReview } from '../src/intelligence/semanticReview.js';
import type { SemanticCandidate } from '../src/intelligence/semanticBootstrap.js';
import type { SemanticCandidateAudit } from '../src/intelligence/semanticAudit.js';
import type { IntelligenceGraph } from '../src/types.js';

const firstRevision = 'a'.repeat(40);
const laterRevision = 'b'.repeat(40);

function fixture(revision = firstRevision) {
  const candidate: SemanticCandidate = {
    id: 'semantic-candidate:technical',
    scope: 'src/intelligence',
    proposal: {
      name: 'Intelligence', kind: 'capability', alternatives: [],
      description: 'Evidence-backed capability candidate for src/intelligence: 5 source file(s) with api, persistence, relationship, structure evidence.',
    },
    authority: {
      state: 'proposed', accepted: false, reviewed: false,
      proofEligible: false, persisted: false, requiresExplicitReview: true,
    },
    provenance: {
      origin: 'intrinsic-derivation', producer: 'semantic-bootstrap.v1', revision,
      evidenceFamilies: ['api', 'persistence', 'relationship', 'structure'],
      nodeIds: ['node:1'], edgeIds: ['edge:1'], evidenceIds: ['evidence:1'],
    },
    support: {
      scopeRole: 'direct', scopeDepth: 2, evidenceFamilyCount: 4, fileCount: 5,
      nodeCount: 100, resolvedEdgeCount: 30, motifKinds: [],
    },
    evidencePacket: { representativeNodes: [], representativeEdges: [] },
  };
  const audit: SemanticCandidateAudit = {
    candidateId: candidate.id, scope: candidate.scope, proposal: candidate.proposal, authority: candidate.authority,
    factuality: { status: 'supported', reasons: [], missingNodeIds: [], missingEdgeIds: [] },
    coreness: {
      classification: 'core-candidate', reasons: [],
      facets: {
        functionalContainer: false, multiFile: true, broadFileSupport: true, evidenceDiverse: true,
        relationshipRich: true, behavioralEvidence: ['api', 'persistence'], architecturalMotif: false,
      },
    },
  };
  const graph: IntelligenceGraph = {
    schemaVersion: 2, analyzerVersion: 'fixture-v1', graphId: 'graph:' + revision, project: 'fixture',
    role: 'W', createdAt: '2026-11-06T00:00:00.000Z', repositoryRevision: revision,
    sourceFingerprint: 'source', topologyFingerprint: 'topology', evidenceFingerprint: 'evidence',
    sources: [], evidence: [], nodes: [], edges: [], namingDivergences: [],
    explicitValueConflicts: [], unmatchedNodeIds: [], unavailableSourceIds: [],
    coverage: {
      trackedFiles: 5, eligibleFiles: 5, analyzedFiles: 5, completeFiles: 5, partialFiles: 0,
      unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0, skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0, skippedFileLimitFiles: 0,
      files: Array.from({ length: 5 }, (_, i) => ({ path: 'src/intelligence/module' + i + '.ts', status: 'complete' as const })),
    },
  };
  return { graph, candidate, audit };
}

function machineAccepted(candidate: SemanticCandidate) {
  const actor = { kind: 'intrinsic-derivation' as const, id: 'intrinsic-technical-scope.v1' };
  const first = semanticMeaningReview(candidate);
  const amended = applySemanticReviewAction(first, {
    kind: 'amend', actor, at: '2026-11-06T00:00:00Z',
    proposal: {
      name: 'src/intelligence', kind: 'domain',
      description: 'Observed technical source scope src/intelligence: 5 completely analyzed files with resolved source relationships.',
    },
  });
  return applySemanticReviewAction(amended, { kind: 'accept', actor, at: '2026-11-06T00:00:00Z' });
}

function realization(
  graph: IntelligenceGraph,
  accepted: ReturnType<typeof machineAccepted>,
  candidate: SemanticCandidate | null,
  audit: SemanticCandidateAudit | null,
) {
  return assessSemanticCurrentEvidence(graph, accepted, candidate ? [candidate] : [],
    new Map(audit ? [[audit.candidateId, audit]] : []));
}

test('currently re-proven machine technical scope remains supported without a review step', () => {
  const { graph, candidate, audit } = fixture();
  const accepted = machineAccepted(candidate);
  const before = JSON.stringify(accepted);
  const result = realization(graph, accepted, candidate, audit);
  assert.equal(result.sourceStatus, 'supported');
  assert.equal(result.trend, 'preserved');
  assert.equal(result.currentlyProvenTechnicalScope, true);
  assert.equal(result.acceptedRecordRetained, true);
  assert.equal(result.policy.automaticTechnicalProofRevalidation, true);
  assert.equal(JSON.stringify(accepted), before, 'read-only realization must not rewrite accepted history');
});

test('new compiler evidence can strengthen or weaken a still-proven meaning at the next revision', () => {
  const first = fixture();
  const accepted = machineAccepted(first.candidate);
  const later = fixture(laterRevision);
  const stronger = { ...later.candidate, support: { ...later.candidate.support, resolvedEdgeCount: 70, nodeCount: 140 } };
  const strong = realization(later.graph, accepted, stronger, later.audit);
  assert.equal(strong.trend, 'strengthened');
  assert.equal(strong.sourceStatus, 'supported');
  assert.equal(strong.currentlyProvenTechnicalScope, true);
  assert.equal(strong.delta?.resolvedEdgeCountDelta, 40);
  const weaker = { ...later.candidate, support: { ...later.candidate.support, resolvedEdgeCount: 14, nodeCount: 90 } };
  const weak = realization(later.graph, accepted, weaker, later.audit);
  assert.equal(weak.trend, 'weakened');
  assert.equal(weak.sourceStatus, 'supported', 'reduced support is not proof loss while the rule still passes');
  assert.equal(weak.currentlyProvenTechnicalScope, true);
  const mixed = { ...later.candidate, support: { ...later.candidate.support, resolvedEdgeCount: 18, nodeCount: 130 } };
  assert.equal(realization(later.graph, accepted, mixed, later.audit).trend, 'mixed');
});

test('partial coverage, conflicting sources, or a no-longer-qualified scope revoke current proof without deleting historical acceptance', () => {
  const first = fixture();
  const accepted = machineAccepted(first.candidate);
  const next = fixture(laterRevision);
  const partial: IntelligenceGraph = {
    ...next.graph,
    coverage: { ...next.graph.coverage!, files: [
      ...next.graph.coverage!.files.slice(0, 4),
      { path: 'src/intelligence/module4.ts', status: 'partial' },
    ] },
  };
  const weakened = realization(partial, accepted, next.candidate, next.audit);
  assert.equal(weakened.sourceStatus, 'unsupported');
  assert.equal(weakened.currentlyProvenTechnicalScope, false);
  assert.match(weakened.reasons.join(' '), /candidate-scope-coverage-incomplete/u);
  const conflict: IntelligenceGraph = {
    ...next.graph,
    explicitValueConflicts: [{
      entityId: 'node:1', leftSourceId: 'one', rightSourceId: 'two',
      key: 'description', leftValue: 'A', rightValue: 'B',
    }],
  };
  assert.equal(realization(conflict, accepted, next.candidate, next.audit).sourceStatus, 'unsupported');
  assert.equal(realization(next.graph, accepted, null, null).trend, 'unsupported');
  assert.equal(accepted.accepted, true, 'past machine acceptance remains an inspectable event');
});

test('human-accepted meaning retains approval while revealing source evidence decline without claiming intent proof', () => {
  const before = fixture();
  const accepted = applySemanticReviewAction(semanticMeaningReview(before.candidate), {
    kind: 'accept', actor: { kind: 'human', id: 'owner' }, at: '2026-11-06T00:00:00Z',
  });
  const next = fixture(laterRevision);
  const weaker = { ...next.candidate, support: { ...next.candidate.support, resolvedEdgeCount: 12 } };
  const result = realization(next.graph, accepted, weaker, next.audit);
  assert.equal(result.sourceStatus, 'supported');
  assert.equal(result.trend, 'weakened');
  assert.equal(result.currentlyProvenTechnicalScope, null);
  assert.equal(result.policy.productIntentNotInferred, true);
  assert.equal(accepted.accepted, true);
});

test('ambiguous current identity cannot borrow prior accepted confidence', () => {
  const { graph, candidate, audit } = fixture(laterRevision);
  const initial = fixture();
  const accepted = machineAccepted(initial.candidate);
  const result = assessSemanticCurrentEvidence(graph, accepted, [candidate, { ...candidate }],
    new Map([[audit.candidateId, audit]]));
  assert.equal(result.sourceStatus, 'ambiguous');
  assert.equal(result.trend, 'ambiguous');
  assert.equal(result.currentlyProvenTechnicalScope, false);
});
