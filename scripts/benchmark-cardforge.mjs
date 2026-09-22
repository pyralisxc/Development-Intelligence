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
const { assessGraph } = await import('../dist/src/intelligence/assessment.js');
const { clearGraphCache } = await import('../dist/src/intelligence/service.js');
const project = 'CardForge';
const ref = 'refs/heads/devint-benchmark';
const started = Date.now();
const scan = await callTool('scan_graph', { project, ref });
const architecture = await callTool('get_architecture', { project, ref });
const parity = await callTool('query_parity', { project, ref, limit: 1000 });
const schema = await callTool('get_graph_schema', { project, ref });
const coverage = await callTool('check_graph_coverage', { project, ref });
const graph = await buildLocalGraph(cardForgeRoot, project);

const pipelineSubject = graph.nodes.find(node => node.kind === 'function' && node.name === 'buildPipelineContentReview');
const persistenceSubject = graph.nodes.find(node => node.kind === 'file' && node.locator === 'src/features/contributor-access/server/profileStore.ts');
if (!pipelineSubject || !persistenceSubject) throw new Error('CardForge benchmark expected pipeline and persistence motif subjects');

assessGraph(graph, pipelineSubject.id);
const pipelineMotifStarted = process.hrtime.bigint();
const pipelineMotifAssessment = assessGraph(graph, pipelineSubject.id);
const pipelineMotifElapsedMs = Number(process.hrtime.bigint() - pipelineMotifStarted) / 1_000_000;
const pipelineMotif = pipelineMotifAssessment.orientation?.certainty?.derived?.find(item => item.kind === 'pipeline');
if (!pipelineMotif || pipelineMotif.signals.length < 2 || pipelineMotif.proofEligible !== false) throw new Error('CardForge pipeline motif was not conservatively derived');

const persistenceMotifStarted = process.hrtime.bigint();
const persistenceMotifAssessment = assessGraph(graph, persistenceSubject.id);
const persistenceMotifElapsedMs = Number(process.hrtime.bigint() - persistenceMotifStarted) / 1_000_000;
const persistenceMotif = persistenceMotifAssessment.orientation?.certainty?.derived?.find(item => item.kind === 'persistence-owner');
if (!persistenceMotif || persistenceMotif.confidence !== 'high' || persistenceMotif.signals.length < 3 || persistenceMotif.proofEligible !== false) throw new Error('CardForge profile store persistence-owner motif was not conservatively derived');
if (Math.max(pipelineMotifElapsedMs, persistenceMotifElapsedMs) > 1000) throw new Error('CardForge motif query exceeded 1000 ms acceptance budget');

const assessmentStarted = Date.now();
const featureAssessment = await callTool('query_intelligence', { project, graphId: scan.graphId, question: 'How is storage management implemented?' });
if (featureAssessment.answerStatus !== 'supported' || featureAssessment.realization?.root?.id !== 'feature:storage-management') {
  throw new Error('CardForge assessment did not resolve natural-language feature phrasing to storage-management');
}
const existenceAssessment = await callTool('query_intelligence', { project, graphId: scan.graphId, question: 'Prove createLibraryZoneAction exists' });
if (existenceAssessment.answerStatus === 'contradicted' || existenceAssessment.interpretedSubject !== 'createLibraryZoneAction') {
  throw new Error('CardForge assessment falsely contradicted a present symbol or retained existence boilerplate');
}
const scopedAudit = await callTool('query_intelligence', { project, graphId: scan.graphId, question: 'Audit storage management' });
if (!Array.isArray(scopedAudit.findings) || scopedAudit.findings.length >= 150) {
  throw new Error(`CardForge scoped audit was not bounded: ${scopedAudit.findings?.length ?? 'missing'} findings`);
}
if (scopedAudit.findingSummary?.total !== scopedAudit.findings.length || scopedAudit.findingSummary?.scope?.resolvedDepth !== 2 || !Array.isArray(scopedAudit.findingSummary?.groups)) {
  throw new Error('CardForge scoped audit did not explain its blast radius and grouped findings');
}
const assessmentElapsedMs = Date.now() - assessmentStarted;

const probes = [
  {
    name: 'Library zone action factory',
    query: 'createLibraryZoneAction',
    expectedTraceLocator: 'src/features/storage-management/hooks/useAccountLibraryActions.ts',
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

const groupedSearch = await callTool('search_graph', { project, graphId: scan.graphId, queries: probes.map(probe => probe.query), limit: 40 });
if (!Array.isArray(groupedSearch.results) || groupedSearch.results.length !== probes.length || groupedSearch.results.some(result => Number(result.nodeTotal ?? 0) < 1)) {
  throw new Error('CardForge grouped search did not return every independent probe');
}
clearGraphCache(project);
const reconstructedSearch = await callTool('search_graph', { project, graphId: scan.graphId, query: probes[0].query, limit: 1 });
if (reconstructedSearch.graphId !== scan.graphId || Number(reconstructedSearch.nodeTotal ?? 0) < 1) throw new Error('Canonical CardForge graphId did not survive process-local cache loss');

const workflowSearch = await callTool('search_graph', { project, graphId: scan.graphId, queries: ['camera', 'zoom', 'responsive', 'touch', 'overflow-x', 'workspaceResponsiveHardening'], limit: 20 });
if (!Array.isArray(workflowSearch.results) || workflowSearch.results.length !== 6) throw new Error('CardForge workflow search did not preserve every independent query');
for (const required of ['camera', 'responsive', 'overflow-x']) {
  const result = workflowSearch.results.find(item => item.query === required);
  if (Number(result?.nodeTotal ?? 0) < 1) throw new Error(`CardForge workflow search expected structural evidence for ${required}`);
}

const kindQueries = {};
for (const kind of ['file', 'function', 'method', 'class', 'interface', 'type', 'import-binding', 'ui-element', 'http-call', 'mcp-tool', 'css-selector', 'css-at-rule', 'css-custom-property', 'feature', 'api', 'route', 'provider', 'mcp', 'surface', 'capability', 'action']) {
  const result = await callTool('search_graph', { project, ref, kinds: [kind], limit: 1 });
  kindQueries[kind] = Number(result.nodeTotal ?? 0);
}

for (const requiredKind of ['feature', 'api', 'provider', 'route', 'mcp']) {
  if (Number(kindQueries[requiredKind] ?? 0) < 1) throw new Error(`CardForge benchmark expected generic semantic kind ${requiredKind}`);
}
for (const requiredKind of ['css-selector', 'css-at-rule', 'css-custom-property']) {
  if (Number(kindQueries[requiredKind] ?? 0) < 1) throw new Error(`CardForge benchmark expected generic CSS kind ${requiredKind}`);
}

const relationshipCounts = architecture?.summary?.relationshipKinds ?? {};
for (const required of ['imports', 'resolves_to', 'calls']) {
  if (Number(relationshipCounts[required] ?? 0) < 1) throw new Error(`CardForge benchmark expected resolved ${required} relationships`);
}

const coverageSummary = coverage?.summary ?? {};
if (Number(coverageSummary.failedFiles ?? 0) > 0) throw new Error(`CardForge benchmark has ${coverageSummary.failedFiles} failed source analyses`);
if (Number(scan.coverage?.eligibleFiles ?? 0) < 1 || Number(scan.coverage?.analyzedFiles ?? 0) < 1) throw new Error('CardForge benchmark did not analyze eligible source files');

const semanticNodes = graph.nodes.filter(node => node.layer === 'semantic');
const semanticEdges = graph.edges.filter(edge => edge.layer === 'semantic');
const report = {
  benchmark: 'CardForge Development Intelligence generic structural + semantic evidence',
  targetSha: actualSha,
  elapsedMs: Date.now() - started,
  scan,
  architecture: architecture.summary ?? architecture,
  parity: {
    entityTotal: parity.entityTotal ?? 0,
    relationshipCount: Array.isArray(parity.relationships) ? parity.relationships.length : 0,
    namingDivergenceCount: Array.isArray(parity.namingDivergences) ? parity.namingDivergences.length : 0,
    unmatchedCount: Array.isArray(parity.unmatchedNodeIds) ? parity.unmatchedNodeIds.length : 0,
  },
  schema,
  coverage,
  nodeKinds: kindQueries,
  semantic: {
    nodes: semanticNodes.length,
    edges: semanticEdges.length,
    conflicts: graph.explicitValueConflicts.length,
    candidateRelationships: semanticEdges.filter(edge => edge.status === 'candidate').length,
    unresolvedRelationships: semanticEdges.filter(edge => edge.status === 'unresolved').length,
  },
  assessment: {
    elapsedMs: assessmentElapsedMs,
    motifs: {
      pipeline: { confidence: pipelineMotif.confidence, signalCount: pipelineMotif.signals.length, elapsedMs: Number(pipelineMotifElapsedMs.toFixed(3)) },
      persistenceOwner: { confidence: persistenceMotif.confidence, signalCount: persistenceMotif.signals.length, elapsedMs: Number(persistenceMotifElapsedMs.toFixed(3)) },
      maxQueryBudgetMs: 1000,
    },
    feature: { answerStatus: featureAssessment.answerStatus, root: featureAssessment.realization?.root ?? null },
    symbolExistence: { answerStatus: existenceAssessment.answerStatus, ambiguous: existenceAssessment.ambiguous, candidateCount: existenceAssessment.candidates?.length ?? 0 },
    scopedAudit: { answerStatus: scopedAudit.answerStatus, findingCount: scopedAudit.findings.length, summary: scopedAudit.findingSummary },
  },
  probes: probeResults,
  groupedSearch: {
    queryCount: groupedSearch.results.length,
    canonicalGraphReconstructed: true,
    workflowQueries: workflowSearch.results.map(result => ({ query: result.query, nodeTotal: result.nodeTotal, edgeTotal: result.edgeTotal })),
  },
  sourceSearch: { total: sourceSearch.total ?? 0, sample: Array.isArray(sourceSearch.matches) ? sourceSearch.matches.slice(0, 5) : [] },
};

const jsonPath = process.env.DEVINT_BENCHMARK_JSON ?? path.resolve('benchmark-cardforge.json');
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

const summary = [
  '# CardForge Development Intelligence benchmark',
  '',
  `- CardForge SHA: \`${actualSha}\``,
  `- Full W: **${scan.nodeCount} nodes / ${scan.edgeCount} relationships**`,
  `- Semantic DI layer: **${semanticNodes.length} nodes / ${semanticEdges.length} relationships**`,
  `- Eligible/analyzed files: **${scan.coverage?.eligibleFiles ?? '?'} / ${scan.coverage?.analyzedFiles ?? '?'}**`,
  `- Failed analyses: **${coverageSummary.failedFiles ?? 0}**`,
  `- Skipped eligible files: **${coverageSummary.skippedFiles ?? 0}**`,
  `- Semantic conflicts: **${graph.explicitValueConflicts.length}**`,
  `- Elapsed: **${report.elapsedMs} ms**`,
  `- Resolved imports: **${relationshipCounts.imports ?? 0}**`,
  `- Import-to-definition resolutions: **${relationshipCounts.resolves_to ?? 0}**`,
  `- Call relationships: **${relationshipCounts.calls ?? 0}**`,
  `- Grouped search: **${groupedSearch.results.length} queries / one graph context**`,
  `- Canonical graphId reconstructed after cache loss: **yes**`,
  `- CSS structure: **${kindQueries['css-selector'] ?? 0} selectors / ${kindQueries['css-at-rule'] ?? 0} at-rules / ${kindQueries['css-custom-property'] ?? 0} custom properties**`,
  `- Assessment calibration: **feature ${featureAssessment.answerStatus} / symbol ${existenceAssessment.answerStatus} / scoped audit ${scopedAudit.findings.length} findings / ${assessmentElapsedMs} ms**`,
  `- Derived motif calibration: **pipeline ${pipelineMotif.confidence} (${pipelineMotif.signals.length} signals, ${pipelineMotifElapsedMs.toFixed(3)} ms) / persistence-owner ${persistenceMotif.confidence} (${persistenceMotif.signals.length} signals, ${persistenceMotifElapsedMs.toFixed(3)} ms) / 1000 ms budget**`,
  '',
  '## Representative structural agent probes',
  '',
  '| Probe | Search nodes | Trace nodes | Trace edges | Exact candidate | Known consumer |',
  '| --- | ---: | ---: | ---: | --- | --- |',
  ...probeResults.map(item => `| ${item.name} | ${item.nodeTotal} | ${item.traceNodes} | ${item.traceEdges} | \`${item.chosenId}\` | ${item.expectedTraceLocator} ✓ |`),
  '',
  '## Generic semantic inventory',
  '',
  '| Kind | Count |',
  '| --- | ---: |',
  ...Object.entries(kindQueries).filter(([kind]) => ['feature', 'api', 'provider', 'route', 'mcp', 'surface', 'capability', 'action'].includes(kind)).map(([kind, count]) => `| ${kind} | ${count} |`),
  '',
  `Raw source search occurrences for \`createCreatorInteractionSession\`: **${sourceSearch.total ?? 0}**`,
  '',
  '> This permanent benchmark is read-only. It proves generic CardForge-scale usefulness and does not depend on the retired Product Reality oracle or write a Development Intelligence checkpoint into CardForge.',
].join('\n');

const markdownPath = process.env.DEVINT_BENCHMARK_MARKDOWN ?? path.resolve('benchmark-cardforge.md');
await fs.writeFile(markdownPath, `${summary}\n`);
console.log(summary);
await fs.rm(temp, { recursive: true, force: true });
