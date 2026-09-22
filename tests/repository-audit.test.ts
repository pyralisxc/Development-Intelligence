import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../src/types.js';
import { synthesizeRepositoryAudit } from '../src/intelligence/repositoryAudit.js';

const source = { id: 'repository', kind: 'repository', locator: 'fixture', revision: 'abc', observedAt: new Date(0).toISOString(), available: true };
const node = (id: string, kind: string, layer: NonNullable<GraphNode['layer']>, locator: string): GraphNode => ({
  id, sourceId: source.id, kind, layer, locator, name: id, value: id, raw: id, checkpoint: layer === 'semantic', evidenceIds: [],
});
const edge = (id: string, from: string, to: string | null, kind: string, status: GraphEdge['status']): GraphEdge => ({
  id, from, to, kind, status, strategy: 'fixture', confidence: status === 'resolved' ? 1 : null,
  evidence: [`fixture:${id}`], layer: 'structural', checkpoint: false, evidenceIds: [`evidence:${id}`],
});

test('repository audit stays bounded, evidence-linked, and non-authoritative', () => {
  const capability = node('capability:checkout', 'capability', 'semantic', 'src/checkout.ts:1');
  const caller = node('function:caller', 'function', 'structural', 'src/caller.ts:2');
  const target = node('function:target', 'function', 'structural', 'src/target.ts:3');
  const graph: IntelligenceGraph = {
    schemaVersion: 2,
    analyzerVersion: 'fixture',
    graphId: 'repo-abc-fixture',
    project: 'Fixture',
    role: 'W',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: 'abc',
    sourceFingerprint: 'source',
    topologyFingerprint: 'topology',
    evidenceFingerprint: 'evidence',
    sources: [source],
    evidence: [
      { id: 'evidence:candidate', sourceId: source.id, kind: 'fixture', locator: 'src/caller.ts:2' },
      { id: 'evidence:unresolved', sourceId: source.id, kind: 'fixture', locator: 'src/caller.ts:2' },
    ],
    nodes: [capability, caller, target],
    edges: [
      edge('candidate', caller.id, target.id, 'calls', 'candidate'),
      edge('unresolved', caller.id, null, 'uses-script', 'unresolved'),
    ],
    namingDivergences: [],
    explicitValueConflicts: [{ entityId: capability.id, leftSourceId: 'left', rightSourceId: 'right', key: 'name', leftValue: 'A', rightValue: 'B' }],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
    coverage: {
      trackedFiles: 3, eligibleFiles: 3, analyzedFiles: 2, completeFiles: 1, partialFiles: 1, unsupportedFiles: 1,
      skippedFiles: 0, failedFiles: 0, skippedOversizedFiles: 0, skippedNonRegularFiles: 0, skippedFileLimitFiles: 0,
      files: [
        { path: 'src/caller.ts', status: 'complete' },
        { path: 'src/target.ts', status: 'partial', reason: 'parser recovered' },
        { path: 'image.png', status: 'unsupported', reason: 'unsupported extension .png' },
      ],
    },
  };

  const audit = synthesizeRepositoryAudit(graph, {
    acceptedPresent: true,
    currentness: {
      acceptedSemanticCurrent: false, sourceCurrent: false, topologyCurrent: true, evidenceCurrent: true,
      analyzerCurrent: true, schemaSupported: true, integrityCurrent: true, checkpointError: null,
    },
    limit: 10,
  }) as any;

  assert.equal(audit.graphId, graph.graphId);
  assert.equal(audit.revision, 'abc');
  assert.equal(audit.coverage.files, undefined);
  assert.ok(audit.coverageBlockers.some((item: any) => item.status === 'partial' && item.count === 1));
  assert.ok(audit.relationshipConcentrations.some((item: any) => item.status === 'unresolved' && item.kind === 'uses-script' && item.count === 1));
  assert.ok(audit.relationshipConcentrations.some((item: any) => item.status === 'candidate' && item.kind === 'calls' && item.count === 1));
  assert.ok(audit.investigationTargets.some((item: any) => item.kind === 'currentness'));
  assert.ok(audit.investigationTargets.some((item: any) => item.kind === 'finding' && /explicit-conflict/.test(item.summary)));
  assert.equal(audit.policy.persisted, false);
  assert.equal(audit.policy.modifiesRepository, false);
  assert.equal(audit.policy.createsWorkItems, false);
  assert.ok(audit.investigationTargets.length <= 10);
});
