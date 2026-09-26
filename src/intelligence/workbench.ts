import { listAuthorizedGithubOwners, loadRegistry } from '../config/registry.js';
import { projectStatus } from '../projectStatus.js';
import { listPublicProjects } from '../source/git.js';
import type { GraphEdge, GraphNode, IntelligenceGraph, RelationshipStatus, TechnicalSourceCapability } from '../types.js';
import { getCodeSnippet, searchCode } from './code.js';
import { currentGraph } from './service.js';
import { diffAcceptedToWorking, findGraphNodeCandidates, graphCoverage, parityLens, searchGraph, traceGraph } from './query.js';
import { listTechnicalSources, queryTechnicalSource } from './technicalSources.js';
import { assessGraph, auditGraph, queryIntelligence, type AuditFinding } from './assessment.js';

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

function compactCoverage(graph: IntelligenceGraph): Record<string, unknown> | null {
  const coverage = graph.coverage;
  if (!coverage) return null;
  const { files: _files, ...summary } = coverage;
  return summary;
}

function projectSubjectBrief(graph: IntelligenceGraph, query: string): Record<string, unknown> {
  const candidates = findGraphNodeCandidates(graph, query, 20);
  if (candidates.length === 0) {
    const assessment = assessGraph(graph, query) as any;
    return {
      query,
      observed: false,
      ambiguous: false,
      answerStatus: assessment.answerStatus ?? 'indeterminate',
      orientation: assessment.orientation ?? null,
      candidates: [],
    };
  }
  if (candidates.length > 1 && !candidates.some(node => node.id === query)) {
    return {
      query,
      observed: true,
      ambiguous: true,
      candidates: candidates.slice(0, 10).map(node => ({
        id: node.id,
        name: displayName(node),
        kind: node.kind,
        layer: node.layer ?? 'structural',
        locator: node.locator,
      })),
    };
  }
  const selected = candidates.find(node => node.id === query) ?? candidates[0]!;
  const incident = graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id);
  const assessment = assessGraph(graph, selected.id) as any;
  return {
    query,
    observed: true,
    ambiguous: false,
    entity: {
      id: selected.id,
      name: displayName(selected),
      kind: selected.kind,
      layer: selected.layer ?? 'structural',
      locator: selected.locator,
    },
    connectionCounts: edgeCounts(incident),
    evidenceCount: new Set([
      ...(selected.evidenceIds ?? []),
      ...incident.flatMap(edge => edge.evidenceIds ?? []),
    ]).size,
    answerStatus: assessment.answerStatus ?? 'indeterminate',
    orientation: assessment.orientation ?? null,
    reach: assessment.reach
      ? {
          totals: assessment.reach.totals ?? null,
          mechanisms: assessment.reach.mechanisms ?? null,
          dimensions: Object.fromEntries(Object.entries(assessment.reach.dimensions ?? {}).map(([name, value]: [string, any]) => [name, {
            observed: Boolean(value?.observed),
            count: Number(value?.count ?? 0),
          }])),
        }
      : null,
  };
}

const OVERVIEW_FINDING_CATEGORIES = new Set<AuditFinding['category']>(['coverage', 'conflict', 'realization']);

export async function projectOverview(project: string, ref?: string | undefined, graphId?: string | undefined, subjects: string[] = []): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref, graphId);
  const [status, diff, sources] = await Promise.all([
    graphId ? Promise.resolve(null) : projectStatus(project, false),
    graphId ? Promise.resolve(null) : diffAcceptedToWorking(project, ref),
    listTechnicalSources(project),
  ]);
  const semantic = graph.nodes.filter(node => node.layer === 'semantic');
  const structural = graph.nodes.filter(node => (node.layer ?? 'structural') === 'structural');
  const representation = graph.nodes.filter(node => node.layer === 'representation');
  const relations = edgeCounts(graph.edges);
  const diffCounts = semanticDiffCounts(diff);
  const findings = auditGraph(graph, undefined, OVERVIEW_FINDING_CATEGORIES);
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
    currentness: status ? (status as any).graph?.currentness ?? null : null,
    coverage: compactCoverage(graph),
    coverageDetailTool: 'check_graph_coverage',
    highlights: semanticHighlights(graph).map(node => ({ id: node.id, kind: node.kind, name: displayName(node), locator: node.locator })),
    areas: topAreas(graph),
    changes: diff ? { ...diffCounts, detail: diff } : null,
    findings: findings.slice(0, 20),
    subjects: subjects.slice(0, 10).map(subject => projectSubjectBrief(graph, subject.trim())).filter(item => Boolean(item.query)),
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
  const reach = (assessment as any).reach ?? null;
  quickNotes.push(`Evidence-backed assessment: ${assessmentStatus}.`);
  if (reach?.dimensions) {
    const observed = Object.entries(reach.dimensions)
      .filter(([, value]: any) => value?.observed)
      .map(([dimension, value]: any) => `${dimension} (${value.count})`);
    if (observed.length) quickNotes.push(`Typed reach: ${observed.join(', ')}. Reach describes resolved connection paths, not impact severity.`);
  }
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
    reach,
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


export type ScopeRankBy = 'fan-in' | 'fan-out' | 'cross-file' | 'relationship-diversity' | 'uncertainty';

function graphArea(node: GraphNode): string | null {
  const file = sourceFile(node.locator);
  if (!file) return null;
  const clean = file.replace(/^\.\//, '');
  const parts = clean.split('/');
  return parts[0] === 'src' && parts[1] ? 'src/' + parts[1] : parts[0] ?? null;
}

function scopeNodeIds(graph: IntelligenceGraph, requested?: string): {
  kind: 'repository' | 'path' | 'file' | 'entity' | 'ambiguous' | 'missing';
  value: string | null;
  ids: Set<string>;
  entity: GraphNode | null;
  candidates: GraphNode[];
} {
  const scope = requested?.trim() ?? '';
  if (!scope || scope === 'repository' || scope === graph.project) {
    return { kind: 'repository', value: scope || graph.project, ids: new Set(graph.nodes.map(node => node.id)), entity: null, candidates: [] };
  }

  const pathScope = scope.replace(/^file:/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  const fileIds = graph.nodes.filter(node => sourceFile(node.locator)?.replace(/^\.\//, '') === pathScope).map(node => node.id);
  if (fileIds.length) return { kind: 'file', value: pathScope, ids: new Set(fileIds), entity: null, candidates: [] };

  const pathIds = graph.nodes.filter(node => {
    const file = sourceFile(node.locator)?.replace(/^\.\//, '');
    return file === pathScope || file?.startsWith(pathScope + '/');
  }).map(node => node.id);
  if (pathIds.length) return { kind: 'path', value: pathScope, ids: new Set(pathIds), entity: null, candidates: [] };

  const candidates = findGraphNodeCandidates(graph, scope, 20);
  const exact = candidates.find(node => node.id === scope);
  if (exact || candidates.length === 1) {
    const entity = exact ?? candidates[0]!;
    return { kind: 'entity', value: entity.id, ids: new Set([entity.id]), entity, candidates: [entity] };
  }
  if (candidates.length > 1) {
    const named = candidates.filter(node => normalizedMention(node.name ?? '') === normalizedMention(scope));
    if (named.length === 1) return { kind: 'entity', value: named[0]!.id, ids: new Set([named[0]!.id]), entity: named[0]!, candidates: named };
  }

  if (candidates.length > 1) return { kind: 'ambiguous', value: scope, ids: new Set(), entity: null, candidates };
  return { kind: 'missing', value: scope, ids: new Set(), entity: null, candidates: [] };
}

function orientationMetric(
  node: GraphNode,
  graph: IntelligenceGraph,
  incident: GraphEdge[],
  rankBy: ScopeRankBy,
): {
  fanIn: number;
  fanOut: number;
  crossFileReach: number;
  crossAreaReach: number;
  relationshipDiversity: number;
  candidate: number;
  unresolved: number;
  semanticLinks: number;
  representationLinks: number;
  callers: number;
  callees: number;
  rankValue: number;
} {
  const byId = new Map(graph.nodes.map(item => [item.id, item]));
  const resolved = incident.filter(edge => edge.status === 'resolved');
  const neighborFiles = new Set<string>();
  const neighborAreas = new Set<string>();
  let semanticLinks = 0;
  let representationLinks = 0;
  let callers = 0;
  let callees = 0;

  for (const edge of resolved) {
    const neighborId = edge.from === node.id ? edge.to : edge.from;
    const neighbor = neighborId ? byId.get(neighborId) : undefined;
    if (neighbor) {
      const file = sourceFile(neighbor.locator);
      if (file) neighborFiles.add(file);
      const area = graphArea(neighbor);
      if (area) neighborAreas.add(area);
      if (neighbor.layer === 'semantic') semanticLinks += 1;
      if (neighbor.layer === 'representation') representationLinks += 1;
    }
    if (edge.kind === 'calls') {
      if (edge.to === node.id) callers += 1;
      if (edge.from === node.id) callees += 1;
    }
  }

  const metrics = {
    fanIn: resolved.filter(edge => edge.to === node.id).length,
    fanOut: resolved.filter(edge => edge.from === node.id).length,
    crossFileReach: neighborFiles.size,
    crossAreaReach: neighborAreas.size,
    relationshipDiversity: new Set(resolved.map(edge => edge.kind)).size,
    candidate: incident.filter(edge => edge.status === 'candidate').length,
    unresolved: incident.filter(edge => edge.status === 'unresolved').length,
    semanticLinks,
    representationLinks,
    callers,
    callees,
  };
  const rankValue = rankBy === 'fan-in' ? metrics.fanIn
    : rankBy === 'fan-out' ? metrics.fanOut
      : rankBy === 'relationship-diversity' ? metrics.relationshipDiversity
        : rankBy === 'uncertainty' ? metrics.candidate + metrics.unresolved
          : metrics.crossFileReach;
  return { ...metrics, rankValue };
}

function orientationReason(metrics: ReturnType<typeof orientationMetric>, rankBy: ScopeRankBy): string {
  if (rankBy === 'fan-in') return String(metrics.fanIn) + ' resolved inbound relationship(s); ' + String(metrics.callers) + ' resolved caller(s).';
  if (rankBy === 'fan-out') return String(metrics.fanOut) + ' resolved outbound relationship(s); ' + String(metrics.callees) + ' resolved callee(s).';
  if (rankBy === 'relationship-diversity') return String(metrics.relationshipDiversity) + ' resolved relationship kind(s) across ' + String(metrics.crossFileReach) + ' neighboring file(s).';
  if (rankBy === 'uncertainty') return String(metrics.candidate) + ' candidate and ' + String(metrics.unresolved) + ' unresolved relationship(s).';
  return String(metrics.crossFileReach) + ' neighboring file(s) and ' + String(metrics.crossAreaReach) + ' neighboring area(s) through resolved relationships.';
}

export async function scopeOrientation(input: {
  project: string;
  scope?: string | undefined;
  ref?: string | undefined;
  graphId?: string | undefined;
  rankBy?: ScopeRankBy | undefined;
  limit?: number | undefined;
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const rankBy = input.rankBy ?? 'cross-file';
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 50);
  const selected = scopeNodeIds(graph, input.scope);

  if (selected.kind === 'ambiguous') {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: true,
      scope: { kind: selected.kind, value: selected.value },
      candidates: selected.candidates.slice(0, 10).map(node => ({ id: node.id, name: displayName(node), kind: node.kind, layer: node.layer ?? 'structural', locator: node.locator })),
      policy: { subjectiveImportanceScore: false, persisted: false },
    };
  }
  if (selected.kind === 'missing') {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: false,
      scope: { kind: selected.kind, value: selected.value },
      keyEntities: [],
      summary: 'No graph scope matching "' + String(selected.value) + '" was observed.',
      coverage: compactCoverage(graph),
      policy: { subjectiveImportanceScore: false, persisted: false },
    };
  }

  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  let scopedIds = selected.ids;
  if (selected.kind === 'entity' && selected.entity) {
    scopedIds = new Set([selected.entity.id]);
    let frontier = [selected.entity.id];
    for (let depth = 0; depth < 2 && frontier.length && scopedIds.size < 300; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of graph.edges) {
          if (edge.status !== 'resolved' || (edge.from !== id && edge.to !== id)) continue;
          const neighbor = edge.from === id ? edge.to : edge.from;
          if (neighbor && !scopedIds.has(neighbor) && scopedIds.size < 300) {
            scopedIds.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
  }

  const nodes = [...scopedIds].map(id => byId.get(id)).filter((node): node is GraphNode => Boolean(node));
  const scopedSet = new Set(nodes.map(node => node.id));
  const incidentByNode = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (edge.from && scopedSet.has(edge.from)) {
      const current = incidentByNode.get(edge.from) ?? [];
      current.push(edge);
      incidentByNode.set(edge.from, current);
    }
    if (edge.to && scopedSet.has(edge.to) && edge.to !== edge.from) {
      const current = incidentByNode.get(edge.to) ?? [];
      current.push(edge);
      incidentByNode.set(edge.to, current);
    }
  }

  const preferredKinds = new Set(['feature','capability','route','api','mcp','provider','file','function','method','class','interface','constructor']);
  const ranked = nodes
    .map(node => ({ node, metrics: orientationMetric(node, graph, incidentByNode.get(node.id) ?? [], rankBy) }))
    .sort((a, b) =>
      b.metrics.rankValue - a.metrics.rankValue
      || Number(preferredKinds.has(b.node.kind)) - Number(preferredKinds.has(a.node.kind))
      || b.metrics.relationshipDiversity - a.metrics.relationshipDiversity
      || displayName(a.node).localeCompare(displayName(b.node)));

  const meaningful = ranked.filter(item => preferredKinds.has(item.node.kind));
  const keySource = meaningful.length >= Math.min(limit, 5) ? meaningful : ranked;
  const keyEntities = keySource.slice(0, limit).map(({ node, metrics }) => ({
    id: node.id,
    name: displayName(node),
    kind: node.kind,
    layer: node.layer ?? 'structural',
    locator: node.locator,
    metrics,
    reason: orientationReason(metrics, rankBy),
  }));

  const boundary = graph.edges
    .filter(edge => edge.status === 'resolved' && edge.from && edge.to && scopedSet.has(edge.from) !== scopedSet.has(edge.to))
    .slice(0, 200);
  const boundarySummaries = boundary.map(edge => {
    const outbound = scopedSet.has(edge.from!);
    const externalId = outbound ? edge.to! : edge.from!;
    const external = byId.get(externalId);
    return {
      edgeId: edge.id,
      direction: outbound ? 'outbound' : 'inbound',
      kind: edge.kind,
      external: { id: externalId, name: displayName(external, externalId), kind: external?.kind ?? 'unknown', locator: external?.locator ?? null },
    };
  });

  const nodeKinds: Record<string, number> = {};
  for (const node of nodes) nodeKinds[node.kind] = (nodeKinds[node.kind] ?? 0) + 1;
  const relationshipKinds: Record<string, number> = {};
  for (const edge of graph.edges.filter(edge => edge.status === 'resolved' && ((edge.from && scopedSet.has(edge.from)) || (edge.to && scopedSet.has(edge.to))))) {
    relationshipKinds[edge.kind] = (relationshipKinds[edge.kind] ?? 0) + 1;
  }

  const uncertainty = ranked
    .filter(item => item.metrics.candidate + item.metrics.unresolved > 0)
    .sort((a,b) => (b.metrics.candidate + b.metrics.unresolved) - (a.metrics.candidate + a.metrics.unresolved))
    .slice(0, Math.min(limit, 10))
    .map(({node,metrics}) => ({ id: node.id, name: displayName(node), kind: node.kind, locator: node.locator, candidate: metrics.candidate, unresolved: metrics.unresolved }));

  return {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    ambiguous: false,
    scope: {
      kind: selected.kind,
      value: selected.value,
      nodeCount: nodes.length,
      resolvedBoundaryCount: boundary.length,
    },
    rankBy,
    summary: String(nodes.length) + ' graph entities are in the selected ' + selected.kind + ' scope; key entities are ordered by ' + rankBy + '.',
    nodeKinds: Object.entries(nodeKinds).sort((a,b) => b[1]-a[1]).slice(0, 12).map(([kind,count]) => ({kind,count})),
    relationshipKinds: Object.entries(relationshipKinds).sort((a,b) => b[1]-a[1]).slice(0, 12).map(([kind,count]) => ({kind,count})),
    keyEntities,
    boundaries: boundarySummaries.slice(0, limit * 2),
    uncertainty,
    nextInspections: keyEntities.slice(0, Math.min(5, keyEntities.length)).map(item => ({ id: item.id, name: item.name, locator: item.locator, reason: item.reason })),
    coverage: compactCoverage(graph),
    policy: {
      subjectiveImportanceScore: false,
      rankFacet: rankBy,
      evidenceLinked: true,
      persisted: false,
      note: 'Orientation ranks observed graph facets only. It does not assign architectural quality, severity, or product priority.',
    },
  };
}

function querySubject(text: string, markers: RegExp[]): string {
  let value = text.trim();
  for (const marker of markers) value = value.replace(marker, ' ');
  return value.replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
}

function normalizedMention(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_./:@-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function plainMention(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

const GENERIC_SUBJECT_NAMES = new Set([
  'api', 'class', 'code', 'config', 'configuration', 'dependency', 'dependencies', 'entity', 'feature',
  'file', 'function', 'implementation', 'module', 'object', 'project', 'provider', 'relationship',
  'relationships', 'route', 'signal', 'source', 'subject', 'system', 'tool', 'unsupported',
]);

function subjectDescriptor(node: GraphNode | null, fallback: string | null, ambiguous = false, candidates: GraphNode[] = []): Record<string, unknown> | null {
  if (!node && !fallback && !ambiguous) return null;
  return {
    query: fallback,
    ambiguous,
    ...(node ? { id: node.id, name: displayName(node), kind: node.kind, layer: node.layer ?? 'structural', locator: node.locator } : {}),
    ...(candidates.length ? { candidates: candidates.slice(0, 10).map(item => ({ id: item.id, name: displayName(item), kind: item.kind, layer: item.layer ?? 'structural', locator: item.locator })) } : {}),
  };
}

function explicitPathMention(text: string): string | null {
  const backtick = [...text.matchAll(/`([^`]+)`/gu)].map(match => match[1]!.trim()).filter(Boolean);
  const raw = [...text.matchAll(/(?:^|[\s("'\`])((?:\.{0,2}\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+|Dockerfile(?:\.[A-Za-z0-9_.-]+)?|\.env(?:\.[A-Za-z0-9_.-]+)?)(?=$|[\s)"'\`,?])/gu)]
    .map(match => match[1]!.trim());
  return [...backtick, ...raw].find(value => value.includes('/') || value.startsWith('.env') || value.startsWith('Dockerfile')) ?? null;
}

function sourceFallbackPattern(text: string, file: string): { pattern: string; regex: boolean } {
  if (/^\.env(?:\.|$)/u.test(file)) return { pattern: '^[A-Z][A-Z0-9_]*=', regex: true };
  const remaining = text.replace(file, ' ');
  const stop = new Set(['a','an','are','can','configure','configured','declared','do','does','file','in','is','of','the','this','to','use','uses','what','which','with','workflow']);
  const tokens = (remaining.match(/[A-Za-z0-9_@./:-]{3,}/gu) ?? [])
    .map(value => value.trim())
    .filter(value => value && !stop.has(value.toLowerCase()));
  if (!tokens.length) return { pattern: '.+', regex: true };
  return { pattern: [...new Set(tokens)].slice(0, 8).map(value => value.replace(/[.*+?^{}()|[\]\\]/gu, '\\$&')).join('|'), regex: true };
}

async function unsupportedPathSourceFallback(
  input: { project: string; ref?: string | undefined; graphId?: string | undefined },
  text: string,
): Promise<Record<string, unknown> | null> {
  const file = explicitPathMention(text);
  if (!file) return null;
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const normalized = file.replace(/^\.\//u, '');
  const coverage = graph.coverage?.files.find(item => item.path.replace(/^\.\//u, '') === normalized);
  if (!coverage || !['unsupported', 'skipped', 'partial'].includes(coverage.status)) return null;
  const search = sourceFallbackPattern(text, file);
  const result = await searchCode({
    project: input.project,
    ref: input.ref,
    graphId: input.graphId,
    pattern: search.pattern,
    filePattern: normalized,
    filePatternMode: 'literal',
    regex: search.regex,
    context: 2,
    limit: 100,
  }) as any;
  return {
    intent: 'source-search',
    subject: { query: normalized, ambiguous: false },
    routing: { tool: 'search_code', file: normalized, coverageStatus: coverage.status },
    answer: `${result.matches?.length ?? 0} exact Git source match(es) found in “${normalized}”; graph-analysis status is ${coverage.status}.`,
    result,
  };
}

async function resolveInvestigationSubject(
  input: { project: string; ref?: string | undefined; graphId?: string | undefined; scope?: string | undefined },
  text: string,
  markers: RegExp[],
): Promise<{ query: string | null; node: GraphNode | null; ambiguous: boolean; candidates: GraphNode[] }> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const scoped = input.scope ? scopeNodeIds(graph, input.scope) : null;
  const scopeIds = scoped && (scoped.kind === 'file' || scoped.kind === 'path' || scoped.kind === 'entity') ? scoped.ids : null;
  const inScope = (nodes: GraphNode[]) => scopeIds ? nodes.filter(node => scopeIds.has(node.id)) : nodes;

  if (scoped?.kind === 'file' && /\b(file|module|owner|owns|ownership|persistence owner)\b/iu.test(text)) {
    const fileNode = graph.nodes.find(node => scopeIds?.has(node.id) && node.kind === 'file');
    if (fileNode) return { query: scoped.value, node: fileNode, ambiguous: false, candidates: [fileNode] };
  }

  const cleaned = querySubject(text, markers);
  if (cleaned) {
    const direct = inScope(findGraphNodeCandidates(graph, cleaned, 20)).filter(node => {
      const name = plainMention(node.name ?? '');
      return !GENERIC_SUBJECT_NAMES.has(name) || plainMention(cleaned) === name;
    });
    const exact = direct.find(node => node.id === cleaned || normalizedMention(node.name ?? '') === normalizedMention(cleaned));
    if (exact) return { query: cleaned, node: exact, ambiguous: false, candidates: [exact] };
    if (direct.length === 1) return { query: cleaned, node: direct[0]!, ambiguous: false, candidates: direct };
  }

  const haystack = normalizedMention(text);
  const mentions = inScope(graph.nodes)
    .map(node => {
      const values = [node.id, node.name ?? '']
        .map(value => ({ raw: value, normalized: normalizedMention(value), plain: plainMention(value) }))
        .filter(value => value.normalized.length >= 3
          && haystack.includes(value.normalized)
          && (!GENERIC_SUBJECT_NAMES.has(value.plain) || plainMention(cleaned) === value.plain));
      const score = values.reduce((max, value) => Math.max(max, value.normalized.length + (/[_.:/@-]/u.test(value.raw) ? 20 : 0)), 0);
      return { node, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) =>
      b.score - a.score
      || Number(b.node.layer === 'semantic') - Number(a.node.layer === 'semantic')
      || a.node.id.localeCompare(b.node.id));

  if (!mentions.length) return { query: cleaned || null, node: null, ambiguous: false, candidates: [] };
  const best = mentions[0]!;
  const tied = mentions.filter(item => item.score === best.score);
  const semanticBest = tied.filter(item => item.node.layer === 'semantic');
  if (semanticBest.length === 1) return { query: cleaned || displayName(semanticBest[0]!.node), node: semanticBest[0]!.node, ambiguous: false, candidates: tied.map(item => item.node) };
  if (tied.length === 1) return { query: cleaned || displayName(best.node), node: best.node, ambiguous: false, candidates: [best.node] };
  return { query: cleaned || null, node: null, ambiguous: true, candidates: tied.map(item => item.node) };
}

export async function queryWorkbench(input: {
  project: string;
  text: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  sourceId?: string | undefined;
  capability?: TechnicalSourceCapability | undefined;
  scope?: string | undefined;
  rankBy?: ScopeRankBy | undefined;
}): Promise<Record<string, unknown>> {
  const text = input.text.trim();
  if (!text) throw new Error('text must be non-empty');
  const lower = text.toLowerCase();

  if (input.sourceId) {
    const external = await queryTechnicalSource({ project: input.project, sourceId: input.sourceId, capability: input.capability, query: text });
    return { intent: 'source-query', subject: null, routing: { tool: 'query_source', sourceId: input.sourceId }, answer: `Read-only query sent to ${input.sourceId}.`, result: external };
  }

  const sourceFallback = await unsupportedPathSourceFallback(input, text);
  if (sourceFallback) return sourceFallback;

  if (/\b(what changed|changes?|diff|delta)\b/.test(lower)) {
    const result = await diffAcceptedToWorking(input.project, input.ref);
    const counts = semanticDiffCounts(result);
    return { intent: 'change', subject: null, routing: { tool: 'diff_graph' }, answer: `Accepted → working semantic change: ${counts.added} added, ${counts.removed} removed, ${counts.changed} changed records.`, result };
  }

  if (/\bcoverage\b/.test(lower)) {
    const result = await graphCoverage(input.project, input.ref, input.graphId);
    const coverage = result as any;
    return { intent: 'coverage', subject: null, routing: { tool: 'check_graph_coverage' }, answer: `Coverage: ${coverage.completeFiles ?? '?'} complete, ${coverage.partialFiles ?? '?'} partial, ${coverage.failedFiles ?? '?'} failed, ${coverage.skippedFiles ?? '?'} skipped files.`, result };
  }

  if (/\bparity\b/.test(lower)) {
    const resolved = await resolveInvestigationSubject(input, text, [/\b(show|find|inspect|query|parity|for|of|what|is|the)\b/gi]);
    const subject = resolved.node?.id ?? resolved.query ?? undefined;
    const result = await parityLens({ project: input.project, ref: input.ref, graphId: input.graphId, query: subject, limit: 100 }) as any;
    return {
      intent: 'parity',
      subject: subjectDescriptor(resolved.node, resolved.query, resolved.ambiguous, resolved.candidates),
      routing: { tool: 'query_parity' },
      answer: `${result.items?.length ?? result.nodes?.length ?? 0} parity result(s) found${subject ? ` for “${subject}”` : ''}.`,
      result,
    };
  }

  if (/\b(code|source|implementation|implemented)\b/.test(lower)) {
    const resolved = await resolveInvestigationSubject(input, text, [/\b(show|show me|find|search|code|source|implementation|implemented|for|of|where|is|the)\b/gi]);
    if (resolved.ambiguous) {
      return { intent: 'code', subject: subjectDescriptor(null, resolved.query, true, resolved.candidates), routing: { tool: 'get_code_snippet' }, answer: 'The requested implementation subject is ambiguous; choose an exact entity.', result: { ambiguous: true, candidates: resolved.candidates } };
    }
    if (resolved.node) {
      try {
        const result = await getCodeSnippet({ project: input.project, ref: input.ref, graphId: input.graphId, node: resolved.node.id, context: 8 }) as any;
        return { intent: 'code', subject: subjectDescriptor(resolved.node, resolved.query), routing: { tool: 'get_code_snippet' }, answer: `Exact source resolved for “${displayName(resolved.node)}”.`, result };
      } catch {
        // Some semantic/runtime entities do not have one exact source snippet; fall back to bounded source search.
      }
    }
    const pattern = resolved.node?.name ?? resolved.query;
    if (pattern) {
      const result = await searchCode({ project: input.project, ref: input.ref, graphId: input.graphId, pattern, limit: 100 }) as any;
      return { intent: 'code', subject: subjectDescriptor(resolved.node, resolved.query), routing: { tool: 'search_code' }, answer: `${result.matches?.length ?? 0} source match(es) found for “${pattern}”.`, result };
    }
  }

  if (/\b(write|writes|writing|mutate|mutates|mutation|persist|persists|persistence|write back|accepted graph|accepted checkpoint)\b/.test(lower)) {
    const resolved = await resolveInvestigationSubject(input, text, [/\b(where|what|which|how|does|do|is|are|write|writes|writing|mutate|mutates|mutation|persist|persists|persistence|back|into|the|an|a)\b/gi]);
    if (!resolved.ambiguous && resolved.node) {
      const terms = [resolved.node.name ?? '', 'writeCheckpoint', 'sealLocalGraph', 'accepted', 'persist']
        .filter(Boolean)
        .map(value => value.replace(/[.*+?^{}()|[\]\\]/gu, '\\$&'))
        .join('|');
      const result = await searchCode({ project: input.project, ref: input.ref, graphId: input.graphId, pattern: terms, regex: true, context: 3, limit: 100 }) as any;
      return {
        intent: 'implementation-claim',
        subject: subjectDescriptor(resolved.node, resolved.query),
        routing: { tool: 'search_code', premiseAssumed: false },
        answer: `Source evidence loaded for the mutation/persistence claim about “${displayName(resolved.node)}” without assuming the premise is true.`,
        result,
      };
    }
  }

  if (/\b(main|major|moving parts|wide view|around|important|most connected|call hubs?|orientation|orient|overview of|what does .+ do)\b/.test(lower)) {
    let requestedScope = input.scope?.trim() || '';
    if (!requestedScope) {
      const pathMatch = text.match(/\b(?:src|tests|docs|scripts|app|lib|packages?)\/[A-Za-z0-9_./@-]+/u);
      if (pathMatch) requestedScope = pathMatch[0]!;
    }
    if (!requestedScope) {
      const resolved = await resolveInvestigationSubject(input, text, [/\b(what|which|show|find|main|major|moving parts|wide view|around|important|most connected|call hubs?|orientation|orient|functions?|dependencies|does|do|uses|use|rely on|under|in|the|this|page|file|module|feature|area)\b/gi]);
      if (!resolved.ambiguous && resolved.node) requestedScope = resolved.node.id;
    }
    if (!requestedScope && /\b(this page|this file|this module|this feature|this area)\b/i.test(text)) {
      return {
        intent: 'orientation',
        subject: null,
        routing: { tool: 'orient_scope', scopeRequired: true },
        answer: 'A concrete file, path, entity, or feature scope is required for “this” orientation questions.',
        result: { scopeRequired: true, supportedScopes: ['repository','path','file','entity','feature/route/api'] },
      };
    }
    const result = await scopeOrientation({
      project: input.project,
      scope: requestedScope || undefined,
      ref: input.ref,
      graphId: input.graphId,
      rankBy: input.rankBy,
    });
    return {
      intent: 'orientation',
      subject: requestedScope ? { query: requestedScope } : null,
      routing: { tool: 'orient_scope', rankBy: input.rankBy ?? 'cross-file' },
      answer: String((result as any).summary ?? 'Scoped orientation complete.'),
      result,
    };
  }

  if (/\b(depend(?:s)? on|dependency|dependencies|used by|uses|callers?|called by|calls?|constructs?|consumers?|connect(?:ed|s|ion)?|relationships?|related|exposed|exposes|route)\b/.test(lower)) {
    const resolved = await resolveInvestigationSubject(input, text, [/\b(what|which|show|find|how|is|are|does|do|depend(?:s)? on|dependency|dependencies|used by|uses|callers?|called by|calls?|constructs?|consumers?|connect(?:ed|s|ion)?|relationships?|related|exposed|exposes|through|route|of|for|to|on|the|an|a)\b/gi]);
    if (resolved.ambiguous) {
      return { intent: 'trace', subject: subjectDescriptor(null, resolved.query, true, resolved.candidates), routing: { tool: 'trace_path' }, answer: 'The relationship subject is ambiguous; choose an exact entity.', result: { ambiguous: true, candidates: resolved.candidates } };
    }
    const subject = resolved.node?.id ?? resolved.query;
    if (subject) {
      const direction = /used by|callers?|called by|consumers?|\bwhich\b.*\buses?\b|\bwhat\b.*\b(?:calls?|constructs?)\b/.test(lower)
        ? 'inbound'
        : /depend(?:s)? on|uses/.test(lower) ? 'outbound' : 'both';
      const result = await traceGraph({ project: input.project, ref: input.ref, graphId: input.graphId, node: subject, direction, depth: 2, statuses: ['resolved'], limit: 250 }) as any;
      return {
        intent: 'trace',
        subject: subjectDescriptor(resolved.node, resolved.query),
        routing: { tool: 'trace_path', direction },
        answer: result.ambiguous ? `“${subject}” is ambiguous; choose an exact entity.` : `${result.nodes?.length ?? 0} entities and ${result.edges?.length ?? 0} resolved relationships are in the traced neighborhood of “${displayName(resolved.node ?? undefined, subject)}”.`,
        result,
      };
    }
  }

  if (/\b(evidence|supports?|supporting|audit|finding|problem|risk|realiz\w*|capability|proof|prove)\b/.test(lower)) {
    const resolved = await resolveInvestigationSubject(input, text, [/\b(what|which|show|find|inspect|evidence|supports?|supporting|audit|assess|finding|findings|problem|problems|risk|risks|realiz\w*|capability|proof|prove|for|of|is|are|does|do|the)\b/gi]);
    const claimNeedsAssessment = /\b(no|none|not|only|second|absent|missing|without|actually|whether|cannot|can't)\b/.test(lower);
    if (!claimNeedsAssessment && !resolved.ambiguous && resolved.node && /\b(evidence|supports?|supporting|proof|prove)\b/.test(lower)) {
      const result = await inspectEntity({ project: input.project, node: resolved.node.id, ref: input.ref, graphId: input.graphId });
      return { intent: 'evidence', subject: subjectDescriptor(resolved.node, resolved.query), routing: { tool: 'inspect_entity' }, answer: `Evidence and resolved context loaded for “${displayName(resolved.node)}”.`, result };
    }
    const result = await queryIntelligence({ project: input.project, question: text, ...(input.ref ? { ref: input.ref } : {}), ...(input.graphId ? { graphId: input.graphId } : {}) });
    return {
      intent: 'intelligence',
      subject: subjectDescriptor(resolved.node, resolved.query, resolved.ambiguous, resolved.candidates),
      routing: { tool: 'query_intelligence' },
      answer: `Evidence-backed assessment: ${String((result as any).answerStatus ?? 'indeterminate')}.`,
      result,
    };
  }

  if (/\b(overview|summary|summarize|project status|what is this project)\b/.test(lower)) {
    const result = await projectOverview(input.project, input.ref, input.graphId);
    return { intent: 'overview', subject: null, routing: { tool: 'project_overview' }, answer: String(result.summary ?? `${input.project} overview`), result };
  }

  const resolved = await resolveInvestigationSubject(input, text, [/^\s*(what is|what's|show me|show|find|where is|inspect|tell me about)\s+/i]);
  if (resolved.ambiguous) {
    return { intent: 'search', subject: subjectDescriptor(null, resolved.query, true, resolved.candidates), routing: { tool: 'search_graph' }, answer: 'The requested subject is ambiguous; choose an exact entity.', result: { ambiguous: true, candidates: resolved.candidates } };
  }
  if (resolved.node) {
    const inspected = await inspectEntity({ project: input.project, node: resolved.node.id, ref: input.ref, graphId: input.graphId });
    return { intent: 'inspect', subject: subjectDescriptor(resolved.node, resolved.query), routing: { tool: 'inspect_entity' }, answer: String(inspected.summary ?? `Found ${displayName(resolved.node)}.`), result: inspected };
  }
  const query = resolved.query || text;
  const result = await searchGraph({ project: input.project, ref: input.ref, graphId: input.graphId, query, limit: 100 }) as any;
  if ((result.nodes?.length ?? 0) === 1) {
    const inspected = await inspectEntity({ project: input.project, node: result.nodes[0].id, ref: input.ref, graphId: input.graphId });
    return { intent: 'inspect', subject: subjectDescriptor(result.nodes[0], query), routing: { tool: 'inspect_entity' }, answer: String(inspected.summary ?? `Found ${query}.`), result: inspected };
  }
  return { intent: 'search', subject: subjectDescriptor(null, query), routing: { tool: 'search_graph' }, answer: `${result.nodeTotal ?? result.nodes?.length ?? 0} entities match “${query}”.`, result };
}


function decomposeQuestionText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const pieces: string[] = [];
  let start = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== '?') continue;
    const piece = trimmed.slice(start, index + 1).trim();
    if (piece) pieces.push(piece);
    start = index + 1;
  }
  const remainder = trimmed.slice(start).trim();
  if (pieces.length > 1 && !remainder) return pieces;
  return [trimmed];
}

function inheritedQuestion(question: string, subjectId: string | null): { text: string; inherited: boolean } {
  if (!subjectId) return { text: question, inherited: false };
  let resolved = question;
  const patterns = [
    /\bthose answers\b/giu,
    /\bthat answer\b/giu,
    /\bthis (?:entity|feature|function|class|page|route|api|subject)\b/giu,
    /\bit\b/giu,
  ];
  let inherited = false;
  for (const pattern of patterns) {
    if (!pattern.test(resolved)) continue;
    pattern.lastIndex = 0;
    resolved = resolved.replace(pattern, subjectId);
    inherited = true;
  }
  return { text: resolved, inherited };
}

export async function queryWorkbenchRequest(input: {
  project: string;
  text?: string | undefined;
  questions?: string[] | undefined;
  ref?: string | undefined;
  graphId?: string | undefined;
  sourceId?: string | undefined;
  capability?: TechnicalSourceCapability | undefined;
  scope?: string | undefined;
  rankBy?: ScopeRankBy | undefined;
}): Promise<Record<string, unknown>> {
  const explicit = (input.questions ?? []).map(question => question.trim()).filter(Boolean);
  if (explicit.length > 10) throw new Error('questions supports at most 10 items');
  const originalText = input.text?.trim() ?? '';
  if (explicit.length && originalText) throw new Error('provide text or questions, not both');

  const questions = explicit.length ? explicit : decomposeQuestionText(originalText);
  if (!questions.length) throw new Error('text or questions must contain at least one question');
  if (questions.length > 10) throw new Error('investigation supports at most 10 questions');

  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const mode = explicit.length ? 'explicit' : questions.length > 1 ? 'decomposed' : 'single';

  if (questions.length === 1) {
    const result = await queryWorkbench({
      project: input.project,
      text: questions[0]!,
      graphId: graph.graphId,
      sourceId: input.sourceId,
      capability: input.capability,
      scope: input.scope,
      rankBy: input.rankBy,
    });
    return {
      ...result,
      request: {
        mode,
        graphId: graph.graphId,
        revision: graph.repositoryRevision,
        questionCount: 1,
        originalText: originalText || null,
      },
    };
  }

  const items: Array<Record<string, unknown>> = [];
  let inheritedSubjectId: string | null = null;
  for (const [index, originalQuestion] of questions.entries()) {
    const inherited = inheritedQuestion(originalQuestion, inheritedSubjectId);
    try {
      const result = await queryWorkbench({
        project: input.project,
        text: inherited.text,
        graphId: graph.graphId,
        sourceId: input.sourceId,
        capability: input.capability,
        scope: input.scope,
        rankBy: input.rankBy,
      }) as any;
      const subjectId = result?.subject && result.subject.ambiguous !== true && typeof result.subject.id === 'string'
        ? result.subject.id
        : null;
      if (subjectId) inheritedSubjectId = subjectId;
      items.push({
        index,
        question: originalQuestion,
        resolvedQuestion: inherited.text,
        inheritedSubject: inherited.inherited ? inheritedSubjectId : null,
        status: 'ok',
        intent: result.intent ?? null,
        subject: result.subject ?? null,
        routing: result.routing ?? null,
        answer: result.answer ?? null,
        result: result.result ?? null,
      });
    } catch (error) {
      items.push({
        index,
        question: originalQuestion,
        resolvedQuestion: inherited.text,
        inheritedSubject: inherited.inherited ? inheritedSubjectId : null,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    intent: 'batch',
    request: {
      mode,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      questionCount: questions.length,
      originalText: originalText || null,
      explicitQuestions: explicit.length > 0,
    },
    items,
    counts: {
      ok: items.filter(item => item.status === 'ok').length,
      error: items.filter(item => item.status === 'error').length,
    },
    policy: {
      deterministicDecomposition: true,
      inheritedSubjectOnlyFromExactPriorResult: true,
      failureIsolation: true,
      persisted: false,
      note: 'Each question is routed independently over one pinned graph context. Prior exact subjects may resolve simple pronouns; ambiguous or failed questions never become graph authority.',
    },
  };
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
