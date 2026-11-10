import assert from 'node:assert/strict';
import test from 'node:test';
import { listTools, callTool } from '../src/mcp.js';

const name = 'derive_captured_source_selection';
test('captured source selector has one read-only shared MCP contract', () => {
  const matching = listTools().filter(tool => tool.name === name);
  assert.equal(matching.length, 1);
  assert.equal(matching[0]!.annotations?.readOnlyHint, true);
  const schema = matching[0]!.inputSchema;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['project','ref','callableId','bindings']);
});
test('MCP captured source selector refuses raw secrets before source inspection', async () => {
  await assert.rejects(callTool(name, {
    project: 'pyralisxc/Development-Intelligence',
    ref: 'commit:' + 'a'.repeat(40),
    callableId: 'symbol:src/auth.ts#function:authorize',
    bindings: { 'process.env.CLERK_SECRET_KEY': 'sensitive-example' },
  }), /Sensitive configuration bindings must be booleans/u);
});
test('MCP captured source selector rejects missing or dynamic bind values', async () => {
  await assert.rejects(callTool(name, {
    project: 'pyralisxc/Development-Intelligence',
    ref: 'commit:' + 'a'.repeat(40),
    callableId: 'symbol:src/auth.ts#function:authorize',
    bindings: { 'request.nextUrl.pathname': { unknown: true } },
  }), /Bindings only admit bounded hypothetical literals/u);
  await assert.rejects(callTool(name, {
    project: 'pyralisxc/Development-Intelligence',
    ref: 'commit:' + 'a'.repeat(40),
    callableId: 'symbol:src/auth.ts#function:authorize',
    bindings: {},
  }), /bindings must have 1-24 hypothetical properties/u);
});
