import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphNode, IntelligenceGraph } from '../src/types.js';
import { analyzeByTechnology } from '../src/intelligence/analyzers/index.js';
import {
  projectSourceConditionEffects, querySourceConditionEffects, sourceConditionsAnswer,
} from '../src/intelligence/sourceConditionEffects.js';
import { inspectRelationshipShape, relationshipKindContract } from '../src/intelligence/graphKnowledge.js';

function specimen(source: string, path = 'src/middleware.ts'): {
  owner: GraphNode; graph: IntelligenceGraph;
} {
  const analyzed = analyzeByTechnology({
    source: { id: 'repo:' + path, kind: 'repository-file', locator: path,
      revision: 'a'.repeat(40), observedAt: '2026-11-14T00:00:00Z', available: true },
    text: source, locatorBase: path,
  });
  const owner = analyzed.observations.find(node => node.name === 'middleware' && node.kind === 'function');
  assert.ok(owner);
  const graph: IntelligenceGraph = {
    schemaVersion: 2, analyzerVersion: '2.24.0-canonical-source-control-facts',
    project: 'fixture', graphId: 'repo-' + 'a'.repeat(40) + '-test',
    role: 'W', createdAt: '2026-11-14T00:00:00Z',
    repositoryRevision: 'a'.repeat(40), sourceFingerprint: 'source',
    topologyFingerprint: 'topology', evidenceFingerprint: 'evidence',
    sources: [], evidence: analyzed.evidence ?? [], nodes: analyzed.observations,
    edges: analyzed.resolutions, unmatchedNodeIds: [],
    namingDivergences: [], explicitValueConflicts: [], unavailableSourceIds: [],
    coverage: { trackedFiles: 1, eligibleFiles: 1, analyzedFiles: 1,
      completeFiles: 1, partialFiles: 0, failedFiles: 0, skippedFiles: 0,
      unsupportedFiles: 0, skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0, skippedFileLimitFiles: 0,
      files: [{ path, status: 'complete' }],
    },
  };
  return { owner, graph };
}
const path = 'src/middleware.ts';
const source = [
  'export function middleware(mode: string) {',
  "  if (mode === 'disabled') return false;",
  '  const value = requestAdapter();',
  '  if (!value) {',
  "    throw new Error('failed');",
  '  }',
  '  perform();',
  '  return true;',
  '}',
].join('\n');

test('graph-built controls match the exact shared AST interpreter without source rereads', async () => {
  const { owner, graph } = specimen(source);
  const old = projectSourceConditionEffects({
    graph, symbol: owner, sourcePath: path, source,
  }) as any;
  assert.equal(old.status, 'supported');
  const fromGraph = await querySourceConditionEffects({
    graph, project: 'fixture', question: 'What does middleware do?',
  }) as any;
  assert.equal(fromGraph.mode, 'canonical-source-condition-effects');
  assert.equal(fromGraph.status, 'supported');
  assert.equal(fromGraph.identity.graphId, graph.graphId);
  assert.equal(fromGraph.identity.functionId, owner.id);
  assert.equal(fromGraph.identity.sourceSha256, old.identity.sourceSha256);
  assert.deepEqual(fromGraph.branches, old.branches);
  assert.deepEqual(fromGraph.effects, old.effects);
  assert.deepEqual(fromGraph.coverage, old.coverage);
  assert.equal(fromGraph.proof.actualSourceSyntaxLocated, true);
  assert.equal(fromGraph.proof.returnOrCallRuntimeObserved, false);
  assert.equal(fromGraph.proof.allPossibleExecutionPathsProven, false);
  assert.match(sourceConditionsAnswer(fromGraph), /not whether the conditions are true/i);
  assert.equal(graph.nodes.filter(node => node.kind === 'source-control-summary').length, 1);

  const ids = new Map(graph.nodes.map(node => [node.id, node]));
  const conditions = graph.nodes.filter(node => node.kind === 'source-condition');
  const effects = graph.nodes.filter(node => node.kind === 'source-effect');
  assert.equal(conditions.length, old.branches.length);
  assert.equal(effects.length, old.effects.length);
  for (const edge of graph.edges.filter(edge => ['has-condition', 'has-effect', 'requires-condition'].includes(edge.kind))) {
    assert.equal(inspectRelationshipShape(edge, ids).status, 'valid');
    assert.equal(relationshipKindContract(edge.kind).realizationEligible, false);
    assert.ok(edge.evidenceIds?.length, 'source occurrence has independent proof');
  }
  assert.ok(graph.edges.some(edge => edge.kind === 'requires-condition' && edge.strategy === 'source-condition-false'));
  assert.ok(graph.edges.some(edge => edge.kind === 'requires-condition' && edge.strategy === 'source-condition-true'));
  assert.ok(graph.evidence.some(proof => proof.kind === 'source-condition-syntax'));
  assert.ok(graph.evidence.some(proof => proof.kind === 'source-effect-syntax'));
});

test('unknown constructs remain unknown even when known source facts were compiled', async () => {
  const source = [
    'export function middleware(mode: string) {',
    "  if (mode === 'disabled') return false;",
    '  while (mode) perform();',
    '  return true;',
    '}',
  ].join('\n');
  const { graph } = specimen(source);
  const result = await querySourceConditionEffects({
    graph, project: 'fixture', question: 'What does middleware do?',
  }) as any;
  assert.equal(result.mode, 'canonical-source-condition-effects');
  assert.equal(result.coverage.completeForSupportedStatements, false);
  assert.ok(result.coverage.unknownConstructs.some((x: any) => x.kind === 'WhileStatement'));
  assert.equal(result.proof.allPossibleExecutionPathsProven, false);
});

test('nested callbacks have separate source-control ownership, never parent execution proof', async () => {
  const source = [
    'export function middleware() {',
    '  accept({ run: () => { if (ready) return 1; return 2; } });',
    '  return 3;',
    '}',
  ].join('\n');
  const { graph, owner } = specimen(source);
  const owned = graph.edges.filter(edge => edge.from === owner.id && edge.kind === 'has-condition');
  assert.equal(owned.length, 0);
  const effectEdges = graph.edges.filter(edge => edge.from === owner.id && edge.kind === 'has-effect');
  assert.equal(effectEdges.length, 2, 'enclosing function has its own call expression and return, not callback internal returns');
  const callbackNodes = graph.nodes.filter(node => node.kind === 'source-control-summary'
    && (node.value as {functionId:string}).functionId !== owner.id);
  assert.equal(callbackNodes.length, 1);
  assert.ok(graph.edges.some(edge => edge.kind === 'has-condition' && edge.from ===
    (callbackNodes[0]!.value as {functionId:string}).functionId));
});

test('malformed TypeScript cannot become a source-proven graph fact', () => {
  const { graph } = specimen('export function middleware() { if ('); // recovered parse only
  assert.equal(graph.nodes.filter(node => node.kind === 'source-control-summary').length, 0);
  assert.equal(graph.edges.filter(edge => edge.kind === 'has-effect').length, 0);
});


test('a two-hop question composes built source premises without reopening Git', async () => {
  const source = [
    'export function callee(mode: boolean) { if (mode) return true; return false; }',
    'export function middleware() { if (ready) return callee(true); return false; }',
  ].join('\n');
  const { graph } = specimen(source);
  const resolved = graph.edges.filter(edge => edge.kind === 'calls'
    && edge.status === 'resolved' && edge.from?.includes('function:middleware'));
  assert.ok(resolved.some(edge => edge.to?.includes('function:callee')),
    'the two-hop question must begin with a real resolved source-call relationship');
  const result = await querySourceConditionEffects({
    graph, project: 'fixture', question: 'What happens when middleware calls callee?',
  }) as any;
  assert.equal(result.mode, 'canonical-source-two-hop-conditions');
  assert.equal(result.timing.sourceReadMs, 0);
  assert.equal(result.timing.sourceLensMs, 0);
  assert.equal(result.timing.sourceCheckoutRequired, false);
  assert.equal(result.proof.runtimeExecutionObserved, false);
  assert.equal(result.proof.jointPredicateSatisfiabilityProven, false);
  assert.equal(result.proof.canonicalGraphUnaffected, true);
});
