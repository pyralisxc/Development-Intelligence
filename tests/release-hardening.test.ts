import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedRequestHosts } from '../src/auth.js';
import { assertGraphIntegrity } from '../src/intelligence/integrity.js';
import { diffGraphs } from '../src/intelligence/query.js';
import { oauthPublicBaseUrl } from '../src/oauth.js';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';

const source = {
  id: 'repo:src/example.ts',
  kind: 'repository-file',
  locator: 'src/example.ts',
  revision: 'fixture',
  observedAt: new Date(0).toISOString(),
  available: true,
} as const;

function node(input: Partial<GraphNode> & Pick<GraphNode, 'id' | 'kind' | 'layer'>): GraphNode {
  return {
    sourceId: source.id,
    locator: 'src/example.ts:1',
    value: input.id,
    raw: input.id,
    ...input,
  };
}

function edge(input: Partial<GraphEdge> & Pick<GraphEdge, 'id' | 'from' | 'to' | 'kind' | 'layer'>): GraphEdge {
  return {
    strategy: 'fixture',
    confidence: 1,
    status: 'resolved',
    evidence: ['src/example.ts:1'],
    ...input,
  };
}

function graph(revision: string, nodes: GraphNode[], edges: GraphEdge[] = [], evidence: IntelligenceGraph['evidence'] = []): IntelligenceGraph {
  return {
    schemaVersion: 2,
    analyzerVersion: 'fixture',
    graphId: `fixture-${revision}`,
    project: 'Fixture',
    role: 'W',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: revision,
    sourceFingerprint: revision,
    topologyFingerprint: revision,
    evidenceFingerprint: revision,
    sources: [source],
    evidence,
    nodes,
    edges,
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
  };
}

test('semantic parity stays stable across structural churn while the full graph still reports it', () => {
  const semantic = node({ id: 'feature:desk', kind: 'feature', layer: 'semantic', checkpoint: true, name: 'desk' });
  const before = graph('before', [
    semantic,
    node({ id: 'file:src/old.ts', kind: 'file', layer: 'structural', locator: 'src/old.ts' }),
    node({ id: 'symbol:src/old.ts#openDesk', kind: 'function', layer: 'structural', name: 'openDesk', locator: 'src/old.ts:5' }),
  ]);
  const after = graph('after', [
    semantic,
    node({ id: 'file:src/new.ts', kind: 'file', layer: 'structural', locator: 'src/new.ts' }),
    node({ id: 'symbol:src/new.ts#openDesk', kind: 'function', layer: 'structural', name: 'openDesk', locator: 'src/new.ts:42' }),
  ]);

  const parity = diffGraphs(before, after, ['semantic']) as any;
  assert.deepEqual(parity.nodes, { added: [], removed: [], changed: [] });
  assert.deepEqual(parity.edges, { added: [], removed: [], changed: [] });

  const full = diffGraphs(before, after) as any;
  assert.equal(full.nodes.added.length, 2);
  assert.equal(full.nodes.removed.length, 2);
});

test('semantic parity reports semantic change without being polluted by structural churn', () => {
  const feature = node({ id: 'feature:desk', kind: 'feature', layer: 'semantic', checkpoint: true, name: 'desk' });
  const action = node({ id: 'action:desk.open-set', kind: 'action', layer: 'semantic', checkpoint: true, name: 'Open Set' });
  const opens = edge({ id: 'edge:open-set-owner', from: action.id, to: feature.id, kind: 'owned-by', layer: 'semantic', checkpoint: true });
  const before = graph('before', [feature, node({ id: 'file:src/old.ts', kind: 'file', layer: 'structural', locator: 'src/old.ts' })]);
  const after = graph('after', [feature, action, node({ id: 'file:src/new.ts', kind: 'file', layer: 'structural', locator: 'src/new.ts' })], [opens]);

  const parity = diffGraphs(before, after, ['semantic']) as any;
  assert.deepEqual(parity.nodes.added.map((item: GraphNode) => item.id), ['action:desk.open-set']);
  assert.deepEqual(parity.nodes.removed, []);
  assert.deepEqual(parity.edges.added.map((item: GraphEdge) => item.id), ['edge:open-set-owner']);
});

test('graph integrity rejects missing endpoints and evidence references', () => {
  const proof = { id: 'evidence:one', sourceId: source.id, kind: 'fixture', locator: 'src/example.ts:1' };
  const validNode = node({ id: 'feature:desk', kind: 'feature', layer: 'semantic', checkpoint: true, evidenceIds: [proof.id] });
  const valid = graph('valid', [validNode], [], [proof]);
  assert.doesNotThrow(() => assertGraphIntegrity(valid));

  const missingEvidence = graph('missing-evidence', [{ ...validNode, evidenceIds: ['evidence:missing'] }]);
  assert.throws(() => assertGraphIntegrity(missingEvidence), /missing evidence/);

  const missingEndpoint = graph('missing-endpoint', [validNode], [edge({ id: 'edge:bad', from: validNode.id, to: 'feature:missing', kind: 'depends-on', layer: 'semantic' })], [proof]);
  assert.throws(() => assertGraphIntegrity(missingEndpoint), /missing to-node/);
});

test('Vercel runtime hostnames extend the exact allowlist without a wildcard', () => {
  assert.deepEqual(allowedRequestHosts({
    DEVINT_ALLOWED_HOSTS: 'mcp.cardforges.com',
    VERCEL: '1',
    VERCEL_URL: 'development-intelligence-a1b2.vercel.app',
    VERCEL_BRANCH_URL: 'development-intelligence-git-feature-owner.vercel.app',
    VERCEL_PROJECT_PRODUCTION_URL: 'development-intelligence.vercel.app',
  }), [
    'mcp.cardforges.com',
    'development-intelligence-a1b2.vercel.app',
    'development-intelligence-git-feature-owner.vercel.app',
    'development-intelligence.vercel.app',
  ]);

  assert.deepEqual(allowedRequestHosts({
    DEVINT_ALLOWED_HOSTS: 'mcp.cardforges.com',
    VERCEL_URL: 'untrusted-preview.vercel.app',
  }), ['mcp.cardforges.com']);

  assert.deepEqual(allowedRequestHosts({
    VERCEL: '1',
    VERCEL_URL: 'https://not-a-host.example/path',
  }), []);
});

test('Vercel previews publish their exact branch origin without changing production identity', () => {
  assert.equal(oauthPublicBaseUrl({
    DEVINT_PUBLIC_BASE_URL: 'https://devint.cardforges.com',
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    VERCEL_BRANCH_URL: 'development-intelligence-git-feature-owner.vercel.app',
    VERCEL_URL: 'development-intelligence-a1b2.vercel.app',
  }), 'https://development-intelligence-git-feature-owner.vercel.app');

  assert.equal(oauthPublicBaseUrl({
    DEVINT_PUBLIC_BASE_URL: 'https://devint.cardforges.com',
    VERCEL: '1',
    VERCEL_ENV: 'production',
    VERCEL_BRANCH_URL: 'development-intelligence-git-main-owner.vercel.app',
  }), 'https://devint.cardforges.com');
});
