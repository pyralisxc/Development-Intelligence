#!/usr/bin/env node
/** Real CardForge graph oracle for source-only SQL RPC correlation. No database access. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildLocalGraph } from '../dist/src/intelligence/local.js';
import { projectTwoHopSourceQuestion, sourceConditionsAnswer } from '../dist/src/intelligence/sourceConditionEffects.js';
import { projectRpcSqlSourceCandidates } from '../dist/src/intelligence/rpcSqlSourceCandidates.js';

const expected='0e86857cedfc14cf7c3d12ce4df00d20909c637c';
const root=path.resolve(process.argv[2]||'benchmark/cardforge');
const actual=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(actual,expected);
const started=performance.now();
const graph=await buildLocalGraph(root,'CardForge');
const graphBuildMs=performance.now()-started;
assert.equal(graph.repositoryRevision,expected);
const question='What happens when setPipelineHeart calls cardforge_set_pipeline_heart?';
const qStarted=performance.now();
const result=await projectTwoHopSourceQuestion({
  graph,project:graph.project,question,
  scope:'src/features/pipeline/lib/pipelineHearts.ts',
  readSource:async name=>fs.readFile(path.resolve(root,name),'utf8'),
});
const sourceProjectionMs=performance.now()-qStarted;
assert.equal(result?.status,'supported',JSON.stringify(result));
assert.equal(result.mode,'rpc-sql-source-candidates');
assert.equal(result.counts.total,3);
assert.equal(result.counts.omitted,0);
assert.equal(result.proof.exactSourceRpcCallEstablished,true);
assert.equal(result.proof.appliedDatabaseFunctionEstablished,false);
assert.equal(result.proof.committedWriteObserved,false);
assert.ok(result.candidates.every(v=>v.qualifiedName==='public.cardforge_set_pipeline_heart'));
assert.ok(result.candidates.every(v=>v.signature.includes('p_lineage_id uuid')));
assert.deepEqual(new Set(result.candidates.map(v=>v.sourcePath)).size,3);
const answer=sourceConditionsAnswer(result);
assert.match(answer,/active database routine.*not established/iu);
assert.match(answer,/3 tracked SQL function declaration/u);
const caller='symbol:src/features/pipeline/lib/pipelineHearts.ts#function:setPipelineHeart';
const unknown=projectRpcSqlSourceCandidates({
  graph,callerId:caller,routineName:'not_a_real_rpc_987',
});
assert.equal(unknown.status,'unproven');
const missingSource={
  ...graph,
  coverage:{
    ...graph.coverage,
    files:graph.coverage.files.map(file=>
      file.path==='supabase/migrations/20260922194500_disambiguate_pipeline_heart_columns.sql'
        ? {...file,status:'partial'} : file),
  },
};
assert.equal(projectRpcSqlSourceCandidates({
  graph:missingSource,callerId:caller,routineName:'cardforge_set_pipeline_heart',
}).status,'unproven');
const receipt={
  exactRevision:actual,graphId:graph.graphId,
  graphConstruction:{wallMs:Number(graphBuildMs.toFixed(2)),
    nodes:graph.nodes.length,edges:graph.edges.length,
    endProcessRssBytes:process.memoryUsage().rss},
  existingGraphUnderstanding:{wallMs:Number(sourceProjectionMs.toFixed(2)),
    totalHistoricalSqlDeclarations:result.counts.total,
    completeForTrackedSource:result.counts.completeForTrackedSource,
    omitted:result.counts.omitted},
  sourceOnly:true,appliedDatabaseDefinitionProven:false,
  executedFunctionObserved:false,committedLedgerWriteProven:false,
  negativeControls:['wrong-rpc','partial-sql-source'],
};
await fs.writeFile('rpc-sql-real-source-evidence.json',JSON.stringify(receipt,null,2)+'\n');
process.stdout.write(JSON.stringify(receipt)+'\n');
