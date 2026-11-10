import assert from 'node:assert/strict';
import test from 'node:test';
import { composeTwoHopSourceEffects } from '../src/intelligence/twoHopSourceComposition.js';
import type { IntelligenceGraph } from '../src/types.js';
const revision='a'.repeat(40),graphId='repo-test';
const callerId='symbol:src/auth.ts#function:authorizeOwnerWrite';
const calleeId='symbol:src/auth.ts#function:authorize';
const callerCondition='src/auth.ts:condition:11752';
const calleeMode='src/auth.ts:condition:6805';
const calleeFlag='src/auth.ts:condition:6832';
const graph={
 project:'DI',graphId,repositoryRevision:revision,analyzerVersion:'test',
 nodes:[callerId,calleeId].map(id=>({id,layer:'structural',kind:'function'})),
 edges:[{id:'call-210',from:callerId,to:calleeId,kind:'calls',layer:'structural',
 status:'resolved',evidence:['src/auth.ts:210']}],
 coverage:{files:[{path:'src/auth.ts',status:'complete'}]},
} as unknown as IntelligenceGraph;
const make=(functionId:string,branches:unknown[],effects:unknown[])=>({
 status:'supported',identity:{project:'DI',graphId,sourceRevision:revision,
 analyzerVersion:'test',functionId,sourcePath:'src/auth.ts'},
 coverage:{completeForSupportedStatements:true,presentationTruncated:false},
 branches,effects,
});
const caller=make(callerId,[{
 id:callerCondition,predicateSha256:'mode-none',sourceLine:210,
 priorRequirements:[],trueBranchTerminates:true,falseBranchTerminates:false,
 conditionsAreSourceSyntaxOnly:true,
}],[{
 kind:'return-call',sourceLine:210,expression:'authorize(...)',expressionSha256:'call-sha',
 requiredConditions:[{conditionId:callerCondition,expectedTruth:true}],runtimeObserved:false,
}]);
const callee=make(calleeId,[
 {id:calleeMode,predicateSha256:'mode-none',sourceLine:113},
 {id:calleeFlag,predicateSha256:'flag-disabled',sourceLine:114},
],[{
 kind:'return',sourceLine:117,expression:'false',expressionSha256:'return-false',
 requiredConditions:[{conditionId:calleeMode,expectedTruth:true},
 {conditionId:calleeFlag,expectedTruth:true}],runtimeObserved:false,
}]);
const input={
 graph,caller,callee,call:{effectLine:210,effectSha256:'call-sha'},
 calleeReturn:{effectLine:117,effectSha256:'return-false'},
 callerAssumptions:{[callerCondition]:true},
 calleeAssumptions:{[calleeMode]:true,[calleeFlag]:true},
};
test('DI owner-write to authorize none-mode conditional source chain',()=>{
 const result=composeTwoHopSourceEffects(input);
 assert.equal(result.status,'established-conditional-source-path');
 assert.equal(result.selectedCalleeReturnExpression,'false');
 assert.equal(result.requiredConditions.length,3);
 assert.equal(result.runtimeObserved,false);
 assert.equal(result.calleeReturnValueProven,false);
});
test('wrong flag, missing guard, or incomplete coverage fails closed',()=>{
 assert.equal(composeTwoHopSourceEffects({...input,calleeAssumptions:{[calleeMode]:true,[calleeFlag]:false}}).status,'unproven');
 assert.equal(composeTwoHopSourceEffects({...input,callerAssumptions:{}}).status,'unproven');
 assert.equal(composeTwoHopSourceEffects({...input,callee:{...callee,coverage:{completeForSupportedStatements:false,presentationTruncated:false}}}).status,'unproven');
});
test('source edge is not inferred from lexical matching or an unrelated callsite',()=>{
 const g={...graph,edges:[{...graph.edges[0],status:'candidate'}]} as IntelligenceGraph;
 assert.equal(composeTwoHopSourceEffects({...input,graph:g}).status,'unproven');
 const g2={...graph,edges:[{...graph.edges[0],evidence:['src/auth.ts:209']}]} as IntelligenceGraph;
 assert.equal(composeTwoHopSourceEffects({...input,graph:g2}).status,'unproven');
});
test('mismatched revision, effect or partial lens does not promote proof',()=>{
 assert.equal(composeTwoHopSourceEffects({...input,callee:{...callee,identity:{...callee.identity,sourceRevision:'b'.repeat(40)}}}).status,'unproven');
 assert.equal(composeTwoHopSourceEffects({...input,call:{effectLine:210,effectSha256:'wrong'}}).status,'unproven');
 assert.equal(composeTwoHopSourceEffects({...input,caller:{...caller,coverage:{completeForSupportedStatements:true,presentationTruncated:true}}}).status,'unproven');
});
