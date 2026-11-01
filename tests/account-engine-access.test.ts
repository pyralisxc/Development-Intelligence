import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withProjectAccess, projectAccessScopeKey, type ProjectAccessBinding } from '../src/config/projectAccess.js';
import { canonicalProjectStorageKey, loadCanonicalGraph, makeCanonicalGraphRecord, saveCanonicalGraph } from '../src/intelligence/canonicalStore.js';
import { clearGraphCache, graphCacheDiagnostics, graphContext, scanGraph } from '../src/intelligence/service.js';
import { runCanonicalReconcileWorker } from '../src/intelligence/canonicalReconcileWorker.js';
import { ANALYZER_VERSION } from '../src/intelligence/repository.js';
import type { IntelligenceGraph } from '../src/types.js';
import { resolveProjectRevision, withResolvedProjectCheckout } from '../src/source/git.js';
import { runChecked } from '../src/util/process.js';
import { recordToolExecution, toolExecutionDiagnostics, clearToolExecutionDiagnostics } from '../src/observability.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-account-engine-'));
  const source = path.join(root, 'source'), remote = path.join(root, 'remote.git');
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await fs.writeFile(path.join(source, 'value.ts'), 'export function original() { return 1; }\n');
  await runChecked('git', ['-C', source, 'add', '.']);
  await runChecked('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source']);
  const revision = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  await runChecked('git', ['clone', '--bare', source, remote]);
  const repository = pathToFileURL(remote).href;
  const graphId = `repo-${revision}-aaaaaaaaaa`;
  const graph = (marker: string): IntelligenceGraph => ({ schemaVersion: 2, analyzerVersion: ANALYZER_VERSION, graphId, project: 'Example', role: 'W', createdAt: new Date(0).toISOString(), repositoryRevision: revision,
    sourceFingerprint: 'fixture-source', topologyFingerprint: 'fixture-topology', evidenceFingerprint: 'fixture-evidence',
    sources: [{ id: 'repo:value.ts', kind: 'repository', locator: repository, revision, observedAt: new Date(0).toISOString(), available: true }],
    nodes: [{ id: 'fixture:marker', sourceId: 'repo:value.ts', kind: 'declared-field', name: marker, locator: 'value.ts:1', value: marker, raw: marker }], edges: [], evidence: [], namingDivergences: [], explicitValueConflicts: [], unmatchedNodeIds: [], unavailableSourceIds: [] });
  const currentness = { acceptedSemanticCurrent: false, sourceCurrent: true, topologyCurrent: true, evidenceCurrent: true, analyzerCurrent: true, schemaSupported: true, integrityCurrent: true, checkpointError: null };
  const bindings: ProjectAccessBinding[] = [], files: string[] = [];
  for (const marker of ['a', 'b']) {
    const canonical = path.join(root, `authority-${marker}`);
    const file = path.join(canonical, canonicalProjectStorageKey('Example'), `${revision}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(makeCanonicalGraphRecord({ project: 'Example', repository, revision, working: graph(marker), accepted: null, currentness })));
    files.push(file);
    bindings.push({ accountId: `account-${marker}`, bindingId: `binding-${marker}`, bindingVersion: 1, authorityId: `authority-${marker}`, internalProject: 'Example',
      config: { repository, defaultRef: 'refs/heads/main', allowedRefs: ['refs/heads/main'], revisionPolicy: 'repository-history', credential: { type: 'none' }, runtimeOrigins: ['https://runtime-fixture.invalid'] }, secretValues: {}, canonical: { kind: 'file', root: canonical } });
  }
  return { root, revision, repository, graphId, bindings, files };
}

test('actual graph caches and cold graphId reads stay inside exact adopted authorities', async () => {
  const f = await fixture(); const a = f.bindings[0]!, b = f.bindings[1]!;
  const bytes = await Promise.all(f.files.map(file => fs.readFile(file, 'utf8')));
  const run = <T>(binding: ProjectAccessBinding, fn: () => Promise<T>) => withProjectAccess(binding, async () => true, fn);
  try {
    clearGraphCache();
    const results = await Promise.all([a, b].map(binding => run(binding, async () => (await graphContext('Example')).graph)));
    assert.deepEqual(results.map(graph => graph.nodes[0]!.value), ['a', 'b']);
    assert.equal(results[0]!.graphId, results[1]!.graphId, 'graph identity is not an authorization token');
    await run(a, async () => { clearGraphCache(); assert.equal((graphCacheDiagnostics().repository as any).entries, 0); });
    await run(b, async () => assert.equal((graphCacheDiagnostics().repository as any).entries, 1));
    const cold = await run(a, async () => await graphContext('Example', { graphId: f.graphId }));
    assert.equal(cold.graph.nodes[0]!.value, 'a');
    assert.equal(cold.graph.project, 'Example', 'adoption does not rename graph identity');
    await run(a, async () => {
      await assert.rejects(() => graphContext('Other', { graphId: f.graphId }), /not authorized/);
      await assert.rejects(() => loadCanonicalGraph({ project: 'Other', repository: f.repository, revision: f.revision }), /not authorized/);
      await assert.rejects(() => saveCanonicalGraph(makeCanonicalGraphRecord({ project: 'Example', repository: f.repository, revision: f.revision, working: cold.graph, accepted: null, currentness: { acceptedSemanticCurrent: false, sourceCurrent: true, topologyCurrent: true, evidenceCurrent: true, analyzerCurrent: true, schemaSupported: true, integrityCurrent: true, checkpointError: null } })), /compute-only/);
      await assert.rejects(() => runCanonicalReconcileWorker({ project: 'Example', defaultBranch: 'main' }), /compute-only/);
      const revision = await resolveProjectRevision('Example');
      await withResolvedProjectCheckout(revision, async checkout => { assert.ok(checkout.root.includes(`binding-${projectAccessScopeKey()}`)); return null; });
    });
    assert.deepEqual(await Promise.all(f.files.map(file => fs.readFile(file, 'utf8'))), bytes, 'accepted/current fixture authority bytes remain unchanged');
  } finally { clearGraphCache(); await fs.rm(f.root, { recursive: true, force: true }); }
});

test('foreign runtime snapshots and diagnostic clearing cannot cross bindings', async () => {
  const f = await fixture(); const a = f.bindings[0]!, b = f.bindings[1]!;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => { assert.equal(new URL(String(input)).hostname, 'runtime-fixture.invalid'); return new Response('{"fixture":true}', { headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  const run = <T>(binding: ProjectAccessBinding, fn: () => Promise<T>) => withProjectAccess(binding, async () => true, fn);
  try {
    const snapshot = await run(a, async () => await scanGraph('Example', { ref: `commit:${f.revision}`, urls: ['https://runtime-fixture.invalid/state'] }));
    await run(b, async () => await assert.rejects(() => graphContext('Example', { graphId: snapshot.graphId }), /unavailable or expired/));
    await run(a, async () => assert.equal((await graphContext('Example', { graphId: snapshot.graphId })).graph.graphId, snapshot.graphId));
    for (const binding of [a, b]) await run(binding, async () => { recordToolExecution({ project: 'Example', tool: binding.bindingId, startedAt: new Date().toISOString(), durationMs: 1, status: 'ok' }); });
    await run(a, async () => { clearToolExecutionDiagnostics(); assert.equal(toolExecutionDiagnostics('Example'), null); });
    await run(b, async () => assert.equal(toolExecutionDiagnostics('Example')?.tool, b.bindingId));
  } finally { globalThis.fetch = originalFetch; clearGraphCache(); clearToolExecutionDiagnostics(); await fs.rm(f.root, { recursive: true, force: true }); }
});
