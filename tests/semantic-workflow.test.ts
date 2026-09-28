import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSemanticReviewCommand, semanticReviewAction } from '../src/intelligence/semanticWorkflow.js';

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
