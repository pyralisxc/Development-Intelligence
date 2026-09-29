import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptedMeaningsForContinuity, initialSemanticReview, parseSemanticLineageCommand, parseSemanticReviewCommand, semanticLineageTransaction, semanticReviewAction, semanticReviewContinuity } from '../src/intelligence/semanticWorkflow.js';

import type { SemanticCandidate } from '../src/intelligence/semanticBootstrap.js';
import { applySemanticReviewAction, semanticMeaningReview, type SemanticMeaningReview } from '../src/intelligence/semanticReview.js';
import { supersedeSemanticMeaning } from '../src/intelligence/semanticEvolution.js';

function candidate(input: { id: string; scope: string; name: string; revision: string; files?: number }): SemanticCandidate {
  return {
    id: input.id,
    scope: input.scope,
    proposal: { name: input.name, description: input.name, kind: 'capability', alternatives: [] },
    authority: { state: 'proposed', accepted: false, reviewed: false, proofEligible: false, persisted: false, requiresExplicitReview: true },
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
      resolvedEdgeCount: 12,
      motifKinds: [],
    },
    evidencePacket: { representativeNodes: [], representativeEdges: [] },
  };
}

function accepted(value: SemanticCandidate): SemanticMeaningReview {
  return applySemanticReviewAction(semanticMeaningReview(value), {
    kind: 'accept',
    actor: { kind: 'human', id: 'human:owner' },
    at: '2026-09-28T18:00:00.000Z',
  });
}

test('semantic review commands normalize bounded human edits without assigning authority', () => {
  const command = parseSemanticReviewCommand({
    kind: 'amend',
    proposal: {
      name: 'Authentication',
      description: 'Handles login and session establishment.',
      kind: 'capability',
      alternatives: ['Sign in', 'Sign in'],
    },
    rationale: 'Owner clarified the concept.',
  });
  assert.deepEqual(command, {
    kind: 'amend',
    proposal: {
      name: 'Authentication',
      description: 'Handles login and session establishment.',
      kind: 'capability',
      alternatives: ['Sign in'],
    },
    rationale: 'Owner clarified the concept.',
  });
  const action = semanticReviewAction(command, { kind: 'human', id: 'human:owner' }, '2026-09-28T18:00:00.000Z');
  assert.equal(action.kind, 'amend');
  assert.deepEqual(action.actor, { kind: 'human', id: 'human:owner' });
});

test('semantic verification requires explicit evidence and preserves the actor boundary', () => {
  assert.throws(
    () => parseSemanticReviewCommand({ kind: 'verify', evidenceIds: [] }),
    /at least one evidence id/i,
  );
  const command = parseSemanticReviewCommand({ kind: 'verify', evidenceIds: ['evidence:b', 'evidence:a', 'evidence:a'] });
  assert.deepEqual(command, { kind: 'verify', evidenceIds: ['evidence:a', 'evidence:b'] });
  const action = semanticReviewAction(command, { kind: 'ai-model', id: 'model:reviewer' }, '2026-09-28T18:01:00.000Z');
  assert.equal(action.kind, 'verify');
  assert.deepEqual(action.actor, { kind: 'ai-model', id: 'model:reviewer' });
});

test('semantic review parser rejects empty amendments and unknown authority actions', () => {
  assert.throws(() => parseSemanticReviewCommand({ kind: 'amend', proposal: {} }), /at least one proposal field/i);
  assert.throws(() => parseSemanticReviewCommand({ kind: 'promote' }), /amend, accept, reject, or verify/i);
});


test('semantic lineage commands are bounded and normalize explicit lineage identities', () => {
  assert.deepEqual(parseSemanticLineageCommand({
    kind: 'split',
    sourceMeaningId: ' semantic-meaning:source ',
    successorCandidateIds: ['candidate:right', 'candidate:left', 'candidate:right'],
  }), {
    kind: 'split',
    sourceMeaningId: 'semantic-meaning:source',
    successorCandidateIds: ['candidate:left', 'candidate:right'],
  });
  assert.deepEqual(parseSemanticLineageCommand({
    kind: 'merge',
    sourceMeaningIds: ['semantic-meaning:b', 'semantic-meaning:a', 'semantic-meaning:a'],
    successorCandidateId: 'candidate:merged',
  }), {
    kind: 'merge',
    sourceMeaningIds: ['semantic-meaning:a', 'semantic-meaning:b'],
    successorCandidateId: 'candidate:merged',
  });
  assert.throws(
    () => parseSemanticLineageCommand({ kind: 'split', sourceMeaningId: 'semantic-meaning:a', successorCandidateIds: ['candidate:only'] }),
    /at least 2 unique values/i,
  );
});

test('semantic lineage transaction reuses evolution primitives and never accepts successors implicitly', () => {
  const source = accepted(candidate({
    id: 'candidate:old',
    scope: 'src/features/old',
    name: 'Old',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const left = candidate({
    id: 'candidate:left',
    scope: 'src/features/new/left',
    name: 'Left',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const right = candidate({
    id: 'candidate:right',
    scope: 'src/features/new/right',
    name: 'Right',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const split = semanticLineageTransaction(
    { kind: 'split', sourceMeaningId: source.meaningId, successorCandidateIds: [left.id, right.id] },
    [left, right],
    [source],
    { kind: 'human', id: 'human:owner' },
    '2026-09-29T01:00:00.000Z',
  );
  assert.equal(split.kind, 'split');
  assert.equal(split.reviews[0]?.state, 'split');
  assert.equal(split.successorMeaningIds.length, 2);
  assert.ok(split.reviews.slice(1).every(review => review.accepted === false));
  assert.ok(split.reviews.slice(1).every(review => review.lineage.predecessorMeaningIds.includes(source.meaningId)));

  const sourceB = accepted(candidate({
    id: 'candidate:old-b',
    scope: 'src/features/old-b',
    name: 'Old B',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const merged = candidate({
    id: 'candidate:merged',
    scope: 'src/features/merged',
    name: 'Merged',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const merge = semanticLineageTransaction(
    { kind: 'merge', sourceMeaningIds: [source.meaningId, sourceB.meaningId], successorCandidateId: merged.id },
    [merged],
    [source, sourceB],
    { kind: 'human', id: 'human:owner' },
    '2026-09-29T01:01:00.000Z',
  );
  assert.ok(merge.reviews.slice(0, 2).every(review => review.state === 'merged'));
  assert.equal(merge.reviews.at(-1)?.accepted, false);
  assert.deepEqual(merge.reviews.at(-1)?.lineage.predecessorMeaningIds, [source.meaningId, sourceB.meaningId].sort());

  assert.throws(
    () => semanticLineageTransaction(
      { kind: 'replace', sourceMeaningId: 'semantic-meaning:missing', successorCandidateId: left.id },
      [left],
      [source],
      { kind: 'human', id: 'human:owner' },
      '2026-09-29T01:02:00.000Z',
    ),
    /not an active accepted meaning/i,
  );
});

test('semantic review preserves one accepted meaning identity across a changed realization', () => {
  const base = accepted(candidate({
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

  const continuity = semanticReviewContinuity(preview, [preview], [base]);
  assert.equal(continuity.state, 'inherited');
  assert.equal(continuity.meaningId, base.meaningId);

  const review = initialSemanticReview(preview, [preview], [base]);
  assert.equal(review.meaningId, base.meaningId);
  assert.equal(review.proposalRevision, preview.provenance.revision);
});

test('ambiguous split-like continuity fails closed instead of inventing a duplicate semantic identity', () => {
  const base = accepted(candidate({
    id: 'candidate:old',
    scope: 'src/features/shared',
    name: 'Shared',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const left = candidate({
    id: 'candidate:left',
    scope: 'src/features/shared',
    name: 'Shared Left',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const right = candidate({
    id: 'candidate:right',
    scope: 'src/features/shared',
    name: 'Shared Right',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  const continuity = semanticReviewContinuity(left, [left, right], [base]);
  assert.equal(continuity.state, 'ambiguous');
  assert.deepEqual(continuity.sourceMeaningIds, [base.meaningId]);
  assert.throws(
    () => initialSemanticReview(left, [left, right], [base]),
    /explicit lineage review is required/i,
  );
});

test('genuinely new semantic candidates receive a new meaning identity', () => {
  const preview = candidate({
    id: 'candidate:new',
    scope: 'src/features/new',
    name: 'New capability',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const continuity = semanticReviewContinuity(preview, [preview], []);
  assert.equal(continuity.state, 'new');
  const review = initialSemanticReview(preview, [preview], []);
  assert.match(review.meaningId, /^semantic-meaning:/u);
});


test('continuity authority does not resurrect an older accepted record after the meaning is superseded', () => {
  const originalCandidate = candidate({
    id: 'candidate:retired',
    scope: 'src/features/retired',
    name: 'Retired capability',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  const original = accepted(originalCandidate);
  const superseded = supersedeSemanticMeaning(
    original,
    ['semantic-meaning:successor'],
    { kind: 'human', id: 'human:owner' },
    '2026-09-28T19:00:00.000Z',
    'Replaced by a more precise concept.',
  );
  const ledger = {
    formatVersion: 1 as const,
    project: 'fixture',
    generation: 2,
    updatedAt: '2026-09-28T19:00:00.000Z',
    records: [
      {
        recordId: 'record:accepted',
        meaningId: original.meaningId,
        revision: original.proposalRevision,
        candidateId: original.candidateId,
        storedAt: '2026-09-28T18:00:00.000Z',
        review: original,
      },
      {
        recordId: 'record:superseded',
        meaningId: superseded.meaningId,
        revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        candidateId: superseded.candidateId,
        storedAt: '2026-09-28T19:00:00.000Z',
        review: { ...superseded, proposalRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      },
    ],
  };

  assert.deepEqual(
    acceptedMeaningsForContinuity(ledger, 'cccccccccccccccccccccccccccccccccccccccc'),
    [],
  );
});
