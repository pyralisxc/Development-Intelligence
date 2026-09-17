import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCheckpoint, writeCheckpoint } from '../src/intelligence/checkpoint.js';
import type { IntelligenceGraph } from '../src/types.js';

function fixtureGraph(): IntelligenceGraph {
  const semanticNodes = Array.from({ length: 48 }, (_, index) => ({
    id: `feature:semantic-${index}`,
    sourceId: `repo:src/features/semantic-${index}/index.ts`,
    kind: 'feature',
    locator: `src/features/semantic-${index}/index.ts:${10 + index}`,
    name: `semantic-${index}`,
    value: { id: `semantic-${index}` },
    raw: `semantic-${index}`,
    layer: 'semantic' as const,
    checkpoint: true,
  }));
  const structuralNodes = Array.from({ length: 160 }, (_, index) => ({
    id: `symbol:src/file-${index}.ts#function:node-${index}`,
    sourceId: `repo:src/file-${index}.ts`,
    kind: 'function',
    locator: `src/file-${index}.ts:${20 + index}`,
    name: `node-${index}`,
    value: `node-${index}`,
    raw: `node-${index}`,
    layer: 'structural' as const,
    checkpoint: false,
  }));
  const semanticEdges = Array.from({ length: 47 }, (_, index) => ({
    id: `semantic-edge-${index}`,
    from: `feature:semantic-${index}`,
    to: `feature:semantic-${index + 1}`,
    kind: 'depends-on',
    strategy: 'fixture',
    confidence: 1,
    status: 'resolved' as const,
    evidence: [`src/features/semantic-${index}/index.ts`],
    layer: 'semantic' as const,
    checkpoint: true,
  }));
  const structuralEdges = Array.from({ length: 159 }, (_, index) => ({
    id: `structural-edge-${index}`,
    from: `symbol:src/file-${index}.ts#function:node-${index}`,
    to: `symbol:src/file-${index + 1}.ts#function:node-${index + 1}`,
    kind: 'calls',
    strategy: 'fixture',
    confidence: 1,
    status: 'resolved' as const,
    evidence: [`src/file-${index}.ts`],
    layer: 'structural' as const,
    checkpoint: false,
  }));
  return {
    schemaVersion: 2,
    analyzerVersion: 'fixture-analyzer',
    graphId: 'fixture',
    project: 'Fixture',
    role: 'B',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: 'fixture-sha',
    sourceFingerprint: 'f'.repeat(64),
    topologyFingerprint: 'a'.repeat(64),
    evidenceFingerprint: 'b'.repeat(64),
    sources: [],
    evidence: [],
    nodes: [...semanticNodes, ...structuralNodes],
    edges: [...semanticEdges, ...structuralEdges],
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
  };
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const directory = path.join(root, '.development-intelligence');
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(path.relative(directory, absolute).split(path.sep).join('/'));
    }
  }
  await walk(directory);
  const output = new Map<string, string>();
  for (const file of files.sort()) output.set(file, await fs.readFile(path.join(directory, file), 'utf8'));
  return output;
}

test('accepted checkpoint is deterministic sharded semantic topology rather than a full structural index', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-shards-'));
  try {
    const graph = fixtureGraph();
    await writeCheckpoint(root, graph);
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.development-intelligence', 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.format, 'sharded-ndjson');
    assert.equal(manifest.summary.nodes, 48, 'only stable semantic entities should persist');
    assert.equal(manifest.summary.edges, 47, 'only stable semantic relationships should persist');
    assert.ok(manifest.shards.length > 1);
    assert.ok(manifest.shards.every((name: string) => /^[0-9a-f]\.ndjson$/.test(name)));
    await assert.rejects(fs.stat(path.join(root, '.development-intelligence', 'graph.ndjson')));

    const first = await snapshot(root);
    const parsed = await readCheckpoint(root);
    assert.equal(parsed?.nodes.length, 48);
    assert.equal(parsed?.edges.length, 47);
    assert.equal(parsed?.integrity.topologyValid, true);
    assert.equal(parsed?.nodes.some(node => node.kind === 'function'), false, 'structural code is rebuilt from Git rather than persisted as accepted topology');

    await writeCheckpoint(root, graph);
    const second = await snapshot(root);
    assert.deepEqual(second, first, 'same semantic topology must produce byte-identical shard files and manifest');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('checkpoint validation rejects same-count shard tampering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-shard-integrity-'));
  try {
    await writeCheckpoint(root, fixtureGraph());
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.development-intelligence', 'manifest.json'), 'utf8')) as { shards: string[] };
    let mutated = false;
    for (const shard of manifest.shards) {
      const target = path.join(root, '.development-intelligence', 'graph', shard);
      const content = await fs.readFile(target, 'utf8');
      if (!content.includes('semantic-')) continue;
      const changed = content.replace('semantic-', 'tampered-');
      if (changed === content) continue;
      await fs.writeFile(target, changed, 'utf8');
      mutated = true;
      break;
    }
    assert.equal(mutated, true, 'fixture must mutate one persisted semantic record without changing counts');
    await assert.rejects(readCheckpoint(root), /topology fingerprint does not match shard contents/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});