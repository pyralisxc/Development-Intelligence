import assert from 'node:assert/strict';
import test from 'node:test';
import { assessAutonomousSemanticProof, AUTONOMOUS_SEMANTIC_PROOF_RULE } from '../src/intelligence/semanticAutonomousAcceptance.js';
import type { SemanticCandidate } from '../src/intelligence/semanticBootstrap.js';
import type { SemanticCandidateAudit } from '../src/intelligence/semanticAudit.js';
import type { IntelligenceGraph } from '../src/types.js';

const revision = 'a'.repeat(40);
function fixture() {
  const evidenceFamilies = ['api', 'persistence', 'relationship', 'structure'] as const;
  const candidate: SemanticCandidate = {
    id: 'semantic-candidate:technical',
    scope: 'src/intelligence',
    proposal: {
      name: 'Intelligence',
      description: 'Evidence-backed capability candidate for src/intelligence: 5 source file(s) with api, persistence, relationship, structure evidence.',
      kind: 'capability', alternatives: [],
    },
    authority: { state: 'proposed', accepted: false, reviewed: false, proofEligible: false, persisted: false, requiresExplicitReview: true },
    provenance: {
      origin: 'intrinsic-derivation', producer: 'semantic-bootstrap.v1', revision,
      evidenceFamilies: [...evidenceFamilies], nodeIds: ['node:1'], edgeIds: ['edge:1'], evidenceIds: ['evidence:source'],
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
      facets: { functionalContainer: false, multiFile: true, broadFileSupport: true, evidenceDiverse: true,
        relationshipRich: true, behavioralEvidence: ['api','persistence'], architecturalMotif: false },
    },
  };
  const graph: IntelligenceGraph = {
    schemaVersion: 2, analyzerVersion: 'fixture', graphId: 'fixture', project: 'fixture',
    role: 'W', createdAt: '2026-11-06T00:00:00.000Z', repositoryRevision: revision,
    sourceFingerprint: 'source', topologyFingerprint: 'topology', evidenceFingerprint: 'evidence',
    sources: [], evidence: [], nodes: [], edges: [], namingDivergences: [],
    explicitValueConflicts: [], unmatchedNodeIds: [], unavailableSourceIds: [],
    coverage: {
      trackedFiles: 5, eligibleFiles: 5, analyzedFiles: 5, completeFiles: 5, partialFiles: 0,
      unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0, skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0, skippedFileLimitFiles: 0,
      files: Array.from({ length: 5 }, (_, i) => ({ path: `src/intelligence/module${i}.ts`, status: 'complete' as const })),
    },
  };
  return { candidate, audit, graph };
}

test('machine acceptance requires exact, complete, independent source proof', () => {
  const { candidate, audit, graph } = fixture();
  const result = assessAutonomousSemanticProof(graph, candidate, audit);
  assert.equal(result.rule, AUTONOMOUS_SEMANTIC_PROOF_RULE);
  assert.equal(result.accepted, true);
  assert.equal(result.completeSourceFiles, 5);
  assert.deepEqual(result.blockers, []);
});

test('machine acceptance fails closed for an underproven source scope or misleading name', () => {
  const { candidate, audit, graph } = fixture();
  assert.equal(assessAutonomousSemanticProof(graph, candidate, { ...audit, coreness: { ...audit.coreness, classification: 'supporting-candidate' } }).accepted, false);
  assert.equal(assessAutonomousSemanticProof(graph, { ...candidate, proposal: { ...candidate.proposal, name: 'Payment processing' } }, audit).accepted, false);
  assert.equal(assessAutonomousSemanticProof(graph, { ...candidate, provenance: { ...candidate.provenance, origin: 'ai-model' } }, audit).accepted, false);
  assert.equal(assessAutonomousSemanticProof(graph, { ...candidate, proposal: { ...candidate.proposal, description: 'Invented product mission' } }, audit).accepted, false);
});

test('machine acceptance does not cross missing coverage, conflicting source, or revision boundary', () => {
  const { candidate, audit, graph } = fixture();
  assert.equal(assessAutonomousSemanticProof({ ...graph, repositoryRevision: 'b'.repeat(40) }, candidate, audit).accepted, false);
  const incomplete = { ...graph, coverage: { ...graph.coverage!, files: [
    ...graph.coverage!.files.slice(0, 4), { path: 'src/intelligence/module4.ts', status: 'partial' as const },
  ] } };
  assert.equal(assessAutonomousSemanticProof(incomplete, candidate, audit).accepted, false);
  const conflict = { ...graph, explicitValueConflicts: [{
    entityId: 'node:1', leftSourceId: 'left', rightSourceId: 'right', key: 'meaning', leftValue: 'one', rightValue: 'two',
  }] };
  assert.equal(assessAutonomousSemanticProof(conflict, candidate, audit).accepted, false);
});

test('the proof rule is stable and has no graph persistence or release side effects', () => {
  const { candidate, audit, graph } = fixture();
  const before = JSON.stringify({ candidate, audit, graph });
  const first = assessAutonomousSemanticProof(graph, candidate, audit);
  assert.deepEqual(assessAutonomousSemanticProof(graph, candidate, audit), first);
  assert.equal(JSON.stringify({ candidate, audit, graph }), before);
});
