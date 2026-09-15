import { checkLocalGraph, sealLocalGraph } from './intelligence/local.js';

const command = process.argv[2];
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const root = arg('--repo-path') ?? process.cwd();
const project = arg('--project');

if (command === 'seal') {
  const result = await sealLocalGraph(root, project);
  console.log(JSON.stringify({ path: result.path, graphId: result.graph.graphId, sourceFingerprint: result.graph.sourceFingerprint, nodes: result.graph.nodes.length, edges: result.graph.edges.length }, null, 2));
} else if (command === 'check') {
  const result = await checkLocalGraph(root, project);
  console.log(JSON.stringify(result, null, 2));
  if (result.current !== true) process.exitCode = 1;
} else {
  console.error('Usage: graphCli.js <seal|check> [--repo-path PATH] [--project NAME]');
  process.exitCode = 2;
}
