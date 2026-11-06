import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSemanticReviewPresentation } from '../src/intelligence/semanticReviewPresentation.js';

function specimen() {
  const nodeIds = Array.from({ length: 4070 }, (_, i) => 'node-' + String(i).padStart(6, '0'));
  const edgeIds = Array.from({ length: 8721 }, (_, i) => 'edge-' + String(i).padStart(6, '0'));
  const provenance = {
    origin: 'source', producer: 'semantic-bootstrap', revision: 'a'.repeat(40),
    evidenceFamilies: ['api', 'structure'], nodeIds, edgeIds, evidenceIds: ['ev-1'],
  };
  const candidate = {
    id: 'semantic-candidate:example', scope: 'src/intelligence',
    proposal: { name: 'Intelligence', kind: 'capability' },
    authority: { accepted: false },
    provenance, support: { nodeCount: nodeIds.length, resolvedEdgeCount: edgeIds.length },
    evidencePacket: { representativeNodes: [{ id: nodeIds[0] }], representativeEdges: [{ id: edgeIds[0] }] },
    review: null, continuity: { state: 'none' },
    reviewAssessment: { recommendedForBaseline: false, factuality: { status: 'limited' } },
    autonomousAssessment: {
      state: 'evidence-qualified', evidenceQualified: true,
      automaticallyMaintained: true, provenance: { ...provenance },
      note: 'Source-derived, not accepted authority.',
    },
    aiProposalPacket: { candidateId: 'semantic-candidate:example', evidence: { nodeIds, edgeIds } },
  };
  return {
    version: 1, project: 'Example', graphId: 'repo-example', revision: 'a'.repeat(40),
    candidates: [candidate], capacity: {
      requestedLimit: 1, eligibleCandidateCount: 14,
      returnedCandidateCount: 1, truncated: true, exhausted: false,
    }, derivedMeanings: [{
      candidateId: candidate.id, meaningId: 'meaning-1', revision: 'a'.repeat(40),
      disposition: 'evidence-qualified', sourceIds: nodeIds, evidenceIds: edgeIds,
    }], gateExplanation: { enrollmentState: 'not-enrolled', note: 'Not a release gate' },
    promotionAudit: { gateStatus: 'non-blocking', items: [] },
    authority: { state: 'miss', recordCount: 0 },
    policy: { stage: 'T2-review-surface', acceptanceImpliesVerification: false },
  };
}

test('summary is proportional, identity-preserving, honest, and read-only', () => {
  const original = specimen();
  const originalJson = JSON.stringify(original);
  const full = projectSemanticReviewPresentation(original, { detail: 'full' });
  assert.strictEqual(full, original, 'full presentation must retain exact source contract');
  const compact = projectSemanticReviewPresentation(original, { detail: 'summary' }) as any;
  assert.ok(JSON.stringify(compact).length < originalJson.length / 10, 'large duplicated provenance must not dominate a two-item page');
  assert.equal(compact.graphId, original.graphId);
  assert.equal(compact.revision, original.revision);
  assert.deepEqual(compact.capacity, original.capacity);
  assert.deepEqual(compact.authority, original.authority);
  assert.deepEqual(compact.promotionAudit, original.promotionAudit);
  assert.deepEqual(compact.gateExplanation, original.gateExplanation);
  assert.deepEqual(compact.policy, original.policy);
  const c = compact.candidates[0];
  assert.equal(c.id, original.candidates[0].id);
  assert.deepEqual(c.reviewAssessment, original.candidates[0].reviewAssessment);
  assert.deepEqual(c.continuity, original.candidates[0].continuity);
  assert.equal(c.provenanceProjection.nodeIdsTotal, 4070);
  assert.equal(c.provenanceProjection.edgeIdsTotal, 8721);
  assert.equal(c.provenanceProjection.evidenceIdsTotal, 1);
  assert.equal(c.provenanceProjection.nodeIdsReturned, 0);
  assert.equal(c.provenanceProjection.autonomousProvenanceDuplicateOmitted, true);
  assert.equal(c.provenanceProjection.aiProposalPacketOmitted, true);
  assert.equal(c.autonomousAssessment.provenance, undefined);
  assert.equal(c.aiProposalPacket, undefined);
  assert.deepEqual(c.evidencePacket, original.candidates[0].evidencePacket);
  assert.equal(compact.derivedMeanings[0].meaningId, 'meaning-1');
  assert.equal(compact.derivedMeanings[0].evidenceProjection.sourceIdsTotal, 4070);
  assert.equal(compact.presentation.candidatePopulationTruncated, true);
  assert.equal(compact.presentation.recovery.exactRevision, original.revision);
  assert.equal(compact.presentation.recovery.requestedLimit, 1);
  assert.match(compact.presentation.recovery.note, /No per-candidate recovery or pagination/u);
  assert.equal(JSON.stringify(original), originalJson, 'summary projection must never mutate canonical inputs');
  assert.deepEqual(projectSemanticReviewPresentation(original, { detail: 'summary' }), compact, 'projection must be deterministic');
});

test('empty and malformed optional provenance remains explicitly bounded without inventing evidence', () => {
  const sample = specimen() as any;
  sample.candidates[0].provenance = {};
  sample.candidates[0].autonomousAssessment = { state: 'unknown' };
  sample.derivedMeanings = [];
  const compact = projectSemanticReviewPresentation(sample, { detail: 'summary' }) as any;
  assert.equal(compact.candidates[0].provenanceProjection.nodeIdsTotal, 0);
  assert.equal(compact.candidates[0].provenanceProjection.autonomousProvenanceDuplicateOmitted, false);
  assert.equal(compact.presentation.returnedDerivedMeaningCount, 0);
  assert.equal(compact.candidates[0].autonomousAssessment.state, 'unknown');
  assert.throws(() => projectSemanticReviewPresentation(sample, { detail: 'unsupported' as any }), /summary or full/u);
});
