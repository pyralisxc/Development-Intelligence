#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildLocalGraph } from '../dist/src/intelligence/local.js';
import { evaluateCapturedBooleanChain, verifyGuardedEarlyReturn } from '../dist/src/intelligence/conditionalCallComposition.js';
const root=process.cwd();
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(process.env.EXACT_DI_SHA&&process.env.EXACT_DI_SHA!==sha)throw new Error('Exact source SHA mismatch');
const graph=await buildLocalGraph(root,'pyralisxc/Development-Intelligence','W');
assert.equal(graph.repositoryRevision,sha);
const auth=readFileSync(resolve(root,'src/auth.ts'),'utf8');
const http=readFileSync(resolve(root,'src/http.ts'),'utf8');
const rootId='symbol:src/auth.ts#function:authorizeOwnerWrite';
const calleeId='symbol:src/auth.ts#function:authorize';
assert.ok(graph.edges.some(e=>e.from===rootId&&e.to===calleeId&&e.kind==='calls'
  &&e.status==='resolved'&&e.evidence.includes('src/auth.ts:210')));
assert.ok(graph.edges.some(e=>e.from==='file:src/http.ts'&&e.to===rootId
  &&e.kind==='references-symbol'&&e.status==='resolved'
  &&e.strategy==='typescript-checker-symbol.v1'
  &&e.evidence.some(v=>v.startsWith('src/http.ts:366:'))));
function prove(flag,expectedBool,expectedGuard){
 const chain=evaluateCapturedBooleanChain({
  graph,sourcePath:'src/auth.ts',source:auth,rootId,calleeId,
  bindings:{'authMode()':'none','process.env.DEVINT_ALLOW_UNAUTHENTICATED':flag},
 });
 assert.equal(chain.status,'established-normal-path',chain.reason);
 assert.equal(chain.value,expectedBool);
 assert.equal(chain.chain.length,2);
 const route=verifyGuardedEarlyReturn({
  graph,source:http,sourcePath:'src/http.ts',guardLine:366,
  callableId:rootId,authorizationResult:chain.value,
 });
 assert.equal(route.status,'established-normal-path',route.reason);
 assert.equal(route.earlyReturn,expectedGuard);
 return {value:chain.value,routeEarlyReturn:route.earlyReturn,
  sourceGuards:chain.guards.length,responseCalls:chain.responseCalls.length};
}
const denied=prove('0',false,true),allowed=prove('1',true,false);
const missing=evaluateCapturedBooleanChain({graph,sourcePath:'src/auth.ts',
 source:auth,rootId,calleeId,bindings:{'authMode()':'none'}});
assert.equal(missing.status,'unproven');
const mutated=auth.replace("process.env.DEVINT_ALLOW_UNAUTHENTICATED !== '1'",
 "process.env.DEVINT_ALLOW_UNAUTHENTICATED === '1'");
assert.notEqual(mutated,auth);
const altered=evaluateCapturedBooleanChain({graph,sourcePath:'src/auth.ts',
 source:mutated,rootId,calleeId,
 bindings:{'authMode()':'none','process.env.DEVINT_ALLOW_UNAUTHENTICATED':'0'}});
assert.equal(altered.status,'established-normal-path');
assert.equal(altered.value,true);
const receipt={revision:sha,graphId:graph.graphId,denied,allowed,
 unconfigured:'unproven',changedCalleeChangesNormalPath:true,
 sourceOnly:true,actualEnvObserved:false,runtimeAuthObserved:false,
 downstreamWriteProven:false,testReplacementProven:false};
writeFileSync('captured-auth-two-hop-proof.json',JSON.stringify(receipt,null,2)+'\n');
process.stdout.write(JSON.stringify(receipt)+'\n');
