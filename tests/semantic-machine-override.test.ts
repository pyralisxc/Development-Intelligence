import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticMeaningReview, applySemanticReviewAction } from '../src/intelligence/semanticReview.js';
import type { SemanticCandidate } from '../src/intelligence/semanticBootstrap.js';

function candidate(): SemanticCandidate {
  const revision = 'a'.repeat(40);
  return {
    id: 'semantic-candidate:scope', scope: 'src/intelligence',
    proposal: { name: 'Intelligence', kind: 'capability', description: 'Candidate, not accepted product intent.', alternatives: [] },
    authority: { state: 'proposed', accepted: false, reviewed: false, proofEligible: false, persisted: false, requiresExplicitReview: true },
    provenance: {
      origin: 'intrinsic-derivation', producer: 'semantic-bootstrap.v1', revision,
      evidenceFamilies: ['api', 'relationship', 'structure'], nodeIds: ['file:src/intelligence/x.ts'],
      edgeIds: ['imports:x'], evidenceIds: ['evidence:x'],
    },
    support: { scopeRole: 'direct', scopeDepth: 2, evidenceFamilyCount: 3, fileCount: 5,
      nodeCount: 12, resolvedEdgeCount: 10, motifKinds: [] },
    evidencePacket: { representativeNodes: [], representativeEdges: [] },
  };
}

function machineAccepted() {
  const actor = { kind: 'intrinsic-derivation' as const, id: 'intrinsic-technical-scope.v1' };
  const proposed = semanticMeaningReview(candidate());
  const amended = applySemanticReviewAction(proposed, {
    kind: 'amend', actor, at: '2026-11-06T00:00:00Z',
    proposal: { name: proposed.scope, kind: 'domain', description: 'Observed technical source scope src/intelligence: source facts only.' },
  });
  return applySemanticReviewAction(amended, {
    kind: 'accept', actor, at: '2026-11-06T00:00:00Z',
  });
}

test('human can reject a machine-accepted technical meaning without erasing the original acceptance history', () => {
  const current = machineAccepted();
  const rejected = applySemanticReviewAction(current, {
    kind: 'reject', actor: { kind: 'human', id: 'owner' },
    at: '2026-11-06T00:01:00Z', rationale: 'The grouping is misleading.',
  });
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.acceptance, null);
  assert.deepEqual(rejected.history.map(event => event.kind), ['amend', 'accept', 'reject']);
  assert.equal(rejected.history.at(-1)?.actor.kind, 'human');
});

test('human can amend machine-accepted technical meaning without leaving the correction silently accepted', () => {
  const corrected = applySemanticReviewAction(machineAccepted(), {
    kind: 'amend', actor: { kind: 'human', id: 'owner' },
    at: '2026-11-06T00:01:00Z',
    proposal: { description: 'Observed technical source scope, but not yet approved as a stable feature grouping.' },
  });
  assert.equal(corrected.state, 'reviewed');
  assert.equal(corrected.reviewed, true);
  assert.equal(corrected.accepted, false);
  assert.equal(corrected.acceptance, null);
  assert.deepEqual(corrected.history.map(event => event.kind), ['amend', 'accept', 'amend']);
});

test('human-accepted meaning and model actions cannot use the machine-only human correction exception', () => {
  const machine = machineAccepted();
  assert.throws(() => applySemanticReviewAction(machine, {
    kind: 'reject', actor: { kind: 'ai-model', id: 'model' }, at: '2026-11-06T00:01:00Z',
  }), /superseded/i);
  const human = applySemanticReviewAction(semanticMeaningReview(candidate()), {
    kind: 'accept', actor: { kind: 'human', id: 'owner' }, at: '2026-11-06T00:00:00Z',
  });
  assert.throws(() => applySemanticReviewAction(human, {
    kind: 'reject', actor: { kind: 'human', id: 'owner' }, at: '2026-11-06T00:01:00Z',
  }), /superseded/i);
  assert.throws(() => applySemanticReviewAction(human, {
    kind: 'amend', actor: { kind: 'human', id: 'owner' },
    at: '2026-11-06T00:01:00Z', proposal: { description: 'Silently edited' },
  }), /replaced or superseded/i);
});
