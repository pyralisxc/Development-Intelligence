#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildLocalGraph, readLocalParityContract } from '../dist/src/intelligence/local.js';
import { evaluateTestIndependentSourceContract } from '../dist/src/intelligence/independentSourceVerification.js';
import { runChecked } from '../dist/src/util/process.js';

const flag = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

async function main() {
  const started = Date.now();
  const root = await fs.realpath(path.resolve(flag('--repo-path') || '.'));
  const input = flag('--contract-file');
  if (!input) throw new Error('--contract-file is required');
  const project = flag('--project') || path.basename(root);
  const head = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const selected = flag('--expected-sha');
  if (selected && selected !== head) throw new Error('selected immutable Git revision differs from checkout HEAD');
  const before = (await runChecked('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (before) throw new Error('source verification needs a clean tracked checkout');
  const contract = await readLocalParityContract(root, input);
  const graph = await buildLocalGraph(root, project);
  const evaluated = evaluateTestIndependentSourceContract(graph, contract.contract);
  const after = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const clean = (await runChecked('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (after !== head || graph.repositoryRevision !== head || clean) {
    throw new Error('exact source revision or tracked checkout changed while verification ran');
  }
  console.log(JSON.stringify({
    ...evaluated,
    measures: {
      elapsedMs: Date.now() - started,
      rssBytes: process.memoryUsage().rss,
      sourceFiles: graph.coverage?.trackedFiles ?? null,
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
    },
  }));
  if (process.argv.includes('--require-established')
    && (evaluated.counts.sourceCounterexamples || evaluated.counts.unresolved)) {
    process.exitCode = 1;
  }
}
main().catch(error => {
  console.error(JSON.stringify({ valid: false, error: String(error?.message || error),
    negativeSourceConclusionsAreNotAssumed: true }));
  process.exitCode = 1;
});
