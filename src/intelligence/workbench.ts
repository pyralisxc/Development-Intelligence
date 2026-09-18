import { listAuthorizedGithubOwners, loadRegistry } from '../config/registry.js';
import { projectStatus } from '../projectStatus.js';
import { listPublicProjects } from '../source/git.js';
import type { GraphEdge, GraphNode, IntelligenceGraph, RelationshipStatus, TechnicalSourceCapability } from '../types.js';
import { getCodeSnippet, searchCode } from './code.js';
import { currentGraph } from './service.js';
import { diffAcceptedToWorking, findGraphNodeCandidates, graphCoverage, parityLens, searchGraph, traceGraph } from './query.js';
import { listTechnicalSources, queryTechnicalSource } from './technicalSources.js';
import { assessGraph, auditGraph, queryIntelligence } from './assessment.js';

function displayName(node: GraphNode | undefined, fallback?: string | null): string {
  return node?.name ?? fallback ?? node?.id ?? 'unknown';
}

function sourceFile(locator: string): string | null {
  const match = locator.match(/^(.*?)(?::\d+(?::\d+)?)?$/);
  const file = match?.[1]?.replace(/^file:\/\//, '') ?? '';
  return file.includes('/') || /\.[A-Za-z0-9]+$/.test(file) ? file : null;
}

function layerLabel(node: GraphNode): string {
  if (node.layer === 'semantic') return 'semantic product concept';
  if (node.layer === 'representation') return 'observed representation';
  return 'code/structural entity';
}

function coverageNote(graph: IntelligenceGraph): string {
  const coverage = graph.coverage;
  if (!coverage) return 'Coverage details are unavailable for this graph context.';
  if (coverage.failedFiles || coverage.partialFiles || coverage.skippedFiles) {
    return `Coverage is incomplete: ${coverage.completeFiles}/${coverage.eligibleFiles} eligible files complete, ${coverage.partialFiles} partial, ${coverage.failedFiles} failed, ${coverage.skippedFiles} skipped.`;
  }
  return `Coverage is complete for ${coverage.eligibleFiles} eligible files (${coverage.trackedFiles} tracked files total).`;
}

function edgeCounts(edges: GraphEdge[]): Record<RelationshipStatus, number> {
  const counts: Record<RelationshipStatus, number> = { resolved: 0, candidate: 0, unresolved: 0 };
  for (const edge of edges) counts[edge.status] += 1;
  return counts;
}

function topAreas(graph: IntelligenceGraph): Array<{ name: string; count: number }> {
  const areas = new Map<string, number>();
  for (const node of graph.nodes.filter(item => item.layer !== 'semantic')) {
    const file = sourceFile(node.locator);
    if (!file) continue;
    const clean = file.replace(/^\.\//, '');
    const parts = clean.split('/');
    const area = parts[0] === 'src' && parts[1] ? `src/${parts[1]}` : parts[0] ?? '(root)';
    areas.set(area, (areas.get(area) ?? 0) + 1);
  }
  return [...areas.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 12);
}

function semanticHighlights(graph: IntelligenceGraph): GraphNode[] {
  const preferred = new Set(['feature', 'capability', 'surface', 'mcp', 'provider', 'route', 'api']);
  return graph.nodes
    .filter(node => node.layer === 'semantic')
    .sort((a, b) => Number(preferred.has(b.kind)) - Number(preferred.has(a.kind)) || a.kind.localeCompare(b.kind) || displayName(a).localeCompare(displayName(b)))
    .slice(0, 18);
}

function semanticDiffCounts(diff: any): { added: number; removed: number; changed: number } {
  const semantic = diff?.semantic;
  if (!semantic) return { added: 0, removed: 0, changed: 0 };
  return {
    added: (semantic.nodes?.added?.length ?? 0) + (semantic.edges?.added?.length ?? 0),
    removed: (semantic.nodes?.removed?.length ?? 0) + (semantic.edges?.removed?.length ?? 0),
    changed: (semantic.nodes?.changed?.length ?? 0) + (semantic.edges?.changed?.length ?? 0),
  };
}

export async function workbenchProjects(): Promise<Record<string, unknown>> {
  const [projects, registry] = await Promise.all([listPublicProjects(), loadRegistry()]);
  return {
    projects: projects.map(project => {
      const name = String(project.project);
      const config = registry[name]!;
      return {
        ...project,
        runtimeOrigins: config.runtimeOrigins?.length ?? 0,
        technicalSources: config.technicalSources?.map(source => ({ id: source.id, label: source.label ?? source.id, capabilities: source.capabilities })) ?? [],
      };
    }),
    githubOwners: listAuthorizedGithubOwners(),
  };
}

export async function projectOverview(project: string, ref?: string | undefined, graphId?: string | undefined): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref, graphId);
  const [status, diff, sources] = await Promise.all([
    projectStatus(project, false),
    graphId ? Promise.resolve(null) : diffAcceptedToWorking(project, ref),
    listTechnicalSources(project),
  ]);
  const semantic = graph.nodes.filter(node => node.layer === 'semantic');
  const structural = graph.nodes.filter(node => (node.layer ?? 'structural') === 'structural');
  const representation = graph.nodes.filter(node => node.layer === 'representation');
  const relations = edgeCounts(graph.edges);
  const diffCounts = semanticDiffCounts(diff);
  const findings = auditGraph(graph);
  const notes = [
    `${project} is currently mapped as ${semantic.length} semantic concepts, ${structural.length} structural/code entities, and ${representation.length} observed representations.`,
    coverageNote(graph),
    `${relations.resolved} relationships are resolved; ${relations.candidate} remain candidates and ${relations.unresolved} are unresolved.`,
  ];
  if (!graphId) notes.push(diffCounts.added || diffCounts.removed || diffCounts.changed
    ? `Accepted → working semantic change: ${diffCounts.added} added, ${diffCounts.removed} removed, ${diffCounts.changed} changed records.`
    : 'No accepted → working semantic topology change is currently detected.');
  if (graph.explicitValueConflicts.length) notes.push(`${graph.explicitValueConflicts.length} explicit semantic value conflict(s) need attention.`);
  if (findings.length) notes.push(`${findings.length} deterministic evidence finding(s) currently deserve attention; findings remain revision-bound projections rather than accepted graph truth.`);
  return {
    project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    role: graph.role,
    summary: notes[0],
    quickNotes: notes,
    counts: {
      nodes: graph.nodes.length,
      semantic: semantic.length,
      structural: structural.length,
      representation: representation.length,
      edges: graph.edges.length,
      evidence: graph.evidence.length,
      conflicts: graph.explicitValueConflicts.length,
      relationships: relations,
    },
    currentness: (status as any).graph?.currentness ?? null,
    coverage: graph.coverage ?? null,
    highlights: semanticHighlights(graph).map(node => ({ id: node.id, kind: node.kind, name: displayName(node), locator: node.locator })),
    areas: topAreas(graph),
    changes: diff ? { ...diffCounts, detail: diff } : null,
    findings: findings.slice(0, 20),
    sources,
  };
}

function changeForNode(diff: any, id: string): Record<string, unknown> | null {
  const semantic = diff?.semantic;
  if (!semantic) return null;
  for (const category of ['nodes', 'edges']) {
    const bucket = semantic[category];
    if (!bucket) continue;
    const added = (bucket.added ?? []).find((item: any) => item.id === id);
    if (added) return { state: 'added', record: added };
    const removed = (bucket.removed ?? []).find((item: any) => item.id === id);
    if (removed) return { state: 'removed', record: removed };
    const changed = (bucket.changed ?? []).find((item: any) => item.before?.id === id || item.after?.id === id);
    if (changed) return { state: 'changed', record: changed };
  }
  return { state: 'unchanged' };
}

export async function inspectEntity(input: { project: string; node: string; ref?: string | undefined; graphId?: string | undefined }): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const candidates = findGraphNodeCandidates(graph, input.node, 20);
  if (!candidates.length) throw new Error(`Graph entity not found: ${input.node}`);
  if (candidates.length > 1 && !candidates.some(node => node.id === input.node)) {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: true,
      candidates: candidates.map(node => ({ id: node.id, name: displayName(node), kind: node.kind, layer: node.layer ?? 'structural', locator: node.locator })),
    };
  }
  const selected = candidates.find(node => node.id === input.node) ?? candidates[0]!;
  const incident = graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const counts = edgeCounts(incident);
  const connections = incident.map(edge => {
    const outgoing = edge.from === selected.id;
    const neighborId = outgoing ? edge.to : edge.from;
    const neighbor = neighborId ? byId.get(neighborId) : undefined;
    return {
      edgeId: edge.id,
      kind: edge.kind,
      direction: outgoing ? 'outbound' : 'inbound',
      status: edge.status,
      confidence: edge.confidence,
      neighbor: neighborId ? { id: neighborId, name: displayName(neighbor, neighborId), kind: neighbor?.kind ?? 'unknown', layer: neighbor?.layer ?? 'structural', locator: neighbor?.locator ?? null } : null,
      evidenceIds: edge.evidenceIds ?? [],
    };
  }).sort((a, b) => (a.status === b.status ? a.kind.localeCompare(b.kind) : a.status === 'resolved' ? -1 : b.status === 'resolved' ? 1 : 0));
  const evidenceIds = new Set([...(selected.evidenceIds ?? []), ...incident.flatMap(edge => edge.evidenceIds ?? [])]);
  const evidence = graph.evidence.filter(item => evidenceIds.has(item.id));
  const resolvedNames = connections.filter(item => item.status === 'resolved' && item.neighbor).slice(0, 4).map(item => `${item.kind} ${item.neighbor!.name}`);
  const quickNotes = [
    `${displayName(selected)} is a ${layerLabel(selected)} of kind “${selected.kind}”.`,
    selected.locator ? `Primary provenance: ${selected.locator}.` : 'No primary source locator is recorded.',
    `${counts.resolved} resolved connection(s), ${counts.candidate} candidate connection(s), and ${counts.unresolved} unresolved connection(s).`,
  ];
  if (resolvedNames.length) quickNotes.push(`Key resolved context: ${resolvedNames.join('; ')}.`);
  if (evidence.length) quickNotes.push(`${evidence.length} evidence record(s) support this entity or its visible relationships.`);
  const assessment = assessGraph(graph, selected.id);
  const assessmentStatus = String((assessment as any).answerStatus ?? 'indeterminate');
  quickNotes.push(`Evidence-backed assessment: ${assessmentStatus}.`);
  let code: unknown = null;
  try { code = await getCodeSnippet({ project: input.project, ref: input.ref, graphId: input.graphId, node: selected.id, context: 5 }); } catch { /* semantic/runtime entities may not map to one source snippet */ }
  let change: unknown = null;
  if (!input.graphId) {
    try { change = changeForNode(await diffAcceptedToWorking(input.project, input.ref), selected.id); } catch { change = null; }
  }
  return {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    ambiguous: false,
    entity: selected,
    summary: quickNotes[0],
    quickNotes,
    connectionCounts: counts,
    connections,
    evidence,
    code,
    change,
    coverage: graph.coverage ?? null,
    assessment,
  };
}

export async function exploreWorkbench(input: { project: string; query?: string | undefined; ref?: string | undefined; graphId?: string | undefined; limit?: number | undefined }): Promise<Record<string, unknown>> {
  const result = await searchGraph({ project: input.project, ref: input.ref, graphId: input.graphId, query: input.query, limit: input.limit ?? 250 }) as any;
  const kindCounts: Record<string, number> = {};
  for (const node of result.nodes ?? []) kindCounts[node.kind] = (kindCounts[node.kind] ?? 0) + 1;
  const topKinds = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return {
    ...result,
    summary: input.query
      ? `${result.nodeTotal ?? result.nodes?.length ?? 0} entities and ${result.edgeTotal ?? result.edges?.length ?? 0} relationships match “${input.query}”.`
      : `${result.nodeTotal ?? result.nodes?.length ?? 0} entities are available in this graph context.`,
    topKinds: topKinds.map(([kind, count]) => ({ kind, count })),
  };
}

function querySubject(text: string, markers: RegExp[]): string {
  let value = text.trim();
  for (const marker of markers) value = value.replace(marker, ' ');
  return value.replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
}

export async function queryWorkbench(input: {
  project: string;
  text: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  sourceId?: string | undefined;
  capability?: TechnicalSourceCapability | undefined;
}): Promise<Record<string, unknown>> {
  const text = input.text.trim();
  if (!text) throw new Error('text must be non-empty');
  const lower = text.toLowerCase();
  if (input.sourceId) {
    const external = await queryTechnicalSource({ project: input.project, sourceId: input.sourceId, capability: input.capability, query: text });
    return { intent: 'source-query', answer: `Read-only query sent to ${input.sourceId}.`, result: external };
  }
  if (/\b(audit|finding|problem|risk|realiz\w*|implement\w*|capability|proof|prove)\b/.test(lower)) {
    const result = await queryIntelligence({ project: input.project, question: text, ...(input.ref ? { ref: input.ref } : {}), ...(input.graphId ? { graphId: input.graphId } : {}) });
    return { intent: 'intelligence', answer: `Evidence-backed assessment: ${String((result as any).answerStatus ?? 'indeterminate')}.`, result };
  }
  if (/\b(what changed|changes?|diff|delta)\b/.test(lower)) {
    const result = await diffAcceptedToWorking(input.project, input.ref);
    const counts = semanticDiffCounts(result);
    return { intent: 'change', answer: `Accepted → working semantic change: ${counts.added} added, ${counts.removed} removed, ${counts.changed} changed records.`, result };
  }
  if (/\bcoverage\b/.test(lower)) {
    const result = await graphCoverage(input.project, input.ref, input.graphId);
    const coverage = result as any;
    return { intent: 'coverage', answer: `Coverage: ${coverage.completeFiles ?? '?'} complete, ${coverage.partialFiles ?? '?'} partial, ${coverage.failedFiles ?? '?'} failed, ${coverage.skippedFiles ?? '?'} skipped files.`, result };
  }
  if (/\bparity\b/.test(lower)) {
    const subject = querySubject(text, [/\b(show|find|inspect|query|parity|for|of)\b/gi]);
    const result = await parityLens({ project: input.project, ref: input.ref, graphId: input.graphId, query: subject || undefined, limit: 100 }) as any;
    return { intent: 'parity', answer: `${result.items?.length ?? result.nodes?.length ?? 0} parity result(s) found${subject ? ` for “${subject}”` : ''}.`, result };
  }
  if (/\b(code|source|implementation)\b/.test(lower)) {
    const pattern = querySubject(text, [/\b(show|find|search|code|source|implementation|for|of|where|is)\b/gi]);
    if (pattern) {
      const result = await searchCode({ project: input.project, ref: input.ref, graphId: input.graphId, pattern, limit: 100 }) as any;
      return { intent: 'code', answer: `${result.matches?.length ?? 0} source match(es) found for “${pattern}”.`, result };
    }
  }
  if (/\b(depends on|dependency|dependencies|used by|uses|callers?|called by)\b/.test(lower)) {
    const subject = querySubject(text, [/\b(what|which|show|find|depends on|dependency|dependencies|used by|uses|callers?|called by|of|for|does)\b/gi]);
    if (subject) {
      const direction = /used by|callers?|called by/.test(lower) ? 'inbound' : /depends on|uses/.test(lower) ? 'outbound' : 'both';
      const result = await traceGraph({ project: input.project, ref: input.ref, graphId: input.graphId, node: subject, direction, depth: 2, statuses: ['resolved'], limit: 250 }) as any;
      return { intent: 'trace', answer: result.ambiguous ? `“${subject}” is ambiguous; choose an exact entity.` : `${result.nodes?.length ?? 0} entities and ${result.edges?.length ?? 0} resolved relationships are in the traced neighborhood of “${subject}”.`, result };
    }
  }
  if (/\b(overview|summary|summarize|project status|what is this project)\b/.test(lower)) {
    const result = await projectOverview(input.project, input.ref, input.graphId);
    return { intent: 'overview', answer: String(result.summary ?? `${input.project} overview`), result };
  }
  const subject = querySubject(text, [/^\s*(what is|what's|show me|show|find|where is|inspect|tell me about)\s+/i]);
  const result = await searchGraph({ project: input.project, ref: input.ref, graphId: input.graphId, query: subject || text, limit: 100 }) as any;
  if ((result.nodes?.length ?? 0) === 1) {
    const inspected = await inspectEntity({ project: input.project, node: result.nodes[0].id, ref: input.ref, graphId: input.graphId });
    return { intent: 'inspect', answer: String(inspected.summary ?? `Found ${subject || text}.`), result: inspected };
  }
  return { intent: 'search', answer: `${result.nodeTotal ?? result.nodes?.length ?? 0} entities match “${subject || text}”.`, result };
}

export async function workbenchSources(project: string, ref?: string | undefined, graphId?: string | undefined): Promise<Record<string, unknown>> {
  const [configured, graph] = await Promise.all([listTechnicalSources(project), currentGraph(project, ref, graphId)]);
  return {
    project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    sources: configured,
    observedGraphSources: graph.sources,
    unavailableSourceIds: graph.unavailableSourceIds,
    coverage: graph.coverage ?? null,
    note: 'Technical sources are operational read-only inputs. Query results are evidence/observations and are not automatically promoted into accepted semantic topology.',
  };
}
