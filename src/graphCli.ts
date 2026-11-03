import { analyzeLocalGraph, checkLocalGraph, readLocalParityContract, readLocalTestClaimCatalog, sealLocalGraph } from './intelligence/local.js';

const command = process.argv[2];
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const root = arg('--repo-path') ?? process.cwd();
const project = arg('--project');
const parityContractFlag = process.argv.includes('--parity-contract');
const parityContractPath = arg('--parity-contract');
const testClaimCatalogFlag = process.argv.includes('--test-claim-catalog');
const testClaimCatalogPath = arg('--test-claim-catalog');

async function main(): Promise<void> {
  if (parityContractFlag && !parityContractPath) throw new Error('--parity-contract requires a path');
  if (parityContractFlag && command !== 'analyze') throw new Error('--parity-contract is supported only for analyze');
  if (testClaimCatalogFlag && !testClaimCatalogPath) throw new Error('--test-claim-catalog requires a path');
  if (testClaimCatalogFlag && command !== 'analyze') throw new Error('--test-claim-catalog is supported only for analyze');
  if (command === 'analyze') {
    const parityContract = parityContractPath ? await readLocalParityContract(root, parityContractPath) : undefined;
    const testClaimCatalog = testClaimCatalogPath ? await readLocalTestClaimCatalog(root, testClaimCatalogPath) : undefined;
    const result = await analyzeLocalGraph(root, project, parityContract, testClaimCatalog);
    console.log(JSON.stringify(result, null, 2));
    if (result.valid !== true) process.exitCode = 1;
  } else if (command === 'seal') {
    const result = await sealLocalGraph(root, project);
    console.log(JSON.stringify({ path: result.path, graphId: result.graph.graphId, sourceFingerprint: result.graph.sourceFingerprint, nodes: result.graph.nodes.length, edges: result.graph.edges.length }, null, 2));
  } else if (command === 'check') {
    const result = await checkLocalGraph(root, project);
    console.log(JSON.stringify(result, null, 2));
    if (result.current !== true) process.exitCode = 1;
  } else {
    console.error('Usage: graphCli.js <analyze|seal|check> [--repo-path PATH] [--project NAME] [--parity-contract PATH] [--test-claim-catalog PATH]');
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
