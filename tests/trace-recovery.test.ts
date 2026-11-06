import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecked } from '../src/util/process.js';
import { clearGraphCache } from '../src/intelligence/service.js';
import { traceGraph } from '../src/intelligence/query.js';

test('trace recovery bounds high-degree node and edge output without claiming absence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-trace-recovery-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const previous = process.env.DEVINT_PROJECTS_FILE;
  try {
    await fs.mkdir(path.join(source, 'src'), { recursive: true });
    await runChecked('git', ['init', '--initial-branch=main', source]);
    await fs.writeFile(path.join(source, 'src', 'high-degree.ts'),
      Array.from({ length: 120 }, (_, i) => `export function caller${i}() { return ${i}; }\n`).join(''));
    await runChecked('git', ['-C', source, 'add', '.']);
    await runChecked('git', ['-C', source, '-c', 'user.email=di@example.invalid', '-c', 'user.name=DI Test', 'commit', '-m', 'trace fixture']);
    const sha = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    await runChecked('git', ['init', '--bare', remote]);
    await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
    await runChecked('git', ['-C', source, 'push', '--all', 'origin']);
    await fs.writeFile(config, JSON.stringify({ TraceRecoveryFixture: {
      repository: pathToFileURL(remote).href, defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'], revisionPolicy: 'repository-history',
      credential: { type: 'none' },
    } }));
    process.env.DEVINT_PROJECTS_FILE = config;
    clearGraphCache();
    const input = { project: 'TraceRecoveryFixture', ref: 'commit:' + sha,
      node: 'file:src/high-degree.ts', direction: 'outbound' as const, depth: 1,
      status: ['resolved' as const] };
    const partial = await traceGraph({ ...input, limit: 20 }) as any;
    assert.equal(partial.ambiguous, false);
    assert.equal(partial.traceProjection.returnedNodes, partial.nodes.length);
    assert.equal(partial.traceProjection.returnedEdges, partial.edges.length);
    assert.ok(partial.nodes.length <= 20);
    assert.ok(partial.edges.length <= 20);
    assert.equal(partial.traceProjection.truncated, true);
    assert.equal(partial.traceProjection.traversalStatus, 'partial');
    assert.ok(partial.traceProjection.knownOmittedEdges > 0);
    const nodeIds = new Set(partial.nodes.map((n: any) => n.id));
    assert.ok(partial.edges.every((e: any) => nodeIds.has(e.from) && nodeIds.has(e.to)),
      'returned edges must have returned endpoints');
    const repeat = await traceGraph({ ...input, limit: 20 }) as any;
    assert.deepEqual(repeat.nodes.map((n: any) => n.id), partial.nodes.map((n: any) => n.id));
    assert.deepEqual(repeat.edges.map((e: any) => e.id), partial.edges.map((e: any) => e.id));
    assert.deepEqual(repeat.traceProjection, partial.traceProjection);

    const wide = await traceGraph({ ...input, limit: 2000 }) as any;
    assert.equal(wide.traceProjection.truncated, false);
    assert.equal(wide.traceProjection.traversalStatus, 'complete-within-requested-depth');
    assert.equal(wide.traceProjection.knownOmittedEdges, 0);
    assert.ok(wide.edges.length > partial.edges.length);

    const zero = await traceGraph({ ...input, depth: 0, limit: 20 }) as any;
    assert.equal(zero.traceProjection.traversalStatus, 'not-performed');
    assert.equal(zero.traceProjection.reason, 'zero-depth');
    assert.equal(zero.traceProjection.truncated, true);
    assert.equal(zero.edges.length, 0);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = previous;
    clearGraphCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
