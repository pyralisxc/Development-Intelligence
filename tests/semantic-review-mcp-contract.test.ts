import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool, listTools } from '../src/mcp.js';

test('semantic review MCP exposes bounded summary plus explicitly pinned lossless candidate recovery', async () => {
  const tool = listTools().find(value => value.name === 'semantic_review_surface');
  assert.ok(tool);
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.deepEqual((tool.inputSchema as any).properties.detail.enum, ['summary', 'full']);
  assert.equal((tool.inputSchema as any).properties.candidateId.type, 'string');
  assert.match(tool.description, /Default detail=summary/u);
  assert.match(tool.description, /No pagination/u);
  await assert.rejects(callTool('semantic_review_surface', {
    project: 'UnconfiguredFixture',
    candidateId: 'semantic-candidate:fixture',
    detail: 'summary',
  }), /candidateId requires detail=full/u);
  await assert.rejects(callTool('semantic_review_surface', {
    project: 'UnconfiguredFixture',
    candidateId: 'semantic-candidate:fixture',
    detail: 'full',
    ref: 'branch:preview',
  }), /immutable commit.*ref or exact graphId/u);
  await assert.rejects(callTool('semantic_review_surface', {
    project: 'UnconfiguredFixture',
    candidateId: 'semantic-candidate:fixture',
    detail: 'full',
  }), /immutable commit.*ref or exact graphId/u);
});
