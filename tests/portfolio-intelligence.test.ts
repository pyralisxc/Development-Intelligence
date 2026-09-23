import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphNode, IntelligenceGraph } from '../src/types.js';
import { synthesizePortfolio, tracePortfolioGraphs } from '../src/intelligence/portfolio.js';

const source = (path: string) => ({ id: `repo:${path}`, kind: 'repository-file', locator: path, revision: 'abc', observedAt: new Date(0).toISOString(), available: true });
const node = (id: string, sourceId: string, kind: string, locator: string, field: string | undefined, value: unknown, layer: NonNullable<GraphNode['layer']> = 'structural'): GraphNode => ({
  id, sourceId, kind, locator, ...(field ? { field } : {}), name: typeof value === 'string' ? value : id, value, raw: JSON.stringify(value), layer, checkpoint: layer === 'semantic', evidenceIds: [],
});
function graph(project: string, revision: string, nodes: GraphNode[]): IntelligenceGraph {
  return {
    schemaVersion: 2, analyzerVersion: 'fixture', graphId: `repo-${revision}-fixture0000`, project, role: 'W',
    createdAt: new Date(0).toISOString(), repositoryRevision: revision, sourceFingerprint: revision, topologyFingerprint: revision,
    evidenceFingerprint: revision, sources: [...new Map(nodes.map(item => [item.sourceId, source(item.sourceId.replace(/^repo:/u, ''))] as const)).values()],
    evidence: [], nodes, edges: [], namingDivergences: [], explicitValueConflicts: [], unmatchedNodeIds: [], unavailableSourceIds: [],
    coverage: { trackedFiles: 1, eligibleFiles: 1, analyzedFiles: 1, completeFiles: 1, partialFiles: 0, unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0, skippedOversizedFiles: 0, skippedNonRegularFiles: 0, skippedFileLimitFiles: 0, files: [{ path: 'package.json', status: 'complete' }] },
  };
}

test('portfolio composition preserves repository authority and derives bounded cross-repository evidence', () => {
  const a = graph('Repo-A', 'a'.repeat(40), [
    node('same-local-id', 'repo:package.json', 'structured-value', 'package.json:name', 'name', '@fixture/a'),
    node('dep-b', 'repo:package.json', 'structured-value', 'package.json:dependencies.@fixture/b', 'dependencies.@fixture/b', '^1.0.0'),
    node('shared-react-a', 'repo:package.json', 'structured-value', 'package.json:dependencies.react', 'dependencies.react', '^19.0.0'),
    node('api:/api/status', 'repo:src/app/api/status/route.ts', 'api', 'src/app/api/status/route.ts', undefined, '/api/status', 'semantic'),
  ]);
  const b = graph('Repo-B', 'b'.repeat(40), [
    node('same-local-id', 'repo:package.json', 'structured-value', 'package.json:name', 'name', '@fixture/b'),
    node('shared-react-b', 'repo:package.json', 'structured-value', 'package.json:dependencies.react', 'dependencies.react', '^19.0.0'),
    node('http-status', 'repo:src/client.ts', 'http-call', 'src/client.ts:10:fetch', 'http', { method: 'GET', url: '/api/status', dynamic: false }, 'representation'),
  ]);

  const result = synthesizePortfolio([
    { key: 'a', project: 'Repo-A', graph: a },
    { key: 'b', project: 'Repo-B', graph: b },
  ], [{ key: 'missing', project: 'Repo-Missing', ref: 'main', error: 'not found' }], 20) as any;

  assert.equal(result.participants.length, 2);
  assert.equal(result.unavailableParticipants.length, 1);
  assert.equal(result.policy.persisted, false);
  assert.equal(result.policy.participantAuthorityPreserved, true);
  assert.ok(result.crossRepositoryLinks.some((item: any) => item.kind === 'depends-on-package' && item.status === 'resolved' && item.identifier === '@fixture/b'));
  assert.ok(result.crossRepositoryLinks.some((item: any) => item.kind === 'references-api' && item.status === 'resolved' && item.identifier === '/api/status'));
  assert.ok(result.sharedDependencies.some((item: any) => item.identifier === 'react' && item.participants.length === 2));
  assert.ok(result.blastRadius.some((item: any) => item.consumerParticipants.includes('a') || item.consumerParticipants.includes('b')));
  const packageLink = result.crossRepositoryLinks.find((item: any) => item.kind === 'depends-on-package');
  assert.match(packageLink.from.nodeId, /^a::/u);
  assert.match(packageLink.to.nodeId, /^b::/u);
  assert.notEqual(packageLink.from.nodeId, packageLink.to.nodeId);
  assert.ok(result.audit.investigationTargets.some((item: any) => item.kind === 'shared-dependency'));
  assert.ok(result.audit.investigationTargets.some((item: any) => item.kind === 'unavailable-participant'));
  assert.equal(result.truncated, false);

  const trace = tracePortfolioGraphs([
    { key: 'a', project: 'Repo-A', graph: a },
    { key: 'b', project: 'Repo-B', graph: b },
  ], [], { start: 'b::http-status', direction: 'outbound', depth: 1, statuses: ['resolved'], limit: 20 }) as any;
  assert.ok(trace.nodes.some((item: any) => item.nodeId === 'a::api:/api/status'));
  assert.ok(trace.hops.some((item: any) => item.scope === 'cross-repository' && item.kind === 'references-api'));
  assert.ok(trace.crossRepositoryHopCount >= 1);
  const crossHop = trace.hops.find((item: any) => item.scope === 'cross-repository');
  assert.equal(crossHop.provenance.from.participant, 'b');
  assert.equal(crossHop.provenance.to.participant, 'a');
});
