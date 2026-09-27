import assert from 'node:assert/strict';
import test from 'node:test';

import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';
import { bootstrapSemanticCandidates } from '../src/intelligence/semanticBootstrap.js';

function node(id: string, kind: string, locator: string, name?: string, layer: 'structural' | 'representation' = 'structural'): GraphNode {
  return {
    id,
    sourceId: 'repo:' + locator.replace(/:\d+.*$/u, ''),
    kind,
    locator,
    ...(name ? { name } : {}),
    value: name ?? id,
    raw: name ?? id,
    layer,
    checkpoint: false,
  };
}

function edge(id: string, from: string, to: string, kind: string): GraphEdge {
  return {
    id,
    from,
    to,
    kind,
    strategy: 'fixture',
    confidence: 1,
    status: 'resolved',
    evidence: ['fixture'],
    layer: 'structural',
    checkpoint: false,
  };
}

function graph(reverse = false): IntelligenceGraph {
  const nodes = [
    node('file:auth-session', 'file', 'src/authentication/session.ts'),
    node('symbol:session', 'function', 'src/authentication/session.ts:3', 'createSession'),
    node('state:session', 'state-binding', 'src/authentication/session.ts:8', 'session'),
    node('file:auth-login', 'file', 'src/authentication/login.ts'),
    node('symbol:login', 'function', 'src/authentication/login.ts:4', 'login'),
    node('route:login', 'route', 'src/authentication/login.ts:10', '/login', 'representation'),
    node('file:utils-string', 'file', 'src/utils/string.ts'),
    node('symbol:slug', 'function', 'src/utils/string.ts:2', 'slugify'),
  ];
  const edges = [
    edge('contains-session', 'file:auth-session', 'symbol:session', 'contains'),
    edge('contains-state', 'file:auth-session', 'state:session', 'contains'),
    edge('contains-login', 'file:auth-login', 'symbol:login', 'contains'),
    edge('contains-route', 'file:auth-login', 'route:login', 'contains'),
    edge('login-calls-session', 'symbol:login', 'symbol:session', 'calls'),
    edge('session-writes-state', 'symbol:session', 'state:session', 'state-write'),
  ];
  return {
    schemaVersion: 2,
    analyzerVersion: 'fixture',
    graphId: 'fixture',
    project: 'ZeroMetadataFixture',
    role: 'W',
    createdAt: '2026-09-27T00:00:00.000Z',
    repositoryRevision: '1111111111111111111111111111111111111111',
    sourceFingerprint: null,
    topologyFingerprint: null,
    evidenceFingerprint: null,
    sources: [],
    evidence: [],
    nodes: reverse ? nodes.slice().reverse() : nodes,
    edges: reverse ? edges.slice().reverse() : edges,
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
    coverage: {
      trackedFiles: 3,
      eligibleFiles: 3,
      analyzedFiles: 3,
      completeFiles: 3,
      partialFiles: 0,
      unsupportedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0,
      skippedFileLimitFiles: 0,
      files: [
        { path: 'src/authentication/session.ts', status: 'complete' },
        { path: 'src/authentication/login.ts', status: 'complete' },
        { path: 'src/utils/string.ts', status: 'complete' },
      ],
    },
  };
}

test('semantic bootstrap derives evidence-linked zero-metadata candidates without accepting them', () => {
  const result = bootstrapSemanticCandidates(graph(), { limit: 10 });
  assert.equal(result.zeroMetadata, true);
  assert.equal(result.declaredSemanticCount, 0);
  assert.equal(result.policy.stage, 'T1-derived-candidates');
  assert.equal(result.policy.persisted, false);
  assert.equal(result.policy.productIntentInferred, false);

  const auth = result.candidates.find(candidate => candidate.scope === 'src/authentication');
  assert.ok(auth, 'authentication candidate should be derived from intrinsic evidence');
  assert.equal(auth.proposal.name, 'Authentication');
  assert.ok(['surface', 'capability'].includes(auth.proposal.kind));
  assert.equal(auth.authority.accepted, false);
  assert.equal(auth.authority.reviewed, false);
  assert.equal(auth.authority.proofEligible, false);
  assert.equal(auth.authority.persisted, false);
  assert.equal(auth.authority.requiresExplicitReview, true);
  assert.equal(auth.provenance.origin, 'intrinsic-derivation');
  assert.equal(auth.provenance.revision, graph().repositoryRevision);
  assert.ok(auth.provenance.evidenceFamilies.includes('structure'));
  assert.ok(auth.provenance.evidenceFamilies.includes('relationship'));
  assert.ok(auth.provenance.evidenceFamilies.some(family => ['interface', 'state'].includes(family)));
  assert.ok(auth.provenance.nodeIds.includes('symbol:login'));
  assert.ok(auth.provenance.edgeIds.includes('login-calls-session'));
  assert.equal(result.candidates.some(candidate => candidate.scope.includes('utils')), false, 'single weak utility files should not become functional meaning');
});

test('semantic candidate identities and ordering are deterministic across graph record ordering', () => {
  const left = bootstrapSemanticCandidates(graph(false), { limit: 10 });
  const right = bootstrapSemanticCandidates(graph(true), { limit: 10 });
  assert.deepEqual(
    left.candidates.map(candidate => ({ id: candidate.id, scope: candidate.scope, name: candidate.proposal.name, families: candidate.provenance.evidenceFamilies })),
    right.candidates.map(candidate => ({ id: candidate.id, scope: candidate.scope, name: candidate.proposal.name, families: candidate.provenance.evidenceFamilies })),
  );
});

test('existing accepted semantic declarations are reported separately from derived candidates', () => {
  const fixture = graph();
  fixture.nodes.push({
    id: 'capability:declared-auth',
    sourceId: 'repo:src/declared.ts',
    kind: 'capability',
    locator: 'src/declared.ts:1',
    name: 'Declared authentication',
    value: 'Declared authentication',
    raw: 'Declared authentication',
    tags: ['semantic'],
    layer: 'semantic',
    checkpoint: true,
  });
  const result = bootstrapSemanticCandidates(fixture);
  assert.equal(result.zeroMetadata, false);
  assert.equal(result.declaredSemanticCount, 1);
  assert.ok(result.candidates.every(candidate => candidate.authority.state === 'proposed' && candidate.authority.accepted === false));
});
