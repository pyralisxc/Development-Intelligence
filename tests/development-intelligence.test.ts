import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecked } from '../src/util/process.js';
import { refreshCodebase, readProjectState, listPublicProjects } from '../src/codebase/sourceManager.js';
import { callCurrentCodebase } from '../src/codebase/proxy.js';
import { loadSelectedBundleManifest } from '../src/codebase/bundles.js';
import { loadRegistry } from '../src/config/registry.js';
import { projectStatus } from '../src/projectStatus.js';
import { scanParity } from '../src/parity/scanner.js';
import { queryParity } from '../src/parity/query.js';
import { diffParity } from '../src/parity/diff.js';
import { listTools } from '../src/mcp.js';

async function commit(repo: string, message: string): Promise<string> {
  await runChecked('git', ['-C', repo, 'add', '.']);
  await runChecked('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message]);
  return (await runChecked('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}

async function makeFixture(): Promise<{ root: string; source: string; remote: string; config: string; data: string; artifacts: string; control: string; ephemeral: string; cbm: string; project: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-test-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const data = path.join(root, 'data');
  const artifacts = path.join(data, 'artifacts');
  const control = path.join(data, 'control');
  const ephemeral = path.join(data, 'ephemeral');
  const config = path.join(root, 'projects.json');
  const cbm = path.join(root, 'fake-cbm.mjs');
  await runChecked('git', ['init', '--bare', '--initial-branch=main', remote]);
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'panel.tsx'), `
export function Panel() {
  const handleManage = async () => {
    const response = await fetch('/api/manage', { method: 'POST' });
    if (response.ok) window.location.assign('/done');
  };
  return <button onClick={handleManage}>Manage item</button>;
}
export const actionDefinition = {
  id: 'item.manage',
  ownerFeature: 'storage',
  scope: 'object',
  automation: { kind: 'published-tool', tools: ['manage_item'] },
  result: 'mutation',
};
export const privateServiceConfig = { authorization: 'must-not-be-persisted-by-parity' };
server.registerTool('manage_item', { title: 'Manage item' }, async () => ({ ok: true }));
`);
  await fs.writeFile(path.join(source, 'README.md'), '# Sample Project\n\n- Manage item from the application.\n');
  await fs.writeFile(path.join(source, 'config.json'), JSON.stringify({ endpoint: '/api/manage', access_token: 'must-not-be-persisted-by-parity' }, null, 2));
  await fs.writeFile(path.join(root, 'outside-secret.json'), JSON.stringify({ secret: 'outside-managed-source' }));
  await fs.symlink('../../outside-secret.json', path.join(source, 'src', 'outside-link.json'));
  await commit(source, 'initial');
  await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await runChecked('git', ['-C', source, 'push', '-u', 'origin', 'main']);

  await fs.writeFile(cbm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const tool = args[1];
const payload = args[2] ? JSON.parse(args[2]) : {};
const cache = process.env.CBM_CACHE_DIR || path.join(process.cwd(), '.fake-cbm-cache');
fs.mkdirSync(cache, { recursive: true });
const rootFile = path.join(cache, 'root.txt');
if (tool === 'index_repository') {
  if (process.env.FAKE_CBM_FAIL === '1') {
    console.log(JSON.stringify({ status: 'degraded', nodes: 1, edges: 0 }));
  } else {
    fs.writeFileSync(rootFile, payload.repo_path || '');
    let artifactPresent = false;
    if (payload.persistence === true && process.env.FAKE_CBM_NO_ARTIFACT !== '1') {
      const artifactDir = path.join(payload.repo_path, '.codebase-memory');
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, 'graph.db.zst'), 'fake-portable-codebase-memory-graph');
      artifactPresent = true;
    } else if (fs.existsSync(path.join(payload.repo_path || '', '.codebase-memory', 'graph.db.zst'))) {
      artifactPresent = true;
    }
    console.log(JSON.stringify({ status: 'indexed', project: payload.name, nodes: 42, edges: 84, artifact_present: artifactPresent }));
  }
} else if (tool === 'index_status') {
  console.log(JSON.stringify({ status: 'ready', project: payload.project, total_nodes: 42, total_edges: 84 }));
} else if (tool === 'delete_project') {
  console.log(JSON.stringify({ deleted: payload.project }));
} else {
  const root = fs.existsSync(rootFile) ? fs.readFileSync(rootFile, 'utf8') : '';
  console.log(JSON.stringify({ tool, args: payload, project: payload.project, root_path: root, repo_path: root }));
}
`, { mode: 0o755 });

  return { root, source, remote, config, data, artifacts, control, ephemeral, cbm, project: 'SampleProject' };
}

function configure(fixture: Awaited<ReturnType<typeof makeFixture>>, runtimeOrigins: string[] = []) {
  process.env.DEVINT_PROJECTS_FILE = fixture.config;
  process.env.DEVINT_DATA_DIR = fixture.data;
  process.env.DEVINT_ARTIFACT_DIR = fixture.artifacts;
  process.env.DEVINT_CONTROL_DIR = fixture.control;
  process.env.DEVINT_EPHEMERAL_DIR = fixture.ephemeral;
  process.env.DEVINT_CBM_BINARY = fixture.cbm;
  process.env.CBM_WORKERS = '1';
  delete process.env.DEVINT_GCS_BUCKET;
  delete process.env.DEVINT_FIRESTORE_ENABLED;
  delete process.env.DEVINT_CLOUD_RUN_JOB_RESOURCE;
  return fs.writeFile(fixture.config, JSON.stringify({
    [fixture.project]: {
      repository: pathToFileURL(fixture.remote).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      credential: { type: 'none' },
      runtimeOrigins,
    },
  }, null, 2));
}

test('immutable revision bundle promotion preserves last-known-good state and clean public identity', async () => {
  const fixture = await makeFixture();
  try {
    await configure(fixture);
    const first = await refreshCodebase(fixture.project);
    assert.equal(first.changed, true);
    assert.equal(first.promoted, true);
    const firstState = await readProjectState(fixture.project);
    assert.ok(firstState.selectedSha);
    assert.ok(firstState.selectedBundleId);
    assert.equal('selectedWorktree' in firstState, false);
    assert.equal('selectedCbmProject' in firstState, false);

    const manifest = await loadSelectedBundleManifest(fixture.project);
    assert.equal(manifest?.sourceSha, firstState.selectedSha);
    assert.equal(manifest?.schemaVersion, 1);
    assert.ok(manifest?.artifacts.graph.sha256);
    assert.equal(JSON.stringify(manifest).includes(fixture.ephemeral), false, 'bundle manifest must not persist ephemeral filesystem paths');

    const query = await callCurrentCodebase(fixture.project, 'search_graph', { query: 'Panel' }) as any;
    assert.equal(query.tool, 'search_graph');
    assert.equal(JSON.stringify(query).includes(fixture.ephemeral), false, 'query results must sanitize ephemeral hydration paths');

    const projects = await listPublicProjects();
    assert.deepEqual(projects.map(item => item.project), [fixture.project]);
    assert.equal('selectedCbmProject' in projects[0]!, false);

    await fs.writeFile(path.join(fixture.source, 'src', 'new.ts'), 'export const newer = true;\n');
    const secondSha = await commit(fixture.source, 'second');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'main']);

    process.env.FAKE_CBM_FAIL = '1';
    await assert.rejects(refreshCodebase(fixture.project), /healthy index/);
    const afterFailed = await readProjectState(fixture.project);
    assert.equal(afterFailed.selectedSha, firstState.selectedSha, 'failed indexing must not replace selected revision bundle');
    assert.equal(afterFailed.selectedBundleId, firstState.selectedBundleId);

    delete process.env.FAKE_CBM_FAIL;
    const second = await refreshCodebase(fixture.project);
    assert.equal(second.indexedSha, secondSha);
    const afterSuccess = await readProjectState(fixture.project);
    assert.equal(afterSuccess.selectedSha, secondSha);
    assert.notEqual(afterSuccess.selectedBundleId, firstState.selectedBundleId);

    const status = await projectStatus(fixture.project, true);
    assert.equal(status.sourceCurrent, true);
    assert.equal(status.selectedSha, secondSha);
    assert.equal(JSON.stringify(status).includes('devint-index-'), false, 'public status must not leak internal Codebase Memory identity');
  } finally {
    delete process.env.FAKE_CBM_FAIL;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('healthy CBM status without a portable graph artifact is never promoted', async () => {
  const fixture = await makeFixture();
  try {
    await configure(fixture);
    process.env.FAKE_CBM_NO_ARTIFACT = '1';
    await assert.rejects(refreshCodebase(fixture.project), /required portable graph artifact/);
    const state = await readProjectState(fixture.project);
    assert.equal(state.selectedSha, null);
    assert.equal(state.selectedBundleId, null);
    assert.equal(state.lastIndexStatus, 'failed');
  } finally {
    delete process.env.FAKE_CBM_NO_ARTIFACT;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('bundle checksum corruption fails closed before Codebase Memory hydration', async () => {
  const fixture = await makeFixture();
  try {
    await configure(fixture);
    await refreshCodebase(fixture.project);
    const manifest = await loadSelectedBundleManifest(fixture.project);
    assert.ok(manifest);
    const graphPath = path.join(fixture.artifacts, manifest!.artifacts.graph.key);
    await fs.appendFile(graphPath, 'tampered');
    await assert.rejects(callCurrentCodebase(fixture.project, 'search_graph', { query: 'Panel' }), /checksum mismatch/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('force refresh repairs damaged derived state without changing source identity', async () => {
  const fixture = await makeFixture();
  try {
    await configure(fixture);
    await refreshCodebase(fixture.project);
    const before = await readProjectState(fixture.project);
    const beforeManifest = await loadSelectedBundleManifest(fixture.project);
    assert.ok(before.selectedSha);
    assert.ok(before.selectedBundleId);
    assert.ok(beforeManifest);

    await fs.appendFile(path.join(fixture.artifacts, beforeManifest!.artifacts.graph.key), 'tampered');
    await assert.rejects(callCurrentCodebase(fixture.project, 'search_graph', { query: 'Panel' }), /checksum mismatch/);

    const repaired = await refreshCodebase(fixture.project, undefined, true);
    assert.equal(repaired.promoted, true);
    assert.equal(repaired.forced, true);
    assert.equal(repaired.indexedSha, before.selectedSha);
    const after = await readProjectState(fixture.project);
    assert.equal(after.selectedSha, before.selectedSha, 'repair must preserve canonical source revision');
    assert.notEqual(after.selectedBundleId, before.selectedBundleId, 'repair must create and promote a fresh immutable bundle generation');

    const query = await callCurrentCodebase(fixture.project, 'search_graph', { query: 'Panel' }) as any;
    assert.equal(query.tool, 'search_graph');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('parity scan reuses indexed repository observations and combines read-only runtime evidence', async () => {
  const fixture = await makeFixture();
  const runtime = http.createServer((_req: any, res: any) => {
    res.writeHead(200, { 'content-type': 'text/html', etag: 'runtime-v1' });
    res.end('<html><head><title>Sample</title></head><body><a href="/account">Manage item</a></body></html>');
  });
  await new Promise<void>(resolve => runtime.listen(0, '127.0.0.1', resolve));
  const address = runtime.address() as any;
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await configure(fixture, [origin]);
    await refreshCodebase(fixture.project);
    const repositoryOnly = await scanParity(fixture.project);
    assert.ok(repositoryOnly.sources.some(source => source.kind === 'repository' && source.available));
    const scan = await scanParity(fixture.project, [`${origin}/`]);
    assert.equal(scan.project, fixture.project);
    assert.ok(scan.sources.some(source => source.kind === 'runtime-http' && source.available));
    assert.ok(scan.observations.some(obs => obs.kind === 'ui-element' && obs.name === 'Manage item'));
    assert.ok(scan.observations.some(obs => obs.kind === 'http-call' && JSON.stringify(obs.value).includes('/api/manage')));
    assert.ok(scan.observations.some(obs => obs.kind === 'mcp-tool' && obs.name === 'manage_item'));
    assert.ok(scan.observations.some(obs => obs.kind === 'declared-field' && obs.field === 'ownerFeature' && obs.value === 'storage'));
    assert.equal(scan.observations.some(obs => obs.raw.includes('must-not-be-persisted-by-parity')), false);
    assert.ok(scan.observations.some(obs => obs.field === 'access_token' && obs.value === '<redacted>'));
    assert.ok(scan.observations.some(obs => obs.field === 'authorization' && obs.value === '<redacted>'));
    assert.equal(scan.observations.some(obs => obs.raw.includes('outside-managed-source')), false);
    assert.ok(scan.sources.find(source => source.kind === 'repository')?.warnings?.some(warning => warning.includes('non-regular tracked file')));
    assert.ok(scan.resolutions.some(rel => rel.kind === 'handled_by' && rel.strategy === 'syntax' && rel.status === 'resolved'));
    assert.ok(scan.resolutions.some(rel => rel.status === 'candidate' && ['exact-value', 'exact-name'].includes(rel.strategy)));

    const queried = await queryParity({ project: fixture.project, scanId: scan.scanId, query: 'manage_item' });
    assert.ok((queried.observationTotal as number) >= 1);

    const original = await fs.readFile(path.join(fixture.source, 'src', 'panel.tsx'), 'utf8');
    await fs.writeFile(path.join(fixture.source, 'src', 'panel.tsx'), original.replace('Manage item</button>', 'Administer item</button>'));
    await commit(fixture.source, 'rename ui');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'main']);
    await refreshCodebase(fixture.project);
    const nextScan = await scanParity(fixture.project, [`${origin}/`]);
    const diff = await diffParity(fixture.project, scan.scanId, nextScan.scanId);
    const observationDiff = diff.observations as any;
    assert.ok(observationDiff.changed.length > 0 || observationDiff.added.length > 0 || observationDiff.removed.length > 0);
  } finally {
    await new Promise<void>(resolve => runtime.close(() => resolve()));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('public MCP tool surface stays tool-only and respects immutable revision semantics', () => {
  const listed = listTools();
  const names = listed.map(tool => tool.name);
  for (const expected of ['refresh_codebase', 'index_status', 'search_graph', 'trace_path', 'scan_parity', 'query_parity', 'diff_parity', 'parity_status']) assert.ok(names.includes(expected), expected);
  for (const forbidden of ['manage_adr', 'index_repository', 'ingest_traces', 'authorize_build', 'create_pull_request', 'developer_os']) assert.equal(names.includes(forbidden), false, forbidden);
  const byName = new Map(listed.map(tool => [tool.name, tool]));
  assert.equal(byName.get('list_projects')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('refresh_codebase')?.annotations?.readOnlyHint, false);
  assert.equal((byName.get('refresh_codebase')?.inputSchema as any)?.properties?.force?.type, 'boolean');
  assert.equal(byName.get('scan_parity')?.annotations?.readOnlyHint, false);
  assert.equal(byName.get('delete_project')?.annotations?.destructiveHint, true);
});

test('registry rejects project identities that collide in derived storage', async () => {
  const fixture = await makeFixture();
  try {
    process.env.DEVINT_PROJECTS_FILE = fixture.config;
    await fs.writeFile(fixture.config, JSON.stringify({
      'Sample/Project': { repository: pathToFileURL(fixture.remote).href, defaultRef: 'refs/heads/main', allowedRefs: ['refs/heads/main'], credential: { type: 'none' } },
      'Sample-Project': { repository: pathToFileURL(fixture.remote).href, defaultRef: 'refs/heads/main', allowedRefs: ['refs/heads/main'], credential: { type: 'none' } },
    }, null, 2));
    await assert.rejects(loadRegistry(), /collide on derived storage key/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('modern MCP HTTP surface follows the 2026-07-28 stateless contract', async () => {
  const fixture = await makeFixture();
  await configure(fixture);
  process.env.DEVINT_AUTH_MODE = 'none';
  process.env.DEVINT_ALLOW_UNAUTHENTICATED = '1';
  const { createDevelopmentIntelligenceServer } = await import('../src/http.js');
  const server = createDevelopmentIntelligenceServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'development-intelligence-test', version: '2.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  try {
    const discover = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } }) });
    assert.equal(discover.status, 200);
    const discoverBody = await discover.json() as any;
    assert.equal(discoverBody.result.resultType, 'complete');
    assert.deepEqual(discoverBody.result.supportedVersions, ['2026-07-28']);
    assert.equal(discoverBody.result._meta['io.modelcontextprotocol/serverInfo'].name, 'Development Intelligence');

    const list = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } }) });
    assert.equal(list.status, 200);
    const listBody = await list.json() as any;
    assert.equal(listBody.result.resultType, 'complete');
    assert.equal(listBody.result.cacheScope, 'private');
    assert.ok(listBody.result.tools.some((tool: any) => tool.name === 'scan_parity'));
    assert.ok(!listBody.result.tools.some((tool: any) => tool.name === 'ingest_traces'));

    const call = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'list_projects' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {}, _meta: meta } }) });
    assert.equal(call.status, 200);
    const callBody = await call.json() as any;
    assert.equal(callBody.result.resultType, 'complete');
    assert.equal(callBody.result.structuredContent.items[0].project, fixture.project);

    const mismatch = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list', 'mcp-name': 'wrong' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_projects', arguments: {}, _meta: meta } }) });
    assert.equal(mismatch.status, 400);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    delete process.env.DEVINT_AUTH_MODE;
    delete process.env.DEVINT_ALLOW_UNAUTHENTICATED;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('authenticated runtime observation refuses cross-origin redirects before forwarding credentials', async () => {
  const fixture = await makeFixture();
  let credentialReachedSecondOrigin = false;
  const destination = http.createServer((req: any, res: any) => {
    if (req.headers.authorization) credentialReachedSecondOrigin = true;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<button>Should not be observed</button>');
  });
  await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve));
  const destinationAddress = destination.address() as any;
  const destinationOrigin = `http://127.0.0.1:${destinationAddress.port}`;
  const redirector = http.createServer((_req: any, res: any) => { res.writeHead(302, { location: `${destinationOrigin}/target` }); res.end(); });
  await new Promise<void>(resolve => redirector.listen(0, '127.0.0.1', resolve));
  const redirectAddress = redirector.address() as any;
  const redirectOrigin = `http://127.0.0.1:${redirectAddress.port}`;
  try {
    await configure(fixture, [redirectOrigin, destinationOrigin]);
    process.env.TEST_RUNTIME_AUTH = 'Bearer test-secret';
    await fs.writeFile(fixture.config, JSON.stringify({
      [fixture.project]: {
        repository: pathToFileURL(fixture.remote).href,
        defaultRef: 'refs/heads/main',
        allowedRefs: ['refs/heads/main'],
        credential: { type: 'none' },
        runtimeOrigins: [redirectOrigin, destinationOrigin],
        runtimeHeaders: [{ name: 'Authorization', valueEnv: 'TEST_RUNTIME_AUTH' }],
      },
    }, null, 2));
    await refreshCodebase(fixture.project);
    const scan = await scanParity(fixture.project, [`${redirectOrigin}/start`]);
    const runtimeSource = scan.sources.find(source => source.id.startsWith('runtime:'));
    assert.equal(runtimeSource?.available, false);
    assert.match(runtimeSource?.error ?? '', /redirects must remain/);
    assert.equal(credentialReachedSecondOrigin, false);
  } finally {
    delete process.env.TEST_RUNTIME_AUTH;
    await new Promise<void>(resolve => redirector.close(() => resolve()));
    await new Promise<void>(resolve => destination.close(() => resolve()));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
