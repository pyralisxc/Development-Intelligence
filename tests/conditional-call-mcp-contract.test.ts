import assert from 'node:assert/strict';
import test from 'node:test';
import { listTools, callTool } from '../src/mcp.js';
const name='derive_captured_boolean_guard';
const base={
 project:'pyralisxc/Development-Intelligence',ref:'commit:'+'a'.repeat(40),
 rootId:'symbol:src/auth.ts#function:authorizeOwnerWrite',
 calleeId:'symbol:src/auth.ts#function:authorize',
 routePath:'src/http.ts',guardLine:366,
};
test('two-hop native captured guard has one read-only tool contract',()=>{
 const tools=listTools().filter(x=>x.name===name);
 assert.equal(tools.length,1);
 assert.equal(tools[0]!.annotations?.readOnlyHint,true);
 assert.deepEqual(tools[0]!.inputSchema.required,
  ['project','ref','rootId','calleeId','routePath','guardLine','bindings']);
});
test('new tool prevents raw secret and dynamic inputs before repository access',async()=>{
 await assert.rejects(callTool(name,{...base,bindings:{'process.env.SECRET_KEY':'password'}}),
  /Sensitive bindings cannot contain raw string values/u);
 await assert.rejects(callTool(name,{...base,bindings:{'authMode()':{dynamic:true}}}),
  /Invalid bounded hypothetical binding/u);
});
