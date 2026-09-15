import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCheckpoint, writeCheckpoint } from '../src/intelligence/checkpoint.js';
import type { IntelligenceGraph } from '../src/types.js';

function fixtureGraph(): IntelligenceGraph {
  const nodes = Array.from({ length: 160 }, (_, index) => ({
    id: `node-${index}`,
    sourceId: 'repository',
    kind: index % 2 ? 'function' : 'file',
    locator: `src/file-${index}.ts`,
    name: `node-${index}`,
    value: `node-${index}`,
    raw: `node-${index}`,
  }));
  const edges = Array.from({ length: 159 }, (_, index) => ({
    id: `edge-${index}`,
    from: `node-${index}`,
    to: `node-${index + 1}`,
    kind: 'calls',
    strategy: 'fixture',
    confidence: 1,
    status: 'resolved' as const,
    evidence: [`src/file-${index}.ts`],
  }));
  return {
    schemaVersion: 1,
    graphId: 'fixture',
    project: 'Fixture',
    role: 'B',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: 'fixture-sha',
    sourceFingerprint: 'f'.repeat(64),
    sources: [],
    nodes,
    edges,
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

test('accepted graph checkpoint is deterministic sharded text rather than one giant binary or NDJSON file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-shards-'));
  try {
    const graph = fixtureGraph();
    await writeCheckpoint(root, graph);
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.development-intelligence', 'manifest.json'), 'utf8'));
    assert.equal(manifest.format, 'sharded-ndjson');
    assert.ok(manifest.shards.length > 1);
    assert.ok(manifest.shards.every((name: string) => /^[0-9a-f]\.ndjson$/.test(name)));
    await assert.rejects(fs.stat(path.join(root, '.development-intelligence', 'graph.ndjson')));

    const first = await snapshot(root);
    const parsed = await readCheckpoint(root);
    assert.equal(parsed?.nodes.length, graph.nodes.length);
    assert.equal(parsed?.edges.length, graph.edges.length);

    await writeCheckpoint(root, graph);
    const second = await snapshot(root);
    assert.deepEqual(second, first, 'same graph must produce byte-identical shard files and manifest');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
