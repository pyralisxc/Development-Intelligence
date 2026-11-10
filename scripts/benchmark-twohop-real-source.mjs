import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {buildRepositoryGraph} from '../dist/src/intelligence/repository.js';
import {projectSourceConditionEffects} from '../dist/src/intelligence/sourceConditionEffects.js';
import {composeTwoHopSourceEffects} from '../dist/src/intelligence/twoHopSourceComposition.js';
const root=process.cwd(),revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourcePath='src/auth.ts',source=readFileSync(sourcePath,'utf8');
assert.match(source,/if \(mode === 'none'\) return authorize\(req, res, options\);/u);
assert.match(source,/process\.env\.DEVINT_ALLOW_UNAUTHENTICATED !== '1'/u);
const graph=await buildRepositoryGraph({project:'Development-Intelligence',repository:root,revision,root,role:'W'});
const get=n=>graph.nodes.find(x=>x.id==='symbol:src/auth.ts#function:'+n);
const callerNode=get('authorizeOwnerWrite'),calleeNode=get('authorize');
assert.ok(callerNode&&calleeNode);
const make=node=>projectSourceConditionEffects({sourcePath,source,symbol:node,graph,maxRows:80});
const caller=make(callerNode),callee=make(calleeNode);
assert.equal(caller.status,'supported');assert.equal(callee.status,'supported');
const call=caller.effects.find(x=>x.kind==='return-call'&&x.sourceLine===210&&x.expression==='authorize(...)');
const ret=callee.effects.find(x=>x.kind==='return'&&x.sourceLine===117&&x.expression==='false');
const ownerOuter=caller.branches.find(x=>x.sourceLine===203);
const owner=caller.branches.find(x=>x.sourceLine===210);
const mode=callee.branches.find(x=>x.sourceLine===113);
const flag=callee.branches.find(x=>x.sourceLine===114);
assert.ok(call&&ret&&ownerOuter&&owner&&mode&&flag);
const input={graph,caller,callee,
 call:{effectLine:call.sourceLine,effectSha256:call.expressionSha256},
 calleeReturn:{effectLine:ret.sourceLine,effectSha256:ret.expressionSha256},
 callerAssumptions:{[ownerOuter.id]:false,[owner.id]:true},
 calleeAssumptions:{[mode.id]:true,[flag.id]:true}};
const proof=composeTwoHopSourceEffects(input);
assert.equal(proof.status,'established-conditional-source-path');
assert.equal(proof.selectedCalleeReturnExpression,'false');
assert.equal(proof.runtimeObserved,false);
assert.equal(proof.proof.argumentMappingProven,false);
assert.equal(composeTwoHopSourceEffects({...input,calleeAssumptions:{[mode.id]:true,[flag.id]:false}}).status,'unproven');
assert.equal(composeTwoHopSourceEffects({...input,graph:{...graph,edges:graph.edges.filter(x=>!(x.from===callerNode.id&&x.to===calleeNode.id&&x.kind==='calls'))}}).status,'unproven');
const report={revision,graphId:graph.graphId,sourceWitnesses:proof.sourceWitnesses,
 predicateCount:proof.requiredConditions.length,sourceOnly:true,runtimeObserved:false,
 configurationObserved:false,negativeControls:['wrong-flag','missing-call-edge']};
writeFileSync('twohop-real-source-evidence.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
