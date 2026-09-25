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

async function commitFixture(root: string): Promise<string> {
  await runChecked('git', ['-C', root, 'add', '.']);
  await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
  return (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
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
  await commitFixture(root);
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

test('same semantic identity preserves contradictory evidence as an explicit conflict', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-semantic-conflict-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await write(root, 'src/one.ts', `export const one = { developmentIntelligence: { kind: 'capability', id: 'sample.shared', label: 'First meaning', relationships: [] } } as const;`);
    await write(root, 'src/two.ts', `export const two = { developmentIntelligence: { kind: 'capability', id: 'sample.shared', label: 'Second meaning', relationships: [] } } as const;`);
    const revision = await commitFixture(root);
    const graph = await buildRepositoryGraph({ project: 'ConflictFixture', repository: root, revision, root, role: 'W' });
    const entity = graph.nodes.find(node => node.id === 'capability:sample.shared');
    assert.ok(entity, 'stable semantic identity must remain one graph entity');
    assert.ok(entity!.tags?.includes('conflicted'), 'the entity must visibly carry conflict state');
    assert.ok((entity!.evidenceIds?.length ?? 0) >= 2, 'both source assertions must remain attached as evidence');
    assert.ok(graph.explicitValueConflicts.some(conflict => conflict.entityId === entity!.id && (conflict.key === 'name' || conflict.key === 'value')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('coverage roles distinguish source, generated, media, archive, configuration, and resources generically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-coverage-roles-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await write(root, 'src/App.java', 'class App {}');
    await write(root, 'build/App.class', 'compiled');
    await write(root, 'assets/icon.png', 'binary-ish');
    await write(root, 'libs/runtime.jar', 'archive');
    await write(root, 'config/app.yml', 'enabled: true');
    await write(root, 'locale/en.lang', 'hello=Hello');
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const graph = await buildRepositoryGraph({ project: 'CoverageRoleFixture', repository: root, revision, root, role: 'W' });
    const role = (suffix: string) => graph.coverage?.files.find(file => file.path.endsWith(suffix))?.role;
    assert.equal(role('src/App.java'), 'source');
    assert.equal(role('build/App.class'), 'generated');
    assert.equal(role('assets/icon.png'), 'media');
    assert.equal(role('libs/runtime.jar'), 'archive');
    assert.equal(role('config/app.yml'), 'configuration');
    assert.equal(role('locale/en.lang'), 'resource');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('coverage distinguishes failed analysis from complete inspection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-coverage-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await write(root, 'src/good.ts', `export function good() { return true; }`);
    await write(root, 'src/broken.json', `{ "broken": `);
    const revision = await commitFixture(root);
    const graph = await buildRepositoryGraph({ project: 'CoverageFixture', repository: root, revision, root, role: 'W' });
    const good = graph.coverage?.files.find(file => file.path === 'src/good.ts');
    const broken = graph.coverage?.files.find(file => file.path === 'src/broken.json');
    assert.equal(good?.status, 'complete');
    assert.equal(broken?.status, 'failed');
    assert.equal(graph.coverage?.failedFiles, 1);
    assert.equal(graph.coverage?.analyzedFiles, 1, 'failed analysis must not count as complete analyzed coverage');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('provider imports resolve while bare host strings remain candidates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-provider-evidence-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await write(root, 'src/features/payments/imported.ts', `import Stripe from 'stripe'; export const client = Stripe;`);
    await write(root, 'src/features/payments/host-only.ts', `export const docs = 'https://api.stripe.com/v1/payment_intents';`);
    const revision = await commitFixture(root);
    const graph = await buildRepositoryGraph({ project: 'ProviderFixture', repository: root, revision, root, role: 'W' });
    const edges = graph.edges.filter(edge => edge.layer === 'semantic' && edge.from === 'feature:payments' && edge.to === 'provider:stripe' && edge.kind === 'integrates-with');
    assert.ok(edges.some(edge => edge.status === 'resolved' && edge.strategy === 'provider import'));
    assert.ok(edges.some(edge => edge.status === 'candidate' && edge.strategy === 'provider host string' && edge.confidence === 0.65));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});