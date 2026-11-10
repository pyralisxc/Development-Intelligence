import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCapturedReturnCall } from '../src/intelligence/conditionalReturnSelector.js';

// Exact relevant callable shape of pinned CardForge middleware old/new revisions.
// No Clerk invocation occurs in this test: only TypeScript source path selection.
const before = [
'export const cardforgeMiddleware = (request: unknown, event: unknown) => {',
'  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {',
'    return NextResponse.next();',
'  }',
"  if (request.nextUrl.pathname === '/mcp') {",
'    return oauthClerkHandler(request, event);',
'  }',
'  return browserClerkHandler(request, event);',
'};',
].join('\n');
const after=before.replace("request.nextUrl.pathname === '/mcp')",
  "request.nextUrl.pathname === '/mcp' || request.nextUrl.pathname === '/mcp/owner')");
const bound={
  'process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY':'configured',
  'process.env.CLERK_SECRET_KEY':'configured',
  'request.nextUrl.pathname':'/mcp/owner',
};
const evaluate=(source:string,bindings:Record<string,string|null>)=>
  selectCapturedReturnCall({sourcePath:'src/infrastructure/auth/middleware.ts',
    source,callable:'cardforgeMiddleware',bindings});
test('caller unchanged yet callee guard expands source-selected handler',()=>{
  const old=evaluate(before,bound),newer=evaluate(after,bound);
  assert.equal(old.status,'established-conditional-selection');
  assert.equal(old.selectedCall,'browserClerkHandler');
  assert.equal(newer.status,'established-conditional-selection');
  assert.equal(newer.selectedCall,'oauthClerkHandler');
  assert.equal(old.proof.externalCalleeExecutionObserved,false);
});
test('missing Clerk key selects source bypass independently of route',()=>{
  const r=evaluate(after,{...bound,'process.env.CLERK_SECRET_KEY':null});
  assert.equal(r.selectedCall,'NextResponse.next');
  assert.equal(r.proof.environmentIndependentlyAttested,false);
});
test('unknown environment cannot be guessed from source alone',()=>{
  const r=evaluate(after,{'request.nextUrl.pathname':'/mcp/owner'});
  assert.equal(r.status,'unproven');
  assert.equal(r.selectedCall,null);
});
test('unsupported asynchronous, computed, or side-effecting expression fails closed',()=>{
  assert.equal(evaluate(after.replace('return browserClerkHandler(request, event);',
    'return browserClerkHandler(resolve(request), event);'),{...bound,
      'request.nextUrl.pathname':'/account'}).status,'unproven');
  assert.equal(evaluate(after.replace('return browserClerkHandler(request, event);',
    'try { return browserClerkHandler(request, event); } finally {}'),{...bound,
      'request.nextUrl.pathname':'/account'}).status,'unproven');
});
test('unresolved, ambiguous declaration does not establish call selection',()=>{
  const duplicated=before+'\n'+before;
  assert.equal(evaluate(duplicated,bound).status,'unproven');
});
