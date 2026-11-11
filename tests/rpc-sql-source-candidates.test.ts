import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRpcSqlSourceCandidates } from '../src/intelligence/rpcSqlSourceCandidates.js';
import type { IntelligenceGraph } from '../src/types.js';

const revision = 'a'.repeat(40);
const caller = 'symbol:src/pipeline.ts#function:setPipelineHeart';
const rpc = 'rpc-call:src/pipeline.ts:133';
const routine = 'cardforge_set_pipeline_heart';
const functions = ['one.sql', 'two.sql', 'three.sql'].map((name, i) => ({
  id: 'sql-def-' + i, kind: 'sql-function', layer: 'structural',
  sourceId: 'repo:supabase/migrations/' + name,
  name: 'public.' + routine, value: { qualifiedName: 'public.' + routine,
    shortName: routine, signature: 'p_lineage_id uuid, p_hearted boolean' },
}));
const graph = {
  project: 'fixture', graphId: 'repo-fixture', repositoryRevision: revision,
  nodes: [
    { id: caller, kind: 'function', name: 'setPipelineHeart', layer: 'structural', sourceId: 'repo:src/pipeline.ts' },
    { id: rpc, kind: 'rpc-call', name: routine, layer: 'representation', sourceId: 'repo:src/pipeline.ts' },
    ...functions,
    { id: 'sql-ref:ledger', kind: 'sql-reference', name: 'public.ledger',
      layer: 'representation', sourceId: 'repo:supabase/migrations/one.sql' },
  ],
  edges: [
    { id: 'source-rpc', from: caller, to: rpc, kind: 'invokes', status: 'resolved', layer: 'representation' },
    { id: 'source-write', from: 'sql-def-0', to: 'sql-ref:ledger', kind: 'writes',
      status: 'resolved', layer: 'representation' },
  ],
  coverage: { files: [
    { path: 'src/pipeline.ts', status: 'complete' },
    ...['one.sql', 'two.sql', 'three.sql'].map(name =>
      ({ path: 'supabase/migrations/' + name, status: 'complete' })),
  ] },
} as unknown as IntelligenceGraph;

test('source RPC connects to three historical SQL definitions without choosing an applied routine', () => {
  const result=projectRpcSqlSourceCandidates({graph,callerId:caller,routineName:routine});
  assert.equal(result.status,'supported');
  assert.equal(result.counts.total,3);
  assert.equal(result.candidates.length,3);
  assert.equal(result.proof.exactSourceRpcCallEstablished,true);
  assert.equal(result.proof.appliedDatabaseFunctionEstablished,false);
  assert.equal(result.proof.committedWriteObserved,false);
  assert.equal(result.candidates[0]?.declaredReferences.some(x=>x.kind==='writes'),true);
});
test('candidate pages recover exactly and reject changed source population', () => {
  const a=projectRpcSqlSourceCandidates({graph,callerId:caller,routineName:routine,pageSize:2});
  const b=projectRpcSqlSourceCandidates({graph,callerId:caller,routineName:routine,
    pageSize:2,offset:2,expectedDigest:a.populationDigest!});
  assert.equal(a.counts.nextOffset,2);
  assert.equal(b.counts.nextOffset,null);
  assert.deepEqual([...a.candidates,...b.candidates].map(x=>x.id).sort(),
    functions.map(x=>x.id).sort());
  assert.throws(()=>projectRpcSqlSourceCandidates({graph,callerId:caller,
    routineName:routine,pageSize:2,offset:2,expectedDigest:'0'.repeat(64)}));
});
test('wrong or candidate RPC edge never upgrades a source relation', () => {
  const wrong={...graph,edges:[{...graph.edges[0],status:'candidate'}]} as IntelligenceGraph;
  assert.equal(projectRpcSqlSourceCandidates({graph:wrong,callerId:caller,
    routineName:routine}).status,'unproven');
  assert.equal(projectRpcSqlSourceCandidates({graph,callerId:caller,
    routineName:'nonexistent'}).status,'unproven');
});
test('incomplete SQL source and duplicate RPC targets remain unproven', () => {
  const partial={...graph,coverage:{files:[
    {path:'src/pipeline.ts',status:'complete'},
    {path:'supabase/migrations/one.sql',status:'partial'},
    ...['two.sql','three.sql'].map(name=>({path:'supabase/migrations/'+name,status:'complete'})),
  ]}} as IntelligenceGraph;
  assert.equal(projectRpcSqlSourceCandidates({graph:partial,callerId:caller,
    routineName:routine}).status,'unproven');
  const dup={...graph,nodes:[...graph.nodes,
    {...graph.nodes[1],id:'rpc-call:duplicate'}],
    edges:[...graph.edges,{...graph.edges[0],id:'source-rpc-dup',to:'rpc-call:duplicate'}]} as IntelligenceGraph;
  assert.equal(projectRpcSqlSourceCandidates({graph:dup,callerId:caller,
    routineName:routine}).status,'unproven');
});
