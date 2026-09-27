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
  assert.equal(result.observedSemanticCount, 0);
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

test('observed semantic facts do not falsely count as explicit semantic metadata', () => {
  const fixture = graph();
  fixture.nodes.push({
    id: 'mcp:observed-tool',
    sourceId: 'repo:src/tool.ts',
    kind: 'mcp',
    locator: 'src/tool.ts:1:mcp',
    name: 'observed_tool',
    value: { tool: 'observed_tool' },
    raw: '{"tool":"observed_tool"}',
    tags: ['semantic', 'protocol-observed'],
    layer: 'semantic',
    checkpoint: true,
  });
  const result = bootstrapSemanticCandidates(fixture);
  assert.equal(result.observedSemanticCount, 1);
  assert.equal(result.declaredSemanticCount, 0);
  assert.equal(result.zeroMetadata, true);
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
    tags: ['semantic', 'declared'],
    layer: 'semantic',
    checkpoint: true,
  });
  const result = bootstrapSemanticCandidates(fixture);
  assert.equal(result.zeroMetadata, false);
  assert.equal(result.observedSemanticCount, 1);
  assert.equal(result.declaredSemanticCount, 1);
  assert.ok(result.candidates.every(candidate => candidate.authority.state === 'proposed' && candidate.authority.accepted === false));
});


test('bounded semantic output prioritizes top-level functional containers over noisy direct scopes', () => {
  const fixture = graph();
  for (let index = 0; index < 12; index += 1) {
    fixture.nodes.push(
      node(`file:noise-${index}`, 'file', `src/runtime/noise-${index}.ts`),
      node(`symbol:noise-${index}`, 'function', `src/runtime/noise-${index}.ts:2`, `noise${index}`),
      node(`state:noise-${index}`, 'state-binding', `src/runtime/noise-${index}.ts:3`, `noiseState${index}`, 'representation'),
    );
    fixture.edges.push(
      edge(`noise-contains-${index}`, `file:noise-${index}`, `symbol:noise-${index}`, 'contains'),
      edge(`noise-state-${index}`, `symbol:noise-${index}`, `state:noise-${index}`, 'state-write'),
    );
  }
  fixture.nodes.push(
    node('file:editor-page', 'file', 'src/features/editor/EditorPage.tsx'),
    node('symbol:editor-page', 'function', 'src/features/editor/EditorPage.tsx:2', 'EditorPage'),
    node('ui:editor', 'ui-element', 'src/features/editor/EditorPage.tsx:4', 'Editor', 'representation'),
    node('file:editor-state', 'file', 'src/features/editor/editorState.ts'),
    node('state:editor', 'state-binding', 'src/features/editor/editorState.ts:3', 'editorState', 'representation'),
  );
  fixture.edges.push(
    edge('editor-contains-page', 'file:editor-page', 'symbol:editor-page', 'contains'),
    edge('editor-contains-ui', 'symbol:editor-page', 'ui:editor', 'contains'),
    edge('editor-state-write', 'symbol:editor-page', 'state:editor', 'state-write'),
  );

  const result = bootstrapSemanticCandidates(fixture, { limit: 1 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.scope, 'src/features/editor');
  assert.equal(result.candidates[0]?.support.scopeRole, 'functional-container');
  assert.equal(result.candidates[0]?.support.scopeDepth, 3);
});


test('semantic bootstrap skips Unity package/member wrappers and preserves functional ownership', () => {
  const fixture = graph();
  fixture.nodes.push(
    node('file:gsc-bootstrap', 'file', 'Packages/com.example.game/Members/Owner/Gameplay/Glue/Bootstrap/GameplaySessionBootstrap.cs'),
    node('symbol:gsc-bootstrap', 'class', 'Packages/com.example.game/Members/Owner/Gameplay/Glue/Bootstrap/GameplaySessionBootstrap.cs:2', 'GameplaySessionBootstrap'),
    node('file:gsc-session', 'file', 'Packages/com.example.game/Members/Owner/Gameplay/Glue/Session/SessionStateMachine.cs'),
    node('symbol:gsc-session', 'class', 'Packages/com.example.game/Members/Owner/Gameplay/Glue/Session/SessionStateMachine.cs:2', 'SessionStateMachine'),
    node('file:gsc-character-a', 'file', 'Packages/com.example.game/Members/Owner/Gameplay/Modules/Character/Runtime/CharacterController.cs'),
    node('symbol:gsc-character-a', 'class', 'Packages/com.example.game/Members/Owner/Gameplay/Modules/Character/Runtime/CharacterController.cs:2', 'CharacterController'),
    node('file:gsc-character-b', 'file', 'Packages/com.example.game/Members/Owner/Gameplay/Modules/Character/Runtime/InteractionInputAdapter2D.cs'),
    node('symbol:gsc-character-b', 'class', 'Packages/com.example.game/Members/Owner/Gameplay/Modules/Character/Runtime/InteractionInputAdapter2D.cs:2', 'InteractionInputAdapter2D'),
  );
  fixture.edges.push(
    edge('gsc-bootstrap-contains', 'file:gsc-bootstrap', 'symbol:gsc-bootstrap', 'contains'),
    edge('gsc-session-contains', 'file:gsc-session', 'symbol:gsc-session', 'contains'),
    edge('gsc-bootstrap-session', 'symbol:gsc-bootstrap', 'symbol:gsc-session', 'calls'),
    edge('gsc-character-a-contains', 'file:gsc-character-a', 'symbol:gsc-character-a', 'contains'),
    edge('gsc-character-b-contains', 'file:gsc-character-b', 'symbol:gsc-character-b', 'contains'),
    edge('gsc-character-link', 'symbol:gsc-character-a', 'symbol:gsc-character-b', 'calls'),
  );

  const result = bootstrapSemanticCandidates(fixture, { limit: 20 });
  assert.ok(result.candidates.some(candidate => candidate.scope === 'Packages/com.example.game/Members/Owner/Gameplay' && candidate.proposal.name === 'Gameplay'));
  assert.ok(result.candidates.some(candidate => candidate.scope === 'Packages/com.example.game/Members/Owner/Gameplay/Modules/Character' && candidate.proposal.name === 'Character'));
  assert.equal(result.candidates.some(candidate => candidate.scope === 'Packages/com.example.game'), false);
});

test('semantic bootstrap skips Java source/package wrappers and exposes package-level concepts', () => {
  const fixture = graph();
  fixture.nodes.push(
    node('file:java-ge-a', 'file', 'src/main/java/medievalsim/grandexchange/domain/GrandExchangeLevelData.java'),
    node('symbol:java-ge-a', 'class', 'src/main/java/medievalsim/grandexchange/domain/GrandExchangeLevelData.java:2', 'GrandExchangeLevelData'),
    node('file:java-ge-b', 'file', 'src/main/java/medievalsim/grandexchange/ui/GrandExchangeContainer.java'),
    node('symbol:java-ge-b', 'class', 'src/main/java/medievalsim/grandexchange/ui/GrandExchangeContainer.java:2', 'GrandExchangeContainer'),
    node('file:java-zone-a', 'file', 'src/main/java/medievalsim/zones/ui/CreateOrExpandZoneTool.java'),
    node('symbol:java-zone-a', 'class', 'src/main/java/medievalsim/zones/ui/CreateOrExpandZoneTool.java:2', 'CreateOrExpandZoneTool'),
    node('file:java-zone-b', 'file', 'src/main/java/medievalsim/zones/ui/ZoneVisualizationHud.java'),
    node('symbol:java-zone-b', 'class', 'src/main/java/medievalsim/zones/ui/ZoneVisualizationHud.java:2', 'ZoneVisualizationHud'),
  );
  fixture.edges.push(
    edge('java-ge-a-contains', 'file:java-ge-a', 'symbol:java-ge-a', 'contains'),
    edge('java-ge-b-contains', 'file:java-ge-b', 'symbol:java-ge-b', 'contains'),
    edge('java-ge-link', 'symbol:java-ge-a', 'symbol:java-ge-b', 'calls'),
    edge('java-zone-a-contains', 'file:java-zone-a', 'symbol:java-zone-a', 'contains'),
    edge('java-zone-b-contains', 'file:java-zone-b', 'symbol:java-zone-b', 'contains'),
    edge('java-zone-link', 'symbol:java-zone-a', 'symbol:java-zone-b', 'calls'),
  );

  const result = bootstrapSemanticCandidates(fixture, { limit: 20 });
  assert.ok(result.candidates.some(candidate => candidate.scope === 'src/main/java/medievalsim/grandexchange'));
  assert.ok(result.candidates.some(candidate => candidate.scope === 'src/main/java/medievalsim/zones'));
  assert.equal(result.candidates.some(candidate => candidate.scope === 'src/main'), false);
});
