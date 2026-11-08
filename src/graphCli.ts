import { analyzeLocalGraph, checkLocalGraph, generateLocalTestClaimCatalog, readLocalParityContract, readLocalTestClaimCatalog, sealLocalGraph } from './intelligence/local.js';
import { readTestClaimReportPage } from './intelligence/testClaimReport.js';
import { buildLocalGraph } from './intelligence/local.js';
import { projectLocalScipEvidence } from './intelligence/scipEvidence.js';
import { projectLocalJoernDataflow } from './intelligence/joernDataflow.js';
import { projectNodeTestEvents } from './intelligence/nodeTestEvidence.js';
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
  if ((nodeEventsPath || nodeProducerVersion || nodeRunId) && command !== 'node-test-evidence') throw new Error('Node test evidence flags require node-test-evidence command');
  if (scipProjectPrefix && command !== 'scip-evidence') throw new Error('--scip-project-prefix is supported only for scip-evidence');
  if (process.argv.includes('--scip-legacy-position-encoding') && !scipLegacyEncoding) throw new Error('--scip-legacy-position-encoding requires utf8, utf16 or utf32');
  if (scipLegacyEncoding && command !== 'scip-evidence') throw new Error('--scip-legacy-position-encoding is supported only for scip-evidence');
  if (command === 'analyze') {
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
    console.log(JSON.stringify({
      mode: 'ephemeral-node-test-event-evidence',
      ...observed,
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
