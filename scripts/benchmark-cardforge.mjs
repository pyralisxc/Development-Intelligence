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
process.env.DEVINT_GRAPH_CACHE_SIZE = '3';

const { callTool } = await import('../dist/src/mcp.js');
const { buildLocalGraph } = await import('../dist/src/intelligence/local.js');
const project = 'CardForge';
const ref = 'refs/heads/devint-benchmark';
const started = Date.now();
const scan = await callTool('scan_graph', { project, ref });
const architecture = await callTool('get_architecture', { project, ref });
const parity = await callTool('scan_parity', { project, ref });
const schema = await callTool('get_graph_schema', { project, ref });
const graph = await buildLocalGraph(cardForgeRoot, project);

const probes = [
  {
    name: 'Product Reality builder',
    query: 'buildCheckpointProductReality',
    expectedTraceLocator: 'scripts/product-reality.mjs',
  },
  {
    name: 'Creator interaction session',
    query: 'createCreatorInteractionSession',
    expectedTraceLocator: 'src/features/desk/hooks/useDeskController.ts',
  },
  {
    name: 'Action descriptor model',
    query: 'ActionDescriptor',
    expectedTraceLocator: 'src/features/desk/model/desk.ts',
  },
];

const probeResults = [];
for (const probe of probes) {
  const search = await callTool('search_graph', { project, ref, query: probe.query, limit: 40 });
  const searchNodes = Array.isArray(search.nodes) ? search.nodes : [];
  if (Number(search.nodeTotal ?? 0) < 1) throw new Error(`Graph benchmark failed to find known CardForge symbol: ${probe.query}`);
  const candidates = searchNodes.filter(node => String(node?.name ?? '').toLowerCase() === probe.query.toLowerCase());
  const ids = [...new Set((candidates.length ? candidates : searchNodes).map(node => node.id).filter(Boolean))].slice(0, 16);
  let trace = null;
  let chosenId = null;
  for (const id of ids) {
    const current = await callTool('trace_path', { project, ref, node: id, direction: 'both', depth: 3, limit: 450 });
    const traceNodes = Array.isArray(current.nodes) ? current.nodes : [];
    if (traceNodes.some(node => String(node?.locator ?? '').includes(probe.expectedTraceLocator))) {
      trace = current;
      chosenId = id;
      break;
    }
  }
  if (!trace) throw new Error(`No exact candidate for ${probe.query} reached known cross-file consumer ${probe.expectedTraceLocator}`);
  const traceNodes = Array.isArray(trace.nodes) ? trace.nodes : [];
  probeResults.push({
    ...probe,
    chosenId,
    nodeTotal: Number(search.nodeTotal ?? 0),
    edgeTotal: Number(search.edgeTotal ?? 0),
    traceNodes: traceNodes.length,
    traceEdges: Array.isArray(trace.edges) ? trace.edges.length : 0,
    crossFileConsumerReached: true,
    sampleNodes: searchNodes.slice(0, 5).map(node => ({ id: node.id, kind: node.kind, layer: node.layer ?? 'structural', name: node.name ?? null, locator: node.locator })),
  });
}

const sourceSearch = await callTool('search_code', { project, ref, pattern: 'createCreatorInteractionSession', context: 1, limit: 50 });
if (Number(sourceSearch.total ?? 0) < 2) throw new Error('Source benchmark expected multiple createCreatorInteractionSession occurrences');

const kindQueries = {};
for (const kind of ['file', 'function', 'method', 'class', 'interface', 'type', 'import-binding', 'ui-element', 'http-call', 'mcp-tool', 'feature', 'api', 'route', 'provider', 'mcp', 'surface', 'capability', 'action']) {
  const result = await callTool('search_graph', { project, ref, kinds: [kind], limit: 1 });
  kindQueries[kind] = Number(result.nodeTotal ?? 0);
}

const relationshipCounts = architecture?.summary?.relationshipKinds ?? {};
for (const required of ['imports', 'resolves_to', 'calls']) {
  if (Number(relationshipCounts[required] ?? 0) < 1) throw new Error(`CardForge benchmark expected resolved ${required} relationships`);
}

function parseOracle(content) {
  const records = content.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  return {
    meta: records.find(record => record.type === 'meta'),
    nodes: records.filter(record => record.type === 'node').map(({ type: _type, ...record }) => record),
    edges: records.filter(record => record.type === 'edge').map(({ type: _type, ...record }) => record),
  };
}

const oracle = parseOracle(await fs.readFile(path.join(cardForgeRoot, 'docs/generated/product-reality.ndjson'), 'utf8'));
const diSemanticNodes = graph.nodes.filter(node => node.layer === 'semantic');
const diSemanticEdges = graph.edges.filter(edge => edge.layer === 'semantic' && edge.from && edge.to);
const diNodeIds = new Set(diSemanticNodes.map(node => node.id));
const diEdgeKeys = new Set(diSemanticEdges.map(edge => `${edge.from}|${edge.kind}|${edge.to}`));
const oracleEdgeKeys = oracle.edges.map(edge => `${edge.from}|${edge.relation}|${edge.to}`);

const nodeKinds = [...new Set(oracle.nodes.map(node => node.kind))].sort();
const parityByKind = {};
for (const kind of nodeKinds) {
  const expected = oracle.nodes.filter(node => node.kind === kind);
  const matched = expected.filter(node => diNodeIds.has(node.id));
  parityByKind[kind] = {
    expected: expected.length,
    matched: matched.length,
    missing: expected.filter(node => !diNodeIds.has(node.id)).map(node => node.id),
    recall: expected.length ? matched.length / expected.length : 1,
  };
}
const matchedEdges = oracleEdgeKeys.filter(key => diEdgeKeys.has(key));
const missingEdges = oracleEdgeKeys.filter(key => !diEdgeKeys.has(key));
const exactNodeMatches = oracle.nodes.filter(node => diNodeIds.has(node.id)).length;

for (const [kind, minimum] of Object.entries({ feature: 0.8, api: 0.8, provider: 0.7 })) {
  const result = parityByKind[kind];
  if (result && result.recall < minimum) throw new Error(`DI semantic migration benchmark ${kind} recall ${result.recall.toFixed(3)} is below ${minimum}`);
}

const report = {
  benchmark: 'CardForge Development Intelligence structural + parity differential',
  targetSha: actualSha,
  elapsedMs: Date.now() - started,
  scan,
  architecture: architecture.summary ?? architecture,
  parity,
  schema,
  nodeKinds: kindQueries,
  probes: probeResults,
  sourceSearch: { total: sourceSearch.total ?? 0, sample: Array.isArray(sourceSearch.matches) ? sourceSearch.matches.slice(0, 5) : [] },
  oracle: {
    topologyFingerprint: oracle.meta?.topologyFingerprint ?? null,
    nodes: oracle.nodes.length,
    edges: oracle.edges.length,
  },
  semanticDifferential: {
    diSemanticNodes: diSemanticNodes.length,
    diSemanticEdges: diSemanticEdges.length,
    exactNodeMatches,
    exactNodeRecall: oracle.nodes.length ? exactNodeMatches / oracle.nodes.length : 1,
    exactEdgeMatches: matchedEdges.length,
    exactEdgeRecall: oracle.edges.length ? matchedEdges.length / oracle.edges.length : 1,
    byKind: parityByKind,
    missingEdges: missingEdges.slice(0, 200),
  },
};

const jsonPath = process.env.DEVINT_BENCHMARK_JSON ?? path.resolve('benchmark-cardforge.json');
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

const summary = [
  '# CardForge Development Intelligence benchmark',
  '',
  `- CardForge SHA: \`${actualSha}\``,
  `- Full W: **${scan.nodeCount} nodes / ${scan.edgeCount} relationships**`,
  `- Semantic DI layer: **${diSemanticNodes.length} nodes / ${diSemanticEdges.length} relationships**`,
  `- Eligible/analyzed files: **${scan.coverage?.eligibleFiles ?? '?'} / ${scan.coverage?.analyzedFiles ?? '?'}**`,
  `- Elapsed: **${report.elapsedMs} ms**`,
  `- Resolved imports: **${relationshipCounts.imports ?? 0}**`,
  `- Import-to-definition resolutions: **${relationshipCounts.resolves_to ?? 0}**`,
  `- Call relationships: **${relationshipCounts.calls ?? 0}**`,
  '',
  '## Representative structural agent probes',
  '',
  '| Probe | Search nodes | Trace nodes | Trace edges | Exact candidate | Known consumer |',
  '| --- | ---: | ---: | ---: | --- | --- |',
  ...probeResults.map(item => `| ${item.name} | ${item.nodeTotal} | ${item.traceNodes} | ${item.traceEdges} | \`${item.chosenId}\` | ${item.expectedTraceLocator} ✓ |`),
  '',
  '## Product Reality migration differential',
  '',
  `Old CardForge oracle: **${oracle.nodes.length} nodes / ${oracle.edges.length} relationships** at topology \`${oracle.meta?.topologyFingerprint ?? 'unknown'}\`.`,
  `Current generic DI exact semantic identity match: **${exactNodeMatches}/${oracle.nodes.length} nodes (${(report.semanticDifferential.exactNodeRecall * 100).toFixed(1)}%)** and **${matchedEdges.length}/${oracle.edges.length} relationships (${(report.semanticDifferential.exactEdgeRecall * 100).toFixed(1)}%)**.`,
  '',
  '| Kind | Oracle | Matched now | Recall | Migration gap |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...Object.entries(parityByKind).map(([kind, value]) => `| ${kind} | ${value.expected} | ${value.matched} | ${(value.recall * 100).toFixed(1)}% | ${value.missing.length} |`),
  '',
  '> Missing action/surface/capability/tool semantics are expected migration evidence at this stage. They must be closed generically or by source-adjacent DI declarations before CardForge Product Reality is deleted.',
  '',
  `Raw source search occurrences for \`createCreatorInteractionSession\`: **${sourceSearch.total ?? 0}**`,
  '',
  '> This benchmark is read-only. It generates disposable W from the pinned CardForge checkout and does not write a Development Intelligence checkpoint into CardForge.',
].join('\n');

const markdownPath = process.env.DEVINT_BENCHMARK_MARKDOWN ?? path.resolve('benchmark-cardforge.md');
await fs.writeFile(markdownPath, `${summary}\n`);
console.log(summary);
await fs.rm(temp, { recursive: true, force: true });
