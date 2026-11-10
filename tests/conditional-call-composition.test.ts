import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntelligenceGraph, GraphNode } from '../src/types.js';
import { evaluateCapturedBooleanChain, verifyGuardedEarlyReturn } from '../src/intelligence/conditionalCallComposition.js';

const path='src/auth.ts', sha='a'.repeat(40);
const root:GraphNode={id:'symbol:src/auth.ts#function:authorizeOwnerWrite',sourceId:'repo:src/auth.ts',
  kind:'function',layer:'structural',name:'authorizeOwnerWrite',locator:'src/auth.ts:1',
  value:'authorizeOwnerWrite',raw:'authorizeOwnerWrite'};
const callee:GraphNode={...root,id:'symbol:src/auth.ts#function:authorize',
  name:'authorize',locator:'src/auth.ts:10'};
const graph={repositoryRevision:sha,nodes:[root,callee],edges:[
 {from:root.id,to:callee.id,kind:'calls',status:'resolved',layer:'structural',
  evidence:['src/auth.ts:11']},
 {from:'file:src/http.ts',to:root.id,kind:'references-symbol',
  status:'resolved',strategy:'typescript-checker-symbol.v1',
  evidence:['src/http.ts:2:12']}
 ],coverage:{files:[{path,status:'complete'},{path:'src/http.ts',status:'complete'}]}} as unknown as IntelligenceGraph;
const source=[
'export function authorizeOwnerWrite(req: unknown, res: unknown, options: unknown) {',
'  const mode = authMode();',
"  if (mode === 'private' || mode === 'oauth') {",
'    if (ownerSessionValid(req)) return true;',
'    return false;',
'  }',
"  if (mode === 'none') return authorize(req, res, options);",
'  return false;',
'}',
'export function authorize(req: unknown, res: unknown, options: unknown) {',
'  const mode = authMode();',
"  if (mode === 'none') {",
"    if (process.env.DEVINT_ALLOW_UNAUTHENTICATED !== '1') {",
'      res.writeHead(503);',
'      res.end();',
'      return false;',
'    }',
'    return true;',
'  }',
'  return false;',
'}'
].join('\n');
function actualGraph(){return {...graph,edges:graph.edges.map(e=>e.kind==='calls'
 ? {...e,evidence:['src/auth.ts:7']} : e)} as IntelligenceGraph;}
const values=(v:string)=>({'authMode()':'none','process.env.DEVINT_ALLOW_UNAUTHENTICATED':v});
test('two-hop mode none and disabled env gives false with source-located response calls',()=>{
 const result=evaluateCapturedBooleanChain({graph:actualGraph(),sourcePath:path,source,rootId:root.id,
  calleeId:callee.id,bindings:values('0')});
 assert.equal(result.status,'established-normal-path');assert.equal(result.value,false);
 assert.equal(result.chain.length,2);assert.equal(result.responseCalls.length,2);
 assert.equal(result.assumptions.noLiveConfigurationObserved,true);
});
test('same source with enabled flag yields true and no response calls',()=>{
 const result=evaluateCapturedBooleanChain({graph:actualGraph(),sourcePath:path,source,rootId:root.id,
  calleeId:callee.id,bindings:values('1')});
 assert.equal(result.status,'established-normal-path');assert.equal(result.value,true);
 assert.equal(result.responseCalls.length,0);
});
test('unproven config, edge, or mutating control does not become established',()=>{
 const a=evaluateCapturedBooleanChain({graph:actualGraph(),sourcePath:path,source,rootId:root.id,
  calleeId:callee.id,bindings:{'authMode()':'none'}});
 assert.equal(a.status,'unproven');
 const b=evaluateCapturedBooleanChain({graph,sourcePath:path,source,rootId:root.id,
  calleeId:callee.id,bindings:values('1')});
 assert.equal(b.status,'unproven');
 const c=evaluateCapturedBooleanChain({graph:actualGraph(),sourcePath:path,
  source:source.replace('res.end();','await res.end();'),rootId:root.id,
  calleeId:callee.id,bindings:values('0')});
 assert.equal(c.status,'unproven');
});
test('compiler-bound HTTP route false auth returns before route body, true falls through',()=>{
 const http="export function serve(req:unknown,res:unknown) {\n  if (!authorizeOwnerWrite(req, res)) return;\n  return write();\n}";
 const neg=verifyGuardedEarlyReturn({graph,source:http,sourcePath:'src/http.ts',
  guardLine:2,callableId:root.id,authorizationResult:false});
 const pos=verifyGuardedEarlyReturn({graph,source:http,sourcePath:'src/http.ts',
  guardLine:2,callableId:root.id,authorizationResult:true});
 assert.equal(neg.status,'established-normal-path');assert.equal(neg.earlyReturn,true);
 assert.equal(pos.status,'established-normal-path');assert.equal(pos.earlyReturn,false);
 assert.equal(verifyGuardedEarlyReturn({graph:{...graph,edges:[]},source:http,sourcePath:'src/http.ts',
  guardLine:2,callableId:root.id,authorizationResult:false}).status,'unproven');
});
