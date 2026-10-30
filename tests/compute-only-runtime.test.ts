import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { callTool } from '../src/mcp.js';
import { createDevelopmentIntelligenceServer } from '../src/http.js';
import { scanGraph, clearGraphCache, currentGraph } from '../src/intelligence/service.js';
import { workingToAcceptedGraph } from '../src/intelligence/checkpoint.js';
import { loadCanonicalGraph, makeCanonicalGraphRecord, saveCanonicalGraph, writeCanonicalDerivedObject, writeCanonicalDerivedObjectConditional } from '../src/intelligence/canonicalStore.js';
import { runChecked } from '../src/util/process.js';

test('compute-only runtime reads remote authority and replays exact source but cannot publish through any entry', async () => {
  const names = ['DEVINT_COMPUTE_ONLY','DEVINT_PROJECTS_JSON','DEVINT_SCRATCH_DIR','DEVINT_CANONICAL_GRAPH_DIR','DEVINT_CANONICAL_BLOB_STORE_ID','DEVINT_CANONICAL_BLOB_TOKEN','DEVINT_AUTH_MODE','DEVINT_BEARER_TOKEN','DEVINT_ALLOWED_HOSTS'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-compute-role-'));
  const originalFetch = globalThis.fetch;
  let server: any;
  try {
    const source = path.join(root, 'source');
    await runChecked('git', ['init', '--initial-branch=main', source]);
    await fs.writeFile(path.join(source, 'value.ts'), 'export const observed = 1;\n');
    await runChecked('git', ['-C', source, 'add', '.']);
    await runChecked('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    const sha = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    const project = 'ComputeFixture';
    const repository = pathToFileURL(source).href;
    process.env.DEVINT_PROJECTS_JSON = JSON.stringify({ [project]: { repository, defaultRef:'main', allowedRefs:['main'], revisionPolicy:'repository-history', credential:{ type:'none' } } });
    process.env.DEVINT_SCRATCH_DIR = path.join(root, 'scratch');
    process.env.DEVINT_COMPUTE_ONLY = '1';
    delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    clearGraphCache();
    const graph = await scanGraph(project, { ref: `commit:${sha}` });
    clearGraphCache();
    const replay = await currentGraph(project, undefined, graph.graphId);
    assert.equal(replay.repositoryRevision, sha, 'cache-loss graphId reconstruction remains exact and process-only');
    const record = makeCanonicalGraphRecord({ project, repository, revision:sha, working:graph, accepted:workingToAcceptedGraph({ graph, repository }), currentness: { acceptedSemanticCurrent:true, sourceCurrent:true, topologyCurrent:true, evidenceCurrent:true, analyzerCurrent:true, schemaSupported:true, integrityCurrent:true, checkpointError:null } });
    // Deliberately configured write-capable-looking credentials. Role, not a
    // missing credential/backend, must prevent every publication attempt.
    process.env.DEVINT_CANONICAL_BLOB_STORE_ID = 'fixture-store';
    process.env.DEVINT_CANONICAL_BLOB_TOKEN = 'fixture-rw-credential';
    const methods: string[] = [];
    globalThis.fetch = (async (_input: any, init?: any) => {
      methods.push(init?.method ?? 'GET');
      const body = JSON.stringify(record);
      return new Response(body, { headers:{ 'content-type':'application/json', 'content-length':String(Buffer.byteLength(body)) } });
    }) as typeof fetch;
    const loaded = await loadCanonicalGraph({ project, repository, revision:sha });
    assert.equal(loaded.record?.accepted?.repositoryRevision, sha);
    await assert.rejects(saveCanonicalGraph(record), /compute-only/);
    await assert.rejects(writeCanonicalDerivedObject(project, 'query/current.json', '{}'), /compute-only/);
    await assert.rejects(writeCanonicalDerivedObjectConditional(project, 'semantic/authority-v1.json', '{}', 'application/json', null), /compute-only/);
    await assert.rejects(callTool('scan_graph', { project }), /immutable/);
    await assert.rejects(callTool('bootstrap_semantic_authority_portfolio', {}), /compute-only/);
    process.env.DEVINT_AUTH_MODE = 'bearer';
    process.env.DEVINT_BEARER_TOKEN = 'fixture-agent-token';
    delete process.env.DEVINT_ALLOWED_HOSTS;
    server = createDevelopmentIntelligenceServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const routes = ['/internal/reconcile-canonical','/workbench/reconcile-canonical', ...['portfolio-bootstrap','bootstrap','change-verify','enrollment','review','ai-proposal','lineage'].map(name => `/workbench/semantics/${name}`)];
    for (const route of routes) {
      const response = await originalFetch(origin + route, { method:route.startsWith('/internal/') ? 'GET' : 'POST', headers:{ authorization:'Bearer fixture-agent-token' } });
      assert.equal(response.status, 403, route);
      assert.match(await response.text(), /COMPUTE_ONLY_AUTHORITY_DENIED/);
    }
    assert.ok(methods.length > 0, 'remote accepted state was actually read');
    assert.deepEqual([...new Set(methods)], ['GET'], 'no PUT/POST/DELETE reaches configured remote authority');
    const canonical = path.join(root, 'must-not-exist');
    process.env.DEVINT_CANONICAL_GRAPH_DIR = canonical;
    await assert.rejects(saveCanonicalGraph(record), /compute-only/);
    await assert.rejects(writeCanonicalDerivedObject(project, 'object.json', '{}'), /compute-only/);
    await assert.rejects(writeCanonicalDerivedObjectConditional(project, 'object.json', '{}', 'application/json', null), /compute-only/);
    await assert.rejects(fs.stat(canonical), /ENOENT/);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(resolve)); }
    clearGraphCache();
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    await fs.rm(root, { recursive:true, force:true });
  }
});
