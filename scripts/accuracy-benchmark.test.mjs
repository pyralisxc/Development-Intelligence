import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAccuracyCase,
  relationshipKey,
  scoreAccuracyCase,
  scoreAccuracySuite,
} from './accuracy-benchmark-lib.mjs';

const baseCase = {
  version: 1,
  id: 'typescript-route-realization',
  capability: 'api-route-realization',
  language: 'typescript',
  project: 'Fixture',
  ref: 'commit:1111111111111111111111111111111111111111',
  question: 'Which implementation realizes /api/health?',
  groundTruth: {
    entities: {
      required: ['api:/api/health', 'symbol:route-handler'],
      forbidden: ['symbol:wrong-handler'],
      complete: false,
    },
    relationships: {
      required: [{ from: 'api:/api/health', kind: 'implemented-by', to: 'symbol:route-handler' }],
      forbidden: [{ from: 'api:/api/health', kind: 'implemented-by', to: 'symbol:wrong-handler' }],
      complete: true,
    },
    answerStatuses: ['supported'],
  },
  provenance: [{ kind: 'source', locator: 'src/app/api/health/route.ts' }],
};

test('accuracy case format preserves exact revision and partial ground truth', () => {
  const normalized = normalizeAccuracyCase(baseCase);
  assert.equal(normalized.ref, baseCase.ref);
  assert.equal(normalized.groundTruth.entities.complete, false);
  assert.equal(normalized.groundTruth.relationships.complete, true);
  assert.equal(relationshipKey({ from: 'a', kind: 'calls', to: 'b' }), 'a|calls|b');
});

test('case scoring reports recall and precision only where ground truth is complete', () => {
  const score = scoreAccuracyCase(baseCase, {
    caseId: baseCase.id,
    entities: ['api:/api/health', 'symbol:route-handler', 'symbol:extra-but-unjudged'],
    relationships: [{ from: 'api:/api/health', kind: 'implemented-by', to: 'symbol:route-handler' }],
    answerStatus: 'supported',
  });
  assert.equal(score.pass, true);
  assert.equal(score.entityScore.recall, 1);
  assert.equal(score.entityScore.precision, null, 'partial entity truth must not manufacture false positives');
  assert.equal(score.relationshipScore.precision, 1);
  assert.equal(score.relationshipScore.recall, 1);
});

test('forbidden and false complete-ground-truth relationships fail deterministically', () => {
  const score = scoreAccuracyCase(baseCase, {
    caseId: baseCase.id,
    entities: ['api:/api/health', 'symbol:route-handler'],
    relationships: [
      { from: 'api:/api/health', kind: 'implemented-by', to: 'symbol:route-handler' },
      { from: 'api:/api/health', kind: 'implemented-by', to: 'symbol:wrong-handler' },
    ],
    answerStatus: 'supported',
  });
  assert.equal(score.pass, false);
  assert.deepEqual(score.relationshipScore.forbiddenPresent, ['api:/api/health|implemented-by|symbol:wrong-handler']);
  assert.equal(score.relationshipScore.precision, 0.5);
});

test('suite scorecard aggregates durable correctness metrics', () => {
  const second = structuredClone(baseCase);
  second.id = 'typescript-route-absence';
  second.groundTruth.relationships = { required: [], forbidden: [], complete: false };
  second.groundTruth.entities = { required: ['route:/'], forbidden: [], complete: true };
  const suite = scoreAccuracySuite([baseCase, second], [
    {
      caseId: baseCase.id,
      entities: ['api:/api/health', 'symbol:route-handler'],
      relationships: [{ from: 'api:/api/health', kind: 'implemented-by', to: 'symbol:route-handler' }],
      answerStatus: 'supported',
    },
    {
      caseId: second.id,
      entities: ['route:/'],
      relationships: [],
      answerStatus: 'supported',
    },
  ]);
  assert.equal(suite.cases, 2);
  assert.equal(suite.passed, 2);
  assert.equal(suite.failed, 0);
  assert.equal(suite.entityRecall, 1);
  assert.equal(suite.entityPrecision, 1);
  assert.equal(suite.relationshipRecall, 1);
  assert.equal(suite.relationshipPrecision, 1);
});
