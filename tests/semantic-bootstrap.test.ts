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


test('exact documentation scope assertions strengthen existing candidates without creating authority', () => {
  const fixture = graph();
  fixture.nodes.push(
    node('file:editor-view', 'file', 'src/features/editor/Editor.tsx'),
    node('symbol:editor-view', 'function', 'src/features/editor/Editor.tsx:2', 'Editor'),
    node('ui:editor-view', 'ui-element', 'src/features/editor/Editor.tsx:4', 'Editor', 'representation'),
    {
      id: 'doc:editor',
      sourceId: 'repo:docs/architecture.md',
      kind: 'document-statement',
      locator: 'docs/architecture.md:20',
      value: 'src/features/editor owns the interactive editor workspace.',
      raw: 'src/features/editor owns the interactive editor workspace.',
      layer: 'structural',
      checkpoint: false,
    },
  );
  fixture.edges.push(
    edge('editor-file-declares', 'file:editor-view', 'symbol:editor-view', 'contains'),
    edge('editor-view-contains-ui', 'symbol:editor-view', 'ui:editor-view', 'contains'),
  );

  const result = bootstrapSemanticCandidates(fixture, { limit: 20 });
  const editor = result.candidates.find(candidate => candidate.scope === 'src/features/editor');
  assert.ok(editor);
  assert.ok(editor.provenance.evidenceFamilies.includes('documentation'));
  assert.ok(editor.provenance.nodeIds.includes('doc:editor'));
  assert.equal(editor.authority.accepted, false);
  assert.equal(editor.authority.persisted, false);
  assert.equal(editor.authority.requiresExplicitReview, true);

  const docsOnly = structuredClone(fixture);
  docsOnly.nodes = docsOnly.nodes.filter(item => item.id === 'doc:editor');
  docsOnly.edges = [];
  const docsOnlyResult = bootstrapSemanticCandidates(docsOnly, { limit: 20 });
  assert.equal(docsOnlyResult.candidates.length, 0, 'documentation alone must not manufacture semantic ownership');
});
