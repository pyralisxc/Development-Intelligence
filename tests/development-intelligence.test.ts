import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecked } from '../src/util/process.js';
import { sealLocalGraph } from '../src/intelligence/local.js';
import { DEVELOPMENT_INTELLIGENCE_SEMANTICS } from '../src/intelligence/semantics.js';
import { graphStatus, scanGraph, clearGraphCache } from '../src/intelligence/service.js';
import { analyzeImpact, diffAcceptedToWorking, graphArchitecture, parityLens, searchGraph, traceGraph } from '../src/intelligence/query.js';
import { searchCode, getCodeSnippet } from '../src/intelligence/code.js';
import { callTool, listTools, toolContract } from '../src/mcp.js';
import { runtimeIdentity } from '../src/runtimeIdentity.js';
import { interfaceProjection, planInvestigationQuestion, projectOverview, projectStatistics, queryWorkbench, queryWorkbenchRequest, scopeOrientation } from '../src/intelligence/workbench.js';
import { loadRegistry } from '../src/config/registry.js';
import { evaluateParityContract } from '../src/intelligence/parityContract.js';
import { sourceFingerprint } from '../src/intelligence/repository.js';
import { loadSemanticAuthority, promoteCanonicalAcceptedGraph } from '../src/intelligence/semanticAuthorityStore.js';
import { bootstrapSemanticPromotionBaseline, reviewSemanticMeaning, semanticReviewSurface, setSemanticPromotionEnrollment, verifySemanticPromotionChange } from '../src/intelligence/semanticWorkflow.js';
import { selectSupportedSemanticPortfolioCandidates } from '../src/intelligence/semanticPortfolioBootstrap.js';
import { interfaceRuntimeObservationContract, isInterfaceRuntimeObservationSource } from '../src/intelligence/interfaceRuntimeObservation.js';

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
  await fs.writeFile(path.join(source, 'src', 'interaction.tsx'), `
import { useState } from 'react';
export function InteractionFixture() {
  const [active, setActive] = useState(false);
  function handlePointerMove() { setActive(true); }
  function handleDrop() { void fetch('/api/drop', { method: 'POST' }); }
  function handleClick() {}
  function handleFocus() { window.location.assign('/focused'); }
  function handleCustomSignal() {}
  return <CanvasWidget
    onPointerMove={handlePointerMove}
    onDrop={handleDrop}
    onClick={handleClick}
    onFocus={handleFocus}
    dataAction={handleCustomSignal}
  />;
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
    assert.equal(stale.accepted.current, true, 'representation-only source churn must preserve accepted semantic A when topology is unchanged');
    assert.equal(stale.currentness.acceptedSemanticCurrent, true);
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

test('portfolio semantic bootstrap selection accepts supported core and supporting meanings but blocks unsupported candidates', () => {
  const selection = selectSupportedSemanticPortfolioCandidates([
    { id: 'core', scope: 'src/core', proposal: { name: 'Core', kind: 'capability' }, reviewAssessment: { supported: true, factuality: 'supported', classification: 'core-candidate' } },
    { id: 'supporting', scope: 'src/support', proposal: { name: 'Supporting', kind: 'surface' }, reviewAssessment: { supported: true, factuality: 'supported', classification: 'supporting-candidate' } },
    { id: 'unproven', scope: 'src/unknown', proposal: { name: 'Unknown', kind: 'feature' }, reviewAssessment: { supported: false, factuality: 'needs-review', classification: 'supporting-candidate' } },
  ] as any);
  assert.deepEqual(selection.selectedCandidateIds, ['core', 'supporting']);
  assert.deepEqual(selection.unsupportedCandidateIds, ['unproven']);
  assert.equal(selection.selected[0]?.classification, 'core-candidate');
  assert.equal(selection.selected[1]?.classification, 'supporting-candidate');

  const empty = selectSupportedSemanticPortfolioCandidates([]);
  assert.deepEqual(empty.selectedCandidateIds, []);
  assert.deepEqual(empty.unsupportedCandidateIds, []);
});

test('owner semantic bootstrap accepts explicit current meaning, enforces the gate, and finalizes exact Main A', async () => {
  const fixture = await makeFixture();
  const previousCanonicalDir = process.env.DEVINT_CANONICAL_GRAPH_DIR;
  process.env.DEVINT_CANONICAL_GRAPH_DIR = path.join(fixture.root, 'semantic-bootstrap-canonical');
  try {
    await fs.rm(path.join(fixture.source, '.development-intelligence'), { recursive: true, force: true });
    const revision = await commit(fixture.source, 'bootstrap semantic gate from current main');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'main']);
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);

    const before = await semanticReviewSurface({ project: fixture.project, limit: 1000 }) as any;
    const candidate = before.candidates.find((item: any) => item.reviewAssessment?.factuality === 'supported') ?? before.candidates[0];
    assert.ok(candidate);
    assert.equal(before.authority.enrollmentState, 'not-enrolled');

    const result = await bootstrapSemanticPromotionBaseline({
      project: fixture.project,
      candidateIds: [candidate.id],
      actor: { kind: 'human', id: 'human:test-owner' },
      at: '2026-10-01T14:55:00.000Z',
      rationale: 'Establish exact current Main as the first enforced semantic baseline.',
      expectedDigest: before.promotionAudit.digest,
    }) as any;

    assert.equal(result.state, 'stored');
    assert.equal(result.revision, revision);
    assert.equal(result.enrollmentState, 'enforced');
    assert.equal(result.gateStatus, 'ready');
    assert.equal(result.acceptedGraphRevision, revision);
    assert.equal(result.acceptedGraphCurrent, true);
    assert.ok(result.acceptedMeanings.some((meaning: any) => meaning.candidateId === candidate.id));

    const after = await semanticReviewSurface({ project: fixture.project, limit: 1000 }) as any;
    assert.equal(after.authority.enrollmentState, 'enforced');
    assert.equal(after.gateExplanation.acceptedGraphRevision, revision);
    assert.equal(after.gateExplanation.acceptedGraphCurrent, true);
    assert.equal(after.promotionAudit.gateStatus, 'ready');
    assert.equal(after.promotionAudit.blockingPendingCount, 0);
  } finally {
    if (previousCanonicalDir === undefined) delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    else process.env.DEVINT_CANONICAL_GRAPH_DIR = previousCanonicalDir;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('zero-metadata semantic lifecycle persists accepted authority through enforced promotion and revision continuity', async () => {
  const fixture = await makeFixture();
  const previousCanonicalDir = process.env.DEVINT_CANONICAL_GRAPH_DIR;
  process.env.DEVINT_CANONICAL_GRAPH_DIR = path.join(fixture.root, 'semantic-canonical');
  try {
    const registry = JSON.parse(await fs.readFile(fixture.config, 'utf8'));
    registry[fixture.project].allowedRefs = ['refs/heads/main', 'refs/heads/preview'];
    await fs.writeFile(fixture.config, JSON.stringify(registry, null, 2));

    await fs.rm(path.join(fixture.source, '.development-intelligence'), { recursive: true, force: true });
    const baseRevision = await commit(fixture.source, 'remove repository-local semantic authority');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'main']);
    clearGraphCache(fixture.project);
    const baseGraph = await scanGraph(fixture.project);
    assert.equal(baseGraph.repositoryRevision, baseRevision);

    const baseSurface = await semanticReviewSurface({ project: fixture.project, limit: 1000 }) as any;
    assert.equal(baseSurface.zeroMetadata, true);
    const candidate = baseSurface.candidates.find((item: any) => /\.(?:ts|tsx|js|jsx)$/u.test(item.scope))
      ?? baseSurface.candidates[0];
    assert.ok(candidate, 'zero-metadata fixture must produce at least one evidence-qualified semantic candidate');

    const accepted = await reviewSemanticMeaning({
      project: fixture.project,
      candidateId: candidate.id,
      command: { kind: 'accept', rationale: 'Fixture meaning reviewed for durable lifecycle proof.' },
      actor: { kind: 'human', id: 'human:test-owner' },
      at: '2026-10-01T15:00:00.000Z',
    });
    assert.equal(accepted.state, 'stored');
    assert.equal(accepted.review.accepted, true);

    const orientation = await queryWorkbench({
      project: fixture.project,
      text: 'What does this project do?',
      semanticDepth: 'expanded',
    }) as any;
    assert.equal(orientation.intent, 'orientation');
    assert.equal(orientation.result.semanticUnderstanding.source, 'accepted-authority');
    assert.ok(
      orientation.result.semanticUnderstanding.meanings.some((meaning: any) => meaning.meaningId === accepted.meaningId),
      'ordinary repository questions must prefer the durable accepted semantic meaning',
    );

    const enrolled = await setSemanticPromotionEnrollment({
      project: fixture.project,
      state: 'enforced',
      actor: { kind: 'human', id: 'human:test-owner' },
      at: '2026-10-01T15:01:00.000Z',
      rationale: 'Enable exact Main-to-Preview semantic release governance for the fixture.',
    });
    assert.equal(enrolled.state, 'stored');
    assert.equal(enrolled.enrollmentState, 'enforced');
    assert.equal(enrolled.enrollment?.baselineRevision, baseRevision);
    assert.ok((enrolled.baselineCandidateCount ?? 0) >= 1);

    const lifecycleFeatureDir = path.join(fixture.source, 'src', 'features', 'semantic-lifecycle');
    await fs.mkdir(lifecycleFeatureDir, { recursive: true });
    await fs.writeFile(path.join(lifecycleFeatureDir, 'index.tsx'), `
import { useState } from 'react';
export function SemanticLifecycleFeature() {
  const [status, setStatus] = useState('idle');
  async function runSemanticLifecycle() {
    setStatus('saving');
    await fetch('/api/semantic-lifecycle', { method: 'POST' });
    setStatus('saved');
  }
  return <button onClick={runSemanticLifecycle}>{status}</button>;
}
`);
    const previewRevision = await commit(fixture.source, 'add new semantic lifecycle feature');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'HEAD:preview']);
    clearGraphCache(fixture.project);

    const previewSurface = await semanticReviewSurface({
      project: fixture.project,
      ref: 'branch:preview',
      limit: 1000,
    }) as any;
    assert.equal(previewSurface.promotionAudit.enrollmentState, 'enforced');
    assert.equal(previewSurface.promotionAudit.baseRevision, baseRevision);
    assert.equal(previewSurface.promotionAudit.previewRevision, previewRevision);
    const newCandidate = previewSurface.candidates.find((item: any) => item.scope === 'src/features/semantic-lifecycle');
    assert.ok(newCandidate, 'Preview must derive the newly added zero-metadata feature candidate');
    const deltaItem = previewSurface.promotionAudit.items.find((item: any) => item.candidateId === newCandidate.id);
    assert.ok(deltaItem, 'new semantic candidate must produce one exact promotion item after the Main baseline');
    assert.equal(deltaItem.changeKind, 'added');
    assert.equal(deltaItem.approved, false);
    assert.equal(previewSurface.promotionAudit.gateStatus, 'semantic-review-required');

    const verified = await verifySemanticPromotionChange({
      project: fixture.project,
      ref: 'branch:preview',
      auditRef: deltaItem.auditRef,
      evidenceIds: ['evidence:fixture-preview-realization'],
      actor: { kind: 'ai-model', id: 'model:test-semantic-verifier' },
      at: '2026-10-01T15:02:00.000Z',
      rationale: 'Fixture evidence confirms the exact observed realization change.',
    });
    assert.equal(verified.state, 'stored');

    const readySurface = await semanticReviewSurface({
      project: fixture.project,
      ref: 'branch:preview',
      limit: 1000,
    }) as any;
    assert.equal(readySurface.promotionAudit.gateStatus, 'ready');
    assert.equal(readySurface.promotionAudit.blockingPendingCount, 0);
    assert.equal(readySurface.promotionAudit.readyForMainSemanticPromotion, true);

    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'HEAD:main']);
    clearGraphCache(fixture.project);
    const promotedWorking = await scanGraph(fixture.project);
    assert.equal(promotedWorking.repositoryRevision, previewRevision);

    const promoted = await promoteCanonicalAcceptedGraph({
      project: fixture.project,
      repository: pathToFileURL(fixture.remote).href,
      revision: previewRevision,
      gate: readySurface.promotionAudit,
    });
    assert.equal(promoted.state, 'stored');

    const promotedAuthority = await loadSemanticAuthority(fixture.project);
    assert.equal(promotedAuthority.ledger?.enrollment?.baselineRevision, previewRevision);
    assert.ok(
      promotedAuthority.ledger?.records.some(record => record.review.meaningId === accepted.meaningId && record.review.accepted),
      'semantic promotion must preserve the accepted meaning identity in DI-owned authority',
    );

    const afterPromotion = await queryWorkbench({
      project: fixture.project,
      text: 'What does this project do?',
      semanticDepth: 'expanded',
    }) as any;
    assert.equal(afterPromotion.result.semanticUnderstanding.source, 'accepted-authority');
    assert.ok(afterPromotion.result.semanticUnderstanding.meanings.some((meaning: any) => meaning.meaningId === accepted.meaningId));

    const readmePath = path.join(fixture.source, 'README.md');
    const readmeSource = await fs.readFile(readmePath, 'utf8');
    await fs.writeFile(readmePath, readmeSource + '\nImplementation notes moved without changing accepted product meaning.\n');
    const nextRevision = await commit(fixture.source, 'implementation-only movement after semantic promotion');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'main']);
    clearGraphCache(fixture.project);
    const nextGraph = await scanGraph(fixture.project);
    assert.equal(nextGraph.repositoryRevision, nextRevision);

    const nextSurface = await semanticReviewSurface({ project: fixture.project, limit: 1000 }) as any;
    const continued = nextSurface.candidates.find((item: any) => item.continuity?.meaningId === accepted.meaningId);
    assert.ok(continued, 'accepted meaning identity must remain discoverable on the next repository revision');

    const nextOrientation = await queryWorkbench({
      project: fixture.project,
      text: 'What does this project do?',
      semanticDepth: 'expanded',
    }) as any;
    assert.equal(nextOrientation.result.semanticUnderstanding.source, 'accepted-authority');
    assert.ok(nextOrientation.result.semanticUnderstanding.meanings.some((meaning: any) => meaning.meaningId === accepted.meaningId));
  } finally {
    clearGraphCache(fixture.project);
    if (previousCanonicalDir === undefined) delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    else process.env.DEVINT_CANONICAL_GRAPH_DIR = previousCanonicalDir;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('shared investigation router maps ordinary questions to existing DI primitives', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);

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

    const combinedAssessment = await callTool('query_intelligence', {
      project: fixture.project,
      question: 'Does Panel exist and what evidence supports it?',
    }) as any;
    assert.equal(combinedAssessment.interpretedSubject, 'Panel');
    assert.equal(combinedAssessment.answerStatus, 'supported');

    const combinedInvestigation = await callTool('investigate', {
      project: fixture.project,
      question: 'Does Panel exist and what evidence supports it?',
    }) as any;
    assert.equal(combinedInvestigation.intent, 'evidence');
    assert.equal(combinedInvestigation.routing.tool, 'inspect_entity');
    assert.equal(combinedInvestigation.routing.targetResolution.node?.name, 'Panel');
    assert.equal(combinedInvestigation.subject?.name, 'Panel');
    assert.equal(combinedInvestigation.result.entity?.name, 'Panel');

    const punctuationTrace = await callTool('investigate', {
      project: fixture.project,
      question: 'What depends on Panel?',
    }) as any;
    assert.equal(punctuationTrace.intent, 'trace');
    assert.equal(punctuationTrace.routing.targetResolution.node?.name, 'Panel');
    assert.equal(punctuationTrace.routing.targetResolution.query, 'Panel');
    assert.equal(punctuationTrace.routing.direction, 'inbound');

    const outboundTrace = await callTool('investigate', {
      project: fixture.project,
      question: 'What does Panel depend on?',
    }) as any;
    assert.equal(outboundTrace.routing.targetResolution.node?.name, 'Panel');
    assert.equal(outboundTrace.routing.direction, 'outbound');
    assert.ok(outboundTrace.result.nodes.some((node: any) => node.name === 'helper'));

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
    assert.equal(workflowSource.routing.file, '.github/workflows/verify.yml');
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

test('question planning separates lane, subject strategy, depth, and proof burden before execution', () => {
  const cases = [
    { question: 'How is the Workbench interface implemented in source?', lane: 'interface', subjectStrategy: 'scope-or-entity' },
    { question: 'Where in source is accepted semantic meaning persisted and evolved?', lane: 'semantic-lifecycle', subjectStrategy: 'repository' },
    { question: 'Are there source-backed implementation gaps or contradictions in semantic review, authority, and promotion workflow?', lane: 'repository-audit', subjectStrategy: 'repository' },
    { question: 'How does the adaptive query planner choose between indexed and sharded reads, and what evidence exposes that choice?', lane: 'implementation-explanation', subjectStrategy: 'source-keyword-evidence' },
    { question: 'What interface and interaction projection capabilities already exist?', lane: 'implementation-explanation', subjectStrategy: 'source-keyword-evidence' },
    { question: 'What graph accuracy benchmark infrastructure already exists?', lane: 'implementation-explanation', subjectStrategy: 'source-keyword-evidence' },
    { question: 'How do the polyglot portfolio, Gin, Amux, and CardForge benchmark scripts use the accuracy scoring contract, and which languages and exact pinned repositories do they cover?', lane: 'implementation-explanation', subjectStrategy: 'source-keyword-evidence' },
    { question: 'How are latency, external tool-call count, graph cost, candidate/unresolved relationship behavior, and evidence correctness measured across the benchmark suite?', lane: 'implementation-explanation', subjectStrategy: 'source-keyword-evidence' },
    { question: 'Where are real checked-in accuracy cases or ground-truth corpora stored beyond cases.example.json?', lane: 'implementation-explanation', subjectStrategy: 'source-keyword-evidence' },
    { question: 'Can this service run as a self-hosted server on arbitrary Linux, macOS, or Windows hardware without Vercel?', lane: 'implementation-explanation', subjectStrategy: 'source-keyword-evidence' },
    { question: 'Which runtime capabilities are provider-neutral versus specifically Vercel-dependent?', lane: 'implementation-explanation', subjectStrategy: 'source-keyword-evidence' },
    { question: 'Does this project include Docker or container packaging, standalone server startup, persistent storage abstraction, and environment-driven host and port configuration?', lane: 'implementation-explanation', subjectStrategy: 'source-keyword-evidence' },
    { question: 'How does Panel implementation persist accepted state?', lane: 'implementation-claim', proofMode: 'claim' },
    { question: 'Where is Panel implemented?', lane: 'code' },
    { question: 'What does Panel depend on?', lane: 'trace' },
    { question: 'Prove Panel is the only composition root.', lane: 'evidence', proofMode: 'claim' },
    { question: 'What does this project do? Go deep across supporting systems and semantic layers.', lane: 'orientation', semanticDepth: 'expanded', completeness: 'expanded' },
    { question: 'Which current failures or warnings should be fixed first because they most limit DI\'s ability to audit itself and other repositories?', lane: 'repository-audit', subjectStrategy: 'repository' },
    { question: 'What are the strongest candidates for simplification that preserve accepted semantic authority, deterministic evidence, and revision binding?', lane: 'repository-audit', subjectStrategy: 'repository' },
    { question: 'Which parts overlap in responsibility or add unnecessary indirection?', lane: 'repository-audit', subjectStrategy: 'repository' },
    { question: 'Audit the evidence for Panel.', lane: 'evidence', subjectStrategy: 'entity-or-query' },
    { question: 'Give me a project status summary.', lane: 'overview', subjectStrategy: 'repository' },
    { question: 'How big is this project and what capacity limits are we near?', lane: 'statistics', subjectStrategy: 'repository' },
    { question: 'How many files, nodes, and edges does this repo have?', lane: 'statistics', subjectStrategy: 'repository' },
    { question: 'Show graph coverage.', lane: 'coverage', subjectStrategy: 'repository' },
  ] as const;

  for (const expected of cases) {
    const plan = planInvestigationQuestion({ text: expected.question });
    assert.equal(plan.lane, expected.lane, expected.question);
    if ('subjectStrategy' in expected) assert.equal(plan.subjectStrategy, expected.subjectStrategy, expected.question);
    if ('proofMode' in expected) assert.equal(plan.proofMode, expected.proofMode, expected.question);
    if ('semanticDepth' in expected) assert.equal(plan.semanticDepth, expected.semanticDepth, expected.question);
    if ('completeness' in expected) assert.equal(plan.completeness, expected.completeness, expected.question);
    assert.equal(plan.continuity, 'immediate-exact-pronoun-only');
  }
});

test('meta-capability inventory questions bypass domain entity resolution', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);
    for (const question of [
      'What interface and interaction projection capabilities already exist?',
      'What graph accuracy benchmark infrastructure already exists?',
      'How do the polyglot portfolio, Gin, Amux, and CardForge benchmark scripts use the accuracy scoring contract, and which languages and exact pinned repositories do they cover?',
      'How are latency, external tool-call count, graph cost, candidate/unresolved relationship behavior, and evidence correctness measured across the benchmark suite?',
      'Where are real checked-in accuracy cases or ground-truth corpora stored beyond cases.example.json?',
      'Can this service run as a self-hosted server on arbitrary Linux, macOS, or Windows hardware without Vercel?',
      'Which runtime capabilities are provider-neutral versus specifically Vercel-dependent?',
      'Does this project include Docker or container packaging, standalone server startup, persistent storage abstraction, and environment-driven host and port configuration?',
    ]) {
      const routed = await callTool('investigate', { project: fixture.project, question }) as any;
      assert.equal(routed.intent, 'implementation-explanation', question);
      assert.equal(routed.routing.tool, 'search_code', question);
      assert.equal(routed.routing.projection, 'implementation-mechanism', question);
      assert.equal(routed.routing.questionPlan.subjectStrategy, 'source-keyword-evidence', question);
      assert.equal(routed.routing.targetResolution.mode, 'source-keywords', question);
      assert.equal(routed.subject, null, 'meta-capability inventory must not bind an incidental graph entity');
    }
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('repository-level self-audit questions bypass entity resolution and use audit_repository', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);
    const routed = await queryWorkbenchRequest({
      project: fixture.project,
      text: 'Which current failures or warnings should be fixed first because they most limit this project ability to audit itself?',
    }) as any;
    assert.equal(routed.intent, 'repository-audit');
    assert.equal(routed.subject, null);
    assert.equal(routed.routing.tool, 'audit_repository');
    assert.equal(routed.routing.questionPlan.lane, 'repository-audit');
    assert.equal(routed.routing.targetResolution.mode, 'repository');
    assert.ok(Array.isArray(routed.result.findings));
    assert.ok(routed.result.findingSummary);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('project statistics exposes bounded graph and capacity facts without inventing byte counts', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);
    const stats = await projectStatistics(fixture.project) as any;
    assert.equal(stats.project, fixture.project);
    assert.equal(typeof stats.graph.nodes, 'number');
    assert.equal(typeof stats.graph.edges, 'number');
    assert.equal(typeof stats.graph.recordWeight, 'number');
    assert.equal(stats.source.sourceBytes, null);
    assert.equal(stats.source.sourceBytesStatus, 'unavailable-not-recorded');
    assert.equal(stats.policy.semanticAuthority, false);

    const routed = await queryWorkbenchRequest({ project: fixture.project, text: 'Give me the general project stats and tell me how big this repo is.' }) as any;
    assert.equal(routed.intent, 'statistics');
    assert.equal(routed.routing.tool, 'project_statistics');
    assert.equal(routed.routing.questionPlan.lane, 'statistics');
    assert.equal(routed.result.policy.operationalStatsAvailable, true);
    assert.equal(typeof routed.result.currentness, 'object');
    assert.equal(typeof routed.result.capacity.cache, 'object');
    assert.equal(typeof routed.result.persistence, 'object');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('multi-question investigation keeps one graph context and isolates questions', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);
    const paragraph = 'What is Panel? What does it depend on? Where is it implemented? What evidence supports those answers?';
    const batch = await queryWorkbenchRequest({ project: fixture.project, text: paragraph }) as any;
    assert.equal(batch.intent, 'batch');
    assert.equal(batch.request.mode, 'decomposed');
    assert.equal(batch.request.questionCount, 4);
    assert.equal(batch.counts.error, 0);
    assert.deepEqual(batch.items.map((item: any) => item.intent), ['inspect', 'trace', 'code', 'evidence']);
    assert.ok(batch.items.slice(1).every((item: any) => item.resolvedQuestion.includes(batch.items[0].subject.id)), 'follow-up pronouns should inherit only the exact first subject');
    assert.ok(batch.items.every((item: any) => item.status === 'ok'));
    assert.ok(batch.items.every((item: any) => item.routing?.questionPlan?.lane), 'every ordinary routed question should expose its pure question plan');
    assert.ok(batch.items.every((item: any) => item.routing?.targetResolution?.mode), 'every ordinary routed question should expose one normalized target-resolution record');

    const explicit = await callTool('investigate', {
      project: fixture.project,
      questions: ['What is Panel?', 'What does it depend on?', 'Where is it implemented?'],
    }) as any;
    assert.equal(explicit.intent, 'batch');
    assert.equal(explicit.request.mode, 'explicit');
    assert.equal(explicit.request.questionCount, 3);
    assert.equal(explicit.graphId, batch.graphId);
    assert.deepEqual(explicit.items.map((item: any) => item.intent), ['inspect', 'trace', 'code']);
    assert.equal(explicit.items[1].inheritedSubject, explicit.items[0].subject.id, 'batch metadata must record the subject a pronoun inherited from before routing the follow-up');

    const trailingNaturalLanguage = await queryWorkbenchRequest({
      project: fixture.project,
      text: 'What is Panel? What does it depend on? Also show where it is implemented',
    }) as any;
    assert.equal(trailingNaturalLanguage.request.mode, 'decomposed');
    assert.equal(trailingNaturalLanguage.request.questionCount, 3, 'a final question-like remainder must remain an independent query even without a trailing question mark');
    assert.deepEqual(trailingNaturalLanguage.items.map((item: any) => item.intent), ['inspect', 'trace', 'code']);

    const mechanism = await callTool('investigate', {
      project: fixture.project,
      question: 'How does Panel handle the manage request, and what evidence shows that implementation path?',
    }) as any;
    assert.equal(mechanism.intent, 'implementation-explanation');
    assert.equal(mechanism.routing.tool, 'search_code');
    assert.equal(mechanism.routing.questionPlan.lane, 'implementation-explanation');
    assert.equal(mechanism.routing.questionPlan.subjectStrategy, 'source-keyword-evidence');
    assert.equal(mechanism.routing.projection, 'implementation-mechanism');
    assert.ok(mechanism.result.matches.length > 0, 'mechanism questions should search bounded source evidence rather than collapse into a generic evidence assessment');
    assert.ok(mechanism.result.mechanism.files.length > 0, 'mechanism projection must group bounded source evidence by file');
    assert.equal(mechanism.result.mechanism.selection.mode, 'graph-ranked-files');
    assert.ok(mechanism.result.mechanism.selection.candidateFiles.some((item: any) => item.file === 'src/panel.tsx'), 'graph-guided source selection must keep the known fixture implementation file');
    assert.ok(mechanism.result.mechanism.keyEntities.length > 0, 'mechanism projection must identify evidence-linked entities in matched files');
    assert.ok(mechanism.result.mechanism.relationships.length > 0, 'mechanism projection must expose resolved graph relationships instead of only raw text hits');
    assert.ok(mechanism.result.mechanism.relationships.some((edge: any) => edge.sourceMatchEndpointCount > 0 || edge.queryTermHits > 0), 'bounded mechanism relationships must prioritize endpoints tied to the query or matched source');
    assert.ok(mechanism.result.mechanism.decisionEvidence.length > 0, 'mechanism projection must expose bounded decision evidence when source contains decision/control terms');
    assert.equal(mechanism.result.mechanism.policy.sourceObservedOnly, true);
    assert.equal(mechanism.result.mechanism.policy.runtimeExecutionProven, false);
    assert.equal(mechanism.result.mechanism.policy.semanticAuthority, false);

    const lifecycleControl = await callTool('investigate', {
      project: fixture.project,
      question: 'How are accepted semantic meanings preserved, evolved, superseded, split, merged, and prevented from silently changing across revisions in source implementation?',
    }) as any;
    assert.equal(lifecycleControl.intent, 'semantic-lifecycle', 'semantic lifecycle must outrank generic implementation-mechanism planning');

    const interfaceControl = await callTool('investigate', {
      project: fixture.project,
      question: 'How is the src/panel.tsx interface implemented in source for click interactions and navigation?',
    }) as any;
    assert.equal(interfaceControl.intent, 'interface', 'interface planning must outrank generic implementation-mechanism planning');
    assert.equal(interfaceControl.routing.tool, 'inspect_interface');

    const traceParaphrases = await Promise.all([
      'What does Panel depend on?',
      'Show dependencies of Panel',
      'Show relationships connected to Panel',
    ].map(question => callTool('investigate', { project: fixture.project, question }) as any));
    const traceSubjectIds = traceParaphrases.map(item => item.routing?.targetResolution?.node?.id ?? null);
    assert.ok(traceSubjectIds[0], 'trace paraphrases must resolve one concrete subject');
    assert.ok(traceSubjectIds.every(id => id === traceSubjectIds[0]), 'trace paraphrases must preserve the same resolved subject');
    assert.ok(traceParaphrases.every(item => item.routing?.questionPlan?.lane === 'trace'));

    const codeParaphrases = await Promise.all([
      'Where is Panel implemented?',
      'Show source implementation for Panel',
    ].map(question => callTool('investigate', { project: fixture.project, question }) as any));
    const codeSubjectIds = codeParaphrases.map(item => item.routing?.targetResolution?.node?.id ?? null);
    assert.ok(codeSubjectIds[0]);
    assert.ok(codeSubjectIds.every(id => id === codeSubjectIds[0]), 'code paraphrases must preserve the same resolved subject');

    const ordinaryEvidence = await callTool('investigate', {
      project: fixture.project,
      question: 'What evidence supports Panel?',
    }) as any;
    const negativeEvidence = await callTool('investigate', {
      project: fixture.project,
      question: 'Prove Panel is the only composition root.',
    }) as any;
    assert.equal(ordinaryEvidence.routing.questionPlan.proofMode, 'evidence');
    assert.equal(negativeEvidence.routing.questionPlan.proofMode, 'claim');
    assert.equal(
      ordinaryEvidence.routing.targetResolution.node.id,
      negativeEvidence.routing.targetResolution.node.id,
      'proof burden must not silently change the resolved subject',
    );

    const independentQuestions = [
      'What is Panel?',
      'Where is helper implemented?',
      'What evidence supports Panel?',
    ];
    const independentBatch = await callTool('investigate', {
      project: fixture.project,
      questions: independentQuestions,
    }) as any;
    const independentSingles = await Promise.all(independentQuestions.map(question => callTool('investigate', {
      project: fixture.project,
      question,
      graphId: independentBatch.graphId,
    }) as any));
    assert.equal(independentBatch.counts.error, 0);
    for (const [index, single] of independentSingles.entries()) {
      const item = independentBatch.items[index];
      assert.equal(item.intent, single.intent, `batch intent drifted for independent question ${index}`);
      assert.equal(item.routing?.tool, single.routing?.tool, `batch routing drifted for independent question ${index}`);
      assert.equal(item.subject?.id ?? null, single.subject?.id ?? null, `batch subject drifted for independent question ${index}`);
      assert.equal(item.answer, single.answer, `batch answer drifted for independent question ${index}`);
    }

    const isolated = await queryWorkbenchRequest({
      project: fixture.project,
      questions: ['What is Panel?', 'What does definitely-not-real depend on?', 'What evidence supports it?'],
    }) as any;
    assert.equal(isolated.items[0].status, 'ok');
    assert.equal(isolated.items[1].status, 'error');
    assert.equal(isolated.items[2].status, 'ok', 'one failed question must not poison later questions');
    assert.equal(isolated.items[2].inheritedSubject, null, 'a failed intervening question must break stale pronoun inheritance');
    assert.equal(isolated.items[2].resolvedQuestion, 'What evidence supports it?', 'later pronouns must remain unresolved instead of silently jumping over a failed question');
    assert.notEqual(isolated.items[2].subject?.id ?? null, isolated.items[0].subject?.id ?? null, 'an older exact subject must not leak across a failed question');
    assert.equal(isolated.counts.error, 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('interface runtime observation contract is provider-neutral and does not confuse deployment evidence with runtime UI evidence', () => {
  const contract = interfaceRuntimeObservationContract() as any;
  assert.equal(contract.version, 1);
  assert.equal(contract.plane, 'interface-runtime');
  assert.equal(contract.providerNeutral, true);
  assert.equal(contract.correlation.nameOnlyCrossPlaneResolutionAllowed, false);
  assert.equal(contract.retention.rawHighCardinalityTelemetryRetainedByDefault, false);
  assert.equal(contract.authority.runtimeObservationIsEvidence, true);
  assert.equal(contract.authority.semanticAuthority, false);

  assert.equal(isInterfaceRuntimeObservationSource({
    id: 'runtime:https://example.test/app',
    kind: 'runtime-http',
    locator: 'https://example.test/app',
    revision: null,
    observedAt: new Date(0).toISOString(),
    available: true,
  }), true);
  assert.equal(isInterfaceRuntimeObservationSource({
    id: 'deployment:123',
    kind: 'deployment',
    locator: 'deployment:123',
    revision: 'abc',
    observedAt: new Date(0).toISOString(),
    available: true,
  }), false);
});

test('interface projection organizes UI interactions and effects without creating semantic authority', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);

    const projection = await interfaceProjection({
      project: fixture.project,
      scope: 'src/panel.tsx',
      limit: 20,
    }) as any;
    assert.equal(projection.scope.kind, 'file');
    assert.equal(projection.policy.deterministic, true);
    assert.equal(projection.policy.persisted, false);
    assert.equal(projection.policy.semanticAuthority, false);
    assert.ok(projection.surfaces.length > 0, 'projection should expose an explicit surface or a source-evidenced surface owner');
    assert.ok(projection.surfaces.some((item: any) => item.projectionRole === 'surface' || item.projectionRole === 'surface-owner'));
    assert.ok(projection.interactions.length > 0 || projection.surfaces.some((item: any) => item.projectionRole === 'surface-owner'));
    assert.ok(projection.effects.some((item: any) => item.kind === 'http-call'));
    assert.ok(projection.transitions.some((item: any) => item.kind === 'navigation-call'));
    assert.equal(projection.runtimeObservations.available, false);
    assert.equal(projection.runtimeObservationContract.version, 1);
    assert.equal(projection.runtimeObservationContract.providerNeutral, true);
    assert.equal(projection.runtimeObservationContract.correlation.exactRepositoryRevisionRequiredForResolved, true);
    assert.equal(projection.runtimeObservationContract.authority.semanticAuthority, false);
    assert.ok(projection.uncertainty.unknowns.some((value: string) => /runtime state transitions/i.test(value)));

    const direct = await callTool('inspect_interface', {
      project: fixture.project,
      scope: 'src/panel.tsx',
      limit: 20,
    }) as any;
    assert.equal(direct.scope.kind, 'file');
    assert.equal(direct.policy.semanticAuthority, false);

    const natural = await callTool('investigate', {
      project: fixture.project,
      question: 'What changes when this control is activated?',
      scope: 'src/panel.tsx',
    }) as any;
    assert.equal(natural.intent, 'interface');
    assert.equal(natural.routing.tool, 'inspect_interface');
    assert.equal(natural.result.scope.kind, 'file');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('interface projection groups exact source-observed event mechanisms without upgrading declared handlers', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);
    const projection = await interfaceProjection({
      project: fixture.project,
      scope: 'src/interaction.tsx',
      limit: 30,
    }) as any;

    assert.equal(projection.capabilities.interactionMechanisms, true);
    assert.equal(projection.interactionMechanisms.policy.sourceObservedOnly, true);
    assert.equal(projection.interactionMechanisms.policy.runtimeOccurrenceProven, false);
    assert.equal(projection.interactionMechanisms.policy.stateEffectsInferred, false);

    const groups = new Map(projection.interactionMechanisms.families.map((group: any) => [group.family, group]));
    for (const family of ['pointer', 'drop', 'click', 'focus']) assert.ok(groups.has(family), family);
    const pointer = (groups.get('pointer') as any).items.find((item: any) => item.prop === 'onPointerMove');
    assert.equal(pointer.component, 'CanvasWidget');
    assert.equal(pointer.declaredHandler, 'handlePointerMove');
    assert.equal(pointer.resolvedHandler?.name, 'handlePointerMove');
    assert.ok(pointer.directConsequences.some((item: any) => item.kind === 'state-write' && item.name === 'active' && item.proof === 'resolved-handler-direct-edge'));
    const drop = (groups.get('drop') as any).items.find((item: any) => item.prop === 'onDrop');
    assert.equal(drop.declaredHandler, 'handleDrop');
    assert.equal(drop.resolvedHandler?.name, 'handleDrop');
    assert.ok(drop.directConsequences.some((item: any) => item.kind === 'http-call' && item.name === 'POST /api/drop'));
    const focus = (groups.get('focus') as any).items.find((item: any) => item.prop === 'onFocus');
    assert.ok(focus.directConsequences.some((item: any) => item.kind === 'navigation-call' && item.name === '/focused'));
    const click = (groups.get('click') as any).items.find((item: any) => item.prop === 'onClick');
    assert.deepEqual(click.directConsequences, []);
    assert.equal(projection.interactionMechanisms.resolvedHandlerCount, 4);
    assert.equal(projection.interactionMechanisms.directConsequenceMechanismCount, 3);
    assert.equal(projection.interactionMechanisms.policy.directConsequencesRequireResolvedHandler, true);
    assert.equal(projection.interactionMechanisms.policy.directConsequencesRequireResolvedInvokesEdge, true);
    const allItems = projection.interactionMechanisms.families.flatMap((group: any) => group.items);
    assert.equal(allItems.some((item: any) => item.prop === 'dataAction'), false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('scope orientation surfaces explainable local graph structure without an opaque importance score', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);
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
    assert.ok(Array.isArray(orientation.responsibilities) && orientation.responsibilities.length > 0);
    assert.ok(orientation.responsibilities.every((item: any) => typeof item.statement === 'string' && Array.isArray(item.evidenceNodeIds)));
    assert.ok(orientation.roleGroups.some((item: any) => Array.isArray(item.entities) && item.entities.length > 0));
    const aggregatedDependencies = [...orientation.dependencies.outbound, ...orientation.dependencies.inbound];
    assert.ok(aggregatedDependencies.length > 0, 'file orientation should aggregate resolved scope-boundary dependencies');
    assert.ok(aggregatedDependencies.every((item: any) => Array.isArray(item.edgeIds) && item.edgeIds.length > 0 && Array.isArray(item.relationshipKinds)));
    assert.equal(/^\d+ graph entities/u.test(orientation.summary), false, 'scoped orientation should lead with observed responsibility rather than topology counts');
    assert.equal(orientation.policy.responsibilitySynthesis, 'observed-role-groups');
    assert.equal(orientation.policy.dependencyAggregation, 'resolved-boundary-edges');
    assert.equal(orientation.policy.summaryInfersProductIntent, false);

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
    assert.equal(natural.answer, natural.result.summary);
    assert.equal(/^\d+ graph entities/u.test(natural.answer), false);
    assert.ok(Array.isArray(natural.result.responsibilities) && natural.result.responsibilities.length > 0);

    const missingScope = await callTool('investigate', {
      project: fixture.project,
      question: 'What are the main functions this page uses?',
    }) as any;
    assert.equal(missingScope.intent, 'orientation');
    assert.equal(missingScope.routing.targetResolution.mode, 'scope-required');
    assert.equal(missingScope.result.scopeRequired, true, 'deictic scope should remain explicit instead of guessing');

    const projectQuestion = await callTool('investigate', {
      project: fixture.project,
      question: 'What does this project do?',
    }) as any;
    assert.equal(projectQuestion.intent, 'orientation');
    assert.equal(projectQuestion.routing.tool, 'orient_scope');
    assert.equal(projectQuestion.routing.semanticDepth, 'nucleus');
    assert.equal(projectQuestion.result.scope.kind, 'repository');
    assert.ok(projectQuestion.result.semanticUnderstanding);
    assert.ok(['accepted-authority', 'observed-semantic-graph', 'derived-candidates', 'structural-only'].includes(projectQuestion.result.semanticUnderstanding.source));
    assert.equal(projectQuestion.result.semanticUnderstanding.depth, 'nucleus');
    assert.equal(projectQuestion.answer, projectQuestion.result.semanticUnderstanding.summary);
    assert.equal(/^\d+ graph entities/u.test(projectQuestion.answer), false, 'general project questions should lead with semantic understanding rather than topology counts');
    assert.equal(projectQuestion.result.semanticUnderstanding.authority.acceptanceImpliesVerification, false);
    assert.equal(projectQuestion.result.semanticUnderstanding.completeness.repositoryOmissionMeansAbsent, false);
    assert.equal(projectQuestion.result.semanticUnderstanding.expansion.nextDepth, 'expanded');

    const expandedProject = await callTool('investigate', {
      project: fixture.project,
      question: 'What does this project do? Go deep across the supporting systems, semantic layers, substrates, and evidence.',
    }) as any;
    assert.equal(expandedProject.routing.semanticDepth, 'expanded');
    assert.equal(expandedProject.result.semanticUnderstanding.depth, 'expanded');
    assert.ok(expandedProject.result.semanticUnderstanding.layers.derived.returned > 0);
    assert.equal(expandedProject.result.semanticUnderstanding.completeness.claim, 'non-exhaustive-semantic-answer');

    const exhaustiveProject = await callTool('investigate', {
      project: fixture.project,
      question: 'What does this project do? Exhaustively enumerate every evidence-qualified semantic candidate in the repository.',
    }) as any;
    assert.equal(exhaustiveProject.routing.semanticDepth, 'exhaustive');
    assert.equal(exhaustiveProject.result.semanticUnderstanding.depth, 'exhaustive');
    assert.equal(exhaustiveProject.result.semanticUnderstanding.completeness.semanticCandidateUniverseExhausted, true);
    assert.equal(exhaustiveProject.result.semanticUnderstanding.completeness.candidateOmissionWithinExhaustedCensusMeansAbsent, true);

    const expandedDerived = expandedProject.result.semanticUnderstanding.layers.derived.items;
    const exhaustiveDerived = exhaustiveProject.result.semanticUnderstanding.layers.derived.items;
    const exhaustiveDerivedIds = new Set(exhaustiveDerived.map((item: any) => item.id));
    assert.ok(
      expandedDerived.every((item: any) => exhaustiveDerivedIds.has(item.id)),
      'exhaustive depth must monotonically contain every semantic candidate surfaced by expanded depth',
    );
    const expandedCoreIds = expandedDerived
      .filter((item: any) => item.coreness === 'core-candidate' && item.factuality === 'supported')
      .map((item: any) => item.id);
    assert.equal(
      expandedProject.result.semanticUnderstanding.layers.derived.coreReturned,
      expandedCoreIds.length,
      'expanded core-return accounting must match the surfaced evidence-qualified core set',
    );
    assert.equal(
      expandedProject.result.semanticUnderstanding.completeness.expandedCoreCoverageComplete,
      true,
      'small complete fixtures should prove expanded core coverage rather than merely imply it',
    );

    const explicitExpanded = await callTool('investigate', {
      project: fixture.project,
      question: 'What does this project do?',
      semanticDepth: 'expanded',
    }) as any;
    assert.equal(explicitExpanded.routing.semanticDepth, 'expanded');

    const semanticDepthBatch = await callTool('investigate', {
      project: fixture.project,
      questions: [
        'What does this project do?',
        'What does this project do? Go deep across supporting semantic layers and substrates.',
        'What does this project do? Exhaustively enumerate every evidence-qualified semantic candidate.',
      ],
    }) as any;
    assert.deepEqual(
      semanticDepthBatch.items.map((item: any) => item.routing.semanticDepth),
      ['nucleus', 'expanded', 'exhaustive'],
      'each batch question should infer semantic depth independently while sharing one graph context',
    );
    assert.ok(semanticDepthBatch.items.every((item: any) => item.result.graphId === semanticDepthBatch.graphId));

    const semanticLifecycle = await callTool('investigate', {
      project: fixture.project,
      question: 'How are accepted semantic meanings preserved, evolved, superseded, split, merged, and prevented from silently changing across revisions?',
    }) as any;
    assert.equal(semanticLifecycle.intent, 'semantic-lifecycle');
    assert.equal(semanticLifecycle.routing.projection, 'semantic-lifecycle');
    assert.match(semanticLifecycle.answer, /proposal.*review.*acceptance.*verification.*stable meaning identity.*Preview→Main/u);
    assert.equal(semanticLifecycle.result.policy.acceptanceImpliesVerification, false);
    assert.equal(semanticLifecycle.result.policy.verificationImpliesAcceptance, false);
    assert.equal(semanticLifecycle.result.policy.verificationRequiresEvidence, true);
    assert.equal(semanticLifecycle.result.policy.acceptedMeaningCannotBeSilentlyAmended, true);
    assert.equal(semanticLifecycle.result.policy.previousRevisionApprovalDoesNotApprovePreviewDelta, true);
    assert.deepEqual(
      semanticLifecycle.result.policy.promotionApprovalAlternatives,
      ['human-accepted', 'human-verified', 'ai-verified'],
    );

    const lifecycleStateQuestions = await callTool('investigate', {
      project: fixture.project,
      questions: [
        'What conditions make the semantic promotion gate enforced rather than advisory or not enrolled?',
        'What is still missing before this repository has an accepted semantic baseline on main?',
      ],
    }) as any;
    assert.deepEqual(
      lifecycleStateQuestions.items.map((item: any) => item.intent),
      ['semantic-lifecycle', 'semantic-lifecycle'],
    );
    assert.notEqual(
      lifecycleStateQuestions.items[0].answer,
      lifecycleStateQuestions.items[1].answer,
      'distinct semantic lifecycle questions must not collapse to one static answer',
    );
    assert.match(lifecycleStateQuestions.items[0].answer, /not enrolled.*non-blocking/iu);
    assert.match(lifecycleStateQuestions.items[1].answer, /does not yet have an accepted semantic baseline/iu);
    assert.equal(lifecycleStateQuestions.items[0].result.governance.enrollmentState, 'not-enrolled');

    const semanticImplementationAudit = await callTool('investigate', {
      project: fixture.project,
      question: 'Are there source-backed implementation gaps or contradictions in semantic review, authority, and promotion workflow?',
    }) as any;
    assert.equal(semanticImplementationAudit.intent, 'repository-audit');
    assert.equal(semanticImplementationAudit.routing.tool, 'audit_repository');
    assert.match(semanticImplementationAudit.answer, /repository defects|deterministic finding/iu);

    const proposalToAuthority = await callTool('investigate', {
      project: fixture.project,
      question: 'How does semantic meaning move from an AI proposal to accepted authority and verification?',
    }) as any;
    assert.equal(proposalToAuthority.intent, 'semantic-lifecycle');
    assert.equal(proposalToAuthority.result.stages[0].stage, 'proposal');
    assert.equal(proposalToAuthority.result.stages.at(-1).stage, 'promotion');


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


test('repository-deictic project questions outrank a colliding Project entity name', async () => {
  const fixture = await makeFixture();
  try {
    await fs.writeFile(path.join(fixture.source, 'src', 'project.ts'), `
export class Project {
  describe() { return 'feature project'; }
}
`);
    await commit(fixture.source, 'add colliding Project entity');
    await runChecked('git', ['-C', fixture.source, 'push', 'origin', 'main']);
    clearGraphCache(fixture.project);
    const graph = await scanGraph(fixture.project);
    assert.ok(graph.nodes.some(node => node.name === 'Project'), 'fixture must contain an entity named Project');

    const general = await callTool('investigate', {
      project: fixture.project,
      question: 'What does this project do?',
    }) as any;
    assert.equal(general.intent, 'orientation');
    assert.equal(general.result.scope.kind, 'repository');
    assert.ok(general.result.semanticUnderstanding);

    const possessive = await callTool('investigate', {
      project: fixture.project,
      question: "What are this project's major capabilities?",
    }) as any;
    assert.equal(possessive.intent, 'orientation');
    assert.equal(possessive.result.scope.kind, 'repository');
    assert.ok(possessive.result.semanticUnderstanding);

    const explicitEntity = await callTool('investigate', {
      project: fixture.project,
      question: 'What does Project do?',
    }) as any;
    assert.equal(explicitEntity.intent, 'orientation');
    assert.equal(explicitEntity.result.scope.kind, 'entity', 'an explicit Project entity question must remain entity-scoped');
    assert.equal(explicitEntity.result.scope.value, graph.nodes.find(node => node.name === 'Project')?.id);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('semantic audit exposes factuality and core facets without changing semantic authority', async () => {
  const fixture = await makeFixture();
  try {
    clearGraphCache(fixture.project);
    await scanGraph(fixture.project);

    const direct = await callTool('audit_semantics', {
      project: fixture.project,
      candidateLimit: 200,
      limit: 30,
    }) as any;
    assert.equal(direct.policy.derivedAssessmentOnly, true);
    assert.equal(direct.policy.authorityUnaffected, true);
    assert.equal(direct.policy.verificationUnaffected, true);
    assert.equal(direct.policy.subjectiveGlobalScore, false);
    assert.equal(direct.policy.productIntentInferred, false);
    assert.equal(direct.candidateUniverse.eligible >= direct.candidateUniverse.returned, true);
    assert.ok(Array.isArray(direct.items));
    assert.ok(direct.items.every((item: any) => item.authority.accepted === false && item.authority.persisted === false));
    assert.ok(direct.items.every((item: any) => ['core-candidate', 'supporting-candidate'].includes(item.coreness.classification)));

    const natural = await callTool('investigate', {
      project: fixture.project,
      question: 'Which semantic meanings look core and are they factual?',
    }) as any;
    assert.equal(natural.intent, 'semantic-audit');
    assert.equal(natural.routing.tool, 'audit_semantics');
    assert.equal(natural.result.policy.authorityUnaffected, true);
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
    assert.ok(Array.isArray(overview.semanticBootstrap?.detailTools));
    for (const candidate of overview.semanticBootstrap?.candidates ?? []) {
      assert.equal(candidate.provenance?.nodeIds, undefined);
      assert.equal(candidate.provenance?.edgeIds, undefined);
      assert.equal(candidate.provenance?.evidenceIds, undefined);
      assert.ok((candidate.provenance?.sampleNodeIds?.length ?? 0) <= 4);
      assert.ok((candidate.provenance?.sampleEdgeIds?.length ?? 0) <= 4);
      assert.ok((candidate.provenance?.sampleEvidenceIds?.length ?? 0) <= 4);
      assert.equal(typeof candidate.provenance?.nodeCount, 'number');
      assert.equal(typeof candidate.provenance?.edgeCount, 'number');
      assert.equal(typeof candidate.provenance?.evidenceCount, 'number');
      assert.ok((candidate.evidencePacket?.representativeNodes?.length ?? 0) <= 6);
      assert.ok((candidate.evidencePacket?.representativeEdges?.length ?? 0) <= 6);
    }
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

test('Development Intelligence semantic declarations cover every live MCP tool without requiring repository Git metadata', () => {
  const modeled = DEVELOPMENT_INTELLIGENCE_SEMANTICS
    .map(entry => entry.developmentIntelligence)
    .filter(entry => entry.kind === 'mcp')
    .map(entry => entry.id)
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
    'project_statistics',
    'investigate',
    'orient_scope',
    'inspect_interface',
    'audit_semantics',
    'semantic_review_surface',
    'semantic_promotion_gate',
    'audit_semantic_authority_portfolio',
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
  assert.equal(byName.get('inspect_interface')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('inspect_interface')?.annotations?.openWorldHint, true);
  assert.equal(byName.get('audit_semantics')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('audit_semantics')?.annotations?.openWorldHint, true);
  assert.equal(byName.get('semantic_review_surface')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('semantic_review_surface')?.annotations?.openWorldHint, true);
  assert.equal(byName.get('semantic_promotion_gate')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('semantic_promotion_gate')?.annotations?.openWorldHint, true);
  assert.equal(byName.get('audit_semantic_authority_portfolio')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('audit_semantic_authority_portfolio')?.annotations?.openWorldHint, true);
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
  assert.deepEqual(contract, { toolCount: 33, contractFingerprint: contract.contractFingerprint });
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
  assert.equal(identity.mcp.toolCount, 33);
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
  await scanGraph(fixture.project);
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
    assert.ok(listBody.result.tools.some((tool: any) => tool.name === 'inspect_interface'));
    assert.ok(listBody.result.tools.some((tool: any) => tool.name === 'audit_semantics'));
    assert.ok(listBody.result.tools.some((tool: any) => tool.name === 'audit_semantic_authority_portfolio'));
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
    assert.match(html, /Semantics/);
    assert.match(html, /data-section="semantics"/);
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
    assert.match(viewerJavaScript, /explicit review/);
    assert.match(viewerJavaScript, /\/workbench\/semantics\/review/);
    assert.match(viewerJavaScript, /\/workbench\/semantics\/lineage/);
    assert.match(viewerJavaScript, /\/workbench\/semantics\/ai-proposal/);
    assert.match(viewerJavaScript, /AI proposal packet \/ import/);
    assert.match(viewerJavaScript, /Record AI proposal from these editable fields/);
    assert.match(viewerJavaScript, /Accept meaning/);
    assert.match(viewerJavaScript, /Verify with evidence/);
    assert.match(viewerJavaScript, /Resolve semantic lineage/);
    assert.match(viewerJavaScript, /Semantic change audit/);
    assert.match(viewerJavaScript, /data-semantic-change-ref/);
    assert.match(viewerJavaScript, /\/workbench\/semantics\/change-verify/);
    assert.match(viewerJavaScript, /\/workbench\/semantics\/enrollment/);
    assert.match(viewerJavaScript, /\/workbench\/semantics\/bootstrap/);
    assert.match(viewerJavaScript, /\/workbench\/semantics\/portfolio-bootstrap/);
    assert.match(viewerJavaScript, /Bootstrap semantic gate on current Main/);
    assert.match(viewerJavaScript, /Bootstrap semantic authority across portfolio/);
    assert.match(viewerJavaScript, /What this means:/);
    assert.match(viewerJavaScript, /Update semantic release policy/);
    assert.match(viewerJavaScript, /Verify this SEM change/);
    assert.match(viewerJavaScript, /stable SEM ID/);
    assert.match(viewerJavaScript, /Split source across candidate group/);
    assert.match(viewerJavaScript, /Merge sources into this candidate/);
    assert.match(viewerJavaScript, /reach describes connection, not impact severity/i);
    assert.match(viewerJavaScript, /Claims and proof/);

    const semanticsParams = new URLSearchParams({ project: fixture.project, action: 'semantics', limit: '20' });
    const semantics = await fetch(`${origin}/workbench/data?${semanticsParams}`);
    assert.equal(semantics.status, 200);
    const semanticsBody = await semantics.json() as any;
    assert.ok(Array.isArray(semanticsBody.candidates));
    assert.equal(semanticsBody.policy.candidatesRemainNonAuthoritativeUntilReviewed, true);
    assert.equal(semanticsBody.policy.acceptanceImpliesVerification, false);
    assert.equal(semanticsBody.policy.ownerWriteSurfaceSeparate, true);
    assert.equal(semanticsBody.policy.aiProposalProviderNeutral, true);
    assert.equal(semanticsBody.policy.modelOutputAcceptedAutomatically, false);
    assert.ok(semanticsBody.candidates.every((candidate: any) => candidate.aiProposalPacket?.policy?.explicitHumanReviewRequiredForAcceptance === true));
    assert.equal(semanticsBody.policy.promotionAuditItemized, true);
    assert.equal(semanticsBody.policy.promotionAuditDesiredOutcomeInferred, false);
    assert.equal(semanticsBody.policy.promotionGateVerificationCanBeDelegated, true);
    assert.equal(semanticsBody.policy.promotionEnrollmentExplicit, true);
    assert.equal(semanticsBody.policy.nonEnrolledAndAdvisoryNeverBlockMain, true);
    assert.equal(semanticsBody.policy.ownerBootstrapRequiresAuthenticatedSession, true);
    assert.equal(semanticsBody.policy.bootstrapDefaultsToSupportedCoreMeanings, true);
    assert.equal(semanticsBody.policy.bootstrapFinalizesOnlyExactCurrentMain, true);
    assert.equal(typeof semanticsBody.gateExplanation.behavior, 'string');
    assert.ok(Array.isArray(semanticsBody.gateExplanation.recommendedBaselineCandidateIds));
    assert.ok(semanticsBody.candidates.every((candidate: any) => candidate.reviewAssessment?.factuality));
    assert.equal(semanticsBody.authority.enrollmentState, 'not-enrolled');
    assert.ok(semanticsBody.promotionAudit);
    assert.equal(semanticsBody.promotionAudit.enrollmentState, 'not-enrolled');
    assert.equal(semanticsBody.promotionAudit.gateStatus, 'non-blocking');
    assert.equal(semanticsBody.promotionAudit.blocksMain, false);
    assert.equal(semanticsBody.promotionAudit.blockingPendingCount, 0);
    assert.match(semanticsBody.promotionAudit.digest, /^[0-9a-f]{24}$/u);
    assert.equal(semanticsBody.promotionAudit.semanticDeltaCount, semanticsBody.promotionAudit.items.length);
    assert.ok(semanticsBody.promotionAudit.items.every((item: any, index: number) =>
      item.ordinal === index + 1
      && /^SEM-[0-9A-F]{8}$/.test(item.auditRef)
      && typeof item.changeId === 'string'
      && typeof item.summary === 'string'
      && Array.isArray(item.reasons)
    ));
    assert.equal(semanticsBody.promotionAudit.policy.desiredOutcomeInferred, false);

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
