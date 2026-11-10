import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCapturedExecutionFacts } from '../src/intelligence/capturedFactGraph.js';
import type { IntelligenceGraph, GraphNode } from '../src/types.js';
import type { CapturedSystemIdentity } from '../src/intelligence/capturedSystemComparison.js';
import type { GraphBoundExecutionFact } from '../src/intelligence/capturedFactGraph.js';
const sha='a'.repeat(40),tree='b'.repeat(40);
const declaration:GraphNode={
  id:'symbol:src/middleware.ts#function:middleware',sourceId:'repo:src/middleware.ts',
  kind:'function',locator:'src/middleware.ts:1',name:'middleware',
  value:'middleware',raw:'middleware',layer:'structural',
};
const graph={
  project:'test-project',repositoryRevision:sha,graphId:'repo-'+sha,
  analyzerVersion:'native-1',nodes:[declaration],edges:[],
  coverage:{files:[{path:'src/middleware.ts',status:'complete'}]},
} as unknown as IntelligenceGraph;
const capture:CapturedSystemIdentity={
  project:graph.project,revision:sha,treeSha:tree,
  graphId:graph.graphId,analyzerVersion:graph.analyzerVersion,
};
const fact:GraphBoundExecutionFact={
  id:'selected-oauth-handler',declarationId:declaration.id,
  revision:sha,graphId:graph.graphId,
  executionContextSha256:'c'.repeat(64),evidence:['src/middleware.ts:4'],
  proof:'established-conditional',dependenciesComplete:true,
  effect:'occurs',mockedDependencies:[],
};
test('qualified source-derived fact projects a resolved ephemeral DI graph relation',()=>{
  const result=projectCapturedExecutionFacts({graph,capture,facts:[fact]});
  assert.equal(result.counts.resolved,1);
  assert.equal(result.edges[0]?.status,'resolved');
  assert.equal(result.nodes[0]?.kind,'derived-execution-fact');
  assert.equal(result.policy.noCanonicalMutation,true);
  assert.equal(graph.nodes.length,1);
});
test('unknown source binding, incomplete evidence, and unverified SQL stay candidates',()=>{
  for(const value of [
    {...fact,proof:'possible' as const},
    {...fact,dependenciesComplete:false},
    {...fact,requiresDatabase:true},
    {...fact,declarationId:'symbol:missing'},
  ]){
    const result=projectCapturedExecutionFacts({graph,capture,facts:[value]});
    assert.equal(result.counts.resolved,0);
    assert.equal(result.counts.candidate,1);
  }
});
test('exact source revision/graph mismatch is refused',()=>{
  assert.throws(()=>projectCapturedExecutionFacts({graph,capture:{...capture,revision:'d'.repeat(40)},facts:[fact]}));
  assert.throws(()=>projectCapturedExecutionFacts({graph,capture,facts:[{...fact,graphId:'wrong'}]}));
});
test('presentation cap reports omitted population',()=>{
  const items=[fact,{...fact,id:'second'}];
  const result=projectCapturedExecutionFacts({graph,capture,facts:items,maxFacts:1});
  assert.equal(result.counts.total,2);
  assert.equal(result.counts.omitted,1);
});
