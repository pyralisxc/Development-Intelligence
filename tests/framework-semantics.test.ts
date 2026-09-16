import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecked } from '../src/util/process.js';
import { buildRepositoryGraph } from '../src/intelligence/repository.js';

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function makeRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-framework-semantics-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  await write(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/*': ['src/*'] },
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'preserve',
    },
  }, null, 2));
  await write(root, 'src/features/owner/components/LazyPanel.tsx', `
export async function loadOwnerUsage() {
  return import('@/features/mcp-usage/client/owner');
}
`);
  await write(root, 'src/features/mcp-usage/client/owner.ts', `
export function OwnerMcpUsagePanel() { return null; }
`);
  await write(root, 'src/app/mcp/route.ts', `
declare const server: { registerTool: (name: string, config: object, handler: () => unknown) => void };
server.registerTool('route_tool', {}, () => ({ ok: true }));
export const runtime = 'nodejs';
`);
  await runChecked('git', ['-C', root, 'add', '.']);
  await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
  return root;
}

test('generic framework semantics include dynamic feature imports and route-exposed MCP tools', async () => {
  const root = await makeRepository();
  try {
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const graph = await buildRepositoryGraph({
      project: 'FrameworkFixture',
      repository: root,
      revision,
      root,
      role: 'W',
    });
    const semanticEdges = new Set(
      graph.edges
        .filter(edge => edge.layer === 'semantic' && edge.from && edge.to)
        .map(edge => `${edge.from}|${edge.kind}|${edge.to}`),
    );
    assert.ok(
      semanticEdges.has('feature:owner|depends-on|feature:mcp-usage'),
      'dynamic import() must contribute the same proven feature dependency as a static import',
    );
    assert.ok(
      semanticEdges.has('route:/mcp|exposes|mcp:route_tool'),
      'a route that directly registers an MCP tool must expose that tool in semantic topology',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
