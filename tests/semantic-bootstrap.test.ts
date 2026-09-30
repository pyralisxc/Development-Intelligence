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

test('single-file HTTP-facing scopes qualify through API evidence without weakening weak utility rejection', () => {
  const fixture = graph();
  fixture.nodes.push(
    node('file:http-context', 'file', 'context.go'),
    node('package:http-context', 'package', 'context.go:5', 'gin'),
    node('struct:http-context', 'struct', 'context.go:61', 'Context'),
    node('import:http-context', 'import-binding', 'context.go:17', 'http'),
  );
  fixture.edges.push(
    edge('http-context-contains-package', 'file:http-context', 'package:http-context', 'contains'),
    edge('http-context-contains-struct', 'file:http-context', 'struct:http-context', 'contains'),
  );

  const result = bootstrapSemanticCandidates(fixture, { limit: 20 });
  const context = result.candidates.find(candidate => candidate.scope === 'context.go');
  assert.ok(context, 'a single-file HTTP-facing scope should qualify through observed API evidence');
  assert.equal(context.support.fileCount, 1);
  assert.ok(context.provenance.evidenceFamilies.includes('structure'));
  assert.ok(context.provenance.evidenceFamilies.includes('relationship'));
  assert.ok(context.provenance.evidenceFamilies.includes('api'));
  assert.equal(context.proposal.kind, 'capability');
  assert.equal(result.candidates.some(candidate => candidate.scope.includes('utils')), false, 'weak single-file utility structure must remain rejected');
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


test('semantic capacity expands without quota filling and remains prefix-stable', () => {
  const fixture = graph();
  fixture.nodes = [];
  fixture.edges = [];
  fixture.coverage = {
    trackedFiles: 160,
    eligibleFiles: 160,
    analyzedFiles: 160,
    completeFiles: 160,
    partialFiles: 0,
    unsupportedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    skippedOversizedFiles: 0,
    skippedNonRegularFiles: 0,
    skippedFileLimitFiles: 0,
    files: [],
  };

  for (let index = 0; index < 60; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const fileA = `src/features/feature-${suffix}/a.ts`;
    const fileB = `src/features/feature-${suffix}/b.ts`;
    fixture.nodes.push(
      node(`file:feature-${suffix}-a`, 'file', fileA),
      node(`symbol:feature-${suffix}-a`, 'function', `${fileA}:2`, `feature${suffix}A`),
      node(`file:feature-${suffix}-b`, 'file', fileB),
      node(`symbol:feature-${suffix}-b`, 'function', `${fileB}:2`, `feature${suffix}B`),
    );
    fixture.edges.push(
      edge(`contains-feature-${suffix}-a`, `file:feature-${suffix}-a`, `symbol:feature-${suffix}-a`, 'contains'),
      edge(`contains-feature-${suffix}-b`, `file:feature-${suffix}-b`, `symbol:feature-${suffix}-b`, 'contains'),
      edge(`feature-${suffix}-link`, `symbol:feature-${suffix}-a`, `symbol:feature-${suffix}-b`, 'calls'),
    );
    fixture.coverage.files.push({ path: fileA, status: 'complete' }, { path: fileB, status: 'complete' });
  }

  for (let index = 0; index < 40; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const file = `src/internal/noise-${suffix}/single.ts`;
    fixture.nodes.push(
      node(`file:noise-${suffix}`, 'file', file),
      node(`symbol:noise-${suffix}`, 'function', `${file}:2`, `noise${suffix}`),
    );
    fixture.coverage.files.push({ path: file, status: 'complete' });
  }

  const at50 = bootstrapSemanticCandidates(fixture, { limit: 50 });
  const at100 = bootstrapSemanticCandidates(fixture, { limit: 100 });
  const overRequested = bootstrapSemanticCandidates(fixture, { limit: 500 });

  assert.equal(at50.candidates.length, 50);
  assert.equal(at50.capacity.eligibleCandidateCount, 60);
  assert.equal(at50.capacity.truncated, true);
  assert.equal(at50.capacity.exhausted, false);

  assert.equal(at100.candidates.length, 60, '100 is a ceiling, not a quota');
  assert.equal(at100.capacity.requestedLimit, 100);
  assert.equal(at100.capacity.operationalLimit, 1000);
  assert.equal(at100.capacity.groupedScopeCount, 100);
  assert.equal(at100.capacity.eligibleCandidateCount, 60);
  assert.equal(at100.capacity.rejectedScopeCount, 40);
  assert.equal(at100.capacity.returnedCandidateCount, 60);
  assert.equal(at100.capacity.truncated, false);
  assert.equal(at100.capacity.exhausted, true);
  assert.equal(at100.capacity.rejectionReasons.insufficientEvidenceFamilies, 40);
  assert.equal(at100.capacity.rejectionReasons.insufficientFileSupport, 0);

  assert.deepEqual(
    at50.candidates.map(candidate => candidate.id),
    at100.candidates.slice(0, 50).map(candidate => candidate.id),
    'raising the presentation budget must not reorder or rewrite earlier meanings',
  );
  assert.equal(overRequested.capacity.requestedLimit, 500, '100 is a benchmark checkpoint, not a semantic hard limit');
  assert.deepEqual(overRequested.candidates.map(candidate => candidate.id), at100.candidates.map(candidate => candidate.id));
});


test('representation locator suffixes cannot manufacture semantic pseudo-file scopes', () => {
  const fixture = graph();
  fixture.nodes = [
    node('file:editor-a', 'file', 'src/features/editor/Editor.tsx'),
    node('symbol:editor-a', 'function', 'src/features/editor/Editor.tsx:2', 'Editor'),
    node('ui:editor-a', 'ui-element', 'src/features/editor/Editor.tsx:selector:.editor-shell', 'Editor shell', 'representation'),
    node('state:editor-a', 'state-binding', 'src/features/editor/Editor.tsx:state-write:selection', 'selection', 'representation'),
    node('file:editor-b', 'file', 'src/features/editor/editorState.ts'),
    node('symbol:editor-b', 'function', 'src/features/editor/editorState.ts:2', 'updateEditorState'),
    node('nav:editor-b', 'navigation-call', 'src/features/editor/editorState.ts:navigation:/studio', '/studio', 'representation'),
  ];
  fixture.edges = [
    edge('editor-a-contains', 'file:editor-a', 'symbol:editor-a', 'contains'),
    edge('editor-a-ui', 'symbol:editor-a', 'ui:editor-a', 'contains'),
    edge('editor-a-state', 'symbol:editor-a', 'state:editor-a', 'state-write'),
    edge('editor-b-contains', 'file:editor-b', 'symbol:editor-b', 'contains'),
    edge('editor-b-nav', 'symbol:editor-b', 'nav:editor-b', 'invokes'),
    edge('editor-link', 'symbol:editor-a', 'symbol:editor-b', 'calls'),
  ];

  const result = bootstrapSemanticCandidates(fixture, { limit: 100 });
  assert.equal(result.capacity.groupedScopeCount, 1, 'all observations must collapse to the physical editor files and one feature scope');
  assert.equal(result.capacity.eligibleCandidateCount, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.scope, 'src/features/editor');
  assert.equal(result.candidates[0]?.support.fileCount, 2, 'semantic support must count physical files, not locator suffixes');
});


test('generic support roots stay structural even when they contain strong technical activity', () => {
  const fixture = graph();
  fixture.nodes = [
    node('file:shared-a', 'file', 'src/shared/session.ts'),
    node('symbol:shared-a', 'function', 'src/shared/session.ts:2', 'writeSession'),
    node('state:shared-a', 'state-binding', 'src/shared/session.ts:state-write:session', 'session', 'representation'),
    node('file:shared-b', 'file', 'src/shared/request.ts'),
    node('symbol:shared-b', 'function', 'src/shared/request.ts:2', 'requestApi'),
    node('api:shared-b', 'http-call', 'src/shared/request.ts:http-call:/api/session', '/api/session', 'representation'),
  ];
  fixture.edges = [
    edge('shared-a-contains', 'file:shared-a', 'symbol:shared-a', 'contains'),
    edge('shared-state', 'symbol:shared-a', 'state:shared-a', 'state-write'),
    edge('shared-b-contains', 'file:shared-b', 'symbol:shared-b', 'contains'),
    edge('shared-api', 'symbol:shared-b', 'api:shared-b', 'calls'),
    edge('shared-link', 'symbol:shared-a', 'symbol:shared-b', 'calls'),
  ];

  const result = bootstrapSemanticCandidates(fixture, { limit: 100 });
  assert.equal(result.capacity.groupedScopeCount, 1);
  assert.equal(result.capacity.eligibleCandidateCount, 0);
  assert.equal(result.capacity.rejectedScopeCount, 1);
  assert.equal(result.capacity.rejectionReasons.genericSupportScope, 1);
  assert.equal(result.candidates.length, 0, 'shared is technical support structure, not product meaning');
});


test('logical graph locators without physical files cannot create semantic scopes', () => {
  const fixture = graph();
  fixture.nodes = [
    {
      id: 'route:logical',
      sourceId: 'route:/account',
      kind: 'route',
      locator: 'route:/account',
      name: '/account',
      value: '/account',
      raw: '/account',
      layer: 'representation',
      checkpoint: false,
    },
    {
      id: 'api:logical',
      sourceId: 'api:/api/account',
      kind: 'api',
      locator: 'api:/api/account',
      name: '/api/account',
      value: '/api/account',
      raw: '/api/account',
      layer: 'representation',
      checkpoint: false,
    },
  ];
  fixture.edges = [edge('route-api', 'route:logical', 'api:logical', 'calls')];

  const result = bootstrapSemanticCandidates(fixture, { limit: 100 });
  assert.equal(result.capacity.groupedScopeCount, 0);
  assert.equal(result.capacity.eligibleCandidateCount, 0);
  assert.equal(result.candidates.length, 0);
});


test('semantic capacity can honestly enumerate more than 100 evidence-qualified meanings', () => {
  const fixture = graph();
  fixture.nodes = [];
  fixture.edges = [];
  fixture.coverage = {
    trackedFiles: 300,
    eligibleFiles: 300,
    analyzedFiles: 300,
    completeFiles: 300,
    partialFiles: 0,
    unsupportedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    skippedOversizedFiles: 0,
    skippedNonRegularFiles: 0,
    skippedFileLimitFiles: 0,
    files: [],
  };

  for (let index = 0; index < 140; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const fileA = `src/features/capability-${suffix}/a.ts`;
    const fileB = `src/features/capability-${suffix}/b.ts`;
    fixture.nodes.push(
      node(`file:cap-${suffix}-a`, 'file', fileA),
      node(`symbol:cap-${suffix}-a`, 'function', `${fileA}:2`, `capability${suffix}A`),
      node(`file:cap-${suffix}-b`, 'file', fileB),
      node(`symbol:cap-${suffix}-b`, 'function', `${fileB}:2`, `capability${suffix}B`),
    );
    fixture.edges.push(
      edge(`cap-${suffix}-contains-a`, `file:cap-${suffix}-a`, `symbol:cap-${suffix}-a`, 'contains'),
      edge(`cap-${suffix}-contains-b`, `file:cap-${suffix}-b`, `symbol:cap-${suffix}-b`, 'contains'),
      edge(`cap-${suffix}-link`, `symbol:cap-${suffix}-a`, `symbol:cap-${suffix}-b`, 'calls'),
    );
    fixture.coverage.files.push({ path: fileA, status: 'complete' }, { path: fileB, status: 'complete' });
  }

  const at50 = bootstrapSemanticCandidates(fixture, { limit: 50 });
  const at100 = bootstrapSemanticCandidates(fixture, { limit: 100 });
  const at200 = bootstrapSemanticCandidates(fixture, { limit: 200 });

  assert.equal(at50.capacity.eligibleCandidateCount, 140);
  assert.equal(at100.capacity.eligibleCandidateCount, 140);
  assert.equal(at100.candidates.length, 100);
  assert.equal(at100.capacity.truncated, true);
  assert.equal(at100.capacity.exhausted, false);
  assert.equal(at200.candidates.length, 140);
  assert.equal(at200.capacity.exhausted, true);
  assert.deepEqual(at50.candidates.map(candidate => candidate.id), at100.candidates.slice(0, 50).map(candidate => candidate.id));
  assert.deepEqual(at100.candidates.map(candidate => candidate.id), at200.candidates.slice(0, 100).map(candidate => candidate.id));
});
