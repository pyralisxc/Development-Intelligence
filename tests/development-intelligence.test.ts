import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecked } from '../src/util/process.js';
import { sealLocalGraph } from '../src/intelligence/local.js';
import { graphStatus, scanGraph, clearGraphCache } from '../src/intelligence/service.js';
import { diffAcceptedToWorking, parityLens, searchGraph, traceGraph } from '../src/intelligence/query.js';
import { searchCode, getCodeSnippet } from '../src/intelligence/code.js';
import { callTool, listTools } from '../src/mcp.js';
import { loadRegistry } from '../src/config/registry.js';
import { evaluateParityContract } from '../src/intelligence/parityContract.js';
import { sourceFingerprint } from '../src/intelligence/repository.js';

async function commit(repo: string, message: string): Promise<string> {
  await runChecked('git', ['-C', repo, 'add', '.']);
  await runChecked('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message]);
  return (await runChecked('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}

async function makeFixture(): Promise<{ root: string; source: string; remote: string; config: string; scratch: string; project: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-git-native-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const scratch = path.join(root, 'scratch');
  const project = 'SampleProject';
  await fs.mkdir(scratch, { recursive: true });
  await runChecked('git', ['init', '--bare', '--initial-branch=main', remote]);
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'helper.ts'), `
export function helper() { return 'ok'; }
`);
  await fs.writeFile(path.join(source, 'src', 'panel.tsx'), `
import { helper } from './helper';
export function Panel() {
  const handleManage = async () => {
    helper();
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
export const privateServiceConfig = { authorization: 'must-not-be-persisted' };
server.registerTool('manage_item', { title: 'Manage item' }, async () => ({ ok: true }));
`);
  await fs.writeFile(path.join(source, 'README.md'), '# Sample Project\n\nManage item from the application.\n');
  await fs.writeFile(path.join(source, 'config.json'), JSON.stringify({ endpoint: '/api/manage', access_token: 'must-not-be-persisted' }, null, 2));
  await fs.writeFile(path.join(source, 'src', 'panel.css'), `
:root { --action-gap: 0.5rem; --api-token: css-secret-value; }
.action-rail, .manage-button { display: flex; overflow-x: auto; gap: var(--action-gap); }
.manage-button::before { content: "{"; }
@media (max-width: 720px) { .action-rail { position: sticky; bottom: 0; } }
`);
  await fs.writeFile(path.join(root, 'outside-secret.json'), JSON.stringify({ secret: 'outside-managed-source' }));
  const outsideLink = path.join(source, 'src', 'outside-link.json');
  let nativeSymlink = true;
  try {
    await fs.symlink('../../outside-secret.json', outsideLink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    nativeSymlink = false;
    await fs.writeFile(outsideLink, '../../outside-secret.json');
  }
  await commit(source, 'initial source');
  if (!nativeSymlink) {
    const blob = (await runChecked('git', ['-C', source, 'hash-object', '-w', 'src/outside-link.json'])).stdout.trim();
    await runChecked('git', ['-C', source, 'update-index', '--add', '--cacheinfo', '120000', blob, 'src/outside-link.json']);
    await runChecked('git', ['-C', source, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--amend', '--no-edit']);
  }
  await sealLocalGraph(source, project);
  await commit(source, 'seal accepted graph A');
  await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await runChecked('git', ['-C', source, 'push', '-u', 'origin', 'main']);

  process.env.DEVINT_PROJECTS_FILE = config;
  process.env.DEVINT_SCRATCH_DIR = scratch;
  process.env.DEVINT_GRAPH_CACHE_SIZE = '3';
  delete process.env.DEVINT_DATA_DIR;
  await fs.writeFile(config, JSON.stringify({
    [project]: {
      repository: pathToFileURL(remote).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      revisionPolicy: 'repository-history',
      credential: { type: 'none' },
      runtimeOrigins: [],
    },
  }, null, 2));
  clearGraphCache();
  return { root, source, remote, config, scratch, project };
}

async function close(server: any) { await new Promise<void>(resolve => server.close(() => resolve())); }

test('source fingerprints use Git content filters instead of platform-specific working bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-portable-fingerprint-'));
  try {
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await fs.writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
    await fs.writeFile(path.join(root, 'sample.txt'), 'one\r\ntwo\r\n');
    await commit(root, 'portable source');
    const windowsBytes = await sourceFingerprint(root);
    await fs.writeFile(path.join(root, 'sample.txt'), 'one\ntwo\n');
    const linuxBytes = await sourceFingerprint(root);
    assert.equal(windowsBytes, linuxBytes, 'line-ending checkout policy must not change canonical source identity');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Git-owned A/W/B graph lifecycle distinguishes source drift from semantic topology drift', async () => {
  const fixture = await makeFixture();
  try {
    const initial = await graphStatus(fixture.project) as any;
    assert.equal(initial.accepted.current, true);
    assert.equal(initial.currentness.acceptedSemanticCurrent, true);
    assert.equal(initial.accepted.sourceFingerprint, initial.working.sourceFingerprint);
    assert.ok(initial.working.nodes > 0);
    assert.ok(initial.working.edges > 0);

    const beforeGraph = await scanGraph(fixture.project);
    assert.ok(beforeGraph.nodes.some(node => node.kind === 'function' && node.name === 'Panel'));
    assert.ok(beforeGraph.nodes.some(node => node.kind === 'file' && node.name === 'src/panel.tsx'));
    assert.ok(beforeGraph.nodes.some(node => node.kind === 'css-selector' && node.name === '.action-rail'));
    assert.ok(beforeGraph.nodes.some(node => node.kind === 'css-at-rule' && String(node.name).includes('max-width: 720px')));
    assert.ok(beforeGraph.nodes.some(node => node.kind === 'css-custom-property' && node.name === '--action-gap'));
    assert.equal(beforeGraph.coverage?.files.find(file => file.path === 'src/panel.css')?.status, 'complete');
    assert.equal(beforeGraph.nodes.some(node => node.raw.includes('must-not-be-persisted')), false, 'secret-like values must remain redacted');
    assert.equal(beforeGraph.nodes.some(node => node.raw.includes('css-secret-value')), false, 'secret-like CSS custom properties must remain redacted');
    assert.equal(beforeGraph.nodes.some(node => node.raw.includes('outside-managed-source')), false, 'tracked symlinks must not escape repository root');
    const compactScan = await callTool('scan_graph', { project: fixture.project }) as any;
    assert.equal(compactScan.coverage.files, undefined, 'ordinary scan responses stay compact; detailed coverage has a dedicated tool');

    const text = await fs.readFile(path.join(fixture.source, 'src', 'panel.tsx'), 'utf8');
    await fs.writeFile(path.join(fixture.source, 'src', 'panel.tsx'), text.replace('Manage item</button>', 'Administer item</button>'));
    await commit(fixture.source, 'working representation change');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'main']);
    clearGraphCache(fixture.project);

    const stale = await graphStatus(fixture.project) as any;
    assert.equal(stale.accepted.current, false, 'A is not accepted-current for a different source fingerprint until B is sealed');
    assert.equal(stale.currentness.sourceCurrent, false);
    assert.equal(stale.currentness.topologyCurrent, true, 'representation-only churn must not manufacture semantic topology drift');
    const delta = await diffAcceptedToWorking(fixture.project) as any;
    const semanticChanges = delta.semantic.nodes.added.length + delta.semantic.nodes.removed.length + delta.semantic.nodes.changed.length
      + delta.semantic.edges.added.length + delta.semantic.edges.removed.length + delta.semantic.edges.changed.length;
    assert.equal(semanticChanges, 0, 'semantic A→W diff must ignore representation-only source churn');

    await sealLocalGraph(fixture.source, fixture.project);
    await commit(fixture.source, 'seal candidate graph B');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'main']);
    clearGraphCache(fixture.project);
    const promoted = await graphStatus(fixture.project) as any;
    assert.equal(promoted.accepted.current, true, 'after Git commit/merge semantics, sealed B is the accepted A for that revision');

    const scratchChildren = await fs.readdir(fixture.scratch);
    assert.deepEqual(scratchChildren, [], 'service-local checkout state must be disposable after each source operation');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('runtime observation snapshots are explicit and never contaminate canonical source W', async () => {
  const fixture = await makeFixture();
  const runtime = http.createServer((_req: any, res: any) => {
    res.writeHead(200, { 'content-type': 'text/html', etag: 'runtime-v1' });
    res.end('<html><body><a href="/account">Manage item</a></body></html>');
  });
  await new Promise<void>(resolve => runtime.listen(0, '127.0.0.1', resolve));
  const address = runtime.address() as any;
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const registry = JSON.parse(await fs.readFile(fixture.config, 'utf8'));
    registry[fixture.project].runtimeOrigins = [origin];
    await fs.writeFile(fixture.config, JSON.stringify(registry, null, 2));
    clearGraphCache(fixture.project);
    const snapshot = await scanGraph(fixture.project, { urls: [`${origin}/`] });
    assert.match(snapshot.graphId, /^snapshot-/);
    assert.ok(snapshot.sources.some(source => source.kind === 'runtime-http'));
    assert.ok(snapshot.nodes.some(node => node.kind === 'ui-element' && node.name === 'Manage item'));

    const snapshotSearch = await searchGraph({ project: fixture.project, graphId: snapshot.graphId, kinds: ['http-status'] }) as any;
    assert.equal(snapshotSearch.nodes.length, 1, 'explicit graphId must address runtime evidence');
    const canonicalSearch = await searchGraph({ project: fixture.project, kinds: ['http-status'] }) as any;
    assert.equal(canonicalSearch.nodes.length, 0, 'ordinary project/ref queries must remain canonical source W');

    assert.ok(snapshot.nodes.some(node => node.kind === 'http-call' && JSON.stringify(node.value).includes('/api/manage')));
    assert.ok(snapshot.nodes.some(node => node.kind === 'mcp-tool' && node.name === 'manage_item'));
    assert.ok(snapshot.edges.some(edge => edge.kind === 'handled_by' && edge.status === 'resolved'));

    const search = await searchGraph({ project: fixture.project, query: 'helper' }) as any;
    assert.ok(search.nodes.some((node: any) => node.name === 'helper'));
    const helperFunction = snapshot.nodes.find(node => node.kind === 'function' && node.name === 'helper');
    assert.ok(helperFunction, 'fixture helper function should have one exact structural identity');
    const trace = await traceGraph({ project: fixture.project, node: 'Panel', direction: 'outbound', depth: 4 }) as any;
    assert.ok(trace.nodes.some((node: any) => node.name === 'helper'), 'native graph traversal should cross module imports and expose called symbols');
    const reverseTrace = await traceGraph({ project: fixture.project, node: helperFunction!.id, direction: 'inbound', depth: 4 }) as any;
    assert.ok(reverseTrace.nodes.some((node: any) => node.name === 'handleManage'), 'cross-file caller discovery should reach the importing caller');
    assert.ok(snapshot.nodes.some(node => node.kind === 'import-binding' && node.name === 'helper'));
    assert.ok(snapshot.edges.some(edge => edge.kind === 'imports' && edge.status === 'resolved'));
    assert.ok(snapshot.edges.some(edge => edge.kind === 'calls' && edge.strategy === 'module-resolution'));

    const expectedNode = snapshot.nodes.find(node => node.layer === 'semantic') ?? snapshot.nodes[0]!;
    const expectedEdge = snapshot.edges.find(edge => edge.status === 'resolved' && edge.from && edge.to)!;
    assert.ok(expectedEdge, 'fixture must expose one resolved relationship for parity-contract evaluation');
    const parity = await evaluateParityContract({
      project: fixture.project,
      graphId: snapshot.graphId,
      contract: {
        version: 1,
        name: 'Manage item parity',
        entities: [
          { id: expectedNode.id, requirement: 'required' },
          { id: 'capability:not-observed', requirement: 'required' },
          { id: expectedNode.id, requirement: 'forbidden' },
        ],
        relationships: [
          { from: expectedEdge.from!, kind: expectedEdge.kind, to: expectedEdge.to!, requirement: 'required' },
          { from: expectedEdge.from!, kind: expectedEdge.kind, to: expectedEdge.to!, requirement: 'forbidden' },
          { from: 'capability:not-observed', kind: 'exposed-on', to: 'surface:not-observed', requirement: 'required' },
        ],
      },
    }) as any;
    assert.equal(parity.passed, false);
    assert.deepEqual(parity.counts, { satisfied: 2, missing: 0, forbiddenPresent: 2, unproven: 2 }, 'the intentionally skipped symlink source keeps negative expectations unproven');
    assert.match(parity.note, /ephemerally/i);

    const code = await searchCode({ project: fixture.project, graphId: snapshot.graphId, pattern: 'fetch', limit: 10 }) as any;
    assert.equal(code.revision, snapshot.repositoryRevision);
    assert.ok(code.matches.some((match: any) => match.file === 'src/panel.tsx'));
    const snippet = await getCodeSnippet({ project: fixture.project, graphId: snapshot.graphId, node: helperFunction!.id, context: 2 }) as any;
    assert.equal(snippet.revision, snapshot.repositoryRevision);
    assert.equal(snippet.file, 'src/helper.ts');
    assert.ok(snippet.lines.some((line: any) => line.text.includes('helper')));

    const canonical = await scanGraph(fixture.project);
    assert.match(canonical.graphId, new RegExp(`^repo-${canonical.repositoryRevision}-[0-9a-f]{10}$`));
    const groupedSearch = await searchGraph({ project: fixture.project, graphId: canonical.graphId, queries: ['action-rail', 'overflow-x', 'helper'], limit: 20 }) as any;
    assert.deepEqual(groupedSearch.results.map((result: any) => result.query), ['action-rail', 'overflow-x', 'helper']);
    assert.ok(groupedSearch.results.every((result: any) => result.nodeTotal > 0), 'grouped search should evaluate independent terms against one canonical graph');
    const groupedParity = await parityLens({ project: fixture.project, graphId: canonical.graphId, queries: ['storage', 'manage'], limit: 20 }) as any;
    assert.deepEqual(groupedParity.results.map((result: any) => result.query), ['storage', 'manage']);

    clearGraphCache(fixture.project);
    const reconstructed = await searchGraph({ project: fixture.project, graphId: canonical.graphId, query: 'helper' }) as any;
    assert.equal(reconstructed.graphId, canonical.graphId, 'canonical graph identifiers must reconstruct exact Git truth after process-local cache loss');
    await assert.rejects(
      () => searchGraph({ project: fixture.project, graphId: snapshot.graphId, query: 'Manage item' }),
      /Runtime graph snapshot is unavailable or expired/,
      'runtime overlays remain intentionally ephemeral',
    );
  } finally {
    await close(runtime);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('public tool surface is the intrinsic DI and Workbench contract, not development methodology or housekeeping', () => {
  const listed = listTools();
  const names = listed.map(tool => tool.name);
  assert.deepEqual(names, [
    'list_projects',
    'resolve_revision',
    'project_status',
    'project_overview',
    'query_intelligence',
    'inspect_entity',
    'list_sources',
    'query_source',
    'scan_graph',
    'search_graph',
    'trace_path',
    'search_code',
    'get_code_snippet',
    'get_graph_schema',
    'get_architecture',
    'check_graph_coverage',
    'get_evidence',
    'diff_graph',
    'query_parity',
    'evaluate_parity',
  ]);
  for (const retired of [
    'graph_status', 'query_graph', 'scan_parity', 'diff_parity', 'clear_cache',
    'refresh_codebase', 'index_status', 'ingest_traces', 'delete_project', 'manage_adr',
    'authorize_build', 'create_pull_request', 'developer_os',
  ]) assert.equal(names.includes(retired), false, retired);
  const serialized = JSON.stringify(listed);
  assert.equal(/Codebase Memory|CBM_CACHE_DIR|graph\.db\.zst/i.test(serialized), false);
  const byName = new Map(listed.map(tool => [tool.name, tool]));
  assert.equal(byName.get('scan_graph')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('query_source')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('query_source')?.annotations?.openWorldHint, true);
  assert.equal(byName.get('query_parity')?.annotations?.openWorldHint, true);
  assert.equal(byName.get('evaluate_parity')?.annotations?.readOnlyHint, true);
});

test('registry rejects project identities that collide in derived keys', async () => {
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

test('modern MCP HTTP contract and human Workbench remain available', async () => {
  const fixture = await makeFixture();
  process.env.DEVINT_AUTH_MODE = 'none';
  process.env.DEVINT_ALLOW_UNAUTHENTICATED = '1';
  const { createDevelopmentIntelligenceServer } = await import('../src/http.js');
  const server = createDevelopmentIntelligenceServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoint = `${origin}/mcp`;
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'development-intelligence-test', version: '2.1.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  try {
    const discover = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } }) });
    assert.equal(discover.status, 200);
    const discoverBody = await discover.json() as any;
    assert.equal(discoverBody.result.resultType, 'complete');
    assert.match(discoverBody.result.instructions, /one evidence(?:-backed)? graph/i);
    assert.match(discoverBody.result.instructions, /human Workbench/i);

    const list = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } }) });
    assert.equal(list.status, 200);
    const listBody = await list.json() as any;
    assert.equal(listBody.result.cacheScope, 'private');
    assert.ok(listBody.result.tools.some((tool: any) => tool.name === 'project_overview'));
    assert.ok(listBody.result.tools.some((tool: any) => tool.name === 'inspect_entity'));
    assert.ok(listBody.result.tools.some((tool: any) => tool.name === 'query_source'));
    assert.equal(listBody.result.tools.some((tool: any) => tool.name === 'clear_cache'), false);

    const chooser = await fetch(`${origin}/`);
    assert.equal(chooser.status, 200);
    assert.match(await chooser.text(), /Choose a project workspace/i);

    const workbench = await fetch(`${origin}/workbench?project=${fixture.project}`);
    assert.equal(workbench.status, 200);
    const html = await workbench.text();
    assert.match(html, /Overview/);
    assert.match(html, /Explore/);
    assert.match(html, /Parity/);
    assert.match(html, /Query/);
    assert.match(html, /Sources/);
    assert.match(html, /Changes/);
    assert.match(html, /Inspector/);
    assert.match(html, /Revision selector/);
    assert.match(html, /graph is one representation/i);
    assert.match(html, /assessment-head/);

    const viewerBundle = await fetch(`${origin}/viewer.js`);
    assert.equal(viewerBundle.status, 200);
    const viewerJavaScript = await viewerBundle.text();
    assert.match(viewerJavaScript, /Evidence-backed assessment/);
    assert.match(viewerJavaScript, /Typed reach/);
    assert.match(viewerJavaScript, /reach describes connection, not impact severity/i);
    assert.match(viewerJavaScript, /Claims and proof/);

    const intelligenceQuery = await fetch(`${origin}/workbench/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: fixture.project, text: 'How is feature:storage capability realized?' }),
    });
    assert.equal(intelligenceQuery.status, 200);
    const intelligenceBody = await intelligenceQuery.json() as any;
    assert.equal(intelligenceBody.intent, 'intelligence');
    assert.ok(Array.isArray(intelligenceBody.result.claims));
    assert.equal(typeof intelligenceBody.result.answerStatus, 'string');
    assert.equal(typeof intelligenceBody.result.revision, 'string');
    assert.equal(typeof intelligenceBody.result.reach, 'object');
    assert.equal(intelligenceBody.result.reach.policy.relationshipStatus, 'resolved');

    const historicalBase = (await runChecked('git', ['-C', fixture.source, 'rev-parse', 'HEAD~1'])).stdout.trim();
    const historicalParams = new URLSearchParams({ project: fixture.project, action: 'changes', baseRef: `commit:${historicalBase}`, headRef: 'branch:main' });
    const historical = await fetch(`${origin}/workbench/data?${historicalParams}`);
    assert.equal(historical.status, 200);
    const historicalBody = await historical.json() as any;
    assert.equal(historicalBody.mode, 'revision-to-revision');
    assert.equal(historicalBody.detail.comparisonMode, 'current-analyzer-replay');
    assert.equal(historicalBody.detail.base.identity.sha, historicalBase);
    assert.equal(historicalBody.detail.head.identity.kind, 'branch');

    const parity = await fetch(`${origin}/workbench/parity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: fixture.project, contract: { version: 1, entities: [{ id: 'capability:not-observed', requirement: 'required' }] } }),
    });
    assert.equal(parity.status, 200);
    const parityBody = await parity.json() as any;
    assert.equal(parityBody.counts.unproven, 1);
    assert.equal(parityBody.passed, false);

    const oldGraph = await fetch(`${origin}/graph?project=${fixture.project}`, { redirect: 'manual' });
    assert.equal(oldGraph.status, 303);
    assert.match(oldGraph.headers.get('location') ?? '', /^\/workbench\?/);
  } finally {
    await close(server);
    delete process.env.DEVINT_AUTH_MODE;
    delete process.env.DEVINT_ALLOW_UNAUTHENTICATED;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
