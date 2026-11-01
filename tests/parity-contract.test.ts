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
  assert.deepEqual(result.counts, { satisfied: 2, missing: 1, forbiddenPresent: 2, unproven: 1, notApplicable: 0 });
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
  assert.deepEqual(result.counts, { satisfied: 0, missing: 0, forbiddenPresent: 0, unproven: 2, notApplicable: 0 });
});

test('Parity Contracts keep negatives unproven when unsupported tracked sources could hide contrary evidence', () => {
  const fixture = graph();
  fixture.coverage = {
    ...fixture.coverage!,
    trackedFiles: 2,
    eligibleFiles: 1,
    analyzedFiles: 1,
    completeFiles: 1,
    unsupportedFiles: 1,
    files: [
      { path: 'src/manage.ts', status: 'complete' },
      { path: 'workflow.yml', status: 'unsupported', reason: 'unsupported extension .yml' },
    ],
  };
  const result = evaluateParityContractGraph(fixture, {
    version: 1,
    entities: [
      { id: 'capability:missing', requirement: 'required' },
      { id: 'capability:forbidden-but-unseen', requirement: 'forbidden' },
    ],
  }) as any;
  assert.deepEqual(result.counts, { satisfied: 0, missing: 0, forbiddenPresent: 0, unproven: 2, notApplicable: 0 });
  assert.equal(result.claimCoverage.supportsNegative, false);
  assert.deepEqual(result.claimCoverage.blockers.map((item: any) => item.path), ['workflow.yml']);
});

test('Parity Contracts reject empty expectation overlays', () => {
  assert.throws(() => normalizeParityContract({ version: 1 }), /at least one entity, relationship, or predicate/i);
});

function reachabilityGraph(complete = true): IntelligenceGraph {
  const fixture = graph(complete);
  fixture.nodes.push(
    { id: 'mcp:owner-a', sourceId: 'owner.ts', kind: 'mcp', locator: 'owner-a', name: 'owner-a', value: {}, raw: '{}', layer: 'semantic' },
    { id: 'mcp:owner-b', sourceId: 'owner.ts', kind: 'mcp', locator: 'owner-b', name: 'owner-b', value: {}, raw: '{}', layer: 'semantic' },
    { id: 'function:bridge', sourceId: 'bridge.ts', kind: 'function', locator: 'bridge', name: 'bridge', value: {}, raw: '{}', layer: 'structural' },
    { id: 'operation:studio-write', sourceId: 'studio.ts', kind: 'operation', locator: 'studio-write', name: 'studio-write', value: {}, raw: '{}', layer: 'semantic' },
  );
  fixture.edges.push(
    { id: 'owner-bridge', from: 'mcp:owner-a', to: 'function:bridge', kind: 'calls', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: ['owner.ts:1'], layer: 'structural' },
    { id: 'bridge-write', from: 'function:bridge', to: 'operation:studio-write', kind: 'invokes', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: ['bridge.ts:1'], layer: 'structural' },
  );
  return fixture;
}

const forbiddenOwnerWrite = {
  id: 'owner-must-not-write-studio',
  type: 'reachability',
  from: { ids: ['mcp:owner-a', 'mcp:owner-b'] },
  to: { ids: ['operation:studio-write'] },
  requirement: 'forbidden',
  quantifier: 'any',
  relationshipKinds: ['calls', 'invokes'],
  maxDepth: 4,
  originalClaim: 'Owner-exposed operations cannot invoke Studio writes.',
};

test('Reachability predicates fail a forbidden indirect path with concrete counterexample evidence', () => {
  const result = evaluateParityContractGraph(reachabilityGraph(), { version: 1, predicates: [forbiddenOwnerWrite] }) as any;
  assert.equal(result.passed, false);
  assert.equal(result.results[0].status, 'forbidden-present');
  assert.deepEqual(result.results[0].observed.counterexamples[0].nodeIds, ['mcp:owner-a', 'function:bridge', 'operation:studio-write']);
  assert.deepEqual(result.results[0].observed.counterexamples[0].edgeIds, ['owner-bridge', 'bridge-write']);
  assert.equal(result.results[0].replacementAssessment.eligible, false);
});

test('Reachability predicates prove a forbidden absence only with exhaustive coverage', () => {
  const fixture = reachabilityGraph();
  fixture.edges = fixture.edges.filter(edge => edge.id !== 'bridge-write');
  const result = evaluateParityContractGraph(fixture, { version: 1, predicates: [forbiddenOwnerWrite] }) as any;
  assert.equal(result.passed, true);
  assert.equal(result.results[0].status, 'satisfied');
  assert.equal(result.results[0].replacementAssessment.eligible, true);
  assert.match(result.results[0].replacementAssessment.note, /source-only assertion/i);
});

test('Reachability predicates keep absent forbidden paths unproven under incomplete coverage', () => {
  const fixture = reachabilityGraph(false);
  fixture.edges = fixture.edges.filter(edge => edge.id !== 'bridge-write');
  const result = evaluateParityContractGraph(fixture, { version: 1, predicates: [forbiddenOwnerWrite] }) as any;
  assert.equal(result.results[0].status, 'unproven');
  assert.equal(result.results[0].replacementAssessment.eligible, false);
  assert.ok(result.results[0].replacementAssessment.blockers.some((item: string) => /coverage/i.test(item)));
});

test('Reachability predicates surface mixed resolved and candidate paths as unproven', () => {
  const fixture = reachabilityGraph();
  fixture.edges = fixture.edges.map(edge => edge.id === 'bridge-write' ? { ...edge, status: 'candidate' as const } : edge);
  const result = evaluateParityContractGraph(fixture, { version: 1, predicates: [forbiddenOwnerWrite] }) as any;
  assert.equal(result.results[0].status, 'unproven');
  assert.deepEqual(result.results[0].observed.tentativePaths[0].statuses, ['resolved', 'candidate']);
});

test('Universal required reachability identifies subjects that do not satisfy the claim', () => {
  const result = evaluateParityContractGraph(reachabilityGraph(), {
    version: 1,
    predicates: [{ ...forbiddenOwnerWrite, id: 'all-owner-tools-write', requirement: 'required', quantifier: 'all' }],
  }) as any;
  assert.equal(result.results[0].status, 'missing');
  assert.deepEqual(result.results[0].observed.resolvedSubjectIds, ['mcp:owner-a']);
});

test('Reachability predicates refuse vacuous success when selectors match no nodes', () => {
  const result = evaluateParityContractGraph(reachabilityGraph(), {
    version: 1,
    predicates: [{ ...forbiddenOwnerWrite, from: { ids: ['mcp:missing'] } }],
  }) as any;
  assert.equal(result.passed, false);
  assert.equal(result.results[0].status, 'not-applicable');
  assert.equal(result.counts.notApplicable, 1);
});

test('Universal reachability refuses a partial exact subject set', () => {
  const result = evaluateParityContractGraph(reachabilityGraph(), {
    version: 1,
    predicates: [{
      ...forbiddenOwnerWrite,
      id: 'all-requested-owner-tools-write',
      from: { ids: ['mcp:owner-a', 'mcp:missing'] },
      requirement: 'required',
      quantifier: 'all',
    }],
  }) as any;
  assert.equal(result.results[0].status, 'missing');
  assert.ok(result.results[0].replacementAssessment.blockers.some((item: string) => item.includes('mcp:missing')));
});

test('Positive existential reachability can replace an equivalent source assertion without unrelated negative coverage', () => {
  const result = evaluateParityContractGraph(reachabilityGraph(false), {
    version: 1,
    predicates: [{ ...forbiddenOwnerWrite, id: 'some-owner-tool-writes', requirement: 'required' }],
  }) as any;
  assert.equal(result.results[0].status, 'satisfied');
  assert.equal(result.results[0].replacementAssessment.eligible, true);
});

test('Reachability predicate contracts reject unbounded or empty selectors', () => {
  assert.throws(() => normalizeParityContract({ version: 1, predicates: [{ ...forbiddenOwnerWrite, maxDepth: 21 }] }), /maxDepth/i);
  assert.throws(() => normalizeParityContract({ version: 1, predicates: [{ ...forbiddenOwnerWrite, from: {} }] }), /selector constraint/i);
});

test('Forbidden absence stays unproven when the bounded search truncates before a late counterexample', () => {
  const fixture = reachabilityGraph();
  fixture.edges = fixture.edges.filter(edge => edge.id !== 'owner-bridge' && edge.id !== 'bridge-write');
  for (let index = 0; index < 10_001; index += 1) {
    const id = `function:fanout-${index}`;
    fixture.nodes.push({ id, sourceId: 'bridge.ts', kind: 'function', locator: id, name: id, value: {}, raw: '{}', layer: 'structural' });
    fixture.edges.push({ id: `fanout-${index}`, from: 'mcp:owner-a', to: id, kind: 'calls', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: ['owner.ts:1'], layer: 'structural' });
    if (index === 10_000) fixture.edges.push({ id: 'late-write', from: id, to: 'operation:studio-write', kind: 'invokes', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: ['bridge.ts:1'], layer: 'structural' });
  }
  const result = evaluateParityContractGraph(fixture, { version: 1, predicates: [forbiddenOwnerWrite] }) as any;
  assert.equal(result.results[0].status, 'unproven');
  assert.equal(result.results[0].replacementAssessment.eligible, false);
  assert.equal(result.results[0].observed.traversal.truncated, true);
});

test('Reachable unresolved unknown destination prevents negative proof under complete source coverage', () => {
  const fixture = reachabilityGraph();
  fixture.edges = fixture.edges.filter(edge => edge.id !== 'owner-bridge' && edge.id !== 'bridge-write');
  fixture.edges.push({ id: 'unknown-write', from: 'mcp:owner-a', to: null, kind: 'calls', strategy: 'syntax', confidence: 0, status: 'unresolved', evidence: ['owner.ts:2'], layer: 'structural' });
  const result = evaluateParityContractGraph(fixture, { version: 1, predicates: [forbiddenOwnerWrite] }) as any;
  assert.equal(result.results[0].status, 'unproven');
  assert.equal(result.results[0].replacementAssessment.eligible, false);
  assert.equal(result.results[0].observed.traversal.unknownEndpoints, true);
});

test('Duplicate predicate IDs are rejected before transition result identity can collapse', () => {
  assert.throws(() => normalizeParityContract({
    version: 1,
    predicates: [
      { ...forbiddenOwnerWrite, id: 'same-identity', from: { ids: ['mcp:owner-a'] } },
      { ...forbiddenOwnerWrite, id: 'same-identity', from: { ids: ['mcp:owner-b'] } },
    ],
  }), /duplicate predicate IDs/i);
});

test('Reachability exposes missing subject registration bridges without treating connectivity as proof', () => {
  const fixture = reachabilityGraph();
  fixture.edges = fixture.edges.filter(edge => edge.from !== 'mcp:owner-a' && edge.from !== 'mcp:owner-b');
  const result = evaluateParityContractGraph(fixture, {
    version: 1,
    predicates: [forbiddenOwnerWrite],
  }) as any;
  assert.equal(result.results[0].status, 'satisfied');
  assert.deepEqual(result.results[0].observed.subjectConnectivity.map((item: any) => item.eligibleEdgeCount), [0, 0]);
  assert.ok(result.results[0].replacementAssessment.blockers.some((item: string) => /registration\/handler bridging/i.test(item)));
});
