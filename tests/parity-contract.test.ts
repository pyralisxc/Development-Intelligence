import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateParityContractGraph, normalizeParityContract } from '../src/intelligence/parityContract.js';
import type { IntelligenceGraph } from '../src/types.js';

function graph(complete = true): IntelligenceGraph {
  return {
    schemaVersion: 2,
    analyzerVersion: 'test',
    graphId: 'working-test',
    project: 'example/project',
    role: 'W',
    createdAt: '2026-09-17T00:00:00.000Z',
    repositoryRevision: 'abc123',
    sourceFingerprint: 'source',
    topologyFingerprint: 'topology',
    evidenceFingerprint: 'evidence',
    sources: [],
    evidence: [],
    nodes: [
      { id: 'capability:manage', sourceId: 'source', kind: 'capability', locator: 'capability:manage', name: 'Manage', value: {}, raw: '{}', layer: 'semantic' },
      { id: 'surface:workspace', sourceId: 'source', kind: 'surface', locator: 'surface:workspace', name: 'Workspace', value: {}, raw: '{}', layer: 'semantic' },
      { id: 'mcp:manage', sourceId: 'source', kind: 'mcp', locator: 'mcp:manage', name: 'manage', value: {}, raw: '{}', layer: 'semantic' },
    ],
    edges: [
      { id: 'resolved', from: 'capability:manage', to: 'surface:workspace', kind: 'exposed-on', strategy: 'declared', confidence: 1, status: 'resolved', evidence: [], layer: 'semantic' },
      { id: 'candidate', from: 'capability:manage', to: 'mcp:manage', kind: 'automated-by', strategy: 'heuristic', confidence: .7, status: 'candidate', evidence: [], layer: 'semantic' },
    ],
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
    coverage: {
      trackedFiles: 1,
      eligibleFiles: 1,
      analyzedFiles: complete ? 1 : 0,
      completeFiles: complete ? 1 : 0,
      partialFiles: complete ? 0 : 1,
      unsupportedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0,
      skippedFileLimitFiles: 0,
      files: [],
    },
  };
}

test('Parity Contracts evaluate required and forbidden observed reality without becoming graph state', () => {
  const result = evaluateParityContractGraph(graph(), {
    version: 1,
    name: 'Manage parity',
    entities: [
      { id: 'capability:manage', requirement: 'required' },
      { id: 'capability:missing', requirement: 'required' },
      { id: 'surface:workspace', requirement: 'forbidden' },
    ],
    relationships: [
      { from: 'capability:manage', kind: 'exposed-on', to: 'surface:workspace', requirement: 'required' },
      { from: 'capability:manage', kind: 'exposed-on', to: 'surface:workspace', requirement: 'forbidden' },
      { from: 'capability:manage', kind: 'automated-by', to: 'mcp:manage', requirement: 'required' },
    ],
  }) as any;
  assert.equal(result.passed, false);
  assert.deepEqual(result.counts, { satisfied: 2, missing: 1, forbiddenPresent: 2, unproven: 1 });
  assert.equal(graph().nodes.some(node => node.id.startsWith('expectation:')), false);
  assert.match(result.note, /does not modify/i);
});

test('Parity Contracts keep absent observations unproven when coverage is incomplete', () => {
  const result = evaluateParityContractGraph(graph(false), {
    version: 1,
    entities: [
      { id: 'capability:missing', requirement: 'required' },
      { id: 'capability:forbidden-but-unseen', requirement: 'forbidden' },
    ],
  }) as any;
  assert.deepEqual(result.counts, { satisfied: 0, missing: 0, forbiddenPresent: 0, unproven: 2 });
});

test('Parity Contracts reject empty expectation overlays', () => {
  assert.throws(() => normalizeParityContract({ version: 1 }), /at least one entity or relationship/i);
});
