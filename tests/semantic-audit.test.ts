import assert from 'node:assert/strict';
import test from 'node:test';

import type { IntelligenceGraph } from '../src/types.js';
import type { SemanticBootstrapProjection, SemanticCandidate } from '../src/intelligence/semanticBootstrap.js';
import { auditSemanticCandidates } from '../src/intelligence/semanticAudit.js';

function candidate(overrides: Partial<SemanticCandidate> & { id: string; scope: string }): SemanticCandidate {
  return {
    id: overrides.id,
    scope: overrides.scope,
    proposal: overrides.proposal ?? {
      name: overrides.scope.split('/').at(-1) ?? overrides.id,
      description: 'fixture',
      kind: 'capability',
      alternatives: [],
    },
    authority: overrides.authority ?? {
      state: 'proposed',
      accepted: false,
      reviewed: false,
      proofEligible: false,
      persisted: false,
      requiresExplicitReview: true,
    },
    provenance: overrides.provenance ?? {
      origin: 'intrinsic-derivation',
      producer: 'semantic-bootstrap.v1',
      revision: '1111111111111111111111111111111111111111',
      evidenceFamilies: ['structure', 'relationship', 'api', 'state'],
      nodeIds: [`node:${overrides.id}`],
      edgeIds: [`edge:${overrides.id}`],
      evidenceIds: [],
    },
    support: overrides.support ?? {
      scopeRole: 'functional-container',
      scopeDepth: 3,
      evidenceFamilyCount: 4,
      fileCount: 12,
      nodeCount: 40,
      resolvedEdgeCount: 18,
      motifKinds: [],
    },
    evidencePacket: overrides.evidencePacket ?? { representativeNodes: [], representativeEdges: [] },
  };
}

function graph(candidates: SemanticCandidate[]): IntelligenceGraph {
  return {
    schemaVersion: 2,
    analyzerVersion: 'fixture',
    graphId: 'fixture',
    project: 'fixture',
    role: 'W',
    createdAt: '2026-09-27T00:00:00.000Z',
    repositoryRevision: '1111111111111111111111111111111111111111',
    sourceFingerprint: null,
    topologyFingerprint: null,
    evidenceFingerprint: null,
    sources: [],
    evidence: [],
    nodes: candidates.flatMap(item => item.provenance.nodeIds.map(id => ({
      id,
      sourceId: 'repo:fixture.ts',
      kind: 'function',
      locator: 'src/fixture.ts:1',
      name: id,
      value: id,
      raw: id,
      layer: 'structural' as const,
      checkpoint: false,
    }))),
    edges: candidates.flatMap(item => item.provenance.edgeIds.map(id => ({
      id,
      from: item.provenance.nodeIds[0] ?? null,
      to: item.provenance.nodeIds[0] ?? null,
      kind: 'calls',
      strategy: 'fixture',
      confidence: 1,
      status: 'resolved' as const,
      evidence: ['fixture'],
      layer: 'structural' as const,
      checkpoint: false,
    }))),
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
  };
}

function bootstrap(candidates: SemanticCandidate[]): SemanticBootstrapProjection {
  return {
    version: 1,
    revision: '1111111111111111111111111111111111111111',
    zeroMetadata: true,
    observedSemanticCount: 0,
    declaredSemanticCount: 0,
    candidates,
    capacity: {
      requestedLimit: candidates.length,
      operationalLimit: 1000,
      groupedScopeCount: candidates.length + 2,
      eligibleCandidateCount: candidates.length,
      rejectedScopeCount: 2,
      returnedCandidateCount: candidates.length,
      truncated: false,
      exhausted: true,
      rejectionReasons: {
        insufficientEvidenceFamilies: 1,
        insufficientFileSupport: 1,
        genericSupportScope: 0,
      },
    },
    policy: {
      stage: 'T1-derived-candidates',
      persisted: false,
      acceptedGraphAffected: false,
      productIntentInferred: false,
      modelOutputAcceptedAutomatically: false,
      explicitReviewRequiredForAcceptance: true,
    },
  };
}

test('semantic audit separates factual support from explicit core facets without changing authority', () => {
  const core = candidate({ id: 'core', scope: 'src/features/editor' });
  const supporting = candidate({
    id: 'supporting',
    scope: 'src/domain/formatting',
    provenance: {
      ...candidate({ id: 'tmp', scope: 'x' }).provenance,
      nodeIds: ['node:supporting'],
      edgeIds: ['edge:supporting'],
      evidenceFamilies: ['structure', 'relationship'],
    },
    support: {
      scopeRole: 'direct',
      scopeDepth: 3,
      evidenceFamilyCount: 2,
      fileCount: 2,
      nodeCount: 5,
      resolvedEdgeCount: 2,
      motifKinds: [],
    },
  });
  const projection = auditSemanticCandidates(graph([core, supporting]), bootstrap([supporting, core]), { limit: 10 });

  assert.equal(projection.counts.audited, 2);
  assert.equal(projection.counts.factualitySupported, 2);
  assert.equal(projection.counts.coreCandidates, 1);
  assert.equal(projection.items[0]?.candidateId, 'core', 'core candidates should surface first using explicit facets');
  assert.equal(projection.items[0]?.coreness.classification, 'core-candidate');
  assert.equal(projection.items[1]?.coreness.classification, 'supporting-candidate');
  assert.equal(projection.policy.subjectiveGlobalScore, false);
  assert.equal(projection.policy.authorityUnaffected, true);
  assert.equal(projection.items[0]?.authority.accepted, false);
});

test('semantic audit allows strongly corroborated multi-file direct scopes to be core without a feature-folder convention', () => {
  const directCore = candidate({
    id: 'direct-core',
    scope: 'binding',
    provenance: {
      ...candidate({ id: 'tmp-direct', scope: 'x' }).provenance,
      nodeIds: ['node:direct-core'],
      edgeIds: ['edge:direct-core'],
      evidenceFamilies: ['structure', 'relationship', 'api'],
    },
    support: {
      scopeRole: 'direct',
      scopeDepth: 1,
      evidenceFamilyCount: 3,
      fileCount: 8,
      nodeCount: 30,
      resolvedEdgeCount: 12,
      motifKinds: [],
    },
  });
  const projection = auditSemanticCandidates(graph([directCore]), bootstrap([directCore]), { limit: 10 });

  assert.equal(projection.counts.coreCandidates, 1);
  assert.equal(projection.items[0]?.coreness.classification, 'core-candidate');
  assert.equal(projection.items[0]?.coreness.facets.functionalContainer, false);
  assert.equal(projection.items[0]?.coreness.facets.multiFile, true);
  assert.equal(projection.items[0]?.coreness.facets.evidenceDiverse, true);
  assert.equal(projection.items[0]?.coreness.facets.relationshipRich, true);
  assert.equal(projection.items[0]?.authority.accepted, false);
});

test('semantic factuality audit exposes broken provenance instead of promoting it', () => {
  const broken = candidate({
    id: 'broken',
    scope: 'src/features/broken',
    provenance: {
      ...candidate({ id: 'tmp2', scope: 'x' }).provenance,
      nodeIds: ['node:missing'],
      edgeIds: ['edge:missing'],
    },
  });
  const emptyGraph = graph([]);
  const projection = auditSemanticCandidates(emptyGraph, bootstrap([broken]));

  assert.equal(projection.counts.factualityNeedsReview, 1);
  assert.equal(projection.items[0]?.factuality.status, 'needs-review');
  assert.deepEqual(projection.items[0]?.factuality.missingNodeIds, ['node:missing']);
  assert.deepEqual(projection.items[0]?.factuality.missingEdgeIds, ['edge:missing']);
  assert.equal(projection.items[0]?.coreness.classification, 'supporting-candidate');
});
