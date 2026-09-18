import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildLocalGraph } from '../dist/src/intelligence/local.js';

const targets = [
  {
    project: 'Game-Studio-Core',
    root: path.resolve(process.argv[2] ?? 'benchmark/game-studio-core'),
    expectedSha: process.env.GAME_STUDIO_CORE_BENCHMARK_SHA ?? '55263c4c0a1ee80fb9d28e6d6c0750d30db4c59d',
    requiredKinds: ['class', 'interface', 'method', 'unity-object', 'unity-asset-guid'],
    requiredStrategies: ['unity-guid', 'unity-file-id', 'unity-meta-companion'],
  },
  {
    project: 'Medieval-Sim',
    root: path.resolve(process.argv[3] ?? 'benchmark/medieval-sim'),
    expectedSha: process.env.MEDIEVAL_SIM_BENCHMARK_SHA ?? '8f721556d9548dfd09378d337b06416415ee09e7',
    requiredKinds: ['class', 'method', 'constructor', 'package', 'import-binding'],
    requiredRelationships: ['imports', 'resolves_to'],
  },
];

const reports = [];
for (const target of targets) {
  const actualSha = execFileSync('git', ['-C', target.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actualSha !== target.expectedSha) throw new Error(`${target.project} benchmark SHA mismatch: expected ${target.expectedSha}, got ${actualSha}`);
  const started = Date.now();
  const graph = await buildLocalGraph(target.root, target.project);
  const kindCounts = Object.fromEntries(target.requiredKinds.map(kind => [kind, graph.nodes.filter(node => node.kind === kind).length]));
  const strategyCounts = Object.fromEntries((target.requiredStrategies ?? []).map(strategy => [strategy, graph.edges.filter(edge => edge.strategy === strategy && edge.status === 'resolved').length]));
  const relationshipCounts = Object.fromEntries((target.requiredRelationships ?? []).map(kind => [kind, graph.edges.filter(edge => edge.kind === kind && edge.status === 'resolved').length]));
  for (const [kind, count] of Object.entries(kindCounts)) if (count < 1) throw new Error(`${target.project} expected observed ${kind} nodes`);
  for (const [strategy, count] of Object.entries(strategyCounts)) if (count < 1) throw new Error(`${target.project} expected resolved ${strategy} relationships`);
  for (const [kind, count] of Object.entries(relationshipCounts)) if (count < 1) throw new Error(`${target.project} expected resolved ${kind} relationships`);
  if (!graph.coverage || graph.coverage.failedFiles > 0) throw new Error(`${target.project} has failed or unavailable coverage`);
  if (graph.coverage.analyzedFiles < 1 || graph.nodes.length < 1 || graph.edges.length < 1) throw new Error(`${target.project} did not produce useful graph depth`);
  reports.push({
    project: target.project,
    targetSha: actualSha,
    elapsedMs: Date.now() - started,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    coverage: {
      eligibleFiles: graph.coverage.eligibleFiles,
      analyzedFiles: graph.coverage.analyzedFiles,
      completeFiles: graph.coverage.completeFiles,
      partialFiles: graph.coverage.partialFiles,
      skippedFiles: graph.coverage.skippedFiles,
      failedFiles: graph.coverage.failedFiles,
    },
    kindCounts,
    strategyCounts,
    relationshipCounts,
  });
}

const jsonPath = process.env.DEVINT_PORTFOLIO_JSON ?? path.resolve('benchmark-polyglot-portfolio.json');
await fs.writeFile(jsonPath, `${JSON.stringify({ benchmark: 'Development Intelligence pinned C#/Unity + Java portfolio', reports }, null, 2)}\n`);
const summary = [
  '# Development Intelligence polyglot portfolio benchmark',
  '',
  '| Repository | Exact SHA | Graph | Coverage | Partial | Skipped | Failed | Elapsed |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...reports.map(item => `| ${item.project} | \`${item.targetSha}\` | ${item.nodes} nodes / ${item.edges} edges | ${item.coverage.analyzedFiles}/${item.coverage.eligibleFiles} analyzed | ${item.coverage.partialFiles} | ${item.coverage.skippedFiles} | ${item.coverage.failedFiles} | ${item.elapsedMs} ms |`),
  '',
  ...reports.flatMap(item => [
    `## ${item.project} evidence`,
    '',
    ...Object.entries({ ...item.kindCounts, ...item.strategyCounts, ...item.relationshipCounts }).map(([name, count]) => `- ${name}: **${count}**`),
    '',
  ]),
  '> These replays are read-only and SHA-pinned. Partial and skipped coverage remains explicit rather than being promoted to complete inspection.',
].join('\n');
const markdownPath = process.env.DEVINT_PORTFOLIO_MARKDOWN ?? path.resolve('benchmark-polyglot-portfolio.md');
await fs.writeFile(markdownPath, `${summary}\n`);
console.log(summary);
