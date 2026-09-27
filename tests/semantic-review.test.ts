import assert from 'node:assert/strict';
import test from 'node:test';

import type { SemanticCandidate } from '../src/intelligence/semanticBootstrap.js';
import { applySemanticReviewAction, semanticMeaningReview } from '../src/intelligence/semanticReview.js';

function candidate(): SemanticCandidate {
  return {
    id: 'semantic-candidate:auth',
    scope: 'src/features/authentication',
    proposal: {
      name: 'Authentication',
      description: 'Evidence-backed authentication capability.',
      kind: 'capability',
      alternatives: [],
    },
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
      revision: '1111111111111111111111111111111111111111',
      evidenceFamilies: ['structure', 'relationship', 'api'],
      nodeIds: ['file:auth'],
      edgeIds: ['edge:auth'],
      evidenceIds: ['evidence:auth'],
    },
    support: {
      scopeRole: 'functional-container',
      scopeDepth: 3,
      evidenceFamilyCount: 3,
      fileCount: 8,
      nodeCount: 20,
      resolvedEdgeCount: 12,
      motifKinds: [],
    },
    evidencePacket: { representativeNodes: [], representativeEdges: [] },
  };
}

test('human acceptance never implies semantic verification', () => {
  const initial = semanticMeaningReview(candidate());
  const amended = applySemanticReviewAction(initial, {
    kind: 'amend',
    actor: { kind: 'ai-model', id: 'model:reviewer' },
    at: '2026-09-27T22:00:00.000Z',
    proposal: { description: 'Handles sign-in, sessions, and account authentication.' },
    rationale: 'Clarify the evidence-backed behavior.',
  });
  const accepted = applySemanticReviewAction(amended, {
    kind: 'accept',
    actor: { kind: 'human', id: 'human:owner' },
    at: '2026-09-27T22:01:00.000Z',
    rationale: 'Meaning is useful and matches project language.',
  });

  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.reviewed, true);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.acceptance?.actor.kind, 'human');
  assert.equal(accepted.verification, null, 'acceptance must not silently become verification');
  assert.equal(accepted.proposalProvenance.origin, 'intrinsic-derivation', 'original proposal provenance must survive AI/human editing');
  assert.equal(accepted.history.length, 2);
});

test('semantic verification is a separate evidence-backed boundary', () => {
  const initial = semanticMeaningReview(candidate());
  const verified = applySemanticReviewAction(initial, {
    kind: 'verify',
    actor: { kind: 'human', id: 'human:verifier' },
    at: '2026-09-27T22:02:00.000Z',
    evidenceIds: ['evidence:runtime', 'evidence:source', 'evidence:runtime'],
    rationale: 'Source and runtime evidence agree.',
  });

  assert.equal(verified.state, 'proposed', 'verification must not imply acceptance');
  assert.equal(verified.accepted, false);
  assert.deepEqual(verified.verification?.evidenceIds, ['evidence:runtime', 'evidence:source']);

  const accepted = applySemanticReviewAction(verified, {
    kind: 'accept',
    actor: { kind: 'human', id: 'human:owner' },
    at: '2026-09-27T22:03:00.000Z',
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.verification?.actor.id, 'human:verifier', 'later acceptance must preserve independent verification');
});

test('accepted meaning cannot be silently amended or destructively rejected', () => {
  const accepted = applySemanticReviewAction(semanticMeaningReview(candidate()), {
    kind: 'accept',
    actor: { kind: 'human', id: 'human:owner' },
    at: '2026-09-27T22:04:00.000Z',
  });

  assert.throws(() => applySemanticReviewAction(accepted, {
    kind: 'amend',
    actor: { kind: 'ai-model', id: 'model:editor' },
    at: '2026-09-27T22:05:00.000Z',
    proposal: { name: 'Identity' },
  }), /replaced or superseded/);

  assert.throws(() => applySemanticReviewAction(accepted, {
    kind: 'reject',
    actor: { kind: 'human', id: 'human:owner' },
    at: '2026-09-27T22:06:00.000Z',
  }), /superseded/);
});

test('verification requires explicit evidence', () => {
  assert.throws(() => applySemanticReviewAction(semanticMeaningReview(candidate()), {
    kind: 'verify',
    actor: { kind: 'ai-model', id: 'model:verifier' },
    at: '2026-09-27T22:07:00.000Z',
    evidenceIds: [],
  }), /requires at least one evidence id/);
});
