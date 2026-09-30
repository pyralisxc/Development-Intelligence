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
  assert.equal(normalized.groundTruth.semanticCandidates, null);
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
  assert.equal(score.semanticCandidateScore, null);
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

const semanticCase = {
  version: 1,
  id: 'semantic-bootstrap-reviewed-universe',
  capability: 'semantic-bootstrap',
  language: 'typescript',
  project: 'ZeroMetadataFixture',
  ref: 'commit:2222222222222222222222222222222222222222',
  question: 'Which functional concepts can be derived from intrinsic evidence?',
  groundTruth: {
    semanticCandidates: {
      universeScopes: ['src/features/authentication', 'src/features/editor', 'src/shared'],
      required: [
        {
          scope: 'src/features/authentication',
          name: 'Authentication',
          origin: 'intrinsic-derivation',
          accepted: false,
          persisted: false,
          proofEligible: false,
          requiresExplicitReview: true,
          minEvidenceFamilies: 2,
        },
        {
          scope: 'src/features/editor',
          name: 'Editor',
          origin: 'intrinsic-derivation',
          accepted: false,
          persisted: false,
          proofEligible: false,
          requiresExplicitReview: true,
        },
      ],
      forbidden: [{ scope: 'src/shared' }],
      complete: true,
    },
  },
  provenance: [
    { kind: 'source', locator: 'src/features/authentication' },
    { kind: 'source', locator: 'src/features/editor' },
  ],
};

const semanticObservations = [
  {
    scope: 'src/features/authentication',
    proposal: { name: 'Authentication', kind: 'capability' },
    provenance: { origin: 'intrinsic-derivation', evidenceFamilies: ['structure', 'relationship', 'state'] },
    authority: { accepted: false, reviewed: false, persisted: false, proofEligible: false, requiresExplicitReview: true },
  },
  {
    scope: 'src/features/editor',
    proposal: { name: 'Editor', kind: 'surface' },
    provenance: { origin: 'intrinsic-derivation', evidenceFamilies: ['structure', 'interface'] },
    authority: { accepted: false, reviewed: false, persisted: false, proofEligible: false, requiresExplicitReview: true },
  },
];

test('semantic candidate scoring measures bounded complete precision and recall with authority constraints', () => {
  const score = scoreAccuracyCase(semanticCase, {
    caseId: semanticCase.id,
    semanticCandidates: semanticObservations,
  });
  assert.equal(score.pass, true);
  assert.equal(score.semanticCandidateScore.recall, 1);
  assert.equal(score.semanticCandidateScore.precision, 1);
  assert.equal(score.semanticCandidateScore.falsePositiveRate, 0);
  assert.equal(score.semanticCandidateScore.requiredFound, 2);
  assert.deepEqual(score.semanticCandidateScore.forbiddenPresent, []);
});

test('semantic candidate scoring rejects generic false positives and authority drift', () => {
  const score = scoreAccuracyCase(semanticCase, {
    caseId: semanticCase.id,
    semanticCandidates: [
      ...semanticObservations,
      {
        scope: 'src/shared',
        proposal: { name: 'Shared', kind: 'feature' },
        provenance: { origin: 'intrinsic-derivation', evidenceFamilies: ['structure', 'relationship'] },
        authority: { accepted: false, reviewed: false, persisted: false, proofEligible: false, requiresExplicitReview: true },
      },
    ],
  });
  assert.equal(score.pass, false);
  assert.equal(score.semanticCandidateScore.recall, 1);
  assert.equal(score.semanticCandidateScore.precision, 0.666667);
  assert.equal(score.semanticCandidateScore.falsePositiveRate, 0.333333);
  assert.deepEqual(score.semanticCandidateScore.forbiddenPresent, ['src/shared|*|*']);
  assert.ok(score.semanticCandidateScore.falseObserved.some(value => value.startsWith('src/shared|')));
});

test('semantic candidate scoring detects proposal authority drift as a missed required concept', () => {
  const drifted = structuredClone(semanticObservations);
  drifted[0].authority.accepted = true;
  const score = scoreAccuracyCase(semanticCase, {
    caseId: semanticCase.id,
    semanticCandidates: drifted,
  });
  assert.equal(score.pass, false);
  assert.equal(score.semanticCandidateScore.recall, 0.5);
  assert.ok(score.semanticCandidateScore.missingRequired.some(value => value.startsWith('src/features/authentication|')));
});

test('suite scorecard aggregates durable correctness metrics', () => {
  const second = structuredClone(baseCase);
  second.id = 'typescript-route-absence';
  second.groundTruth.relationships = { required: [], forbidden: [], complete: false };
  second.groundTruth.entities = { required: ['route:/'], forbidden: [], complete: true };
  const suite = scoreAccuracySuite([baseCase, second, semanticCase], [
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
    {
      caseId: semanticCase.id,
      semanticCandidates: semanticObservations,
    },
  ]);
  assert.equal(suite.cases, 3);
  assert.equal(suite.passed, 3);
  assert.equal(suite.failed, 0);
  assert.equal(suite.entityRecall, 1);
  assert.equal(suite.entityPrecision, 1);
  assert.equal(suite.relationshipRecall, 1);
  assert.equal(suite.relationshipPrecision, 1);
  assert.equal(suite.semanticCandidateRecall, 1);
  assert.equal(suite.semanticCandidatePrecision, 1);
  assert.equal(suite.semanticCandidateFalsePositiveRate, 0);
});
