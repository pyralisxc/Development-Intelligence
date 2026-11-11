import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntelligenceGraph, GraphNode } from '../src/types.js';
import {
  isConditionEffectQuestion, parseTwoHopSourceQuestion,
  projectTwoHopSourceQuestion, sourceConditionsAnswer,
} from '../src/intelligence/sourceConditionEffects.js';

const revision = 'a'.repeat(40);
const callerId = 'symbol:src/caller.ts#function:caller';
const calleeId = 'symbol:src/callee.ts#function:callee';
const callerSource = [
  'export function caller(req: { allowed: boolean; good: boolean }) {',
  '  if (req.allowed) return callee(req);',
  '  return false;',
  '}',
].join('\n');
const calleeSource = [
  'export function callee(req: { good: boolean }) {',
  '  if (req.good) return true;',
  '  return false;',
  '}',
].join('\n');
const nodes: GraphNode[] = [
  { id: callerId, sourceId: 'repo:src/caller.ts',
    kind: 'function', name: 'caller', locator: 'src/caller.ts:1',
    layer: 'structural', raw: 'caller', value: 'caller' },
  { id: calleeId, sourceId: 'repo:src/callee.ts',
    kind: 'function', name: 'callee', locator: 'src/callee.ts:1',
    layer: 'structural', raw: 'callee', value: 'callee' },
];
const graph: IntelligenceGraph = {
  project: 'fixture', graphId: 'repo-fixture-exact',
  repositoryRevision: revision, analyzerVersion: 'native-fixture-v1',
  nodes, edges: [{ id: 'resolved-call', from: callerId, to: calleeId,
    kind: 'calls', status: 'resolved', layer: 'structural',
    strategy: 'module-resolution', confidence: 1,
    evidence: ['src/caller.ts:2'] }],
  coverage: { files: [
    {path: 'src/caller.ts', status: 'complete'},
    {path: 'src/callee.ts', status: 'complete'},
  ] },
} as unknown as IntelligenceGraph;
const sources: Record<string,string> = {
  'src/caller.ts':callerSource,'src/callee.ts':calleeSource,
};
const ask = (question: string, g = graph) =>
  projectTwoHopSourceQuestion({ graph:g, project:'fixture', question,
    readSource: async p => sources[p] ?? null });

test('ordinary explicit pair grammar does not hijack unrelated questions', () => {
  assert.deepEqual(parseTwoHopSourceQuestion('What happens when caller calls callee?'),
    { caller:'caller',callee:'callee' });
  assert.deepEqual(parseTwoHopSourceQuestion('What conditions and effects propagate from caller to callee?'),
    { caller:'caller',callee:'callee' });
  assert.equal(isConditionEffectQuestion('How does caller call callee?'), true);
  assert.deepEqual(parseTwoHopSourceQuestion('Under what conditions does caller call callee?'),
    { caller:'caller',callee:'callee' });
  assert.equal(parseTwoHopSourceQuestion('When does caller invoke callee?'),null);
  assert.equal(isConditionEffectQuestion('When does caller invoke callee?'),true);
  assert.deepEqual(parseTwoHopSourceQuestion('Which conditions govern caller calling callee?'),
    { caller:'caller',callee:'callee' });
  assert.equal(parseTwoHopSourceQuestion('Under what conditions does caller call a function?'),null);
  assert.equal(parseTwoHopSourceQuestion('Under what conditions does caller call caller?'),null);
  assert.equal(isConditionEffectQuestion('Which tests cover callee?'), false);
  assert.equal(parseTwoHopSourceQuestion('What happens when the MSI rollback fails?'),null);
});

test('existing graph: ordinary two-hop question establishes both conditional source returns', async () => {
  const result = await ask('What happens when caller calls callee?') as any;
  assert.equal(result.status,'supported',JSON.stringify(result));
  assert.equal(result.mode,'two-hop-conditional-source');
  assert.equal(result.counts.candidatePairCount,2);
  assert.equal(result.counts.qualified,2);
  assert.equal(result.counts.omitted,0);
  assert.equal(result.proof.argumentMappingProven,false);
  assert.equal(result.proof.jointPredicateSatisfiabilityProven,false);
  assert.equal(result.runtimeObserved,false);
  assert.equal(result.paths[0].requiredConditions.length,2);
  assert.ok(result.paths.some((p:any)=>p.expression==='true'));
  assert.ok(result.paths.some((p:any)=>p.expression==='false'));
  assert.match(sourceConditionsAnswer(result),/joint path feasibility/i);
  assert.equal(result.timing.graphBuildIncluded,false);
  assert.equal(graph.nodes.length,2);
});

test('missing exact call, candidate edge, wrong scope or partial coverage never become proof', async () => {
  const noCall={...graph,edges:[]} as IntelligenceGraph;
  assert.equal((await ask('What happens when caller calls callee?',noCall))?.status,'unproven');
  const candidate={...graph,edges:[{...graph.edges[0],status:'candidate'}]} as IntelligenceGraph;
  assert.equal((await ask('What happens when caller calls callee?',candidate))?.status,'unproven');
  const partial={...graph,coverage:{files:[
    {path:'src/caller.ts',status:'complete'},
    {path:'src/callee.ts',status:'partial'},
  ]}} as IntelligenceGraph;
  assert.equal((await ask('What happens when caller calls callee?',partial))?.status,'unproven');
  const scoped=await projectTwoHopSourceQuestion({
    graph,project:'fixture',question:'What happens when caller calls callee?',
    scope:'src/other.ts',readSource:async p=>sources[p] ?? null,
  });
  assert.equal(scoped?.status,'unproven');
});

test('cross-file direct return-call in callee is presented as selection, never observed external result', async () => {
  const g: IntelligenceGraph = {
    ...graph,
    nodes: [
      {...nodes[0]!,name:'proxy',id:'symbol:src/caller.ts#function:proxy'},
      {...nodes[1]!,name:'middleware',id:'symbol:src/callee.ts#function:middleware'},
    ],
    edges:[{...graph.edges[0]!,from:'symbol:src/caller.ts#function:proxy',
      to:'symbol:src/callee.ts#function:middleware'}],
  };
  const nextSources:Record<string,string>={
    'src/caller.ts':'export function proxy(req:unknown) {\n  return middleware(req);\n}',
    'src/callee.ts':[
      'export function middleware(req:unknown) {',
      '  if (process.env.CLK_KEY) return oauthHandler(req);',
      '  return browserHandler(req);',
      '}',
    ].join('\n'),
  };
  const r=await projectTwoHopSourceQuestion({
    graph:g,project:'fixture',question:'What happens when proxy calls middleware?',
    readSource:async p=>nextSources[p] ?? null,
  }) as any;
  assert.equal(r.status,'supported',JSON.stringify(r));
  assert.equal(r.counts.qualified,2);
  assert.ok(r.paths.every((p:any)=>p.kind==='return-call'));
  assert.ok(r.paths.some((p:any)=>p.expression==='oauthHandler(...)'));
  assert.equal(r.proof.runtimeExecutionObserved,false);
});

test('ordinary caller/callee condition wording uses the exact existing-graph proof', async () => {
  const q='Under what conditions does caller call callee?';
  const result=await ask(q) as any;
  assert.equal(result.status,'supported',JSON.stringify(result));
  assert.equal(result.mode,'two-hop-conditional-source');
  assert.equal(result.counts.qualified,2);
  assert.equal(result.timing.graphBuildIncluded,false);
  assert.equal(result.proof.runtimeExecutionObserved,false);
});

test('same-line wrong callee expression does not become a conditional path', async () => {
  const wrong:Record<string,string>={...sources,'src/caller.ts':callerSource.replace('callee(req)','unrelated(req)')};
  const result=await projectTwoHopSourceQuestion({
    graph,project:'fixture',question:'What happens when caller calls callee?',
    readSource:async p=>wrong[p] ?? null,
  }) as any;
  assert.equal(result.status,'unproven');
  assert.equal(result.counts.qualified,0);
});
