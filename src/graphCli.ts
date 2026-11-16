import { analyzeLocalGraph, checkLocalGraph, generateLocalTestClaimCatalog, readLocalParityContract, readLocalTestClaimCatalog, sealLocalGraph } from './intelligence/local.js';
import { promises as fs } from 'node:fs';
import { readTestClaimReportPage } from './intelligence/testClaimReport.js';
import { buildLocalGraph, buildLocalRevisionGraph, buildLocalWorkingGraph } from './intelligence/local.js';
import { activateLocalSourceGraph, backupLocalSourceGraphs, localSourceGraphHistory, readLocalSourceGraph, removeLocalGraphTarget, saveLocalSourceGraph } from './intelligence/localGraphStore.js';
import { filterGraph } from './intelligence/graphFilter.js';
import { compareRevisionSet, diffGraphs, pageGraphDiff } from './intelligence/query.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { projectLocalScipEvidence } from './intelligence/scipEvidence.js';
import { projectLocalJoernDataflow } from './intelligence/joernDataflow.js';
import { pageNodeTestEvents, projectNodeTestEvents } from './intelligence/nodeTestEvidence.js';
import { joinAssertionEvidence } from './intelligence/assertionEvidenceRouting.js';
import { generateTestClaimCatalog } from './intelligence/testClaimInventory.js';

const command = process.argv[2];
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const args = (name: string): string[] => process.argv.flatMap((value: string, index: number) => value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : []);
const root = arg('--repo-path') ?? process.cwd();
const project = arg('--project');
const parityContractFlag = process.argv.includes('--parity-contract');
const parityContractPath = arg('--parity-contract');
const testClaimCatalogFlag = process.argv.includes('--test-claim-catalog');
const testClaimCatalogPath = arg('--test-claim-catalog');
const testClaimReportPath = arg('--test-claim-report-path');
const producerCommit = arg('--producer-commit');
const scipIndexPath = arg('--scip-index');
const joernSlicePath = arg('--joern-slice-json');
const nodeEventsPath = arg('--node-test-events-jsonl');
const nodeProducerVersion = arg('--node-version');
const nodeRunId = arg('--node-run-id');
const nodeEventOffset = arg('--node-events-offset');
const nodeEventPageSize = arg('--node-events-page-size');
const nodeExpectedDigest = arg('--node-events-expected-sha256');
const joernProducerVersion = arg('--joern-version');
const joernProjectPrefix = arg('--joern-project-prefix');
const scipProjectPrefix = arg('--scip-project-prefix');
const scipLegacyEncodingRaw = arg('--scip-legacy-position-encoding');
const scipLegacyEncoding = scipLegacyEncodingRaw === 'utf8' || scipLegacyEncodingRaw === 'utf16' || scipLegacyEncodingRaw === 'utf32'
  ? scipLegacyEncodingRaw : undefined;

async function main(): Promise<void> {
  if (parityContractFlag && !parityContractPath) throw new Error('--parity-contract requires a path');
  if (parityContractFlag && command !== 'analyze') throw new Error('--parity-contract is supported only for analyze');
  if (testClaimCatalogFlag && !testClaimCatalogPath) throw new Error('--test-claim-catalog requires a path');
  if (testClaimCatalogFlag && command !== 'analyze') throw new Error('--test-claim-catalog is supported only for analyze');
  if (testClaimReportPath && command !== 'analyze' && command !== 'test-claims') throw new Error('--test-claim-report-path is supported only for analyze or test-claims');
  if (scipIndexPath && command !== 'scip-evidence') throw new Error('--scip-index is supported only for scip-evidence');
  if ((joernSlicePath || joernProducerVersion || joernProjectPrefix) && command !== 'joern-evidence') throw new Error('Joern evidence flags require joern-evidence command');
  if ((nodeEventsPath || nodeProducerVersion || nodeRunId || nodeEventOffset
    || nodeEventPageSize || nodeExpectedDigest) && command !== 'node-test-evidence') {
    throw new Error('Node test evidence flags require node-test-evidence command');
  }
  if (scipProjectPrefix && command !== 'scip-evidence') throw new Error('--scip-project-prefix is supported only for scip-evidence');
  if (process.argv.includes('--scip-legacy-position-encoding') && !scipLegacyEncoding) throw new Error('--scip-legacy-position-encoding requires utf8, utf16 or utf32');
  if (scipLegacyEncoding && command !== 'scip-evidence') throw new Error('--scip-legacy-position-encoding is supported only for scip-evidence');
  if (command === 'working-build') {
    const graph = await buildLocalWorkingGraph(root, project);
    const dataDir = arg('--data-dir');
    const retained = dataDir ? await saveLocalSourceGraph(dataDir, graph, Number(arg('--retain') ?? '3')) : undefined;
    const { files: _files, ...coverage } = graph.coverage ?? {};
    console.log(JSON.stringify({ project: graph.project, graphId: graph.graphId, sourceState: graph.sourceState, sourceFingerprint: graph.sourceFingerprint, nodes: graph.nodes.length, edges: graph.edges.length, coverage, producerCoverage: graph.producerCoverage, ...(retained ? { retained } : {}) }, null, 2));
  } else if (command === 'revision-build') {
    const ref = arg('--ref');
    const dataDir = arg('--data-dir');
    const target = arg('--target') ?? ref;
    if (!ref || !target || !dataDir) throw new Error('revision-build requires --ref and --data-dir');
    if (target === 'working') throw new Error('The working target is reserved for current local files');
    const graph = await buildLocalRevisionGraph(root, ref, project);
    const retained = await saveLocalSourceGraph(dataDir, graph, Number(arg('--retain') ?? '3'), target);
    console.log(JSON.stringify({ project: graph.project, target, revision: graph.repositoryRevision, graphId: graph.graphId, nodes: graph.nodes.length, edges: graph.edges.length, retained, producerCoverage: graph.producerCoverage }, null, 2));
  } else if (command === 'working-backup' || command === 'working-restore') {
    const dataDir = arg('--data-dir');
    const backupDir = arg('--backup-dir');
    if (!dataDir || !backupDir) throw new Error(`${command} requires --data-dir and --backup-dir`);
    if (command === 'working-backup') {
      await backupLocalSourceGraphs(dataDir, backupDir);
      console.log(JSON.stringify({ operation: command, sourceGraphs: path.resolve(backupDir, 'source-graphs'), includesWorkingSourceFiles: false }, null, 2));
      return;
    }
    const from = path.resolve(backupDir, 'source-graphs');
    const to = path.resolve(dataDir, 'source-graphs');
    if (from === to || to.startsWith(`${from}${path.sep}`) || from.startsWith(`${to}${path.sep}`)) throw new Error('Backup and source graph directories must be separate');
    await fs.mkdir(path.dirname(to), { recursive: true });
    try { await fs.lstat(to); throw new Error(`Destination already exists: ${to}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.cp(from, to, { recursive: true, force: false, errorOnExist: true });
    console.log(JSON.stringify({ operation: command, sourceGraphs: to, includesWorkingSourceFiles: false }, null, 2));
  } else if (command === 'working-history') {
    const dataDir = arg('--data-dir');
    if (!dataDir || !project) throw new Error('working-history requires --data-dir and --project');
    console.log(JSON.stringify(await localSourceGraphHistory(dataDir, project), null, 2));
  } else if (command === 'working-activate') {
    const dataDir = arg('--data-dir');
    const graphId = arg('--graph-id');
    if (!dataDir || !project || !graphId) throw new Error('working-activate requires --data-dir, --project and --graph-id');
    await activateLocalSourceGraph(dataDir, project, graphId);
    console.log(JSON.stringify({ project, graphId, active: true }, null, 2));
  } else if (command === 'working-unpin') {
    const dataDir = arg('--data-dir');
    const target = arg('--target');
    if (!dataDir || !project || !target) throw new Error('working-unpin requires --data-dir, --project and --target');
    await removeLocalGraphTarget(dataDir, project, target);
    console.log(JSON.stringify({ project, target, pinned: false }, null, 2));
  } else if (command === 'working-compare') {
    const dataDir = arg('--data-dir');
    const base = arg('--base');
    const target = arg('--target') ?? 'working';
    if (!dataDir || !project) throw new Error('working-compare requires --data-dir and --project');
    const offset = Number(arg('--offset') ?? '0'), limit = Number(arg('--limit') ?? '50');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Comparison offset must be non-negative and limit must be 1..500');
    if (!base) {
      process.env.DEVINT_LOCAL_GRAPH_DIR = path.resolve(dataDir);
      process.env.DEVINT_PROJECTS_JSON = JSON.stringify({ [project]: { repository: pathToFileURL(path.resolve(root)).href, defaultRef: 'HEAD', revisionPolicy: 'repository-history' } });
      const refs = args('--ref');
      console.log(JSON.stringify(await compareRevisionSet({ project, refs: refs.length ? refs : ['main', 'preview', 'working-tree'], offset, limit }), null, 2));
      return;
    }
    const catalog = await localSourceGraphHistory(dataDir, project);
    const resolve = (name: string) => catalog?.entries.find(item => item.generation === catalog.targets?.[name]);
    const baseEntry = resolve(base), targetEntry = resolve(target);
    if (!baseEntry || !targetEntry) throw new Error('Comparison targets must have retained graphs');
    const [left, right] = await Promise.all([readLocalSourceGraph(dataDir, project, baseEntry.graphId, baseEntry.generation), readLocalSourceGraph(dataDir, project, targetEntry.graphId, targetEntry.generation)]);
    const page = pageGraphDiff(diffGraphs(left, right), offset, limit);
    console.log(JSON.stringify({ project, baseTarget: base, target, ...page }, null, 2));
  } else if (command === 'working-query') {
    const dataDir = arg('--data-dir');
    const question = arg('--question');
    if (!dataDir || !project || !question) throw new Error('working-query requires --data-dir, --project and --question');
    const target = arg('--target');
    const catalog = target ? await localSourceGraphHistory(dataDir, project) : null;
    const generation = target ? catalog?.targets?.[target] : undefined;
    const entry = target ? catalog?.entries.find(item => item.generation === generation) : undefined;
    const graphId = arg('--graph-id') ?? entry?.graphId;
    if (target && !graphId) throw new Error(`No retained graph target: ${target}`);
    const graph = await readLocalSourceGraph(dataDir, project, graphId, arg('--graph-id') ? undefined : entry?.generation);
    console.log(JSON.stringify({ project, graphId: graph.graphId, sourceState: graph.sourceState, result: filterGraph(graph, { text: question }) }, null, 2));
  } else if (command === 'working-serve' || command === 'working-mcp') {
    const dataDir = arg('--data-dir');
    if (!dataDir || !project) throw new Error(`${command} requires --data-dir and --project`);
    process.env.DEVINT_LOCAL_GRAPH_DIR = path.resolve(dataDir);
    process.env.DEVINT_PROJECTS_JSON = JSON.stringify({ [project]: { repository: pathToFileURL(path.resolve(root)).href, defaultRef: 'HEAD', revisionPolicy: 'repository-history' } });
    if (command === 'working-mcp') await import('./stdio.js');
    else {
      process.env.DEVINT_AUTH_MODE = 'none';
      process.env.DEVINT_ALLOW_UNAUTHENTICATED = '1';
      const port = Number(arg('--port') ?? '8787');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
      const { createDevelopmentIntelligenceServer } = await import('./http.js');
      const server = createDevelopmentIntelligenceServer();
      server.listen(port, '127.0.0.1', () => console.error(`Development Intelligence Workbench: http://127.0.0.1:${port}/workbench`));
    }
  } else if (command === 'analyze') {
    const parityContract = parityContractPath ? await readLocalParityContract(root, parityContractPath) : undefined;
    const testClaimCatalog = testClaimCatalogPath ? await readLocalTestClaimCatalog(root, testClaimCatalogPath) : undefined;
    if (testClaimReportPath && !producerCommit) throw new Error('--producer-commit is required with --test-claim-report-path');
    const result = await analyzeLocalGraph(root, project, parityContract, testClaimCatalog, testClaimReportPath ? { path: testClaimReportPath, producerCommit: producerCommit! } : undefined);
    console.log(JSON.stringify(result, null, 2));
    if (result.valid !== true) process.exitCode = 1;
  } else if (command === 'scip-evidence') {
    if (!scipIndexPath) throw new Error('scip-evidence requires --scip-index');
    const canonical = await buildLocalGraph(root, project);
    const projection = await projectLocalScipEvidence({
      root, indexPath: scipIndexPath, graph: canonical,
      ...(scipProjectPrefix === undefined ? {} : { projectPrefix: scipProjectPrefix }),
      ...(scipLegacyEncoding === undefined ? {} : { legacyPositionEncoding: scipLegacyEncoding }),
    });
    console.log(JSON.stringify({
      mode: 'ephemeral-scip-evidence',
      project: canonical.project,
      revision: canonical.repositoryRevision,
      graphId: projection.graph.graphId,
      canonicalGraphId: canonical.graphId,
      index: projection.index,
      counts: projection.counts,
      compilerOverlap: projection.compilerOverlap,
      sampleEdges: projection.graph.edges.slice(canonical.edges.length, canonical.edges.length + 12),
      policy: projection.policy,
    }, null, 2));
  } else if (command === 'joern-evidence') {
    if (!joernSlicePath || !joernProducerVersion) {
      throw new Error('joern-evidence requires --joern-slice-json and --joern-version');
    }
    const canonical = await buildLocalGraph(root, project);
    const catalog = await generateTestClaimCatalog(root, canonical, {
      sourcePrefixes: ['tests/', 'scripts/', 'packaging/'],
      sourceSuffixes: ['.test.ts', '.test.mjs', '.test.js', '.test.tsx', '.spec.ts', '.spec.tsx', '.spec.js'],
    });
    const overlay = await projectLocalJoernDataflow({
      root, graph: canonical, slicePath: joernSlicePath,
      producerVersion: joernProducerVersion,
      ...(joernProjectPrefix ? { projectPrefix: joernProjectPrefix } : {}),
      testCatalog: catalog,
    });
    console.log(JSON.stringify({
      mode: 'ephemeral-oss-dataflow-evidence',
      project: canonical.project,
      revision: canonical.repositoryRevision,
      canonicalGraphId: canonical.graphId,
      graphId: overlay.graph.graphId,
      producer: overlay.producer,
      source: overlay.source,
      counts: overlay.counts,
      candidates: overlay.candidates,
      assertionEvidence: joinAssertionEvidence({ graph: canonical, catalog, joern: overlay }),
      policy: overlay.policy,
    }, null, 2));
  } else if (command === 'node-test-evidence') {
    if (!nodeEventsPath || !nodeProducerVersion) {
      throw new Error('node-test-evidence requires --node-test-events-jsonl and --node-version');
    }
    const canonical = await buildLocalGraph(root, project);
    const catalog = await generateTestClaimCatalog(root, canonical, {
      sourcePrefixes: ['tests/', 'scripts/', 'packaging/'],
      sourceSuffixes: ['.test.ts', '.test.mjs', '.test.js', '.test.tsx', '.spec.ts', '.spec.tsx', '.spec.js'],
    });
    const observed = await projectNodeTestEvents({
      root, graph: canonical, catalog, eventPath: nodeEventsPath,
      nodeVersion: nodeProducerVersion,
      ...(nodeRunId ? { runId: nodeRunId } : {}),
    });
    const offset = Number(nodeEventOffset ?? '0');
    const pageSize = Number(nodeEventPageSize ?? '100');
    if (offset > 0 && !nodeExpectedDigest) {
      throw new Error('Later Node test event pages require --node-events-expected-sha256');
    }
    if (nodeExpectedDigest && nodeExpectedDigest !== observed.identity.reportSha256) {
      throw new Error('Node test event report SHA-256 does not match requested page identity');
    }
    const presented = pageNodeTestEvents(observed, offset, pageSize);
    console.log(JSON.stringify({
      mode: 'ephemeral-node-test-event-evidence',
      ...observed,
      ...presented,
      // All assertions are joined BEFORE output presentation pagination.
      assertionEvidence: joinAssertionEvidence({ graph: canonical, catalog, testEvents: observed }),
    }, null, 2));
  } else if (command === 'catalog') {
    const sourcePrefixes = args('--source-prefix');
    const sourceSuffixes = args('--source-suffix');
    const outputPath = arg('--output');
    if (!project || !outputPath || !sourcePrefixes.length || !sourceSuffixes.length) throw new Error('catalog requires --project, --output, at least one --source-prefix, and at least one --source-suffix');
    const result = await generateLocalTestClaimCatalog({ root, project, sourcePrefixes, sourceSuffixes, outputPath });
    console.log(JSON.stringify({ path: result.path, revision: result.catalog.revision, analyzerVersion: result.catalog.analyzerVersion, counts: { files: result.catalog.files.length, declarations: result.catalog.declarations.length, assertions: result.catalog.assertions.length, unsupportedFiles: result.catalog.files.filter(file => file.disposition === 'unsupported').length }, claims: result.catalog.claims.length }, null, 2));
  } else if (command === 'test-claims') {
    const digest = arg('--report-digest');
    const revision = arg('--revision');
    if (!digest || !revision || !project) throw new Error('test-claims requires --project, --report-digest and --revision');
    const page = Number(arg('--page') ?? '0');
    const pageSize = Number(arg('--page-size') ?? '100');
    if (!Number.isInteger(page) || page < 0 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('test-claims page must be non-negative and page-size must be 1..500');
    console.log(JSON.stringify(await readTestClaimReportPage({ root, ...(testClaimReportPath ? { reportPath: testClaimReportPath } : {}), expectedDigest: digest, expectedRevision: revision, expectedProject: project, page, pageSize }), null, 2));
  } else if (command === 'seal') {
    const result = await sealLocalGraph(root, project);
    console.log(JSON.stringify({ path: result.path, graphId: result.graph.graphId, sourceFingerprint: result.graph.sourceFingerprint, nodes: result.graph.nodes.length, edges: result.graph.edges.length }, null, 2));
  } else if (command === 'check') {
    const result = await checkLocalGraph(root, project);
    console.log(JSON.stringify(result, null, 2));
    if (result.current !== true) process.exitCode = 1;
  } else {
    console.error('Usage: graphCli.js <analyze|catalog|seal|check|test-claims|scip-evidence|joern-evidence|node-test-evidence> [--repo-path PATH] [--project NAME] [--source-prefix PATH] [--source-suffix SUFFIX] [--output PATH] [--parity-contract PATH] [--test-claim-catalog PATH] [--test-claim-report-path PATH] [--scip-index FILE.scip] [--scip-project-prefix PATH] [--scip-legacy-position-encoding utf8|utf16|utf32] [--joern-slice-json FILE] [--joern-version VERSION] [--joern-project-prefix PATH] [--node-test-events-jsonl FILE] [--node-version VERSION] [--node-run-id RUN_ID]');
    process.exitCode = 2;
  }
}

await main().catch(error => {
  console.error(JSON.stringify({
    valid: false,
    mode: command ?? null,
    error: {
      code: testClaimCatalogFlag ? 'test-claim-catalog-error' : parityContractFlag ? 'parity-contract-error' : 'operation-error',
      message: error instanceof Error ? error.message : String(error),
    },
    ...(parityContractPath ? { parityContract: { supplied: true, path: parityContractPath, valid: false } } : {}),
    ...(testClaimCatalogPath ? { testClaimCatalog: { supplied: true, path: testClaimCatalogPath, valid: false } } : {}),
  }, null, 2));
  process.exitCode = 1;
});
