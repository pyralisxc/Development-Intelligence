import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecked } from '../src/util/process.js';
import { buildLocalGraph, sealLocalGraph } from '../src/intelligence/local.js';
import { graphStatus, scanGraph, clearGraphCache } from '../src/intelligence/service.js';
import { analyzeImpact, diffAcceptedToWorking, graphArchitecture, parityLens, searchGraph, traceGraph } from '../src/intelligence/query.js';
import { searchCode, getCodeSnippet } from '../src/intelligence/code.js';
import { callTool, listTools, toolContract } from '../src/mcp.js';
import { runtimeIdentity } from '../src/runtimeIdentity.js';
import { projectOverview, queryWorkbench, queryWorkbenchRequest, scopeOrientation } from '../src/intelligence/workbench.js';
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
  await fs.writeFile(path.join(source, 'src', 'ArchitectureAggregateProbe.cs'), `
public sealed class ArchitectureAggregateProbe
{
    public ArchitectureAggregateProbe() {}
}
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
  await fs.writeFile(path.join(source, 'config.json'), JSON.stringify({ endpoint: '/api/manage', module: 'NodeNext', access_token: 'must-not-be-persisted' }, null, 2));
  await fs.mkdir(path.join(source, '.github', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(source, '.github', 'workflows', 'verify.yml'), 'name: verify\non:\n  push:\n    branches: [main, preview]\njobs:\n  verify:\n    steps:\n      - uses: actions/setup-node@v7\n        with:\n          node-version: 22\n');
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

    const helperSubject = beforeGraph.nodes.find(node => node.kind === 'function' && node.name === 'helper')!;
    const csharpSubject = beforeGraph.nodes.find(node => node.kind === 'class' && node.name === 'ArchitectureAggregateProbe')!;
    assert.ok(helperSubject && csharpSubject, 'fixture must expose exact subjects for bundled overview');
    const overview = await projectOverview(fixture.project, undefined, compactScan.graphId, [helperSubject.id, csharpSubject.id, 'DefinitelyMissingRuntimeOwner']) as any;
    assert.equal(overview.graphId, compactScan.graphId);
    assert.equal(overview.coverage.files, undefined, 'project overview must stay compact; per-file coverage belongs to check_graph_coverage');
    assert.equal(overview.currentness, null, 'exact graphId overview must not resolve unrelated default-branch currentness');
    assert.equal(overview.subjects.length, 3);
    assert.equal(overview.subjects[0].entity.name, 'helper');
    assert.equal(overview.subjects[0].observed, true);
    assert.equal(overview.subjects[1].entity.name, 'ArchitectureAggregateProbe');
    assert.equal(overview.subjects[1].observed, true);
    assert.equal(overview.subjects[2].observed, false);
    assert.equal(typeof overview.subjects[2].answerStatus, 'string');
    assert.equal(overview.findings.some((item: any) => item.category === 'relationship'), false, 'compact overview must not materialize per-edge relationship findings; audit_repository owns relationship investigation');

    const architecture = await graphArchitecture(fixture.project) as any;
    assert.equal(typeof architecture.summary.nodeKinds.constructor, 'number');
    assert.ok(architecture.summary.nodeKinds.constructor >= 1, 'constructor node kinds must count numerically without Object.prototype collision');
    assert.equal(Number.isFinite(architecture.summary.nodeKinds.constructor), true);

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

test('impact analysis seeds from actual changed files even when topology is stable', async () => {
  const fixture = await makeFixture();
  try {
    const base = (await runChecked('git', ['-C', fixture.source, 'rev-parse', 'HEAD'])).stdout.trim();
    await fs.writeFile(path.join(fixture.source, 'src', 'helper.ts'), `
export function helper() { return 'changed implementation'; }
`);
    const head = await commit(fixture.source, 'change helper implementation');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'main']);
    clearGraphCache();

    const impact = await analyzeImpact({
      project: fixture.project,
      baseRef: `commit:${base}`,
      ref: `commit:${head}`,
      direction: 'inbound',
      depth: 3,
      limit: 500,
    }) as any;

    assert.equal(impact.base.identity.sha, base);
    assert.equal(impact.head.identity.sha, head);
    assert.equal(impact.changedFileCount, 1);
    assert.equal(impact.changedFiles[0]?.path, 'src/helper.ts');
    assert.ok(impact.afterImpact.seedTotal > 0, 'changed source file must seed graph entities even when structural topology is unchanged');
    assert.ok(impact.afterImpact.nodes.some((node: any) => node.sourceId === 'repo:src/helper.ts'));
    assert.ok(
      impact.afterImpact.nodes.some((node: any) => node.sourceId === 'repo:src/panel.tsx'),
      'inbound impact should reach a caller in panel.tsx',
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('shared investigation router maps ordinary questions to existing DI primitives', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);

    const code = await queryWorkbench({ project: fixture.project, text: 'Show me code for Panel' }) as any;
    assert.equal(code.intent, 'code');
    assert.equal(code.routing.tool, 'get_code_snippet');
    assert.equal(code.subject?.name, 'Panel');
    assert.equal(code.result.file, 'src/panel.tsx');

    const trace = await queryWorkbench({ project: fixture.project, text: 'What does Panel depend on?' }) as any;
    assert.equal(trace.intent, 'trace');
    assert.equal(trace.routing.tool, 'trace_path');
    assert.equal(trace.subject?.name, 'Panel');
    assert.ok(trace.result.nodes.some((node: any) => node.name === 'helper'), 'dependency routing should reach the helper call');

    const evidence = await queryWorkbench({ project: fixture.project, text: 'What evidence supports Panel?' }) as any;
    assert.equal(evidence.intent, 'evidence');
    assert.equal(evidence.routing.tool, 'inspect_entity');
    assert.equal(evidence.subject?.name, 'Panel');

    const throughMcp = await callTool('investigate', { project: fixture.project, question: 'What does Panel depend on?' }) as any;
    assert.equal(throughMcp.intent, trace.intent);
    assert.equal(throughMcp.routing.tool, trace.routing.tool);
    assert.equal(throughMcp.subject?.id, trace.subject?.id);

    const directAssessment = await callTool('query_intelligence', { project: fixture.project, question: 'What evidence supports Panel?' }) as any;
    assert.equal(directAssessment.interpretedSubject, 'Panel');
    assert.equal(directAssessment.answerStatus, 'supported');


    const scopedOwner = await callTool('investigate', {
      project: fixture.project,
      question: 'Which module owns helper behavior in this file?',
      scope: 'src/panel.tsx',
    }) as any;
    assert.notEqual(scopedOwner.subject?.name, 'module', 'generic nouns outside an explicit scope must not outrank scoped entities');
    assert.match(scopedOwner.subject?.locator ?? '', /src\/panel\.tsx/);

    const workflowSource = await callTool('investigate', {
      project: fixture.project,
      question: 'Which Node.js version does .github/workflows/verify.yml configure?',
    }) as any;
    assert.equal(workflowSource.intent, 'source-search');
    assert.equal(workflowSource.routing.tool, 'search_code');
    assert.ok(workflowSource.result.matches.some((match: any) => /node-version:\s*22/.test(match.text)));

    const premise = await callTool('investigate', {
      project: fixture.project,
      question: 'Where does Panel write accepted graph state?',
    }) as any;
    assert.equal(premise.intent, 'implementation-claim');
    assert.equal(premise.routing.premiseAssumed, false);

    const negativeProof = await callTool('investigate', {
      project: fixture.project,
      question: 'Prove Panel is the only composition root.',
    }) as any;
    assert.equal(negativeProof.routing.tool, 'query_intelligence', 'uniqueness/negative proof must not degrade into simple entity inspection');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('multi-question investigation keeps one graph context and isolates questions', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    const paragraph = 'What is Panel? What does it depend on? Where is it implemented? What evidence supports those answers?';
    const batch = await queryWorkbenchRequest({ project: fixture.project, text: paragraph }) as any;
    assert.equal(batch.intent, 'batch');
    assert.equal(batch.request.mode, 'decomposed');
    assert.equal(batch.request.questionCount, 4);
    assert.equal(batch.counts.error, 0);
    assert.deepEqual(batch.items.map((item: any) => item.intent), ['inspect', 'trace', 'code', 'evidence']);
    assert.ok(batch.items.slice(1).every((item: any) => item.resolvedQuestion.includes(batch.items[0].subject.id)), 'follow-up pronouns should inherit only the exact first subject');
    assert.ok(batch.items.every((item: any) => item.status === 'ok'));

    const explicit = await callTool('investigate', {
      project: fixture.project,
      questions: ['What is Panel?', 'What does it depend on?', 'Where is it implemented?'],
    }) as any;
    assert.equal(explicit.intent, 'batch');
    assert.equal(explicit.request.mode, 'explicit');
    assert.equal(explicit.request.questionCount, 3);
    assert.equal(explicit.graphId, batch.graphId);
    assert.deepEqual(explicit.items.map((item: any) => item.intent), ['inspect', 'trace', 'code']);

    const isolated = await queryWorkbenchRequest({
      project: fixture.project,
      questions: ['What is Panel?', 'What does definitely-not-real depend on?', 'What evidence supports it?'],
    }) as any;
    assert.equal(isolated.items[0].status, 'ok');
    assert.equal(isolated.items[1].status, 'error');
    assert.equal(isolated.items[2].status, 'ok', 'one failed question must not poison later questions');
    assert.equal(isolated.counts.error, 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('scope orientation surfaces explainable local graph structure without an opaque importance score', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    const orientation = await scopeOrientation({
      project: fixture.project,
      scope: 'src/panel.tsx',
      rankBy: 'cross-file',
      limit: 10,
    }) as any;
    assert.equal(orientation.scope.kind, 'file');
    assert.equal(orientation.rankBy, 'cross-file');
    assert.equal(orientation.policy.subjectiveImportanceScore, false);
    assert.ok(orientation.keyEntities.some((item: any) => item.name === 'Panel'));
    assert.ok(orientation.keyEntities.every((item: any) => typeof item.id === 'string' && typeof item.reason === 'string'));
    assert.ok(orientation.boundaries.some((item: any) => item.external?.locator === 'src/helper.ts'), 'file orientation should expose the helper boundary');

    const area = await callTool('orient_scope', {
      project: fixture.project,
      scope: 'src',
      rankBy: 'fan-in',
      limit: 10,
    }) as any;
    assert.equal(area.scope.kind, 'path');
    assert.equal(area.policy.rankFacet, 'fan-in');
    assert.ok(area.keyEntities.length > 0);

    const natural = await callTool('investigate', {
      project: fixture.project,
      question: 'What are the main functions this page uses?',
      scope: 'src/panel.tsx',
      rankBy: 'relationship-diversity',
    }) as any;
    assert.equal(natural.intent, 'orientation');
    assert.equal(natural.routing.tool, 'orient_scope');
    assert.equal(natural.result.scope.kind, 'file');
    assert.equal(natural.result.rankBy, 'relationship-diversity');

    const missingScope = await callTool('investigate', {
      project: fixture.project,
      question: 'What are the main functions this page uses?',
    }) as any;
    assert.equal(missingScope.intent, 'orientation');
    assert.equal(missingScope.result.scopeRequired, true, 'deictic scope should remain explicit instead of guessing');


    const scopedSpecific = await callTool('investigate', {
      project: fixture.project,
      question: 'Which file owns this module behavior?',
      scope: 'src/panel.tsx',
    }) as any;
    assert.equal(scopedSpecific.subject?.locator, 'src/panel.tsx', 'explicit file scope must constrain specific subject resolution as well as orientation');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('headless rich projections stay compact by default and preserve explicit detail escape hatches', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    const graph = await scanGraph(fixture.project);
    const panel = graph.nodes.find(node => node.name === 'Panel');
    assert.ok(panel);

    const inspected = await callTool('inspect_entity', { project: fixture.project, node: panel.id }) as any;
    assert.equal(inspected.coverage?.files, undefined);
    assert.equal(inspected.coverage?.fileDetailTool, undefined);
    assert.ok(inspected.detailTools.includes('get_evidence'));

    const assessed = await callTool('query_intelligence', { project: fixture.project, question: 'Panel' }) as any;
    assert.equal(assessed.realization?.resolvedPaths?.nodes, undefined);
    assert.equal(typeof assessed.realization?.resolvedPaths?.nodeCount, 'number');
    assert.ok(Array.isArray(assessed.realization?.resolvedPaths?.detailTools));

    const overview = await callTool('project_overview', { project: fixture.project, subjects: ['Panel'] }) as any;
    assert.equal(overview.changes?.detail, undefined);
    assert.equal(overview.changes?.detailTool, 'diff_graph');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('search_code path filtering is explicit, safe, and supports literal/prefix/glob modes', async () => {
  const fixture = await makeFixture();
  try {
    const literal = await callTool('search_code', {
      project: fixture.project,
      pattern: 'helper',
      filePattern: 'src/panel.tsx',
      filePatternMode: 'literal',
    }) as any;
    assert.ok(literal.matches.length > 0);
    assert.ok(literal.matches.every((match: any) => match.file === 'src/panel.tsx'));

    const glob = await callTool('search_code', {
      project: fixture.project,
      pattern: 'helper',
      filePattern: 'src/**/*.tsx',
      filePatternMode: 'glob',
    }) as any;
    assert.ok(glob.matches.some((match: any) => match.file === 'src/panel.tsx'));

    await assert.rejects(
      () => callTool('search_code', { project: fixture.project, pattern: 'helper', filePattern: 'src/**/*.ts' }),
      /filePattern is an invalid regular expression.*filePatternMode/s,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('Development Intelligence semantic self-model covers every live MCP tool', async () => {
  const graph = await buildLocalGraph(process.cwd(), 'Development-Intelligence');
  const modeled = graph.nodes
    .filter(node => node.kind === 'mcp' && node.layer === 'semantic')
    .map(node => node.name)
    .filter((name): name is string => Boolean(name))
    .sort();
  const live = listTools().map(tool => tool.name).sort();
  assert.deepEqual(modeled, live);
});

test('public tool surface is the intrinsic DI and Workbench contract, not development methodology or housekeeping', () => {
  const listed = listTools();
  const names = listed.map(tool => tool.name);
  assert.deepEqual(names, [
    'list_projects',
    'resolve_revision',
    'project_status',
    'project_overview',
    'investigate',
    'orient_scope',
    'query_intelligence',
    'audit_repository',
    'inspect_portfolio',
    'trace_portfolio',
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
    'analyze_impact',
    'verify_transition',
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
  assert.equal(byName.get('inspect_portfolio')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('inspect_portfolio')?.annotations?.openWorldHint, true);
  assert.equal(byName.get('trace_portfolio')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('trace_portfolio')?.annotations?.openWorldHint, true);
  assert.equal(byName.get('verify_transition')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('verify_transition')?.annotations?.openWorldHint, true);
  assert.equal(byName.get('evaluate_parity')?.annotations?.readOnlyHint, true);
  const contract = toolContract();
  assert.deepEqual(contract, { toolCount: 27, contractFingerprint: contract.contractFingerprint });
  assert.match(contract.contractFingerprint, /^[0-9a-f]{24}$/);
  assert.equal(toolContract().contractFingerprint, contract.contractFingerprint);
});

test('runtime identity only exposes exact deployment metadata and the MCP contract', () => {
  const identity = runtimeIdentity({
    DEVINT_BUILD_SHA: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    VERCEL_GIT_COMMIT_SHA: '1111111111111111111111111111111111111111',
    VERCEL_GIT_COMMIT_REF: 'work/production-check',
    VERCEL_TARGET_ENV: 'Production',
    UNRELATED_SECRET: 'must-not-escape',
  });
  assert.deepEqual(identity.deployment, {
    revision: 'abcdef0123456789abcdef0123456789abcdef01',
    gitRef: 'work/production-check',
    environment: 'production',
  });
  assert.equal(identity.mcp.toolCount, 27);
  assert.equal(JSON.stringify(identity).includes('must-not-escape'), false);

  assert.deepEqual(runtimeIdentity({
    DEVINT_BUILD_SHA: 'not-a-sha',
    VERCEL_GIT_COMMIT_REF: 'bad ref with spaces',
    VERCEL_TARGET_ENV: 'secret-environment-name',
  }).deployment, { revision: null, gitRef: null, environment: null });
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
  process.env.VERCEL_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
  process.env.VERCEL_GIT_COMMIT_REF = 'work/health-contract';
  process.env.VERCEL_TARGET_ENV = 'preview';
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
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as any;
    assert.deepEqual(healthBody.deployment, {
      revision: '0123456789abcdef0123456789abcdef01234567',
      gitRef: 'work/health-contract',
      environment: 'preview',
    });
    assert.deepEqual(healthBody.mcp, toolContract());

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
    assert.ok(listBody.result.tools.some((tool: any) => tool.name === 'investigate'));
    assert.ok(listBody.result.tools.some((tool: any) => tool.name === 'orient_scope'));
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
    assert.ok('reach' in intelligenceBody.result, 'Workbench query must preserve the shared assessment reach field even when no entity is unambiguously selected');

    const batchQuery = await fetch(`${origin}/workbench/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: fixture.project, text: 'What is Panel? What does it depend on? Where is it implemented?' }),
    });
    assert.equal(batchQuery.status, 200);
    const batchBody = await batchQuery.json() as any;
    assert.equal(batchBody.intent, 'batch');
    assert.equal(batchBody.request.questionCount, 3);
    assert.deepEqual(batchBody.items.map((item: any) => item.intent), ['inspect', 'trace', 'code']);

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
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_REF;
    delete process.env.VERCEL_TARGET_ENV;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
