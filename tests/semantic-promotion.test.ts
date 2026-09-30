import assert from 'node:assert/strict';
import test from 'node:test';

import type { SemanticCandidate } from '../src/intelligence/semanticBootstrap.js';
import { applySemanticReviewAction, semanticMeaningReview, type SemanticMeaningReview } from '../src/intelligence/semanticReview.js';
import { buildSemanticPromotionGate } from '../src/intelligence/semanticPromotion.js';

function candidate(input: {
  id: string;
  scope: string;
  name: string;
  revision: string;
  files?: number;
  edges?: number;
}): SemanticCandidate {
  return {
    id: input.id,
    scope: input.scope,
    proposal: { name: input.name, description: input.name, kind: 'capability', alternatives: [] },
    authority: {
      state: 'proposed',
      accepted: false,
      reviewed: false,
      proofEligible: false,
      persisted: false,
      requiresExplicitReview: true,
    },
    provenance: {
      origin: 'intrinsic-derivation',
      producer: 'semantic-bootstrap.v1',
      revision: input.revision,
      evidenceFamilies: ['structure', 'relationship', 'api'],
      nodeIds: [`node:${input.id}`],
      edgeIds: [`edge:${input.id}`],
      evidenceIds: [],
    },
    support: {
      scopeRole: 'functional-container',
      scopeDepth: input.scope.split('/').length,
      evidenceFamilyCount: 3,
      fileCount: input.files ?? 8,
      nodeCount: 20,
      resolvedEdgeCount: input.edges ?? 12,
      motifKinds: [],
    },
    evidencePacket: { representativeNodes: [], representativeEdges: [] },
  };
}

function accepted(value: SemanticCandidate): SemanticMeaningReview {
  return applySemanticReviewAction(semanticMeaningReview(value), {
    kind: 'accept',
    actor: { kind: 'human', id: 'human:owner' },
    at: '2026-09-27T18:00:00.000Z',
  });
}

function previewReview(
  value: SemanticCandidate,
  meaningId?: string,
): SemanticMeaningReview {
  return semanticMeaningReview(value, meaningId ? { meaningId } : {});
}

test('Preview→Main semantic gate omits stable meanings and shows only semantic delta', () => {
  const mainStable = accepted(candidate({
    id: 'candidate:stable',
    scope: 'src/features/stable',
    name: 'Stable',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const mainChanged = accepted(candidate({
    id: 'candidate:changed',
    scope: 'src/features/changed',
    name: 'Changed',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    files: 8,
  }));

  const stablePreview = candidate({
    id: 'candidate:stable',
    scope: 'src/features/stable',
    name: 'Stable',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const changedPreview = candidate({
    id: 'candidate:changed',
    scope: 'src/features/changed',
    name: 'Changed',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    files: 11,
  });
  const addedPreview = candidate({
    id: 'candidate:added',
    scope: 'src/features/added',
    name: 'Added',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  const gate = buildSemanticPromotionGate({
    baseMeanings: [mainStable, mainChanged],
    previewCandidates: [stablePreview, changedPreview, addedPreview],
    baseRevision: mainStable.proposalRevision,
    previewRevision: stablePreview.provenance.revision,
  });

  assert.equal(gate.semanticDeltaCount, 2);
  assert.deepEqual(gate.items.map(item => item.changeKind).sort(), ['added', 'realization-changed']);
  assert.deepEqual(gate.items.map(item => item.ordinal), [1, 2]);
  assert.ok(gate.items.every(item => /^SEM-[0-9A-F]{8}$/.test(item.auditRef)));
  assert.ok(gate.items.every(item => item.summary.length > 0));
  assert.equal(gate.policy.itemizedAuditManifest, true);
  assert.equal(gate.policy.stableAuditReferences, true);
  assert.equal(gate.policy.desiredOutcomeInferred, false);
  assert.ok(gate.items.find(item => item.changeKind === 'realization-changed')?.before);
  assert.ok(gate.items.find(item => item.changeKind === 'realization-changed')?.after);
  assert.equal(gate.items.some(item => item.name === 'Stable'), false, 'unchanged meaning should not clutter Preview review');
  assert.equal(gate.readyForMainSemanticPromotion, false);
  assert.equal(gate.pendingCount, 2);
});

test('unsupported accepted meaning becomes an addressable factual audit item without inventing a successor', () => {
  const main = accepted(candidate({
    id: 'candidate:removed',
    scope: 'src/features/removed',
    name: 'Removed Capability',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const gate = buildSemanticPromotionGate({
    baseMeanings: [main],
    previewCandidates: [],
    previewReviews: [],
    baseRevision: main.proposalRevision,
    previewRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  assert.equal(gate.semanticDeltaCount, 1);
  assert.equal(gate.items[0]?.changeKind, 'unsupported');
  assert.equal(gate.items[0]?.before?.name, 'Removed Capability');
  assert.equal(gate.items[0]?.after, null);
  assert.match(gate.items[0]?.summary ?? '', /no longer supports/i);
  assert.match(gate.items[0]?.auditRef ?? '', /^SEM-[0-9A-F]{8}$/);
  assert.equal(gate.items[0]?.evolution?.reviewRequired, true);

  const verified = buildSemanticPromotionGate({
    baseMeanings: [main],
    previewCandidates: [],
    previewReviews: [],
    changeVerifications: [{
      version: 1,
      changeId: gate.items[0]!.changeId,
      auditRef: gate.items[0]!.auditRef,
      targetRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      actor: { kind: 'ai-model', id: 'agent:trusted' },
      at: '2026-09-29T04:00:00.000Z',
      evidenceIds: ['evidence:absence-checked'],
      rationale: 'Verified current Preview no longer supports the meaning.',
    }],
    baseRevision: main.proposalRevision,
    previewRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  assert.equal(verified.items[0]?.approved, true);
  assert.deepEqual(verified.items[0]?.approvalBases, ['ai-verified']);
  assert.equal(verified.items[0]?.verification?.auditRef, gate.items[0]?.auditRef);
  assert.equal(verified.readyForMainSemanticPromotion, true);
});

test('semantic audit references and ordinals do not change when approval state changes', () => {
  const main = accepted(candidate({
    id: 'candidate:studio',
    scope: 'src/features/studio',
    name: 'Studio',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    files: 8,
  }));
  const preview = candidate({
    id: 'candidate:studio',
    scope: 'src/features/studio',
    name: 'Studio',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    files: 12,
  });
  const pending = buildSemanticPromotionGate({
    baseMeanings: [main],
    previewCandidates: [preview],
    previewReviews: [],
    baseRevision: main.proposalRevision,
    previewRevision: preview.provenance.revision,
  });
  const acceptedPreview = applySemanticReviewAction(previewReview(preview, main.meaningId), {
    kind: 'accept',
    actor: { kind: 'human', id: 'human:owner' },
    at: '2026-09-29T03:00:00.000Z',
  });
  const cleared = buildSemanticPromotionGate({
    baseMeanings: [main],
    previewCandidates: [preview],
    previewReviews: [acceptedPreview],
    baseRevision: main.proposalRevision,
    previewRevision: preview.provenance.revision,
  });

  assert.equal(pending.items[0]?.auditRef, cleared.items[0]?.auditRef);
  assert.equal(pending.items[0]?.ordinal, cleared.items[0]?.ordinal);
  assert.equal(pending.items[0]?.approved, false);
  assert.equal(cleared.items[0]?.approved, true);
});

test('old Main human acceptance does not approve a new Preview semantic change', () => {
  const main = accepted(candidate({
    id: 'candidate:studio',
    scope: 'src/features/studio',
    name: 'Studio',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    files: 8,
  }));
  const preview = candidate({
    id: 'candidate:studio',
    scope: 'src/features/studio',
    name: 'Studio',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    files: 12,
  });

  const gate = buildSemanticPromotionGate({
    baseMeanings: [main],
    previewCandidates: [preview],
    previewReviews: [main],
    baseRevision: main.proposalRevision,
    previewRevision: preview.provenance.revision,
  });

  assert.equal(gate.items[0]?.approved, false);
  assert.deepEqual(gate.items[0]?.approvalBases, []);
  assert.equal(gate.policy.previousRevisionApprovalDoesNotApprovePreviewDelta, true);
});

test('AI verification can satisfy a Preview semantic gate without becoming acceptance', () => {
  const main = accepted(candidate({
    id: 'candidate:studio',
    scope: 'src/features/studio',
    name: 'Studio',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    files: 8,
  }));
  const preview = candidate({
    id: 'candidate:studio',
    scope: 'src/features/studio',
    name: 'Studio',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    files: 12,
  });
  const verified = applySemanticReviewAction(previewReview(preview, main.meaningId), {
    kind: 'verify',
    actor: { kind: 'ai-model', id: 'model:semantic-verifier' },
    at: '2026-09-27T19:00:00.000Z',
    evidenceIds: ['evidence:preview-source', 'evidence:preview-relationships'],
  });

  const gate = buildSemanticPromotionGate({
    baseMeanings: [main],
    previewCandidates: [preview],
    previewReviews: [verified],
    baseRevision: main.proposalRevision,
    previewRevision: preview.provenance.revision,
  });

  assert.equal(verified.accepted, false);
  assert.equal(gate.items[0]?.approved, true);
  assert.deepEqual(gate.items[0]?.approvalBases, ['ai-verified']);
  assert.equal(gate.readyForMainSemanticPromotion, true);
  assert.equal(gate.policy.verificationCanApprovePromotion, true);
});

test('current-revision human acceptance or verification independently satisfies Preview semantic promotion', () => {
  const newAcceptedCandidate = candidate({
    id: 'candidate:new-accepted',
    scope: 'src/features/new-accepted',
    name: 'New Accepted',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const newVerifiedCandidate = candidate({
    id: 'candidate:new-verified',
    scope: 'src/features/new-verified',
    name: 'New Verified',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  const humanAccepted = applySemanticReviewAction(previewReview(newAcceptedCandidate), {
    kind: 'accept',
    actor: { kind: 'human', id: 'human:owner' },
    at: '2026-09-27T19:10:00.000Z',
  });
  const humanVerified = applySemanticReviewAction(previewReview(newVerifiedCandidate), {
    kind: 'verify',
    actor: { kind: 'human', id: 'human:owner' },
    at: '2026-09-27T19:11:00.000Z',
    evidenceIds: ['evidence:checked'],
  });

  const gate = buildSemanticPromotionGate({
    baseMeanings: [],
    previewCandidates: [newAcceptedCandidate, newVerifiedCandidate],
    previewReviews: [humanAccepted, humanVerified],
    baseRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    previewRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  assert.equal(gate.pendingCount, 0);
  assert.equal(gate.readyForMainSemanticPromotion, true);
  assert.equal(gate.items.find(item => item.name === 'New Accepted')?.approved, true);
  assert.equal(gate.items.find(item => item.name === 'New Verified')?.approved, true);
  assert.deepEqual(
    gate.items.flatMap(item => item.approvalBases).sort(),
    ['human-accepted', 'human-verified'],
  );
});

test('unapproved semantic delta blocks Main semantic promotion', () => {
  const added = candidate({
    id: 'candidate:unreviewed',
    scope: 'src/features/unreviewed',
    name: 'Unreviewed',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const gate = buildSemanticPromotionGate({
    baseMeanings: [],
    previewCandidates: [added],
    baseRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    previewRevision: added.provenance.revision,
  });

  assert.equal(gate.semanticDeltaCount, 1);
  assert.equal(gate.pendingCount, 1);
  assert.equal(gate.readyForMainSemanticPromotion, false);
  assert.deepEqual(gate.items[0]?.approvalBases, []);
  assert.equal(gate.items[0]?.reviewRequired, true);
});
