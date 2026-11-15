#!/usr/bin/env node
/**
 * Real Git graph vs a deliberately fixture-only database metadata envelope.
 * Does not connect to Postgres or authenticate provider observations.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildLocalGraph } from '../dist/src/intelligence/local.js';
import { reconcileCapturedCatalog } from '../dist/src/intelligence/capturedCatalogReconciliation.js';

const arg=key=>{const i=process.argv.indexOf(key);return i>=0?process.argv[i+1]:null;};
const kind=arg('--source'),root=path.resolve(arg('--repo-root')||'.');
assert.ok(kind==='di'||kind==='cardforge');
const sha=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(arg('--expected-sha'))assert.equal(sha,arg('--expected-sha'),'exact Git revision');
const project=kind==='cardforge'?'CardForge':'Development-Intelligence';
const started=performance.now();
const graph=await buildLocalGraph(root,project);
const graphBuildMs=performance.now()-started;
assert.equal(graph.repositoryRevision,sha);
const name='public.cardforge_set_pipeline_heart';
const signature='p_lineage_id uuid, p_account_id text, p_hearted boolean, p_viewer_access text, p_contributor boolean, p_owner boolean';
const timestamp='2026-11-11T18:30:00Z';
const evidence={
 source:{id:'offline-metadata-fixture',type:'read-only-http',adapter:'database-schema',
   label:'non-live-fixture',capability:'query',endpoint:'https://example.invalid'},
 snapshot:{id:'fixture-observation-1',sourceRevision:sha,observedAt:timestamp,
   sourceObservedAt:timestamp,freshness:'unknown',ageMs:null},
 sanitization:{policy:'sanitized-v1',redactedFields:0,redactedValues:0},
 availability:{available:true,httpStatus:200},
 coverage:{status:'complete',observed:1,expected:null},
 observations:[{id:'fixture-routine',kind:'database-function',name,
   locator:'database-function:'+name,observedAt:timestamp,sourceRevision:sha,
   value:{schema:'public',name:'cardforge_set_pipeline_heart',qualifiedName:name,
     raw:{identity_arguments:signature}}}],
 relationships:[],correlations:[],correlationStatus:{attempted:false,available:false},raw:null,
};
const warm=[];
let result;
for(let i=0;i<4;i++){
 const st=performance.now();
 result=reconcileCapturedCatalog({graph,qualifiedName:name,evidence});
 warm.push(Number((performance.now()-st).toFixed(3)));
 assert.equal(result.capture.inventoryComplete,false);
 assert.equal(result.policy.noNegativeAbsenceFromAdapterRecognition,true);
 assert.equal(result.policy.noAppliedRoutineOrCommittedWriteProof,true);
 assert.equal(result.graphProjection.canonicalGraphUnchanged,true);
 assert.ok(result.graphProjection.edges.every(x=>x.status==='candidate'));
}
if(kind==='cardforge'){
 assert.equal(result.population.sourceCandidates,3);
 assert.equal(result.population.observedCandidates,1);
 assert.equal(result.population.total,3);
 assert.ok(result.rows.every(x=>x.comparison==='candidate-signature-agreement'));
 const wrong={...evidence,observations:[{...evidence.observations[0],
   value:{qualifiedName:name,raw:{identity_arguments:'p_lineage_id uuid'}}}]};
 const mismatch=reconcileCapturedCatalog({graph,qualifiedName:name,evidence:wrong});
 assert.ok(mismatch.rows.every(x=>x.comparison==='candidate-signature-difference'));
 const gone={...evidence,observations:[]};
 assert.equal(reconcileCapturedCatalog({graph,qualifiedName:name,evidence:gone})
  .rows.every(x=>x.comparison==='source-without-observation'),true);
 const sourcePaths=new Set(result.rows.map(x=>x.sourcePath));
 assert.equal(sourcePaths.size,3);
}else{
 assert.equal(result.population.sourceCandidates,0);
 assert.equal(result.population.observedCandidates,1);
 assert.equal(result.rows[0].comparison,'observation-without-source');
}
const receipt={
 kind,revision:sha,graphId:graph.graphId,
 source:{nodes:graph.nodes.length,edges:graph.edges.length},
 coldGraphBuildMs:Number(graphBuildMs.toFixed(3)),
 repeatedExistingGraphCatalogComparisonMs:warm,
 endRssBytes:process.memoryUsage().rss,
 sourceCandidates:result.population.sourceCandidates,
 observedCandidates:result.population.observedCandidates,
 comparison:result.rows.map(x=>x.comparison),
 noGraphRebuildInComparison:true,
 noLiveDatabaseRead:true,noAppliedRoutineTruth:true,
 negativeControls:['no-inventory-absence-proof','mismatched-signature','historical-source-not-applied'],
};
const file='captured-catalog-'+kind+'-receipt.json';
writeFileSync(file,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
