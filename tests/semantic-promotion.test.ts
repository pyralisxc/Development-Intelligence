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
  assert.equal(gate.items.some(item => item.name === 'Stable'), false, 'unchanged meaning should not clutter Preview review');
  assert.equal(gate.readyForMainSemanticPromotion, false);
  assert.equal(gate.pendingCount, 2);
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

test('AI verification can approve a Preview semantic delta without becoming acceptance', () => {
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
});

test('human acceptance or human verification independently satisfy Preview semantic promotion', () => {
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
