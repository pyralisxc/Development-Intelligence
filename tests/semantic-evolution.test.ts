import assert from 'node:assert/strict';
import test from 'node:test';

import type { SemanticCandidate } from '../src/intelligence/semanticBootstrap.js';
import { applySemanticReviewAction, semanticMeaningReview, type SemanticMeaningReview } from '../src/intelligence/semanticReview.js';
import {
  evaluateSemanticEvolution,
  mergeSemanticMeanings,
  replaceSemanticMeaning,
  splitSemanticMeaning,
  supersedeSemanticMeaning,
} from '../src/intelligence/semanticEvolution.js';

function candidate(input: {
  id: string;
  scope: string;
  name: string;
  revision: string;
  families?: SemanticCandidate['provenance']['evidenceFamilies'];
  files?: number;
  nodes?: number;
  edges?: number;
}): SemanticCandidate {
  const families = input.families ?? ['structure', 'relationship', 'api'];
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
      evidenceFamilies: families,
      nodeIds: [`node:${input.id}`],
      edgeIds: [`edge:${input.id}`],
      evidenceIds: [],
    },
    support: {
      scopeRole: 'functional-container',
      scopeDepth: input.scope.split('/').length,
      evidenceFamilyCount: families.length,
      fileCount: input.files ?? 8,
      nodeCount: input.nodes ?? 24,
      resolvedEdgeCount: input.edges ?? 12,
      motifKinds: [],
    },
    evidencePacket: { representativeNodes: [], representativeEdges: [] },
  };
}

function accepted(value: SemanticCandidate, human = 'human:owner'): SemanticMeaningReview {
  return applySemanticReviewAction(semanticMeaningReview(value), {
    kind: 'accept',
    actor: { kind: 'human', id: human },
    at: '2026-09-27T20:00:00.000Z',
  });
}

test('accepted semantic identity survives implementation realization changes', () => {
  const original = accepted(candidate({
    id: 'candidate:studio',
    scope: 'src/features/studio',
    name: 'Studio',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const changed = candidate({
    id: 'candidate:studio',
    scope: 'src/features/studio',
    name: 'Studio',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    families: ['structure', 'relationship', 'api', 'state'],
    files: 11,
    nodes: 35,
    edges: 19,
  });

  const result = evaluateSemanticEvolution(original, [changed], changed.provenance.revision);
  assert.equal(result.meaningId, original.meaningId);
  assert.equal(result.status, 'realization-changed');
  assert.equal(result.reviewRequired, false);
  assert.equal(result.matchedCandidate?.id, changed.id);
  assert.deepEqual(result.supportDelta?.addedEvidenceFamilies, ['state']);
});

test('semantic identity survives a source-scope move when normalized meaning remains', () => {
  const original = accepted(candidate({
    id: 'candidate:library-old',
    scope: 'src/features/library',
    name: 'Library',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const moved = candidate({
    id: 'candidate:library-new',
    scope: 'src/domains/library',
    name: 'Library',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  const result = evaluateSemanticEvolution(original, [moved], moved.provenance.revision);
  assert.equal(result.status, 'realization-changed');
  assert.equal(result.reviewRequired, false);
  assert.equal(result.meaningId, original.meaningId);
  assert.match(result.reasons.join(' '), /scope changed/i);
});

test('rename, weakened support, ambiguity and disappearance request review explicitly', () => {
  const original = accepted(candidate({
    id: 'candidate:publishing',
    scope: 'src/features/publishing',
    name: 'Publishing',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    families: ['structure', 'relationship', 'api', 'state'],
    files: 10,
    edges: 20,
  }));

  const renamed = candidate({
    id: 'candidate:distribution',
    scope: 'src/features/publishing',
    name: 'Distribution',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    families: ['structure', 'relationship', 'api', 'state'],
    files: 10,
    edges: 20,
  });
  assert.equal(evaluateSemanticEvolution(original, [renamed], renamed.provenance.revision).status, 'renamed');

  const weakened = candidate({
    id: 'candidate:publishing',
    scope: 'src/features/publishing',
    name: 'Publishing',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    families: ['structure', 'relationship'],
    files: 3,
    edges: 5,
  });
  const weakenedResult = evaluateSemanticEvolution(original, [weakened], weakened.provenance.revision);
  assert.equal(weakenedResult.status, 'weakened');
  assert.equal(weakenedResult.reviewRequired, true);

  const ambiguousA = candidate({
    id: 'candidate:publishing-a',
    scope: 'src/domains/publishing-a',
    name: 'Publishing',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const ambiguousB = candidate({
    id: 'candidate:publishing-b',
    scope: 'src/domains/publishing-b',
    name: 'Publishing',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  assert.equal(evaluateSemanticEvolution(original, [ambiguousA, ambiguousB], ambiguousA.provenance.revision).status, 'ambiguous');

  const unsupported = evaluateSemanticEvolution(original, [], 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.reviewRequired, true);
});

test('replace creates a new semantic identity with explicit predecessor/successor lineage', () => {
  const original = accepted(candidate({
    id: 'candidate:old',
    scope: 'src/features/old',
    name: 'Old Capability',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const next = candidate({
    id: 'candidate:new',
    scope: 'src/features/new',
    name: 'New Capability',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  const result = replaceSemanticMeaning(
    original,
    next,
    { kind: 'human', id: 'human:owner' },
    '2026-09-27T20:10:00.000Z',
    'Product meaning materially changed.',
  );
  assert.equal(result.source.state, 'superseded');
  assert.notEqual(result.successors[0]?.meaningId, original.meaningId);
  assert.deepEqual(result.source.lineage.successorMeaningIds, [result.successors[0]!.meaningId]);
  assert.deepEqual(result.successors[0]?.lineage.predecessorMeaningIds, [original.meaningId]);
  assert.equal(result.successors[0]?.accepted, false, 'replacement successor must be reviewed independently');
});

test('split and merge preserve explicit lineage without automatically accepting successors', () => {
  const original = accepted(candidate({
    id: 'candidate:marketing',
    scope: 'src/features/marketing',
    name: 'Marketing',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const content = candidate({
    id: 'candidate:marketing-content',
    scope: 'src/features/marketing-content',
    name: 'Marketing Content',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const distribution = candidate({
    id: 'candidate:marketing-distribution',
    scope: 'src/features/marketing-distribution',
    name: 'Marketing Distribution',
    revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  const split = splitSemanticMeaning(
    original,
    [content, distribution],
    { kind: 'human', id: 'human:owner' },
    '2026-09-27T20:20:00.000Z',
  );
  assert.equal(split.source.state, 'split');
  assert.equal(split.successors.length, 2);
  assert.ok(split.successors.every(item => item.accepted === false));
  assert.ok(split.successors.every(item => item.lineage.predecessorMeaningIds.includes(original.meaningId)));

  const acceptedContent = accepted(content);
  const acceptedDistribution = accepted(distribution);
  const unified = candidate({
    id: 'candidate:marketing-unified',
    scope: 'src/features/marketing',
    name: 'Marketing',
    revision: 'cccccccccccccccccccccccccccccccccccccccc',
  });
  const merged = mergeSemanticMeanings(
    [acceptedContent, acceptedDistribution],
    unified,
    { kind: 'human', id: 'human:owner' },
    '2026-09-27T20:30:00.000Z',
  );
  assert.ok(merged.sources.every(item => item.state === 'merged'));
  assert.equal(merged.successor.accepted, false);
  assert.deepEqual(
    merged.successor.lineage.predecessorMeaningIds,
    [acceptedContent.meaningId, acceptedDistribution.meaningId].sort(),
  );
});

test('explicit supersession can point to known successor identities without inventing successors', () => {
  const original = accepted(candidate({
    id: 'candidate:legacy',
    scope: 'src/features/legacy',
    name: 'Legacy',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  const updated = supersedeSemanticMeaning(
    original,
    ['semantic-meaning:new-b', 'semantic-meaning:new-a'],
    { kind: 'repository-declaration', id: 'repo:decision' },
    '2026-09-27T20:40:00.000Z',
    'Repository decision superseded legacy meaning.',
  );
  assert.equal(updated.state, 'superseded');
  assert.deepEqual(updated.lineage.successorMeaningIds, ['semantic-meaning:new-a', 'semantic-meaning:new-b']);
});
