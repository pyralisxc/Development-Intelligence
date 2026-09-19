import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTypedReach, reachMechanism } from '../src/intelligence/reach.js';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';

const source = { id: 'repository', kind: 'repository', locator: 'fixture', revision: 'abc', observedAt: new Date(0).toISOString(), available: true };
const node = (id: string, kind: string, layer: NonNullable<GraphNode['layer']>): GraphNode => ({
  id, sourceId: source.id, kind, layer, name: id, locator: `src/${id}.ts:1`, value: id, raw: id, checkpoint: layer === 'semantic',
});
const edge = (id: string, from: string, to: string, kind: string, status: GraphEdge['status'] = 'resolved'): GraphEdge => ({
  id, from, to, kind, status, strategy: 'fixture', confidence: status === 'resolved' ? 1 : null, evidence: ['fixture'], layer: 'representation', checkpoint: false,
});

function graph(): IntelligenceGraph {
  return {
    schemaVersion: 2, analyzerVersion: 'fixture', graphId: 'fixture', project: 'Fixture', role: 'W', createdAt: new Date(0).toISOString(),
    repositoryRevision: 'abc', sourceFingerprint: 'source', topologyFingerprint: 'topology', evidenceFingerprint: 'evidence',
    sources: [source], evidence: [],
    nodes: [
      node('capability:checkout', 'capability', 'semantic'),
      node('surface:web', 'surface', 'semantic'),
      node('mcp:checkout', 'mcp', 'semantic'),
      node('api:/checkout', 'api', 'semantic'),
      node('function:checkout', 'function', 'structural'),
      node('sql-table:orders', 'sql-table', 'structural'),
      node('provider:stripe', 'provider', 'semantic'),
      node('feature:orders', 'feature', 'semantic'),
      node('function:helper', 'function', 'structural'),
    ],
    edges: [
      edge('e1', 'capability:checkout', 'surface:web', 'exposed-on'),
      edge('e2', 'capability:checkout', 'mcp:checkout', 'automated-by'),
      edge('e3', 'capability:checkout', 'api:/checkout', 'connected-to'),
      edge('e4', 'api:/checkout', 'function:checkout', 'implemented-by'),
      edge('e5', 'function:checkout', 'sql-table:orders', 'writes'),
      edge('e6', 'function:checkout', 'provider:stripe', 'integrates-with'),
      edge('e7', 'function:checkout', 'feature:orders', 'contains'),
      edge('e8', 'function:checkout', 'function:helper', 'calls'),
      edge('candidate', 'feature:orders', 'provider:stripe', 'same_observed_name', 'candidate'),
      edge('unresolved', 'surface:web', 'provider:stripe', 'integrates-with', 'unresolved'),
    ],
    namingDivergences: [], explicitValueConflicts: [], unmatchedNodeIds: [], unavailableSourceIds: [],
    coverage: { trackedFiles: 1, eligibleFiles: 1, analyzedFiles: 1, completeFiles: 1, partialFiles: 0, unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0, skippedOversizedFiles: 0, skippedNonRegularFiles: 0, skippedFileLimitFiles: 0, files: [] },
  };
}

test('typed reach reports dimensions and shortest resolved paths without a global blast score', () => {
  const fixture = graph();
  const root = fixture.nodes.find(item => item.id === 'capability:checkout')!;
  const reach = projectTypedReach(fixture, root, { depth: 4 });

  assert.equal(reach.dimensions.human.observed, true);
  assert.equal(reach.dimensions.agent.observed, true);
  assert.equal(reach.dimensions.transport.observed, true);
  assert.equal(reach.dimensions.implementation.observed, true);
  assert.equal(reach.dimensions.persistence.observed, true);
  assert.equal(reach.dimensions.provider.observed, true);
  assert.equal(reach.dimensions['cross-feature'].targetIds.includes('feature:orders'), true);
  assert.equal(reach.dimensions.persistence.paths[0].relationshipKinds.includes('writes'), true);
  assert.equal(reach.mechanisms.execution > 0, true);
  assert.equal(reach.mechanisms.persistence > 0, true);
  assert.equal(reach.mechanisms.provider > 0, true);
  assert.equal(reach.excludedRelationships.candidate, 1);
  assert.equal(reach.excludedRelationships.unresolved, 1);
  assert.equal('score' in reach, false);
  assert.match(reach.policy.interpretation, /does not score severity/i);
});

test('reach mechanism classification describes connection type rather than importance', () => {
  assert.equal(reachMechanism('contains'), 'composition-context');
  assert.equal(reachMechanism('imports'), 'dependency');
  assert.equal(reachMechanism('calls'), 'execution');
  assert.equal(reachMechanism('same_observed_name'), 'identity-resolution');
  assert.equal(reachMechanism('exposed-on'), 'surface');
  assert.equal(reachMechanism('writes'), 'persistence');
  assert.equal(reachMechanism('integrates-with'), 'provider');
});
