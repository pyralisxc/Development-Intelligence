import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRpcDiscoveryQuestion, projectRpcDiscoveryQuestion, rpcDiscoveryAnswer }
  from '../src/intelligence/rpcDiscoveryQuestion.js';
import { isConditionEffectQuestion, querySourceConditionEffects, sourceConditionsAnswer }
  from '../src/intelligence/sourceConditionEffects.js';
import type { IntelligenceGraph } from '../src/types.js';

const name='cardforge_set_pipeline_heart', callerId='function:src/set.ts';
const graph={project:'project',repositoryRevision:'a'.repeat(40),graphId:'repo-a',
 nodes:[
  {id:callerId,name:'setPipelineHeart',kind:'function',layer:'structural',sourceId:'repo:src/set.ts'},
  {id:'rpc:1',name,kind:'rpc-call',layer:'representation',sourceId:'repo:src/set.ts'},
  {id:'sql:1',name:'public.'+name,kind:'sql-function',layer:'structural',
    sourceId:'repo:migrations/one.sql',
    value:{shortName:name,qualifiedName:'public.'+name,signature:'p_id uuid'}},
  {id:'sql:2',name:'public.'+name,kind:'sql-function',layer:'structural',
    sourceId:'repo:migrations/two.sql',
    value:{shortName:name,qualifiedName:'public.'+name,signature:'p_id uuid'}},
 ],
 edges:[{id:'invoke',kind:'invokes',status:'resolved',from:callerId,to:'rpc:1'}],
 coverage:{files:[
  {path:'src/set.ts',status:'complete'},
  {path:'migrations/one.sql',status:'complete'},
  {path:'migrations/two.sql',status:'complete'},
 ]},
} as unknown as IntelligenceGraph;
const q='Which database functions might setPipelineHeart call, and which one is applied in Staging?';

test('natural real-use RPC discovery wording identifies caller without guessing a database',()=>{
 assert.deepEqual(parseRpcDiscoveryQuestion(q),{caller:'setPipelineHeart',environment:'Staging'});
 assert.deepEqual(parseRpcDiscoveryQuestion('Which SQL routines does setPipelineHeart invoke?'),
   {caller:'setPipelineHeart',environment:null});
 for(const phrase of ['Which tests cover setPipelineHeart?',
   'Which database functions might the service call?',
   'Which database functions might setPipelineHeart call and erase rows?']) {
   assert.equal(parseRpcDiscoveryQuestion(phrase),null);
 }
});
test('source SQL declarations are connected, active database is explicitly unknown',()=>{
 const result=projectRpcDiscoveryQuestion({graph,project:'project',question:q})!;
 assert.equal(result.status,'supported');
 assert.equal((result.counts as any).sourceSqlCandidates,2);
 assert.equal((result.routines as any[])[0]?.total,2);
 assert.equal((result.proof as any).appliedDatabaseFunctionEstablished,false);
 assert.equal((result.proof as any).sourceRpcInvocationEstablished,true);
 const answer=rpcDiscoveryAnswer(result);
 assert.match(answer,/applied in Staging/);
 assert.match(answer,/not established/);
 assert.match(answer,/two.sql/);
 assert.doesNotMatch(answer,/was applied in Staging/);
});
test('ambiguous functions, incomplete SQL coverage and unresolved RPC stay unproven',()=>{
 const dup={...graph,nodes:[...graph.nodes,{...graph.nodes[0],id:'other-caller'}]} as IntelligenceGraph;
 assert.equal(projectRpcDiscoveryQuestion({graph:dup,project:'project',question:q})!.status,'unproven');
 const partial={...graph,coverage:{files:[...graph.coverage!.files,
  {path:'migrations/uninspected.sql',status:'skipped'}]}} as IntelligenceGraph;
 assert.equal(projectRpcDiscoveryQuestion({graph:partial,project:'project',question:q})!.status,'unproven');
 const tentative={...graph,edges:[{...graph.edges[0],status:'candidate'}]} as IntelligenceGraph;
 assert.equal(projectRpcDiscoveryQuestion({graph:tentative,project:'project',question:q})!.status,'unproven');
 const absent=projectRpcDiscoveryQuestion({graph,project:'project',
  question:'Which database functions might nonexistentCall call?'})!;
 assert.equal(absent.status,'unproven');
});
test('explicit source scope resolves unique exact caller, not coincidental name',()=>{
 const dup={...graph,nodes:[...graph.nodes,
  {...graph.nodes[0],id:'other-caller',sourceId:'repo:src/other.ts'}],
 coverage:{files:[...graph.coverage!.files,{path:'src/other.ts',status:'complete'}]}} as IntelligenceGraph;
 assert.equal(projectRpcDiscoveryQuestion({graph:dup,project:'project',question:q})!.status,'unproven');
 assert.equal(projectRpcDiscoveryQuestion({graph:dup,project:'project',question:q,
  scope:'src/set.ts'})!.status,'supported');
});

test('ordinary DI routed question uses the existing graph without graph construction',async ()=>{
 assert.equal(isConditionEffectQuestion(q),true);
 const answer=await querySourceConditionEffects({graph,project:'project',question:q});
 assert.equal(answer?.mode,'ordinary-source-rpc-discovery');
 assert.equal(answer?.status,'supported');
 assert.match(sourceConditionsAnswer(answer!),/Staging remains unknown/);
 assert.equal((answer?.timing as any)?.graphConstructionIncluded,false);
 assert.equal(isConditionEffectQuestion('Which tests cover setPipelineHeart?'),false);
});
