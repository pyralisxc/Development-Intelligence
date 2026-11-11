#!/usr/bin/env node
/**
 * Real immutable-codebase acceptance of ordinary two-hop SOURCE answers.
 * Measures cold graph construction separately from repeated reasoning over
 * ONE already-built graph. No application, SQL routine, test runner or
 * production handler is invoked.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildLocalGraph } from '../dist/src/intelligence/local.js';
import {
  isConditionEffectQuestion, projectTwoHopSourceQuestion,
  sourceConditionsAnswer,
} from '../dist/src/intelligence/sourceConditionEffects.js';

function arg(name) {
  const index=process.argv.indexOf(name);
  return index<0 ? null : process.argv[index+1] ?? null;
}
const kind=arg('--source');
assert.ok(kind==='di'||kind==='cardforge','Expected --source di|cardforge');
const root=path.resolve(arg('--repo-root')||'.');
const actualSha=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const expectedSha=arg('--expected-sha');
if(expectedSha)assert.equal(actualSha,expectedSha,'must analyze exact pinned Git commit');
const project=kind==='di'?'Development-Intelligence':'CardForge';
const graphStart=performance.now();
const graph=await buildLocalGraph(root,project);
const graphBuildMs=performance.now()-graphStart;
assert.equal(graph.repositoryRevision,actualSha);
const caller=kind==='di'?'authorizeOwnerWrite':'proxy';
const callee=kind==='di'?'authorize':'cardforgeMiddleware';
const question='What happens when '+caller+' calls '+callee+'?';
assert.equal(isConditionEffectQuestion(question),true);
const scope=kind==='di'?'src/auth.ts':'src/proxy.ts';
const readSource=async relative=>{
  const target=path.resolve(root,relative);
  const canonical=path.relative(root,target).split(path.sep).join('/');
  assert.equal(canonical,relative,'source must remain within exact checkout');
  return await fs.readFile(target,'utf8');
};
const warmDurations=[];
let result;
for(let i=0;i<4;i++){
  const start=performance.now();
  result=await projectTwoHopSourceQuestion({
    graph,project,question,scope,readSource,
  });
  warmDurations.push(performance.now()-start);
  assert.equal(result?.status,'supported',
    'real source graph must contain exact conditional call path: '+JSON.stringify(result));
  assert.equal(result?.mode,'two-hop-conditional-source');
  assert.ok(result.counts.qualified>=1);
  assert.equal(result.counts.omitted,0);
  assert.equal(result.proof.jointPredicateSatisfiabilityProven,false);
  assert.equal(result.proof.argumentMappingProven,false);
  assert.equal(result.proof.runtimeExecutionObserved,false);
  assert.equal(result.timing.graphBuildIncluded,false);
  assert.match(sourceConditionsAnswer(result),/runtime behavior are not proven/u);
}
const values=result.paths.map(p=>p.expression);
if(kind==='di'){
  assert.ok(values.includes('false'),'DI source must expose authorize deny return path');
  assert.ok(result.paths.some(p=>p.sourceWitnesses.some(w=>w==='src/auth.ts:210')));
}else{
  assert.ok(values.includes('oauthClerkHandler(...)'));
  assert.ok(values.includes('browserClerkHandler(...)'));
  assert.ok(values.includes('NextResponse.next(...)'));
  assert.ok(result.paths.some(p=>p.sourceWitnesses.some(w=>w==='src/proxy.ts:6')));
}
const wrong=await projectTwoHopSourceQuestion({
  graph,project,
  question:'What happens when '+caller+' calls thisDefinitelyDoesNotExist123?',
  scope,readSource,
});
assert.equal(wrong?.status,'unproven');
assert.equal(wrong?.reason,'exact-resolved-call-target-unavailable');
const report={
  project, revision:actualSha,graphId:graph.graphId,
  graphConstruction:{wallMs:Number(graphBuildMs.toFixed(2)),
    nodes:graph.nodes.length,edges:graph.edges.length,
    endProcessRssBytes:process.memoryUsage().rss,
    eligibleFiles:graph.coverage?.eligibleFiles??null,
    completeFiles:graph.coverage?.completeFiles??null},
  existingGraphUnderstanding:{
    query:question,sourceOnly:true,runtimeObserved:false,
    warmProjectionWallMs:warmDurations.map(v=>Number(v.toFixed(2))),
    lastBreakdown:result.timing,
    paths:result.counts,
    noGraphRebuildInLoop:true,
  },
  negativeControls:['unknown-target','unknown-feasibility','unknown-runtime'],
};
await fs.writeFile('twohop-ordinary-'+kind+'-measurements.json',JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify(report)+'\n');
