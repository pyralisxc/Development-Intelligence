import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cardForgeRoot = path.resolve(process.argv[2] ?? 'benchmark/cardforge');
const expectedSha = process.env.CARDFORGE_BENCHMARK_SHA ?? '6d6788cf87dd37d7685d26fa10a15e06fa1208ba';
const actualSha = execFileSync('git', ['-C', cardForgeRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actualSha !== expectedSha) throw new Error(`CardForge benchmark SHA mismatch: expected ${expectedSha}, got ${actualSha}`);

execFileSync('git', ['-C', cardForgeRoot, 'update-ref', 'refs/heads/devint-benchmark', actualSha]);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-cardforge-benchmark-'));
const configPath = path.join(temp, 'projects.json');
const localRepository = pathToFileURL(path.join(cardForgeRoot, '.git')).href;
await fs.writeFile(configPath, JSON.stringify({
  CardForge: {
    repository: localRepository,
    defaultRef: 'refs/heads/devint-benchmark',
    allowedRefs: ['refs/heads/devint-benchmark'],
    credential: { type: 'none' },
  },
}, null, 2));

process.env.DEVINT_PROJECTS_FILE = configPath;
process.env.DEVINT_SCRATCH_DIR = path.join(temp, 'scratch');
process.env.DEVINT_GRAPH_MAX_FILES = process.env.DEVINT_GRAPH_MAX_FILES ?? '20000';
process.env.DEVINT_GRAPH_MAX_FILE_BYTES = process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? '2000000';
process.env.DEVINT_GRAPH_CACHE_SIZE = '2';

const { callTool } = await import('../dist/src/mcp.js');
const project = 'CardForge';
const ref = 'refs/heads/devint-benchmark';
const started = Date.now();
const scan = await callTool('scan_graph', { project, ref });
const architecture = await callTool('get_architecture', { project, ref });
const schema = await callTool('get_graph_schema', { project, ref });

const probes = [
  { name: 'Product Reality builder', query: 'buildCheckpointProductReality' },
  { name: 'Creator interaction session', query: 'createCreatorInteractionSession' },
  { name: 'Action descriptor model', query: 'ActionDescriptor' },
];

const probeResults = [];
for (const probe of probes) {
  const search = await callTool('search_graph', { project, ref, query: probe.query, limit: 30 });
  const nodeTotal = Number(search.nodeTotal ?? 0);
  if (nodeTotal < 1) throw new Error(`Graph benchmark failed to find known CardForge symbol: ${probe.query}`);
  let trace = null;
  try {
    trace = await callTool('trace_path', { project, ref, node: probe.query, direction: 'both', depth: 2, limit: 200 });
  } catch (error) {
    trace = { error: error instanceof Error ? error.message : String(error), nodes: [], edges: [] };
  }
  probeResults.push({
    ...probe,
    nodeTotal,
    edgeTotal: Number(search.edgeTotal ?? 0),
    traceNodes: Array.isArray(trace.nodes) ? trace.nodes.length : 0,
    traceEdges: Array.isArray(trace.edges) ? trace.edges.length : 0,
    traceError: trace.error ?? null,
    sampleNodes: Array.isArray(search.nodes) ? search.nodes.slice(0, 5).map(node => ({ kind: node.kind, name: node.name ?? null, locator: node.locator })) : [],
  });
}

const sourceSearch = await callTool('search_code', { project, ref, pattern: 'createCreatorInteractionSession', context: 1, limit: 50 });
if (Number(sourceSearch.total ?? 0) < 2) throw new Error('Source benchmark expected multiple createCreatorInteractionSession occurrences');

const kindQueries = {};
for (const kind of ['file', 'function', 'method', 'class', 'interface', 'type', 'ui-element', 'http-call', 'mcp-tool']) {
  const result = await callTool('search_graph', { project, ref, kinds: [kind], limit: 1 });
  kindQueries[kind] = Number(result.nodeTotal ?? 0);
}

const report = {
  benchmark: 'CardForge intrinsic DI graph',
  targetSha: actualSha,
  elapsedMs: Date.now() - started,
  scan,
  architecture: architecture.summary ?? architecture,
  schema,
  nodeKinds: kindQueries,
  probes: probeResults,
  sourceSearch: { total: sourceSearch.total ?? 0, sample: Array.isArray(sourceSearch.matches) ? sourceSearch.matches.slice(0, 5) : [] },
};

const jsonPath = process.env.DEVINT_BENCHMARK_JSON ?? path.resolve('benchmark-cardforge.json');
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

const summary = [
  '# CardForge intrinsic graph benchmark',
  '',
  `- CardForge SHA: \`${actualSha}\``,
  `- Nodes: **${scan.nodeCount}**`,
  `- Relationships: **${scan.edgeCount}**`,
  `- Eligible/analyzed files: **${scan.coverage?.eligibleFiles ?? '?'} / ${scan.coverage?.analyzedFiles ?? '?'}**`,
  `- Elapsed: **${report.elapsedMs} ms**`,
  '',
  '## Node kinds',
  '',
  '| Kind | Count |',
  '| --- | ---: |',
  ...Object.entries(kindQueries).map(([kind, count]) => `| ${kind} | ${count} |`),
  '',
  '## Representative agent probes',
  '',
  '| Probe | Search nodes | Trace nodes | Trace edges |',
  '| --- | ---: | ---: | ---: |',
  ...probeResults.map(item => `| ${item.name} | ${item.nodeTotal} | ${item.traceNodes} | ${item.traceEdges} |`),
  '',
  `Raw source search occurrences for \`createCreatorInteractionSession\`: **${sourceSearch.total ?? 0}**`,
  '',
  '> This benchmark is read-only. It generates disposable W from the pinned CardForge checkout and does not write a Development Intelligence checkpoint into CardForge.',
].join('\n');

const markdownPath = process.env.DEVINT_BENCHMARK_MARKDOWN ?? path.resolve('benchmark-cardforge.md');
await fs.writeFile(markdownPath, `${summary}\n`);
console.log(summary);
await fs.rm(temp, { recursive: true, force: true });
