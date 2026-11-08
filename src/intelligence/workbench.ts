import { listAuthorizedGithubOwners, loadRegistry } from '../config/registry.js';
import { projectStatus } from '../projectStatus.js';
import { listPublicProjects } from '../source/git.js';
import type { GraphEdge, GraphNode, IntelligenceGraph, RelationshipStatus, TechnicalSourceCapability } from '../types.js';
import { getCodeSnippet, searchCode } from './code.js';
import { currentGraph } from './service.js';
import { diffAcceptedToWorking, findGraphNodeCandidates, graphCoverage, parityLens, searchGraph, traceGraph } from './query.js';
import { listTechnicalSources, queryTechnicalSource } from './technicalSources.js';
import { parseSourceReferenceQuestion, sourceReferenceProjection, sourceReferenceAnswer, parseFileOutboundQuestion, fileOutboundProjection, fileOutboundAnswer } from './sourceReferenceQuestion.js';
import { assessGraph, auditGraph, queryIntelligence, type AuditFinding } from './assessment.js';
import { bootstrapSemanticCandidates } from './semanticBootstrap.js';
import { semanticReviewSurface } from './semanticWorkflow.js';
import { auditSemanticCandidates } from './semanticAudit.js';
import { loadSemanticAuthority } from './semanticAuthorityStore.js';
import { deriveCurrentSemanticTruth } from './semanticCurrentTruth.js';
import { graphRecordWeight } from './capacity.js';
import { repositoryAudit } from './repositoryAudit.js';
import { interfaceRuntimeObservationContract, isInterfaceRuntimeObservationSource } from './interfaceRuntimeObservation.js';

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

export async function semanticAudit(input: {
  project: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  limit?: number | undefined;
  candidateLimit?: number | undefined;
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const candidateLimit = Math.min(Math.max(input.candidateLimit ?? 200, 1), 1000);
  const bootstrap = bootstrapSemanticCandidates(graph, { limit: candidateLimit });
  const audit = auditSemanticCandidates(graph, bootstrap, { limit: input.limit ?? 30 });
  const reviewed = audit.items.length;
  const core = audit.counts.coreCandidates;
  const needsReview = audit.counts.factualityNeedsReview;
  return {
    project: input.project,
    graphId: graph.graphId,
    summary: `${audit.candidateUniverse.eligible} evidence-qualified semantic candidate(s); ${core} of ${reviewed} audited candidate(s) satisfy the explicit core-candidate facets and ${needsReview} require factuality review.`,
    ...audit,
    coverage: compactCoverage(graph),
    policyNote: 'Core/supporting is an evidence-grounded audit classification, not semantic authority. Acceptance and verification remain separate.',
  };
}

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
    semanticBootstrap: bootstrapSemanticCandidates(graph, { limit: 12 }),
    changes: diff ? { ...diffCounts, detail: diff } : null,
    findings: findings.slice(0, 20),
    subjects: subjects.slice(0, 10).map(subject => projectSubjectBrief(graph, subject.trim())).filter(item => Boolean(item.query)),
    sources,
  };
}

export async function projectStatistics(project: string, ref?: string | undefined, graphId?: string | undefined): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref, graphId);
  let graphStatus: any = null;
  try {
    const status = await projectStatus(project, false);
    const candidate = (status as any).graph ?? null;
    if (candidate?.revision === graph.repositoryRevision) graphStatus = candidate;
  } catch {
    graphStatus = null;
  }
  const semantic = graph.nodes.filter(node => node.layer === 'semantic').length;
  const structural = graph.nodes.filter(node => (node.layer ?? 'structural') === 'structural').length;
  const representation = graph.nodes.filter(node => node.layer === 'representation').length;
  const coverage = compactCoverage(graph) as any;
  const cache = graphStatus?.cache ?? null;
  const observability = graphStatus?.observability ?? null;
  const maxRetainedRecords = typeof cache?.maxRetainedRecords === 'number' ? cache.maxRetainedRecords : null;
  const retainedRecords = typeof cache?.retainedRecords === 'number' ? cache.retainedRecords : null;
  const cacheUtilization = maxRetainedRecords && retainedRecords !== null
    ? Number((retainedRecords / maxRetainedRecords).toFixed(4))
    : null;
  const warnings: string[] = [];
  if (coverage?.failedFiles) warnings.push(`${coverage.failedFiles} source file(s) failed analysis.`);
  if (coverage?.partialFiles) warnings.push(`${coverage.partialFiles} source file(s) are only partially analyzed.`);
  if (coverage?.skippedFiles) warnings.push(`${coverage.skippedFiles} source file(s) were skipped.`);
  if (cacheUtilization !== null && cacheUtilization >= 0.8) warnings.push(`Process graph-cache record utilization is ${Math.round(cacheUtilization * 100)}% of its configured bound.`);

  return {
    project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    role: graph.role,
    summary: `${project}: ${coverage?.trackedFiles ?? 'unknown'} tracked files, ${graph.nodes.length} graph nodes, ${graph.edges.length} edges, ${semantic} semantic concepts, and ${graph.evidence.length} evidence records.`,
    source: {
      trackedFiles: coverage?.trackedFiles ?? null,
      eligibleFiles: coverage?.eligibleFiles ?? null,
      analyzedFiles: coverage?.analyzedFiles ?? null,
      completeFiles: coverage?.completeFiles ?? null,
      partialFiles: coverage?.partialFiles ?? null,
      unsupportedFiles: coverage?.unsupportedFiles ?? null,
      skippedFiles: coverage?.skippedFiles ?? null,
      failedFiles: coverage?.failedFiles ?? null,
      sourceBytes: null,
      sourceBytesStatus: 'unavailable-not-recorded',
    },
    graph: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      evidenceRecords: graph.evidence.length,
      semanticNodes: semantic,
      structuralNodes: structural,
      representationNodes: representation,
      sources: graph.sources.length,
      recordWeight: graphRecordWeight(graph),
      explicitValueConflicts: graph.explicitValueConflicts.length,
      unresolvedNodeIds: graph.unmatchedNodeIds.length,
      unavailableSources: graph.unavailableSourceIds.length,
    },
    currentness: graphStatus?.currentness ?? null,
    persistence: observability ? {
      canonical: observability.persistence ?? null,
      queryArtifacts: observability.queryArtifacts ?? null,
    } : null,
    capacity: {
      cache: cache ? {
        ...cache,
        utilization: cacheUtilization,
      } : null,
      coldBuild: observability?.coldBuild ?? null,
      graphAccess: observability?.graphAccess ?? null,
      lastToolCall: observability?.lastToolCall ?? null,
      limits: {
        maxRetainedRecords,
        repositoryMaxEntries: cache?.repository?.maxEntries ?? null,
        snapshotMaxEntries: cache?.snapshots?.maxEntries ?? null,
        coldBuildConcurrency: cache?.coldBuilds?.limit ?? null,
      },
    },
    providerStorage: {
      available: false,
      bytes: null,
      note: 'Provider storage is not inferred from repository graph state. It is populated only when a configured live evidence plane supplies project-scoped storage metrics.',
    },
    warnings,
    policy: {
      descriptiveOnly: true,
      semanticAuthority: false,
      unknownValuesRemainNull: true,
      operationalStatsRequireExactRevisionMatch: true,
      operationalStatsAvailable: Boolean(graphStatus),
    },
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
  byId: ReadonlyMap<string, GraphNode>,
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


type OrientationRole =
  | 'semantic'
  | 'interface'
  | 'implementation'
  | 'effects'
  | 'integration'
  | 'representation'
  | 'structural';

function orientationRole(node: GraphNode): OrientationRole {
  if (node.layer === 'semantic') return 'semantic';
  if (node.layer === 'representation') return 'representation';
  if (['route', 'api', 'ui-element', 'surface'].includes(node.kind)) return 'interface';
  if (['function', 'method', 'constructor', 'class', 'interface'].includes(node.kind)) return 'implementation';
  if (['state-binding', 'state-write', 'navigation-call', 'http-call', 'rpc-call', 'sql-reference'].includes(node.kind)) return 'effects';
  if (['provider', 'mcp', 'mcp-tool'].includes(node.kind)) return 'integration';
  return 'structural';
}

function orientationRoleStatement(role: OrientationRole, count: number, names: string[]): string {
  const examples = semanticNameList(names, 3);
  const suffix = examples ? `, including ${examples}` : '';
  if (role === 'semantic') return `Represents ${count} evidence-linked semantic concept(s)${suffix}.`;
  if (role === 'interface') return `Exposes ${count} route/API/UI interface entity or entities${suffix}.`;
  if (role === 'implementation') return `Implements ${count} callable/type entity or entities${suffix}.`;
  if (role === 'effects') return `Contains ${count} observed state/navigation/network/persistence effect entity or entities${suffix}.`;
  if (role === 'integration') return `Connects ${count} provider/tool integration entity or entities${suffix}.`;
  if (role === 'representation') return `Carries ${count} representation/layout/style observation(s)${suffix}.`;
  return `Contains ${count} additional structural entity or entities${suffix}.`;
}

interface OrientationBoundarySummary {
  edgeId: string;
  direction: 'outbound' | 'inbound';
  kind: string;
  external: { id: string; name: string; kind: string; locator: string | null };
}

function orientationDependencies(
  boundaries: OrientationBoundarySummary[],
  direction: 'outbound' | 'inbound',
  limit: number,
): Array<{
  external: OrientationBoundarySummary['external'];
  relationshipKinds: string[];
  edgeIds: string[];
  relationshipCount: number;
}> {
  const grouped = new Map<string, {
    external: OrientationBoundarySummary['external'];
    kinds: Set<string>;
    edgeIds: string[];
  }>();
  for (const boundary of boundaries) {
    if (boundary.direction !== direction) continue;
    const current = grouped.get(boundary.external.id) ?? {
      external: boundary.external,
      kinds: new Set<string>(),
      edgeIds: [],
    };
    current.kinds.add(boundary.kind);
    current.edgeIds.push(boundary.edgeId);
    grouped.set(boundary.external.id, current);
  }
  return [...grouped.values()]
    .map(item => ({
      external: item.external,
      relationshipKinds: [...item.kinds].sort(),
      edgeIds: [...new Set(item.edgeIds)].sort(),
      relationshipCount: item.edgeIds.length,
    }))
    .sort((a, b) =>
      b.relationshipCount - a.relationshipCount
      || b.relationshipKinds.length - a.relationshipKinds.length
      || a.external.name.localeCompare(b.external.name)
      || a.external.id.localeCompare(b.external.id))
    .slice(0, Math.max(1, limit));
}

function semanticNameList(names: string[], limit: number): string {
  const unique = [...new Set(names.filter(Boolean))];
  const shown = unique.slice(0, limit);
  if (!shown.length) return '';
  if (shown.length === 1) return shown[0]!;
  const suffix = unique.length > shown.length ? ` and ${unique.length - shown.length} more` : '';
  if (shown.length === 2) return shown.join(' and ') + suffix;
  return shown.slice(0, -1).join(', ') + ', and ' + shown[shown.length - 1] + suffix;
}

export type SemanticQueryDepth = 'nucleus' | 'expanded' | 'exhaustive';

function semanticDepthForQuestion(text: string, explicit?: SemanticQueryDepth): SemanticQueryDepth {
  if (explicit) return explicit;
  const lower = text.toLowerCase();
  if (/\b(exhaustive|exhaustively|every|everything|complete census|full census|entire semantic|all semantic)\b/u.test(lower)) return 'exhaustive';
  if (/\b(go deep|deep dive|deeply|in depth|broaden|broad view|full picture|supporting systems?|supporting (?:areas|layers|substrates)|substrates?|underneath|across (?:the )?semantic|major capabilities)\b/u.test(lower)) return 'expanded';
  return 'nucleus';
}

function implementationExplorationIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const asksMechanism = /\b(how|where)\b/u.test(lower);
  const mechanism = /\b(?:rout\w*|choos\w*|select\w*|dispatch\w*|decompos\w*|inherit\w*|prevent\w*|contaminat\w*|handl\w*|resolv\w*|plann\w*|shard\w*|index\w*|load\w*|map\w*|correlat\w*)\b/u.test(lower);
  return asksMechanism && mechanism;
}

/** Comparative test-assurance questions need source claims, not an incidental
 * entity with a coincidentally named field. This routes evidence; it does not
 * assert semantic equivalence or replace runtime verification. */

type SpecificSemanticQuestion = 'saved' | 'excluded' | 'candidate';
function specificSemanticQuestion(text: string): SpecificSemanticQuestion | null {
  const lower = text.toLowerCase();
  // A repository orientation may enumerate all semantic candidates without
  // requesting evidence about one candidate. Preserve the existing depth route.
  if (/\b(?:what does (?:this|the) project do|project overview|repository overview)\b/u.test(lower)) return null;
  const asks = /\b(?:which|what|list|show|how many|why)\b/u.test(lower);
  if (asks && /\b(?:semantic|meanings?|candidates?)\b/u.test(lower)
    && /\b(?:saved|stored|persisted|automatically derived|automatically maintained)\b/u.test(lower)) return 'saved';
  if (asks && /\b(?:exclud\w*|omitt\w*|not eligible|not promoted)\b/u.test(lower)
    && /\b(?:semantic|candidates?|meanings?|scopes?)\b/u.test(lower)) return 'excluded';
  if (asks && /\bcandidate\b/u.test(lower)
    && /\b(?:evidence|support|uncertain|uncertainty|why)\b/u.test(lower)) return 'candidate';
  return null;
}
async function explainSpecificSemanticQuestion(project: string, graphId: string, text: string, kind: SpecificSemanticQuestion, callerScope?: string): Promise<Record<string, unknown>> {
  // The source of truth is the existing revision-bound, read-only review
  // surface. Return a proportional projection, not a second meaning model.
  const surface = await semanticReviewSurface({ project, graphId, limit: 1000 });
  const c = surface.candidates;
  const derivedIds = new Set(surface.derivedMeanings.map(item => item.candidateId));
  const accepted = c.filter(item => item.review?.accepted === true);
  const machineAccepted = accepted.filter(item => item.review?.acceptance?.actor.kind === 'intrinsic-derivation');
  const humanAccepted = accepted.filter(item => item.review?.acceptance?.actor.kind === 'human');
  const base = {
    revision: surface.revision, graphId: surface.graphId,
    authority: { state: surface.authority.state, generation: surface.authority.generation,
      recordCount: surface.authority.recordCount, enrollmentState: surface.authority.enrollmentState },
    capacity: { eligible: surface.capacity.eligibleCandidateCount,
      excluded: surface.capacity.rejectedScopeCount, exhausted: surface.capacity.exhausted,
      exclusionsTruncated: surface.capacity.excludedScopes.truncated },
    policy: { evidenceOnly: true, acceptedByDerivation: machineAccepted.length > 0,
      automaticAcceptanceRestrictedToTechnicalScope: true, runtimeVerified: false },
  };
  if (kind === 'saved') {
    const saved = c.filter(item => derivedIds.has(item.id)).map(item => ({
      candidateId:item.id, name:item.proposal.name, scope:item.scope,
      meaningId:surface.derivedMeanings.find(row => row.candidateId === item.id)?.meaningId ?? null,
      explicitlyAccepted: item.review?.accepted === true,
    }));
    return { intent:'semantic-lifecycle', subject:null, routing:{tool:'semantic_review_surface',projection:'saved-inventory'},
      answer: String(saved.length) + ' currently pending source-derived meaning(s), '
        + String(machineAccepted.length) + ' machine-accepted technical source scope(s), and '
        + String(humanAccepted.length) + ' human-accepted meaning(s). Machine acceptance proves technical source scope only, not product purpose or runtime execution.',
      result:{ ...base, saved, counts:{derived:saved.length,accepted:accepted.length,
        machineAccepted:machineAccepted.length,humanAccepted:humanAccepted.length,
        otherAccepted:accepted.length-machineAccepted.length-humanAccepted.length,
        reviewRecords:surface.authority.recordCount} } };
  }
  if (kind === 'excluded') {
    // An explicit caller scope is authoritative input for selection, not a
    // reason to infer product meaning. Do not discard it for question prose.
    const path = callerScope?.trim() || explicitInvestigationScope(text);
    const matches = surface.capacity.excludedScopes.items.filter(item => path && (
      item.scope === path || item.representativeNodes.some(node => node.locator === path || node.locator.startsWith(path + ':'))));
    if (matches.length !== 1) return {
      intent:'semantic-audit',subject:path ? {query:path}:null,
      routing:{tool:'semantic_review_surface',projection:'excluded-scope',resolved:false},
      answer:'No single excluded scope resolved in the bounded census; this does not establish absence or eligibility.',
      result:{...base,path,matches:matches.slice(0,5)},
    };
    const item = matches[0]!;
    return { intent:'semantic-audit',subject:{query:item.scope},
      routing:{tool:'semantic_review_surface',projection:'excluded-scope',resolved:true},
      answer:'Scope ' + item.scope + ' is excluded for ' + item.reason + ': '
        + String(item.fileCount) + ' file(s), ' + String(item.nodeCount) + ' nodes, '
        + String(item.resolvedEdgeCount) + ' resolved edges; evidence families: '
        + item.evidenceFamilies.join(', ') + '. Exclusion does not mean absent or incorrect source.',
      result:{...base,exclusion:item,candidateAuthorityAssigned:false} };
  }
  const lower = text.toLowerCase();
  const explicitCandidateIds = [...new Set((text.match(/semantic-candidate:[a-z0-9]+/giu) ?? []).map(id => id.toLowerCase()))];
  // Structured caller scope is authoritative. Otherwise a literal candidate ID
  // outranks an incidental prose file path (e.g. "unlike src/mcp.ts").
  const requestedScope = callerScope?.trim() || (explicitCandidateIds.length ? null : explicitInvestigationScope(text));
  // Exact identity takes precedence. A short candidate such as "Git" must
  // not match incidental "GitHub", and ambiguities remain visible.
  const normalized = (value: string) => value.toLocaleLowerCase('en-US');
  const nameInQuestion = (value: string) => {
    const phrase = normalized(value.trim());
    if (!phrase) return false;
    let at = lower.indexOf(phrase);
    while (at !== -1) {
      const before = at === 0 ? '' : lower[at - 1]!;
      const afterIndex = at + phrase.length;
      const after = afterIndex >= lower.length ? '' : lower[afterIndex]!;
      const token = /[a-z0-9_]/u;
      if ((!before || !token.test(before)) && (!after || !token.test(after))) return true;
      at = lower.indexOf(phrase, at + 1);
    }
    return false;
  };
  const matches = requestedScope
    ? c.filter(item => item.id === requestedScope || item.scope === requestedScope)
    : explicitCandidateIds.length
      ? c.filter(item => explicitCandidateIds.includes(item.id))
      : c.filter(item => nameInQuestion(item.proposal.name));

  if (matches.length !== 1) return {
    intent:'semantic-audit',subject:null,
    routing:{tool:'semantic_review_surface',projection:'candidate-evidence',resolved:false},
    answer:matches.length ? 'Multiple candidate identities matched; provide an exact scope or candidate ID.'
      : 'No candidate identity resolved from the requested name or scope.',
    result:{...base,candidates:matches.slice(0,10).map(item => ({id:item.id,name:item.proposal.name,scope:item.scope}))},
  };
  const item = matches[0]!;
  return {intent:'semantic-audit',subject:{query:item.proposal.name,candidateId:item.id,scope:item.scope},
    routing:{tool:'semantic_review_surface',projection:'candidate-evidence',resolved:true},
    answer:'Candidate ' + item.proposal.name + ': ' + String(item.support.fileCount) + ' source file(s), '
      + String(item.support.nodeCount) + ' nodes, ' + String(item.support.resolvedEdgeCount)
      + ' resolved edges; evidence families: ' + item.provenance.evidenceFamilies.join(', ')
      + '. Audit factuality: ' + item.reviewAssessment.factuality
      + '; candidate classification: ' + item.reviewAssessment.classification
      + (item.review?.accepted === true && item.review.acceptance?.actor.kind === 'intrinsic-derivation'
        ? '. Only its literal technical source scope is machine-accepted; its candidate functional meaning is not proven.'
        : item.review?.accepted === true ? '. Acceptance is recorded separately from runtime verification.'
          : '. This is source qualification, not runtime verification or accepted intent.'),
    result:{ ...base,candidate:{
      id:item.id,scope:item.scope,proposal:item.proposal,support:item.support,
      evidenceFamilies:item.provenance.evidenceFamilies,
      representativeNodes:item.evidencePacket.representativeNodes.slice(0,8),
      representativeEdges:item.evidencePacket.representativeEdges.slice(0,8),
      auditFactuality:item.reviewAssessment.factuality,
      coreClassification:item.reviewAssessment.classification,
      reviewAssessment:item.reviewAssessment,
      autonomousState:item.autonomousAssessment.state,
      derivedCurrent:derivedIds.has(item.id),
      accepted:item.review?.accepted === true,
      acceptanceActorKind:item.review?.acceptance?.actor.kind ?? null,
      machineAcceptedTechnicalScope:item.review?.accepted === true
        && item.review?.acceptance?.actor.kind === 'intrinsic-derivation',
      humanAccepted:item.review?.accepted === true && item.review?.acceptance?.actor.kind === 'human',
      explicitlyAccepted:item.review?.accepted === true && item.review?.acceptance?.actor.kind === 'human',
    } },
  };
}

function testAssuranceComparisonIntent(text: string): boolean {
  const lower = text.toLowerCase();
  // A test/assurance comparison may ask whether the graph can replace an
  // assertion, or whether two checks overlap, without saying "protection lost".
  const protectionSubject = /\b(?:tests?|assertions?|checks?|fixtures?|expectations?|guarantees?)\b/u.test(lower);
  const comparison = /\b(?:replac\w*|remov\w*|chang\w*|substitut\w*|instead|drop(?:ped)?|eliminat\w*|redundan\w*|overlap\w*|equivalen\w*|lost|lose|preserv\w*)\b/u.test(lower);
  return protectionSubject && comparison;
}

function implementationInventoryIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const asksInventory = /\b(?:what|which|show|list|explain|describe)\b/u.test(lower)
    && /\b(?:already|currently|now|exist|exists|available|implemented|supported|present|have|has)\b/u.test(lower);
  const inventory = /\b(?:capabilit(?:y|ies)|infrastructure|projections?|routers?|routing|benchmarks?|benchmarking|tooling|mechanisms?|pipelines?|services?|systems?)\b/u.test(lower);
  const implementationContext = /\b(?:graph|semantic|interface|interaction|accuracy|benchmark|query|investigation|analysis|runtime|source|code|repository|repo|project)\b/u.test(lower);
  return asksInventory && inventory && implementationContext;
}

function implementationMetaInquiryIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const asks = /\b(?:how|where|what|which|show|explain|describe)\b/u.test(lower);
  const metaSubject = /\b(?:benchmarks?|benchmarking|scorecards?|scor(?:e|er|ing)|ground[- ]truth|corpus|corpora|manifests?|routers?|routing|projections?|tooling|pipelines?|planners?|index(?:ed|ing)?|shards?|sharding|caches?|metrics?|measure(?:d|ment|ments)|accuracy cases?)\b/u.test(lower);
  const developmentContext = /\b(?:graph|semantic|interface|interaction|accuracy|benchmark|query|investigation|analysis|runtime|source|code|repository|repositories|repo|project|scripts?|tools?|calls?|relationships?|evidence)\b/u.test(lower);
  return asks && metaSubject && developmentContext;
}

function deploymentPortabilityInquiryIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const asks = /\b(?:can|could|does|do|is|are|what|which|how|where|show|explain|describe)\b/u.test(lower);
  const deploymentTopic = /\b(?:self[- ]host(?:ed|ing)?|hosting|deploy(?:ed|ment|ments)?|portable|portability|vercel|docker|containers?|standalone|server startup|hardware|linux|macos|windows)\b/u.test(lower);
  const operationalContext = /\b(?:runtime|server|provider|environment|configuration|config|packag(?:e|ing)|install(?:er|ation)?|storage|database|host|port|entrypoints?|dependencies|capabilit(?:y|ies)|infrastructure)\b/u.test(lower);
  return asks && deploymentTopic && operationalContext;
}

function implementationExplorationTerms(text: string): string[] {
  const stop = new Set([
    'about', 'against', 'also', 'another', 'between', 'broader', 'choice', 'current', 'does', 'doing',
    'evidence', 'exact', 'explain', 'from', 'graph', 'into', 'other', 'question', 'questions', 'read',
    'reads', 'request', 'requests', 'system', 'that', 'their', 'them', 'then', 'there', 'these', 'they',
    'this', 'those', 'what', 'when', 'where', 'which', 'with', 'without',
  ]);
  const words = text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/gu) ?? [];
  const stems = words
    .map(word => word.replace(/(?:ing|edly|ed|es|s)$/iu, ''))
    .map(word => word.length >= 5 ? word.toLowerCase() : '')
    .filter(Boolean)
    .filter(word => !stop.has(word));
  return [...new Set(stems)].slice(0, 10);
}

function implementationExplorationPattern(text: string): string {
  const terms = implementationExplorationTerms(text);
  if (!terms.length) return '.+';
  return terms.flatMap(term => {
    const capitalized = term.charAt(0).toUpperCase() + term.slice(1);
    return [term + '[A-Za-z0-9_-]*', capitalized + '[A-Za-z0-9_-]*'];
  }).join('|');
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^{}()|[\]\\]/gu, '\\$&');
}

function rankedMechanismSourceFiles(
  graph: IntelligenceGraph,
  text: string,
  limit = 12,
): Array<{ file: string; score: number; matchedTerms: string[]; nodeHits: number }> {
  const terms = implementationExplorationTerms(text);
  if (!terms.length) return [];
  const files = new Map<string, { score: number; terms: Set<string>; nodeHits: number }>();
  for (const node of graph.nodes) {
    const file = sourceFile(node.locator)?.replace(/^\.\//u, '');
    if (!file) continue;
    const name = String(node.name ?? '').toLowerCase();
    const identity = (String(node.id) + ' ' + String(node.locator)).toLowerCase();
    const matched = terms.filter(term => name.includes(term) || identity.includes(term));
    if (!matched.length) continue;
    const current = files.get(file) ?? { score: 0, terms: new Set<string>(), nodeHits: 0 };
    current.nodeHits += 1;
    for (const term of matched) {
      current.terms.add(term);
      current.score += 2 + Number(name.includes(term)) * 2;
    }
    if (node.layer === 'structural' || node.layer === 'representation') current.score += 1;
    files.set(file, current);
  }
  return [...files.entries()]
    .map(([file, value]) => ({
      file,
      score: value.score + value.terms.size * 4,
      matchedTerms: [...value.terms].sort(),
      nodeHits: value.nodeHits,
    }))
    .sort((a, b) =>
      b.matchedTerms.length - a.matchedTerms.length
      || b.score - a.score
      || b.nodeHits - a.nodeHits
      || a.file.localeCompare(b.file))
    .slice(0, Math.max(1, limit));
}
async function implementationMechanismProjection(input: {
  project: string;
  text: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  scope?: string | undefined;
  limit?: number | undefined;
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const assuranceComparison = testAssuranceComparisonIntent(input.text);
  // Prefer source symbols and the concrete proposed replacement over incidental
  // words such as "protection" or "lost". No match is an explicit unknown.
  // An explicit assertion operand is stronger subject evidence than a common
  // provider method such as assert.equal. Never replace a missing operand with
  // unrelated lexical matches from other tests.
  const requestedAssertionSyntax = assuranceComparison
    ? input.text.match(/\b((?:assert|expect)\.[A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/u)
    : null;
  const requestedAssertionOperand = requestedAssertionSyntax?.[2] ?? null;
  const requestedFile = assuranceComparison ? explicitInvestigationScope(input.text) : null;
  const anchors = assuranceComparison
    ? [...new Set([
        ...(requestedAssertionOperand ? [requestedAssertionOperand] : []),
        ...(input.text.match(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9_$]*\b/gu) ?? []),
        ...(input.text.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\b/gu) ?? [])
          .filter(value => !/^(?:assert|expect)\./u.test(value)),
        ...[...input.text.matchAll(/\bliteral\s+([0-9]+)\b/giu)].map(match => match[1]!),
      ])].slice(0, 8)
    : [];
  const pattern = requestedAssertionSyntax
    ? regexEscape(requestedAssertionSyntax[1]!) + '\\s*\\(\\s*' + regexEscape(requestedAssertionSyntax[2]!) + '\\b'
    : anchors.length
      ? '(?:' + anchors.map(regexEscape).join('|') + ')'
      : implementationExplorationPattern(input.text);
  const queryTerms = implementationExplorationTerms(input.text);
  const explicitScope = input.scope?.trim() || requestedFile || '';
  const rankedFiles = explicitScope || anchors.length ? [] : rankedMechanismSourceFiles(graph, input.text, 12);
  const rankedFilePattern = rankedFiles.length
    ? '^(?:' + rankedFiles.map(item => regexEscape(item.file)).join('|') + ')$'
    : undefined;
  const source = await searchCode({
    project: input.project,
    ref: input.ref,
    graphId: graph.graphId,
    pattern,
    ...(explicitScope
      ? {
          filePattern: explicitScope.replace(/^\.\//u, ''),
          filePatternMode: /\.[A-Za-z0-9]+$/u.test(explicitScope) ? 'literal' as const : 'prefix' as const,
        }
      : rankedFilePattern
        ? { filePattern: rankedFilePattern, filePatternMode: 'regex' as const }
        : {}),
    regex: true,
    context: 3,
    limit: Math.min(Math.max(input.limit ?? 100, 1), 250),
    ...(requestedAssertionSyntax ? { syntacticCall: {
      callee: requestedAssertionSyntax[1]!,
      firstArgumentIdentifier: requestedAssertionSyntax[2]!,
    } } : {}),
  }) as any;
  const rawMatches = Array.isArray(source.matches) ? source.matches : [];
  // Syntax validation is performed in the whole exact-revision source file
  // before returning a match, not on a detached search-result line.
  const matches = rawMatches;
  const fileMap = new Map<string, any[]>();
  for (const match of matches) {
    const file = String(match.file ?? '').trim();
    if (!file) continue;
    const items = fileMap.get(file) ?? [];
    items.push(match);
    fileMap.set(file, items);
  }
  const matchedFiles = new Set(fileMap.keys());
  const matchedSourceLines = new Map<string, Set<number>>();
  for (const match of matches) {
    const file = String(match.file ?? '').trim();
    const line = Number(match.line ?? 0);
    if (!file || !Number.isFinite(line) || line <= 0) continue;
    const lines = matchedSourceLines.get(file) ?? new Set<number>();
    lines.add(line);
    matchedSourceLines.set(file, lines);
  }
  const endpointRelevance = (node: GraphNode | undefined): { queryTermHits: number; sourceMatch: boolean } => {
    if (!node) return { queryTermHits: 0, sourceMatch: false };
    const name = String(node.name ?? '').toLowerCase();
    const queryTermHits = queryTerms.filter(term => name.includes(term)).length;
    const file = sourceFile(node.locator)?.replace(/^\.\//u, '') ?? '';
    const lineMatch = node.locator.match(/:(\d+)(?::|$)/u);
    const line = Number(lineMatch?.[1] ?? 0);
    return {
      queryTermHits,
      sourceMatch: Boolean(file && line > 0 && matchedSourceLines.get(file)?.has(line)),
    };
  };
  const scopedNodes = graph.nodes.filter(node => {
    const file = sourceFile(node.locator)?.replace(/^\.\//u, '');
    return Boolean(file && matchedFiles.has(file));
  });
  const scopedIds = new Set(scopedNodes.map(node => node.id));
  const byId = new Map(graph.nodes.map(node => [node.id, node]));

  const touching = graph.edges.filter(edge =>
    Boolean(edge.from && scopedIds.has(edge.from))
    || Boolean(edge.to && scopedIds.has(edge.to)));
  const relationshipItems = touching
    .map(edge => {
      const from = edge.from ? byId.get(edge.from) : undefined;
      const to = edge.to ? byId.get(edge.to) : undefined;
      const fromRelevance = endpointRelevance(from);
      const toRelevance = endpointRelevance(to);
      return {
        queryTermHits: fromRelevance.queryTermHits + toRelevance.queryTermHits,
        sourceMatchEndpointCount: Number(fromRelevance.sourceMatch) + Number(toRelevance.sourceMatch),
        edgeId: edge.id,
        kind: edge.kind,
        status: edge.status,
        confidence: edge.confidence,
        from: edge.from ? {
          id: edge.from,
          name: displayName(from, edge.from),
          kind: from?.kind ?? 'unknown',
          locator: from?.locator ?? null,
        } : null,
        to: edge.to ? {
          id: edge.to,
          name: displayName(to, edge.to),
          kind: to?.kind ?? 'unknown',
          locator: to?.locator ?? null,
        } : null,
        evidenceIds: edge.evidenceIds ?? [],
        bothEndpointsInMatchedFiles: Boolean(edge.from && edge.to && scopedIds.has(edge.from) && scopedIds.has(edge.to)),
      };
    })
    .sort((a, b) =>
      Number(b.status === 'resolved') - Number(a.status === 'resolved')
      || b.sourceMatchEndpointCount - a.sourceMatchEndpointCount
      || b.queryTermHits - a.queryTermHits
      || Number(b.bothEndpointsInMatchedFiles) - Number(a.bothEndpointsInMatchedFiles)
      || a.kind.localeCompare(b.kind)
      || String(a.edgeId).localeCompare(String(b.edgeId)));

  const resolved = relationshipItems.filter(item => item.status === 'resolved');
  const unresolved = relationshipItems.filter(item => item.status !== 'resolved');
  const resolvedDegree = new Map<string, number>();
  for (const edge of resolved) {
    if (edge.from?.id && scopedIds.has(edge.from.id)) resolvedDegree.set(edge.from.id, (resolvedDegree.get(edge.from.id) ?? 0) + 1);
    if (edge.to?.id && scopedIds.has(edge.to.id)) resolvedDegree.set(edge.to.id, (resolvedDegree.get(edge.to.id) ?? 0) + 1);
  }

  const keyEntities = scopedNodes
    .map(node => ({
      id: node.id,
      name: displayName(node),
      kind: node.kind,
      layer: node.layer ?? 'structural',
      locator: node.locator,
      queryTermHits: endpointRelevance(node).queryTermHits,
      sourceMatch: endpointRelevance(node).sourceMatch,
      resolvedRelationshipCount: resolvedDegree.get(node.id) ?? 0,
      evidenceCount: (node.evidenceIds ?? []).length,
    }))
    .sort((a, b) =>
      Number(b.sourceMatch) - Number(a.sourceMatch)
      || b.queryTermHits - a.queryTermHits
      || b.resolvedRelationshipCount - a.resolvedRelationshipCount
      || b.evidenceCount - a.evidenceCount
      || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id))
    .slice(0, 20);

  const decisionEvidence = matches
    .filter((match: any) => /\b(if|else|switch|case|return|fallback|strategy|mode|select|choose|plan|shard|index|cache|exact)\b/iu.test(String(match.text ?? '')))
    .slice(0, 30)
    .map((match: any) => ({
      file: match.file,
      line: match.line,
      text: match.text,
      before: match.before,
      after: match.after,
    }));

  const files = [...fileMap.entries()]
    .map(([file, items]) => ({
      file,
      matchCount: items.length,
      sample: items.slice(0, 5).map((match: any) => ({
        line: match.line,
        text: match.text,
        before: match.before,
        after: match.after,
      })),
    }))
    .sort((a, b) => b.matchCount - a.matchCount || a.file.localeCompare(b.file))
    .slice(0, 20);

  const fileNames = files.slice(0, 4).map(item => item.file);
  // Source observations and the user's proposed change are separate truth classes.
  // Matching a symbol or a number is not proof that an assertion is equivalent.
  const proposedLiteral = input.text.match(/\bliteral\s+([0-9]+)\b/iu)?.[1] ?? null;
  const proposedLength = input.text.match(/\b([A-Za-z_$][A-Za-z0-9_$]*\.length)\b/u)?.[1] ?? null;
  const resolvedSubject = requestedAssertionSyntax
    ? { kind: 'assertion-call-site', value: requestedAssertionSyntax[0],
        status: matches.length ? 'observed-syntactic-call-site' : 'not-established-in-bounded-source' }
    : anchors.length
      ? { kind: 'named-source-anchors', values: anchors, status: matches.length ? 'source-matched' : 'not-found' }
      : { kind: 'unresolved-source-subject', status: 'not-established' };
  const sourceObservations = matches
    .filter((match: any) => typeof match.file === 'string' && Number.isInteger(match.line) && typeof match.text === 'string')
    .map((match: any) => ({
      file: String(match.file),
      line: Number(match.line),
      text: String(match.text).trim().slice(0, 500),
      kind: /^(?:tests|test)\//u.test(String(match.file)) ? 'test-source'
        : /^scripts\//u.test(String(match.file)) ? 'verification-script' : 'implementation-source',
    }))
    .slice(0, 24);
  const sourceExamples = sourceObservations.slice(0, 4)
    .map((item: {file: string; line: number; kind: string}) => item.file + ':' + item.line + ' (' + item.kind + ')').join('; ');
  const summary = assuranceComparison
    ? (sourceObservations.length
      ? 'Found ' + matches.length + ' bounded source match(es) in ' + fileMap.size
        + ' file(s), including ' + sourceExamples + '. These are source locations, not an established finding about the protection lost by the proposed change. Compare the original assertion, independent assertions, and runtime checks before concluding redundancy or equivalence.'
      : 'No bounded source matches established the requested test-assurance comparison; equivalence and lost protection remain unknown.')
    : matches.length
    ? String(matches.length) + ' bounded source match(es) across ' + String(fileMap.size) + ' file(s); '
      + String(resolved.length) + ' resolved graph relationship(s) connect entities in or directly adjacent to those files'
      + (fileNames.length ? ', led by ' + semanticNameList(fileNames, 4) : '') + '.'
    : 'No bounded source evidence matched the requested implementation mechanism in this graph context.';

  return {
    ...source,
    ...(assuranceComparison ? {
      matches,
      total: matches.length,
      rawSourceMatchCount: rawMatches.length,
      rawSourceTotal: Number(source.total ?? rawMatches.length),
      sourceValidatedMatchCount: matches.length,
      sourceValidationScope: requestedAssertionSyntax
        ? 'whole-file-ast-call-and-first-operand-syntax-only' : 'bounded-lexical-anchor',
    } : {}),
    summary,
    mechanism: {
      pattern,
      ...(assuranceComparison ? { assuranceComparison: {
        requestedSubject: { source: 'user-question-only', scope: explicitScope || null, ...resolvedSubject },
        proposedChange: { source: 'user-question-only', literal: proposedLiteral, replacementExpression: proposedLength },
        sourceObservations,
        assessment: 'not-established',
        sourceEvidenceOnly: true,
        runtimeEquivalenceProven: false,
        replacementAuthorized: false,
        independentProtectionEstablished: false,
      } } : {}),
      selection: {
        mode: explicitScope ? 'explicit-scope' : rankedFiles.length ? 'graph-ranked-files' : 'repository-fallback',
        explicitScope: explicitScope || null,
        candidateFiles: rankedFiles,
        sourceFilePattern: explicitScope || rankedFilePattern || null,
      },
      files,
      keyEntities,
      relationships: resolved.slice(0, 50),
      decisionEvidence,
      uncertainty: {
        candidateRelationships: unresolved.filter(item => item.status === 'candidate').length,
        unresolvedRelationships: unresolved.filter(item => item.status === 'unresolved').length,
        examples: unresolved.slice(0, 20),
      },
      policy: {
        deterministic: true,
        sourceObservedOnly: true,
        graphRelationshipsRequireObservedEdges: true,
        runtimeExecutionProven: false,
        productIntentInferred: false,
        semanticAuthority: false,
        persisted: false,
      },
    },
    coverage: compactCoverage(graph),
  };
}

export type InvestigationQuestionLane =
  | 'source-query'
  | 'interface'
  | 'semantic-lifecycle'
  | 'implementation-explanation'
  | 'change'
  | 'statistics'
  | 'coverage'
  | 'parity'
  | 'implementation-claim'
  | 'code'
  | 'semantic-audit'
  | 'repository-audit'
  | 'orientation'
  | 'trace'
  | 'evidence'
  | 'overview'
  | 'entity';

export type InvestigationQuestionProofMode = 'descriptive' | 'evidence' | 'claim';
export type InvestigationQuestionSubjectStrategy =
  | 'external-source'
  | 'repository'
  | 'scope-or-entity'
  | 'source-keyword-evidence'
  | 'entity-or-query';

export interface InvestigationQuestionPlan {
  lane: InvestigationQuestionLane;
  semanticDepth: SemanticQueryDepth;
  proofMode: InvestigationQuestionProofMode;
  subjectStrategy: InvestigationQuestionSubjectStrategy;
  completeness: 'bounded' | SemanticQueryDepth;
  continuity: 'immediate-exact-pronoun-only';
}

export function planInvestigationQuestion(input: {
  text: string;
  sourceId?: string;
  semanticDepth?: SemanticQueryDepth;
}): InvestigationQuestionPlan {
  const text = input.text.trim();
  if (!text) throw new Error('text must be non-empty');
  const lower = text.toLowerCase();
  const semanticDepth = semanticDepthForQuestion(text, input.semanticDepth);
  const interfaceIntent = /\b(interface|interaction|interactive|ui\b|state owners?|state controls?|what changes when|handlers?|click|drag|drop|scroll|pointer|overlay|navigation|surfaces?)\b/u.test(lower);
  const architectureSimplificationIntent =
    /\b(simplif\w*|over[- ]?complicat\w*|over[- ]?complex\w*|maintenance burden|unnecessary (?:abstraction|layer|indirection)s?)\b/u.test(lower)
    || (
      /\b(overlap\w*|duplicat\w*|redundan\w*|indirection)\b/u.test(lower)
      && /\b(parts?|areas?|layers?|responsibilit\w*|architecture|architectural|implementation|system|project|repository|repo|codebase|paths?|flows?)\b/u.test(lower)
    );
  const semanticLifecycleIntent =
    /\b(semantic|meaning|meanings)\b/u.test(lower)
    && /\b(propos(?:e|ed|al|als|ing)?|review(?:ed|ing)?|accept(?:ed|ance|ing)?|verif(?:y|ied|ication|ying)|authorit(?:y|ative)|evolv(?:e|ed|ing|ution)|preserv(?:e|ed|ing)|supersed(?:e|ed|ing)|split|merge(?:d|s|ing)?|replace(?:d|ment|s|ing)?|lineage|canonical|promot(?:e|ed|ion|ing))\b/u.test(lower);
  const semanticLifecycleAuditIntent =
    semanticLifecycleIntent
    && /\b(gaps?|contradictions?|issues?|problems?|risks?|bugs?|weaknesses?)\b/u.test(lower)
    && /\b(source|implementation|workflow|system|code)\b/u.test(lower);
  const repositorySemanticOrientationIntent =
    /\b(?:this|the)\s+(?:project|repository|repo|codebase)(?:['’]s)?\b/iu.test(text)
    && /\b(main|major|moving parts|wide view|orientation|orient|overview|what does .+ do)\b/u.test(lower);
  const semanticAuditIntent =
    !repositorySemanticOrientationIntent
    && (
      /\b(semantic factuality|semantic meaning|semantic meanings|semantic candidate|semantic candidates|over[- ]?deriv|over[- ]?expand|core capabilities|core concepts|core meanings|supporting meanings|supporting capabilities)\b/u.test(lower)
      || (/\bsemantic\b/u.test(lower) && /\b(core|supporting|factual|factuality|audit|meaning|candidate|candidates)\b/u.test(lower))
    );
  const orientationIntent = /\b(main|major|moving parts|wide view|around|important|most connected|call hubs?|orientation|orient|overview of|what does .+ do)\b/u.test(lower);
  const implementationClaimIntent = /\b(write|writes|writing|mutate|mutates|mutation|persist|persists|persistence|write back|accepted graph|accepted checkpoint)\b/u.test(lower);
  const codeIntent = /\b(code|source|implementation|implemented)\b/u.test(lower);
  const traceIntent = /\b(depend(?:s)? on|dependency|dependencies|used by|uses|callers?|called by|calls?|constructs?|consumers?|connect(?:ed|s|ion)?|relationships?|related|exposed|exposes|route)\b/u.test(lower);
  const evidenceIntent = /\b(evidence|supports?|supporting|audit|finding|problem|risk|realiz\w*|capability|proof|prove)\b/u.test(lower);
  const claimIntent = /\b(no|none|not|only|second|absent|missing|without|actually|whether|cannot|can't)\b/u.test(lower);
  const statisticsIntent =
    /\b(?:project|repository|repo|codebase|graph)\b[^?.!]{0,60}\b(?:size|stats|statistics|capacity|footprint|limits?|big|large|resource pressure|storage usage)\b/u.test(lower)
    || /\b(?:how (?:big|large) is (?:this|the) (?:project|repository|repo|codebase)|general (?:project )?stats|project stats|capacity profile|how many (?:files|nodes|edges|semantic concepts)|near (?:our )?capacity|close to (?:our )?capacity)\b/u.test(lower);
  const repositoryAuditIntent =
    (
      /\b(?:this|the|our)\s+(?:project|repository|repo|codebase|system)\b/u.test(lower)
      || /\b(?:itself|ourselves|self[- ]audit|repository-wide|project-wide|overall)\b/u.test(lower)
      || /\bwhich\s+(?:current\s+)?(?:failures?|warnings?)\b/u.test(lower)
    )
    && /\b(?:audit|risks?|problems?|failures?|warnings?|blind spots?|weaknesses?|correctness|maintainability|architecture|architectural|fix(?:ed|es|ing)?|priorit(?:y|ize|ized|ization)|limitations?|issues?)\b/u.test(lower);

  const specificSemantic = specificSemanticQuestion(text);
  const testAssuranceComparison = testAssuranceComparisonIntent(text);
  const implementationInventory = implementationInventoryIntent(text);
  const implementationMetaInquiry = implementationMetaInquiryIntent(text);
  const deploymentPortabilityInquiry = deploymentPortabilityInquiryIntent(text);

  let lane: InvestigationQuestionLane;
  if (input.sourceId) lane = 'source-query';
  else if (specificSemantic) lane = specificSemantic === 'saved' ? 'semantic-lifecycle' : 'semantic-audit';
  else if (testAssuranceComparison || implementationInventory || implementationMetaInquiry || deploymentPortabilityInquiry) lane = 'implementation-explanation';
  else if (interfaceIntent) lane = 'interface';
  else if (architectureSimplificationIntent || semanticLifecycleAuditIntent) lane = 'repository-audit';
  // Project-level "what does this codebase do" questions must inspect the
  // current graph even if the prose mentions historic semantic acceptance.
  // A question explicitly about a release gate, enrollment or promotion
  // baseline remains governance, never a description of current code.
  else if (repositorySemanticOrientationIntent
    && !/\b(?:baseline|enroll(?:ed|ment|ing)?|gate|promot(?:e|ed|ion|ing)?)\b/u.test(lower)) lane = 'orientation';
  else if (semanticLifecycleIntent) lane = 'semantic-lifecycle';
  else if (implementationExplorationIntent(text)) lane = 'implementation-explanation';
  else if (/\b(what changed|changes?|diff|delta)\b/u.test(lower)) lane = 'change';
  else if (statisticsIntent) lane = 'statistics';
  else if (/\bcoverage\b/u.test(lower)) lane = 'coverage';
  else if (/\bparity\b/u.test(lower)) lane = 'parity';
  else if (implementationClaimIntent) lane = 'implementation-claim';
  else if (codeIntent) lane = 'code';
  else if (semanticAuditIntent) lane = 'semantic-audit';
  else if (repositoryAuditIntent) lane = 'repository-audit';
  else if (orientationIntent) lane = 'orientation';
  else if (traceIntent) lane = 'trace';
  else if (evidenceIntent) lane = 'evidence';
  else if (/\b(overview|summary|summarize|project status|what is this project)\b/u.test(lower)) lane = 'overview';
  else lane = 'entity';

  const proofMode: InvestigationQuestionProofMode =
    lane === 'implementation-claim' || (lane === 'evidence' && claimIntent)
      ? 'claim'
      : lane === 'evidence'
        ? 'evidence'
        : 'descriptive';

  const subjectStrategy: InvestigationQuestionSubjectStrategy =
    lane === 'source-query'
      ? 'external-source'
      : lane === 'implementation-explanation'
        ? 'source-keyword-evidence'
        : lane === 'interface' || lane === 'orientation'
          ? 'scope-or-entity'
          : ['semantic-lifecycle', 'semantic-audit', 'repository-audit', 'change', 'statistics', 'coverage', 'overview'].includes(lane)
            ? 'repository'
            : 'entity-or-query';

  return {
    lane,
    semanticDepth,
    proofMode,
    subjectStrategy,
    completeness: lane === 'orientation' ? semanticDepth : 'bounded',
    continuity: 'immediate-exact-pronoun-only',
  };
}

async function repositorySemanticUnderstanding(
  project: string,
  graph: IntelligenceGraph,
  limit: number,
  depth: SemanticQueryDepth,
  orientationReuse?: OrientationQueryReuse,
): Promise<Record<string, unknown>> {
  // The selected exact-revision graph is the sole input to present meaning.
  // A prior review ledger, acceptance event, or recorded interpretation must
  // never outrank the current code (including for historical Git selectors).
  const truth = orientationReuse
    ? (orientationReuse.currentSemanticTruth ??= deriveCurrentSemanticTruth(graph))
    : deriveCurrentSemanticTruth(graph);
  const proven = truth.provenTechnicalScopes;
  const observed = truth.declaredConcepts.map(node => ({
    id: node.id, name: node.name, kind: node.kind, locator: node.locator,
    declared: true, evidenceCount: node.evidenceIds.length,
  }));
  const derivedAll = truth.interpretations
    .map(item => ({
      id: item.candidateId, name: item.name, description: item.description,
      kind: item.proposedKind, scope: item.scope,
      evidenceFamilies: item.evidenceFamilies,
      evidenceFamilyCount: item.evidenceFamilies.length,
      fileCount: item.sourceFileCount,
      resolvedEdgeCount: item.resolvedRelationships,
      coreness: item.coreness, factuality: item.factuality,
      sourceStatus: item.sourceStatus,
      technicalScopeProven: item.technicalScopeProven,
      proofBlockers: item.proofBlockers,
      authority: {
        source: 'selected-graph', acceptedFromHistory: false,
        technicalEvidenceUsableWithoutReview: true,
        productIntentProven: false, persisted: false,
      },
    }))
    .sort((a,b) =>
      Number(b.coreness === 'core-candidate') - Number(a.coreness === 'core-candidate')
      || b.evidenceFamilyCount - a.evidenceFamilyCount
      || b.fileCount - a.fileCount
      || a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  const coreDerived = derivedAll.filter(x => x.coreness === 'core-candidate' && x.factuality === 'supported');
  const supportDerived = derivedAll.filter(x => x.coreness !== 'core-candidate' || x.factuality !== 'supported');
  const candidateLimit = depth === 'exhaustive' ? 1000
    : depth === 'expanded' ? Math.min(Math.max(limit * 6,64),250)
    : Math.min(Math.max(limit * 2,24),100);
  const bounded = derivedAll.slice(0,candidateLimit);
  const censusExhausted = truth.counts.candidatePopulationExhausted;
  const projectedExhausted = censusExhausted && bounded.length === derivedAll.length;
  const source = proven.length ? 'current-source-proven'
    : observed.length ? 'current-source-declared'
      : derivedAll.length ? 'current-source-derived' : 'structural-only';
  const primary = proven.length ? proven.map(x => x.scope)
    : observed.length ? observed.map(x=>x.name) : coreDerived.length
      ? coreDerived.map(x=>x.name) : derivedAll.map(x=>x.name);
  const coverageNote = truth.exclusions.completeForEligibleSources
    ? 'All eligible source files were analyzed.'
    : 'Source coverage is incomplete; absence and exhaustive conclusions are unavailable.';
  const summary = primary.length
    ? 'Current source understanding of ' + project + ' at ' + String(graph.repositoryRevision)
      + ': ' + truth.counts.provenTechnicalScopes + ' independently proven technical source scope(s), '
      + truth.counts.sourceDeclaredConcepts + ' source-declared semantic concept(s), '
      + truth.counts.supportedInterpretations + ' source-supported interpretation(s). '
      + 'Leading evidence-backed areas: ' + semanticNameList(primary,6) + '. '
      + coverageNote + ' These facts do not establish desired product intent or runtime execution.'
    : 'No currently source-proven technical scopes or semantic declarations were found for '
      + project + '. ' + coverageNote + ' DI must not reuse older acceptance as current truth.';
  const supportingLimit=Math.min(Math.max(limit*2,24),64);
  const derivedLayer = depth === 'nucleus' ? [] : depth === 'exhaustive'
    ? bounded
    : [...coreDerived.filter(x=>bounded.includes(x)),...supportDerived.filter(x=>bounded.includes(x)).slice(0,supportingLimit)];
  const provenLayer = depth === 'nucleus' ? [] : depth === 'exhaustive'
    ? proven : proven.slice(0,supportingLimit);
  const observedLayer = depth === 'nucleus' ? [] : depth === 'exhaustive'
    ? observed : observed.slice(0,supportingLimit);
  const nextDepth = depth === 'nucleus' ? 'expanded'
    : depth === 'expanded' ? 'exhaustive' : null;
  return {
    source, depth, summary,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    analyzerVersion: graph.analyzerVersion,
    authority: {
      source: 'selected-exact-graph',
      durable: false,
      acceptedCount: 0,
      verifiedCount: 0,
      acceptanceImpliesVerification: false,
      previouslyAcceptedMeaningsNotConsulted: true,
      currentProvenTechnicalScopeCount: proven.length,
      currentSourceDeclaredCount: observed.length,
      currentSourceSupportedInterpretationCount: truth.counts.supportedInterpretations,
    },
    ...(proven.length ? { meanings: proven.slice(0,limit) } : {}),
    ...(!proven.length && observed.length ? { concepts: observed.slice(0,limit) } : {}),
    ...(!proven.length && !observed.length && derivedAll.length ? { candidates: (coreDerived.length ? coreDerived : derivedAll).slice(0,limit) } : {}),
    layers: {
      proven: { count: proven.length, returned: provenLayer.length, items: provenLayer,
        authority: 'current-source-proven' },
      observed: { count: observed.length, returned: observedLayer.length, items: observedLayer,
        authority: 'current-source-declared' },
      derived: {
        eligibleCount: derivedAll.length, returned: derivedLayer.length,
        exhausted: projectedExhausted, truncated: !projectedExhausted,
        coreCandidateCount: coreDerived.length,
        coreReturned: derivedLayer.filter(x=>x.coreness==='core-candidate'&&x.factuality==='supported').length,
        supportingCandidateCount: supportDerived.length,
        supportingReturned: derivedLayer.filter(x=>x.coreness!=='core-candidate'||x.factuality!=='supported').length,
        supportingPresentationTruncated: depth === 'expanded' && supportDerived.length > supportingLimit,
        factualityNeedsReview: derivedAll.filter(x=>x.factuality!=='supported').length,
        items: derivedLayer, authority: 'current-source-interpretation-not-product-intent',
      },
      accepted: { count: 0, returned: 0, items: [],
        authority: 'not-a-current-source-evidence-input' },
    },
    completeness: {
      requestedDepth: depth,
      semanticCandidateUniverseExhausted: censusExhausted && depth === 'exhaustive',
      candidateOperationalLimit: 1000,
      eligibleSourceCoverageComplete: truth.exclusions.completeForEligibleSources,
      unsupportedFiles: truth.exclusions.unsupportedFiles,
      claim: depth === 'exhaustive'
        ? (censusExhausted ? 'exhaustive-derived-candidate-census' : 'exhaustive-request-bounded-by-operational-limit')
        : 'non-exhaustive-semantic-answer',
      repositoryOmissionMeansAbsent: false,
      candidateOmissionWithinExhaustedCensusMeansAbsent: depth === 'exhaustive' && censusExhausted,
      expandedCoreCoverageComplete: depth !== 'expanded' ? null : censusExhausted,
      expandedSupportingPresentationComplete: depth !== 'expanded' ? null : supportDerived.length <= supportingLimit,
    },
    expansion: {
      currentDepth: depth, nextDepth,
      availableDepths: ['nucleus','expanded','exhaustive'],
      note: nextDepth
        ? 'The same exact graph can be expanded to ' + nextDepth + ' without consulting prior semantic history.'
        : 'Exhaustive depth enumerates the current qualified candidate census, not product intent.',
    },
    policy: {
      builtOnlyFromSelectedGraph: true,
      historicalAcceptanceNeverInput: true,
      technicalSourceFactsNeedNoManualReview: true,
      sourceDerivedInterpretationDoesNotProveProductIntent: true,
      omissionIsNotAbsenceOutsideDeclaredCompleteScope: true,
      persisted: false,
    },
  };
}

async function semanticLifecycleOverview(project: string): Promise<Record<string, unknown>> {
  const authority = await loadSemanticAuthority(project);
  const latestByMeaning = new Map<string, NonNullable<typeof authority.ledger>['records'][number]['review']>();
  for (const record of authority.ledger?.records ?? []) latestByMeaning.set(record.meaningId, record.review);
  const reviews = [...latestByMeaning.values()];
  const active = reviews.filter(review => !['superseded', 'split', 'merged'].includes(review.state));
  const accepted = active.filter(review => review.accepted);
  const verified = active.filter(review => Boolean(review.verification));
  const humanAccepted = accepted.filter(review => review.acceptance?.actor.kind === 'human');
  const humanVerified = verified.filter(review => review.verification?.actor.kind === 'human');
  const aiVerified = verified.filter(review => review.verification?.actor.kind === 'ai-model');
  const enrollment = authority.ledger?.enrollment ?? null;

  return {
    summary: 'Semantic meaning moves from evidence-backed proposal → shared AI/human review → independent acceptance and/or evidence-backed verification → stable meaning identity across revisions → explicit lineage for replacement, supersession, split, or merge → current-revision approval at the Preview→Main boundary. Acceptance never implies verification, and verification never implies acceptance.',
    stages: [
      {
        stage: 'proposal',
        authority: false,
        description: 'Intrinsic graph evidence can propose feature/capability/surface/domain meaning. A proposal is not accepted authority and requires explicit review.',
      },
      {
        stage: 'review',
        authority: false,
        description: 'AI or human reviewers can amend the same proposal while its original provenance is preserved.',
      },
      {
        stage: 'acceptance',
        authority: true,
        description: 'Acceptance records who accepted the meaning and why. Acceptance is independent from semantic verification; human acceptance can approve the current Preview semantic delta.',
      },
      {
        stage: 'verification',
        authority: false,
        description: 'Verification requires explicit evidence IDs and remains independent from acceptance. A trusted human or delegated agent may verify the factual SEM change itself; that verification can satisfy the Preview promotion gate without becoming semantic acceptance.',
      },
      {
        stage: 'evolution',
        authority: 'evidence-led-current-meaning',
        description: 'A meaning identity may carry forward when current evidence supports continuity, but continuity is not a goal by itself. Changed, unsupported, ambiguous, split, merged, or replaced meaning is handled as a Preview transition rather than forcing yesterday\'s interpretation onto the current revision.',
      },
      {
        stage: 'promotion',
        authority: 'preview-gate',
        description: 'A current-revision human acceptance or explicit current-revision SEM verification may satisfy a promotion item. Verification proves the observed change, not product intent; ambiguous or disputed changes remain directly auditable by SEM ID.',
      },
    ],
    authority: {
      storageState: authority.state,
      durable: authority.durable,
      storedRecords: authority.ledger?.records.length ?? 0,
      latestMeanings: reviews.length,
      activeMeanings: active.length,
      acceptedMeanings: accepted.length,
      verifiedMeanings: verified.length,
      humanAcceptedMeanings: humanAccepted.length,
      humanVerifiedMeanings: humanVerified.length,
      aiVerifiedMeanings: aiVerified.length,
    },
    governance: {
      enrollmentState: enrollment?.state ?? 'not-enrolled',
      baselineRevision: enrollment?.baselineRevision ?? null,
      baselineCandidateCount: enrollment?.baselineCandidateIds.length ?? 0,
      gateCanBlockMain: enrollment?.state === 'enforced',
    },
    policy: {
      sharedHumanAiReviewSurface: true,
      acceptanceImpliesVerification: false,
      verificationImpliesAcceptance: false,
      verificationRequiresEvidence: true,
      proposalProvenancePreserved: true,
      acceptedMeaningCannotBeSilentlyAmended: true,
      lineageRequiredForReplacementSplitMergeSupersession: true,
      promotionApprovalAlternatives: ['human-accepted', 'human-verified', 'ai-verified'],
      previousRevisionApprovalDoesNotApprovePreviewDelta: true,
      projection: 'read-only-explanation',
      persisted: false,
    },
  };
}

function semanticLifecycleAnswer(question: string, overview: Record<string, unknown>): string {
  const lower = question.toLowerCase();
  const authority = (overview.authority ?? {}) as Record<string, unknown>;
  const governance = (overview.governance ?? {}) as Record<string, unknown>;
  const accepted = Number(authority.acceptedMeanings ?? 0);
  const verified = Number(authority.verifiedMeanings ?? 0);
  const enrollmentState = String(governance.enrollmentState ?? 'not-enrolled');
  const baselineRevision = typeof governance.baselineRevision === 'string' ? governance.baselineRevision : null;
  const baselineCandidateCount = Number(governance.baselineCandidateCount ?? 0);

  if (/\b(gate|enroll(?:ed|ment)?|enforc(?:e|ed|ement)?|advisory|block(?:s|ing)? main)\b/u.test(lower)) {
    if (enrollmentState === 'not-enrolled') {
      return `The semantic promotion gate is not enrolled, so it is currently non-blocking. There is no enforced Preview→Main semantic baseline; accepted authority must be established and the gate explicitly enrolled before semantic changes can block Main.`;
    }
    if (enrollmentState === 'advisory') {
      return `The semantic promotion gate is advisory, so it reports semantic deltas but does not block Main. The recorded baseline is ${baselineRevision ?? 'not set'} with ${baselineCandidateCount} baseline candidate(s).`;
    }
    return `The semantic promotion gate is enforced against baseline ${baselineRevision ?? 'unknown'} with ${baselineCandidateCount} baseline candidate(s). In enforced mode, unapproved current-revision semantic deltas can block Main until they are accepted or evidence-verified.`;
  }

  if (/\b(missing|remain(?:s|ing)?|still|before|baseline)\b/u.test(lower)
    && /\b(semantic|accept(?:ed|ance)?|baseline|authority|main)\b/u.test(lower)) {
    if (accepted === 0) {
      return `DI does not yet have an accepted semantic baseline: there are 0 accepted active meanings and ${verified} verified active meaning(s), and gate enrollment is ${enrollmentState}. Establish accepted semantic authority first, then explicitly record/enforce a baseline revision for Preview→Main governance.`;
    }
    if (!baselineRevision) {
      return `DI has ${accepted} accepted active semantic meaning(s), but no baseline revision is recorded and gate enrollment is ${enrollmentState}. The remaining governance step is to explicitly enroll the promotion gate against the accepted Main baseline.`;
    }
    return `DI has ${accepted} accepted active semantic meaning(s) and a recorded baseline at ${baselineRevision}. Gate enrollment is ${enrollmentState}; current Preview deltas still require revision-specific approval whenever enforcement is active.`;
  }

  return String(overview.summary ?? 'Semantic lifecycle explanation complete.');
}

function repositoryAuditAnswer(result: Record<string, any>): string {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const blockers = Array.isArray(result.coverageBlockers) ? result.coverageBlockers : [];
  const targets = Array.isArray(result.investigationTargets) ? result.investigationTargets : [];
  if (findings.length === 0 && blockers.length === 0) {
    return targets.length
      ? `No deterministic repository defects or coverage blockers were found on the pinned revision. DI did surface ${targets.length} investigation target(s); those are evidence-backed areas worth inspecting, not proven defects.`
      : 'No deterministic repository defects or coverage blockers were found on the pinned revision.';
  }
  const summaries = findings
    .slice(0, 3)
    .map((item: any) => String(item.summary ?? item.message ?? '').trim())
    .filter(Boolean);
  const detail = summaries.length ? ` Leading findings: ${summaries.join(' ')}` : '';
  return `Repository audit found ${findings.length} deterministic finding(s) and ${blockers.length} coverage blocker(s) on the pinned revision.${detail}`;
}

// Per-investigation, revision-pinned orientation work. Never shared globally:
 // batches can resolve distinct graph snapshots even for the same project.
type OrientationQueryReuse = {
  graph: IntelligenceGraph;
  byId?: Map<string, GraphNode>;
  incidentByNode?: Map<string, GraphEdge[]>;
  metrics?: Map<string, ReturnType<typeof orientationMetric>>;
  rankBy?: ScopeRankBy;
  semanticCensus?: ReturnType<typeof bootstrapSemanticCandidates>;
  currentSemanticTruth?: ReturnType<typeof deriveCurrentSemanticTruth>;
};

export async function scopeOrientation(input: {
  project: string;
  scope?: string | undefined;
  ref?: string | undefined;
  graphId?: string | undefined;
  rankBy?: ScopeRankBy | undefined;
  semanticDepth?: SemanticQueryDepth | undefined;
  limit?: number | undefined;
  orientationReuse?: OrientationQueryReuse | undefined;
}): Promise<Record<string, unknown>> {
  // Reuse is valid only for an exact graph identity selected by the caller.
  // A ref selector needs fresh resolution: never infer ref equivalence from
  // project identity or carry indexes from an unrelated graph snapshot.
  const candidateReuse = input.orientationReuse;
  const reusable = candidateReuse && candidateReuse.graph.project === input.project
    && !input.ref
    && input.graphId === candidateReuse.graph.graphId
    ? candidateReuse : undefined;
  const graph = reusable?.graph ?? await currentGraph(input.project, input.ref, input.graphId);
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

  const byId = reusable?.byId ?? new Map(graph.nodes.map(node => [node.id, node]));
  if (reusable) reusable.byId = byId;
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
  let incidentByNode = reusable?.incidentByNode;
  if (!incidentByNode) {
    incidentByNode = new Map<string, GraphEdge[]>();
    for (const edge of graph.edges) {
      if (edge.from) {
        const current = incidentByNode.get(edge.from) ?? [];
        current.push(edge);
        incidentByNode.set(edge.from, current);
      }
      if (edge.to && edge.to !== edge.from) {
        const current = incidentByNode.get(edge.to) ?? [];
        current.push(edge);
        incidentByNode.set(edge.to, current);
      }
    }
    if (reusable) reusable.incidentByNode = incidentByNode;
  }

  // The ranked list and role summaries inspect the same scoped nodes at the
  // same graph revision/rank criterion. Reuse metrics per node within this
  // single orientation, never across revisions or distinct graph contexts.
  if (reusable && reusable.rankBy !== rankBy) {
    delete reusable.metrics;
    reusable.rankBy = rankBy;
  }
  const metricCache = reusable?.metrics ?? new Map<string, ReturnType<typeof orientationMetric>>();
  if (reusable) reusable.metrics = metricCache;
  const scopedMetrics = (node: GraphNode): ReturnType<typeof orientationMetric> => {
    const existing = metricCache.get(node.id);
    if (existing) return existing;
    const calculated = orientationMetric(node, byId, incidentByNode.get(node.id) ?? [], rankBy);
    metricCache.set(node.id, calculated);
    return calculated;
  };

  const preferredKinds = new Set(['feature','capability','route','api','mcp','provider','file','function','method','class','interface','constructor']);
  const ranked = nodes
    .map(node => ({ node, metrics: scopedMetrics(node) }))
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
  const boundarySummaries: OrientationBoundarySummary[] = boundary.map(edge => {
    const outbound = scopedSet.has(edge.from!);
    const externalId = outbound ? edge.to! : edge.from!;
    const external = byId.get(externalId);
    return {
      edgeId: edge.id,
      direction: outbound ? ('outbound' as const) : ('inbound' as const),
      kind: edge.kind,
      external: { id: externalId, name: displayName(external, externalId), kind: external?.kind ?? 'unknown', locator: external?.locator ?? null },
    };
  });

  const roleOrder: OrientationRole[] = ['semantic', 'interface', 'implementation', 'effects', 'integration', 'representation', 'structural'];
  const roleGroups = roleOrder.flatMap(role => {
    const members = nodes.filter(node => orientationRole(node) === role);
    if (!members.length) return [];
    const sorted = members
      .map(node => ({ node, metrics: scopedMetrics(node) }))
      .sort((a, b) =>
        b.metrics.rankValue - a.metrics.rankValue
        || b.metrics.relationshipDiversity - a.metrics.relationshipDiversity
        || displayName(a.node).localeCompare(displayName(b.node)));
    return [{
      role,
      count: members.length,
      entities: sorted.slice(0, Math.min(limit, 8)).map(({ node, metrics }) => ({
        id: node.id,
        name: displayName(node),
        kind: node.kind,
        layer: node.layer ?? 'structural',
        locator: node.locator,
        metrics,
      })),
      evidenceNodeIds: members.map(node => node.id).sort().slice(0, 100),
    }];
  });
  const dependencies = {
    outbound: orientationDependencies(boundarySummaries, 'outbound', Math.min(limit, 12)),
    inbound: orientationDependencies(boundarySummaries, 'inbound', Math.min(limit, 12)),
  };
  const responsibilities = roleGroups
    .filter(group => group.role !== 'structural' || roleGroups.length === 1)
    .slice(0, 6)
    .map(group => ({
      kind: group.role,
      statement: orientationRoleStatement(group.role, group.count, group.entities.map(item => item.name)),
      evidenceNodeIds: [...group.evidenceNodeIds],
    }));
  if (dependencies.outbound.length) {
    const edgeIds = dependencies.outbound.flatMap(item => item.edgeIds);
    responsibilities.push({
      kind: 'outbound-dependencies' as any,
      statement: `Depends outward on ${dependencies.outbound.length} observed external target(s) through ${new Set(dependencies.outbound.flatMap(item => item.relationshipKinds)).size} resolved relationship kind(s).`,
      evidenceNodeIds: dependencies.outbound.map(item => item.external.id),
      evidenceEdgeIds: [...new Set(edgeIds)].sort(),
    } as any);
  }
  if (dependencies.inbound.length) {
    const edgeIds = dependencies.inbound.flatMap(item => item.edgeIds);
    responsibilities.push({
      kind: 'inbound-dependents' as any,
      statement: `Receives ${dependencies.inbound.length} observed external dependent/source target(s) through ${new Set(dependencies.inbound.flatMap(item => item.relationshipKinds)).size} resolved relationship kind(s).`,
      evidenceNodeIds: dependencies.inbound.map(item => item.external.id),
      evidenceEdgeIds: [...new Set(edgeIds)].sort(),
    } as any);
  }

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

  const semanticUnderstanding = selected.kind === 'repository'
    ? await repositorySemanticUnderstanding(input.project, graph, Math.min(limit, 12), input.semanticDepth ?? 'nucleus', reusable)
    : null;

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
    summary: semanticUnderstanding
      ? String(semanticUnderstanding.summary)
      : responsibilities.length
        ? responsibilities.slice(0, 3).map(item => item.statement).join(' ')
        : String(nodes.length) + ' graph entities are in the selected ' + selected.kind + ' scope; no stronger bounded responsibility synthesis was available.',
    semanticUnderstanding,
    responsibilities,
    roleGroups,
    dependencies,
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
      responsibilitySynthesis: 'observed-role-groups',
      dependencyAggregation: 'resolved-boundary-edges',
      summaryInfersProductIntent: false,
      persisted: false,
      note: 'Orientation ranks and synthesizes observed graph facets only. It does not assign architectural quality, severity, product priority, or product intent.',
    },
  };
}


const INTERFACE_SURFACE_KINDS = new Set(['surface', 'route', 'ui-element']);
const INTERFACE_STATE_KINDS = new Set(['state-binding', 'state-write']);
const INTERFACE_INTERACTION_KINDS = new Set(['ui-element', 'component-prop-handler', 'component-prop-binding']);
const INTERFACE_TRANSITION_KINDS = new Set(['navigation-call', 'route-reference', 'route']);
const INTERFACE_EFFECT_KINDS = new Set(['http-call', 'rpc-call', 'sql-reference', 'mcp-tool']);
const INTERFACE_REPRESENTATION_KINDS = new Set(['css-class-reference', 'css-selector', 'css-at-rule', 'css-custom-property']);
const INTERACTION_MECHANISM_NODE_KINDS = new Set(['component-prop-binding', 'component-prop-handler']);
const DIRECT_CONSEQUENCE_KINDS = new Set(['state-write', 'navigation-call', 'http-call', 'rpc-call']);
const INTERACTION_FAMILY_ORDER = ['pointer', 'drop', 'drag', 'scroll', 'click', 'focus', 'keyboard', 'input', 'submit', 'context-menu', 'touch', 'mouse'] as const;
type InteractionFamily = typeof INTERACTION_FAMILY_ORDER[number];

function interactionFamily(prop: string): InteractionFamily | null {
  if (/^on(?:Stage)?Pointer[A-Z]/u.test(prop)) return 'pointer';
  if (prop === 'onDrop') return 'drop';
  if (/^onDrag[A-Z]?/u.test(prop)) return 'drag';
  if (/^onScroll[A-Z]?/u.test(prop)) return 'scroll';
  if (/^on(?:Double)?Click$/u.test(prop)) return 'click';
  if (prop === 'onFocus' || prop === 'onBlur') return 'focus';
  if (/^onKey[A-Z]/u.test(prop)) return 'keyboard';
  if (['onChange', 'onInput', 'onBeforeInput'].includes(prop) || /^on[A-Za-z0-9]*Change$/u.test(prop)) return 'input';
  if (prop === 'onSubmit') return 'submit';
  if (prop === 'onContextMenu') return 'context-menu';
  if (/^onTouch[A-Z]/u.test(prop)) return 'touch';
  if (/^onMouse[A-Z]/u.test(prop)) return 'mouse';
  return null;
}

function objectValue(node: GraphNode): Record<string, unknown> {
  return node.value && typeof node.value === 'object' && !Array.isArray(node.value)
    ? node.value as Record<string, unknown>
    : {};
}

interface InterfaceProjectionItem {
  id: string;
  name: string;
  kind: string;
  layer: string;
  locator: string;
  sourceFile: string | null;
  value: unknown;
  resolvedRelationshipCount: number;
  links: Array<{
    edgeId: string;
    kind: string;
    direction: 'outbound' | 'inbound';
    neighbor: { id: string; name: string; kind: string; locator: string | null } | null;
  }>;
  projectionRole?: 'surface' | 'surface-owner';
}

function interfaceProjectionItem(
  node: GraphNode,
  byId: Map<string, GraphNode>,
  incident: GraphEdge[],
): InterfaceProjectionItem {
  const resolved = incident.filter(edge => edge.status === 'resolved');
  const links: InterfaceProjectionItem['links'] = resolved.slice(0, 8).map(edge => {
    const outbound = edge.from === node.id;
    const neighborId = outbound ? edge.to : edge.from;
    const neighbor = neighborId ? byId.get(neighborId) : undefined;
    return {
      edgeId: edge.id,
      kind: edge.kind,
      direction: outbound ? 'outbound' : 'inbound',
      neighbor: neighborId ? {
        id: neighborId,
        name: displayName(neighbor, neighborId),
        kind: neighbor?.kind ?? 'unknown',
        locator: neighbor?.locator ?? null,
      } : null,
    };
  });
  return {
    id: node.id,
    name: displayName(node),
    kind: node.kind,
    layer: node.layer ?? 'structural',
    locator: node.locator,
    sourceFile: sourceFile(node.locator),
    value: node.value ?? null,
    resolvedRelationshipCount: resolved.length,
    links,
  };
}

export async function interfaceProjection(input: {
  project: string;
  scope?: string | undefined;
  ref?: string | undefined;
  graphId?: string | undefined;
  limit?: number | undefined;
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const selected = scopeNodeIds(graph, input.scope);

  if (selected.kind === 'ambiguous') {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: true,
      scope: { kind: selected.kind, value: selected.value },
      candidates: selected.candidates.slice(0, 10).map(node => ({
        id: node.id,
        name: displayName(node),
        kind: node.kind,
        layer: node.layer ?? 'structural',
        locator: node.locator,
      })),
      policy: { deterministic: true, persisted: false, semanticAuthority: false },
    };
  }
  if (selected.kind === 'missing') {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: false,
      scope: { kind: selected.kind, value: selected.value },
      summary: 'No graph scope matching "' + String(selected.value) + '" was observed.',
      surfaces: [],
      state: [],
      interactions: [],
      interactionMechanisms: { total: 0, families: [] },
      transitions: [],
      effects: [],
      representation: [],
      runtimeObservationContract: interfaceRuntimeObservationContract(),
      coverage: compactCoverage(graph),
      policy: { deterministic: true, persisted: false, semanticAuthority: false },
    };
  }

  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  let scopedIds = selected.ids;
  if (selected.kind === 'entity' && selected.entity) {
    scopedIds = new Set([selected.entity.id]);
    let frontier = [selected.entity.id];
    for (let depth = 0; depth < 2 && frontier.length && scopedIds.size < 500; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of graph.edges) {
          if (edge.status !== 'resolved' || (edge.from !== id && edge.to !== id)) continue;
          const neighbor = edge.from === id ? edge.to : edge.from;
          if (neighbor && !scopedIds.has(neighbor) && scopedIds.size < 500) {
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
  const touchingEdges: GraphEdge[] = [];
  for (const edge of graph.edges) {
    const touches = Boolean((edge.from && scopedSet.has(edge.from)) || (edge.to && scopedSet.has(edge.to)));
    if (!touches) continue;
    touchingEdges.push(edge);
    for (const endpoint of [edge.from, edge.to]) {
      if (!endpoint) continue;
      const current = incidentByNode.get(endpoint) ?? [];
      current.push(edge);
      incidentByNode.set(endpoint, current);
    }
  }

  const projectionCandidates = new Map(nodes.map(node => [node.id, node]));
  for (const edge of touchingEdges) {
    if (edge.status !== 'resolved') continue;
    for (const endpoint of [edge.from, edge.to]) {
      if (!endpoint || projectionCandidates.has(endpoint)) continue;
      const node = byId.get(endpoint);
      if (node) projectionCandidates.set(endpoint, node);
    }
  }

  const projectNodes = (kinds: Set<string>) => [...projectionCandidates.values()]
    .filter(node => kinds.has(node.kind))
    .sort((a, b) =>
      (incidentByNode.get(b.id)?.filter(edge => edge.status === 'resolved').length ?? 0)
      - (incidentByNode.get(a.id)?.filter(edge => edge.status === 'resolved').length ?? 0)
      || displayName(a).localeCompare(displayName(b)))
    .slice(0, limit)
    .map(node => interfaceProjectionItem(node, byId, incidentByNode.get(node.id) ?? []));

  const explicitSurfaces = projectNodes(INTERFACE_SURFACE_KINDS).map(item => ({ ...item, projectionRole: 'surface' }));
  const interfaceEvidenceKinds = new Set([
    ...INTERFACE_INTERACTION_KINDS,
    ...INTERFACE_STATE_KINDS,
    ...INTERFACE_TRANSITION_KINDS,
    ...INTERFACE_EFFECT_KINDS,
  ]);
  const surfaceOwners = nodes
    .filter(node => ['function', 'method', 'class', 'interface', 'file'].includes(node.kind))
    .filter(node => /\.(?:tsx|jsx)$/iu.test(sourceFile(node.locator) ?? ''))
    .filter(node => (incidentByNode.get(node.id) ?? []).some(edge => {
      if (edge.status !== 'resolved') return false;
      const neighborId = edge.from === node.id ? edge.to : edge.from;
      const neighbor = neighborId ? byId.get(neighborId) : undefined;
      return Boolean(neighbor && interfaceEvidenceKinds.has(neighbor.kind));
    }))
    .sort((a, b) =>
      (incidentByNode.get(b.id)?.filter(edge => edge.status === 'resolved').length ?? 0)
      - (incidentByNode.get(a.id)?.filter(edge => edge.status === 'resolved').length ?? 0)
      || displayName(a).localeCompare(displayName(b)))
    .slice(0, limit)
    .map(node => ({
      ...interfaceProjectionItem(node, byId, incidentByNode.get(node.id) ?? []),
      projectionRole: 'surface-owner',
    }));
  const surfaces = [...explicitSurfaces, ...surfaceOwners]
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
    .slice(0, limit);
  const state = projectNodes(INTERFACE_STATE_KINDS);
  const interactions = projectNodes(INTERFACE_INTERACTION_KINDS);
  const transitions = projectNodes(INTERFACE_TRANSITION_KINDS);
  const effects = projectNodes(INTERFACE_EFFECT_KINDS);
  const representation = projectNodes(INTERFACE_REPRESENTATION_KINDS);

  const mechanismItems = [...projectionCandidates.values()]
    .filter(node => INTERACTION_MECHANISM_NODE_KINDS.has(node.kind))
    .map(node => {
      const value = objectValue(node);
      const prop = typeof value.prop === 'string' ? value.prop : null;
      if (!prop) return null;
      const family = interactionFamily(prop);
      if (!family) return null;
      const component = typeof value.component === 'string' ? value.component : null;
      const declaredHandler = typeof value.handler === 'string' ? value.handler : null;
      const handlerEdge = (incidentByNode.get(node.id) ?? []).find(edge =>
        edge.status === 'resolved' && edge.from === node.id && edge.kind === 'binds_to' && Boolean(edge.to));
      const handlerNode = handlerEdge?.to ? byId.get(handlerEdge.to) : undefined;
      const directConsequences = handlerNode ? graph.edges
        .filter(edge =>
          edge.status === 'resolved'
          && edge.from === handlerNode.id
          && edge.kind === 'invokes'
          && Boolean(edge.to)
          && DIRECT_CONSEQUENCE_KINDS.has(byId.get(edge.to!)?.kind ?? ''))
        .slice(0, 20)
        .map(edge => {
          const consequence = byId.get(edge.to!);
          return {
            edgeId: edge.id,
            relationshipKind: edge.kind,
            id: consequence!.id,
            kind: consequence!.kind,
            name: displayName(consequence!),
            locator: consequence!.locator,
            value: consequence!.value ?? null,
            evidence: edge.evidence ?? [],
            proof: 'resolved-handler-direct-edge',
          };
        }) : [];
      return {
        id: node.id,
        family,
        component,
        prop,
        declaredHandler,
        resolvedHandler: handlerNode ? {
          id: handlerNode.id,
          name: displayName(handlerNode),
          kind: handlerNode.kind,
          locator: handlerNode.locator,
        } : null,
        directConsequences,
        evidence: {
          nodeId: node.id,
          nodeKind: node.kind,
          locator: node.locator,
          sourceFile: sourceFile(node.locator),
          plane: 'source',
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) =>
      INTERACTION_FAMILY_ORDER.indexOf(a.family) - INTERACTION_FAMILY_ORDER.indexOf(b.family)
      || String(a.component ?? '').localeCompare(String(b.component ?? ''))
      || a.prop.localeCompare(b.prop)
      || a.id.localeCompare(b.id));
  const mechanismSampleLimit = Math.min(limit, 20);
  const resolvedHandlerCount = mechanismItems.filter(item => item.resolvedHandler).length;
  const directConsequenceMechanismCount = mechanismItems.filter(item => item.directConsequences.length > 0).length;
  const directConsequenceCount = mechanismItems.reduce((sum, item) => sum + item.directConsequences.length, 0);
  const interactionMechanisms = {
    total: mechanismItems.length,
    resolvedHandlerCount,
    unresolvedHandlerCount: mechanismItems.length - resolvedHandlerCount,
    directConsequenceMechanismCount,
    directConsequenceCount,
    families: INTERACTION_FAMILY_ORDER
      .map(family => {
        const familyItems = mechanismItems.filter(item => item.family === family);
        return {
          family,
          count: familyItems.length,
          items: familyItems.slice(0, mechanismSampleLimit),
        };
      })
      .filter(group => group.count > 0),
    policy: {
      sourceObservedOnly: true,
      declaredHandlerIsNotResolvedHandler: true,
      runtimeOccurrenceProven: false,
      stateEffectsInferred: false,
      directConsequencesRequireResolvedHandler: true,
      directConsequencesRequireResolvedInvokesEdge: true,
    },
  };

  const uncertaintyEdges = touchingEdges.filter(edge => edge.status !== 'resolved');
  const runtimeSources = graph.sources.filter(isInterfaceRuntimeObservationSource);
  const observedKinds = new Set(nodes.map(node => node.kind));
  const unknowns: string[] = [];
  if (!runtimeSources.length) {
    unknowns.push('Rendered visibility, geometry, stacking, scroll ownership, pointer/focus ownership, and actual runtime state transitions are not proven by source-only evidence.');
  }
  if (!state.length) unknowns.push('No source-derived state binding/write nodes were observed in this scope.');
  if (!representation.length) unknowns.push('No CSS representation nodes were observed in this scope; layout/visibility behavior may require source or runtime inspection.');

  const combined = [...surfaces, ...state, ...interactions, ...transitions, ...effects]
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
    .sort((a: any, b: any) => Number(b.resolvedRelationshipCount ?? 0) - Number(a.resolvedRelationshipCount ?? 0));

  return {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    ambiguous: false,
    scope: {
      kind: selected.kind,
      value: selected.value,
      nodeCount: nodes.length,
      neighborhoodDepth: selected.kind === 'entity' ? 2 : 0,
    },
    summary: [
      surfaces.length ? String(surfaces.length) + ' surface/route item(s)' : 'no surface/route items',
      state.length ? String(state.length) + ' state item(s)' : 'no state items',
      interactions.length ? String(interactions.length) + ' interaction item(s)' : 'no interaction items',
      mechanismItems.length ? String(mechanismItems.length) + ' source-observed interaction mechanism(s)' : 'no classified interaction mechanisms',
      transitions.length ? String(transitions.length) + ' transition item(s)' : 'no transition items',
      effects.length ? String(effects.length) + ' external/persistence effect item(s)' : 'no external/persistence effects',
    ].join('; ') + ' observed in the selected scope.',
    capabilities: {
      surfaces: surfaces.length > 0,
      state: state.length > 0,
      interactions: interactions.length > 0,
      interactionMechanisms: mechanismItems.length > 0,
      transitions: transitions.length > 0,
      effects: effects.length > 0,
      representation: representation.length > 0,
      runtimeObservations: runtimeSources.length > 0,
    },
    surfaces,
    state,
    interactions,
    interactionMechanisms,
    transitions,
    effects,
    representation,
    runtimeObservationContract: interfaceRuntimeObservationContract(),
    runtimeObservations: {
      available: runtimeSources.length > 0,
      sources: runtimeSources.map(source => ({
        id: source.id,
        kind: source.kind,
        locator: source.locator,
        revision: source.revision,
        observedAt: source.observedAt,
        available: source.available,
      })),
    },
    uncertainty: {
      candidateEdges: uncertaintyEdges.filter(edge => edge.status === 'candidate').length,
      unresolvedEdges: uncertaintyEdges.filter(edge => edge.status === 'unresolved').length,
      examples: uncertaintyEdges.slice(0, Math.min(limit, 12)).map(edge => ({
        edgeId: edge.id,
        kind: edge.kind,
        status: edge.status,
        from: edge.from,
        to: edge.to,
      })),
      unknowns,
    },
    nextInspections: combined.slice(0, Math.min(8, limit)).map((item: any) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      locator: item.locator,
      reason: String(item.resolvedRelationshipCount ?? 0) + ' resolved relationship(s) in the interface projection.',
    })),
    coverage: compactCoverage(graph),
    policy: {
      deterministic: true,
      evidenceLinked: true,
      persisted: false,
      semanticAuthority: false,
      runtimeClaimsRequireObservation: true,
      note: 'This is a derived interface/interaction view over the canonical graph. It does not create UI truth, semantic product intent, or runtime state.',
    },
    observedNodeKinds: [...observedKinds].sort(),
  };
}

function querySubject(text: string, markers: RegExp[]): string {
  let value = text.trim();
  for (const marker of markers) value = value.replace(marker, ' ');
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^[?!.,;]+|[?!.,;]+$/gu, '')
    .trim();
}

function normalizedMention(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_./:@-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function plainMention(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

type RequestedEntityRole = 'implementation' | 'import' | 'callable' | null;

function requestedEntityRole(text: string): RequestedEntityRole {
  const lower = text.toLowerCase();
  if (/\b(imported|import(?:s|ing)? binding|import statement)\b/u.test(lower)) return 'import';
  if (/\b(implemented|implementation|defined|definition|declaration)\b/u.test(lower)) return 'implementation';
  if (/\b(callers?|callees?|called by|calls?)\b/u.test(lower)) return 'callable';
  return null;
}

function isExactSymbolQuestion(query: string): boolean {
  // Case is not evidence of identity: a lowercase symbol is just as exact as an uppercase one.
  // Exclude deictic/generic requests, whose meaning depends on context rather than identifier spelling.
  return /^[A-Za-z_$][\w$]*$/u.test(query)
    && !GENERIC_SUBJECT_NAMES.has(plainMention(query))
    && !['it', 'this', 'that', 'these', 'those', 'me', 'you', 'we', 'us'].includes(query.toLowerCase());
}

function compatibleEntityRole(node: GraphNode, role: RequestedEntityRole): boolean {
  if (!role) return true;
  if (role === 'import') return node.kind === 'import-binding';
  if (role === 'callable') return node.id.startsWith('symbol:') && ['function', 'method'].includes(node.kind);
  return node.id.startsWith('symbol:') && ['function', 'method', 'class', 'variable', 'interface', 'type'].includes(node.kind);
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
  const raw = [...text.matchAll(/(?:^|[\s("'`])((?:\.{0,2}\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+|Dockerfile(?:\.[A-Za-z0-9_.-]+)?|\.env(?:\.[A-Za-z0-9_.-]+)?)(?=$|[\s)"'`,?])/gu)]
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
  const operationalPath = /(?:^|\/)(?:Dockerfile(?:\.[A-Za-z0-9_.-]+)?|action\.ya?ml|[^/]+\.ya?ml|\.env\.(?:example|sample)|\.(?:git|docker)ignore)$/u.test(normalized);
  const sourceFactQuestion = /\b(?:version|configure|configured|configuration|setting|value|variable|image|trigger|job|step|input|output|ignore|ignored|uses?|declares?)\b/iu.test(text);
  if (!coverage || (!['unsupported', 'skipped', 'partial'].includes(coverage.status) && !(operationalPath && sourceFactQuestion))) return null;
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

type InvestigationTargetMode =
  | 'external-source'
  | 'repository'
  | 'source-keywords'
  | 'scope'
  | 'entity'
  | 'query'
  | 'scope-required';

interface InvestigationTargetResolution {
  strategy: InvestigationQuestionSubjectStrategy;
  mode: InvestigationTargetMode;
  query: string | null;
  scope: string | null;
  node: GraphNode | null;
  ambiguous: boolean;
  candidates: GraphNode[];
  exactUnresolved?: boolean;
  implicitOnly?: boolean;
}

function subjectMarkersForLane(lane: InvestigationQuestionLane): RegExp[] {
  switch (lane) {
    case 'parity':
      return [/\b(show|find|inspect|query|parity|for|of|what|is|the)\b/gi];
    case 'code':
      return [/\b(show|show me|find|search|code|source|implementation|implemented|for|of|where|is|the)\b/gi];
    case 'implementation-claim':
      return [/\b(where|what|which|how|does|do|is|are|write|writes|writing|mutate|mutates|mutation|persist|persists|persistence|back|into|the|an|a)\b/gi];
    case 'interface':
      return [/\b(what|which|show|find|explain|interface|interaction|interactive|ui|state|owners?|controls?|changes?|when|handlers?|click|drag|drop|scroll|pointer|overlay|navigation|surfaces?|major|in|of|for|the|this|page|feature|workspace)\b/gi];
    case 'orientation':
      return [/\b(what|which|show|find|main|major|moving parts|wide view|around|important|most connected|call hubs?|orientation|orient|functions?|dependencies|does|do|uses|use|rely on|under|in|the|this|page|file|module|feature|area)\b/gi];
    case 'trace':
      return [/\b(what|which|show|find|how|is|are|does|do|depend(?:s)? on|dependency|dependencies|used by|uses|callers?|called by|calls?|constructs?|consumers?|connect(?:ed|s|ion)?|relationships?|related|exposed|exposes|through|route|of|for|to|on|the|an|a)\b/gi];
    case 'evidence':
      return [/\b(what|which|show|find|inspect|evidence|supports?|supporting|audit|assess|finding|findings|problem|problems|risk|risks|realiz\w*|capability|proof|prove|for|of|is|are|does|do|the|exists?|existence|whether|and|also|it|this|that)\b/gi];
    case 'entity':
      return [/^\s*(what is|what's|show me|show|find|where is|inspect|tell me about)\s+/i];
    default:
      return [];
  }
}

function explicitInvestigationScope(text: string): string | null {
  const pathMatch = text.match(/\b(?:src|tests|docs|scripts|app|lib|packages?)\/[A-Za-z0-9_./@-]+/u);
  return pathMatch?.[0] ?? null;
}

async function resolveInvestigationSubject(
  input: { project: string; ref?: string | undefined; graphId?: string | undefined; scope?: string | undefined },
  text: string,
  markers: RegExp[],
): Promise<{ query: string | null; node: GraphNode | null; ambiguous: boolean; candidates: GraphNode[]; exactUnresolved?: boolean; implicitOnly?: boolean }> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const scoped = input.scope ? scopeNodeIds(graph, input.scope) : null;
  const scopeIds = scoped && (scoped.kind === 'file' || scoped.kind === 'path' || scoped.kind === 'entity') ? scoped.ids : null;
  const inScope = (nodes: GraphNode[]) => scopeIds ? nodes.filter(node => scopeIds.has(node.id)) : nodes;

  if (scoped?.kind === 'file' && /\b(file|module|owner|owns|ownership|persistence owner)\b/iu.test(text)) {
    const fileNode = graph.nodes.find(node => scopeIds?.has(node.id) && node.kind === 'file');
    if (fileNode) return { query: scoped.value, node: fileNode, ambiguous: false, candidates: [fileNode] };
  }

  const cleaned = querySubject(text, markers);
  const role = requestedEntityRole(text);
  if (cleaned) {
    const direct = inScope(findGraphNodeCandidates(graph, cleaned, 100)).filter(node => {
      const name = plainMention(node.name ?? '');
      return !GENERIC_SUBJECT_NAMES.has(name) || plainMention(cleaned) === name;
    });
    const exact = direct.filter(node => node.id === cleaned || normalizedMention(node.name ?? '') === normalizedMention(cleaned));
    const compatible = exact.filter(node => node.id === cleaned || compatibleEntityRole(node, role));
    if (compatible.length === 1) return { query: cleaned, node: compatible[0]!, ambiguous: false, candidates: compatible };
    if (compatible.length > 1) {
      if (!role) {
        // A real declaration is stronger identity evidence than another file's import of it.
        const definitions = compatible.filter(node => node.id.startsWith('symbol:')
          && ['function', 'method', 'class', 'variable', 'interface', 'type'].includes(node.kind));
        if (definitions.length === 1) {
          return { query: cleaned, node: definitions[0]!, ambiguous: false, candidates: [definitions[0]!] };
        }
        if (definitions.length > 1) {
          return { query: cleaned, node: null, ambiguous: true, candidates: definitions };
        }
        // Preserve existing unqualified exact-name behavior for non-declaration observations.
        return { query: cleaned, node: compatible[0]!, ambiguous: false, candidates: [compatible[0]!] };
      }
      return { query: cleaned, node: null, ambiguous: true, candidates: compatible };
    }
    if (exact.length && role) return { query: cleaned, node: null, ambiguous: true, candidates: exact };
    // An explicit symbol must not silently resolve to a different semantic concept.
    if (isExactSymbolQuestion(cleaned)) {
      return { query: cleaned, node: null, ambiguous: false, candidates: direct.slice(0, 10), exactUnresolved: true };
    }
    const suitable = direct.filter(node => compatibleEntityRole(node, role));
    if (suitable.length === 1) return { query: cleaned, node: null, ambiguous: false, candidates: suitable, implicitOnly: true };
  }

  const haystack = normalizedMention(text);
  const mentions = inScope(graph.nodes).filter(node => compatibleEntityRole(node, role))
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
  // A substring mentioned in a question is a navigation suggestion, not an
  // identity proof. Only the exact ID/name branch above may resolve the subject.
  // Otherwise generic nouns inside failure/relationship questions could become
  // falsely asserted implementation owners.
  const bestScore = mentions[0]!.score;
  const suggestions = mentions.filter(item => item.score === bestScore).slice(0, 10).map(item => item.node);
  return { query: cleaned || null, node: null, ambiguous: false, candidates: suggestions, implicitOnly: true };
}

async function resolveInvestigationTarget(
  input: { project: string; ref?: string | undefined; graphId?: string | undefined; scope?: string | undefined },
  text: string,
  plan: InvestigationQuestionPlan,
): Promise<InvestigationTargetResolution> {
  const base = {
    strategy: plan.subjectStrategy,
    query: null,
    scope: null,
    node: null,
    ambiguous: false,
    candidates: [] as GraphNode[],
  };

  if (plan.subjectStrategy === 'external-source') return { ...base, mode: 'external-source' };
  if (plan.subjectStrategy === 'repository') return { ...base, mode: 'repository' };
  if (plan.subjectStrategy === 'source-keyword-evidence') return { ...base, mode: 'source-keywords' };

  if (plan.subjectStrategy === 'scope-or-entity') {
    const explicitScope = input.scope?.trim() || explicitInvestigationScope(text);
    if (explicitScope) return { ...base, mode: 'scope', scope: explicitScope, query: explicitScope };

    const repositoryDeictic = plan.lane === 'orientation'
      && /\b(?:this|the)\s+(?:project|repository|repo|codebase)(?:['’]s)?\b/iu.test(text);
    if (repositoryDeictic) return { ...base, mode: 'repository' };

    const scopeRequired = plan.lane === 'interface'
      ? /\b(this page|this feature|this workspace|this panel|this screen)\b/iu.test(text)
      : /\b(this page|this file|this module|this feature|this area)\b/iu.test(text);
    if (scopeRequired) return { ...base, mode: 'scope-required', query: null };

    const resolved = await resolveInvestigationSubject(input, text, subjectMarkersForLane(plan.lane));
    if (resolved.node) {
      return {
        strategy: plan.subjectStrategy,
        mode: 'entity',
        query: resolved.query,
        scope: resolved.node.id,
        node: resolved.node,
        ambiguous: false,
        candidates: resolved.candidates,
      };
    }
    if (resolved.exactUnresolved) {
      return { ...base, mode: 'query', query: resolved.query, exactUnresolved: true, candidates: resolved.candidates };
    }
    if (resolved.ambiguous) {
      return {
        strategy: plan.subjectStrategy,
        mode: 'query',
        query: resolved.query,
        scope: null,
        node: null,
        ambiguous: true,
        candidates: resolved.candidates,
      };
    }

    return { ...base, mode: 'repository', query: resolved.query };
  }

  const resolved = await resolveInvestigationSubject(input, text, subjectMarkersForLane(plan.lane));
  return {
    strategy: plan.subjectStrategy,
    mode: resolved.node ? 'entity' : 'query',
    query: resolved.query,
    scope: resolved.node?.id ?? null,
    node: resolved.node,
    ambiguous: resolved.ambiguous,
    candidates: resolved.candidates,
    ...(resolved.exactUnresolved ? { exactUnresolved: true } : {}),
    ...(resolved.implicitOnly ? { implicitOnly: true } : {}),
  };
}

function targetResolutionForRouting(target: InvestigationTargetResolution): Record<string, unknown> {
  return {
    strategy: target.strategy,
    mode: target.mode,
    query: target.query,
    scope: target.scope,
    ambiguous: target.ambiguous,
    exactUnresolved: target.exactUnresolved === true,
    implicitOnly: target.implicitOnly === true,
    node: target.node
      ? {
          id: target.node.id,
          name: displayName(target.node),
          kind: target.node.kind,
          layer: target.node.layer ?? 'structural',
          locator: target.node.locator,
        }
      : null,
    candidates: target.candidates.slice(0, 10).map(item => ({
      id: item.id,
      name: displayName(item),
      kind: item.kind,
      layer: item.layer ?? 'structural',
      locator: item.locator,
    })),
  };
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
  semanticDepth?: SemanticQueryDepth | undefined;
  orientationReuse?: OrientationQueryReuse | undefined;
}): Promise<Record<string, unknown>> {
  const text = input.text.trim();
  if (!text) throw new Error('text must be non-empty');
  const lower = text.toLowerCase();
  const plan = planInvestigationQuestion({
    text,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.semanticDepth ? { semanticDepth: input.semanticDepth } : {}),
  });
  const sourceReference = !input.sourceId ? parseSourceReferenceQuestion(text) : null;
  if (sourceReference) {
    const graph = await currentGraph(input.project, input.ref, input.graphId);
    const result = sourceReferenceProjection(graph, sourceReference, input.scope);
    return {
      intent: 'source-relationship',
      subject: result.targetNodeId ? { id: result.targetNodeId, name: result.symbol } : null,
      routing: {
        tool: 'canonical-graph-relationships', projection: 'source-reference',
        questionPlan: { ...plan, lane: 'source-relationship', proofMode: 'evidence',
          subjectStrategy: 'entity-or-query' },
        targetResolution: { strategy: 'exact-source-and-symbol', mode: 'source-relationship',
          query: result.symbol, scope: result.sourcePath, ambiguous: result.reason.startsWith('ambiguous') },
      },
      answer: sourceReferenceAnswer(result),
      answerClassification: result.status === 'supported' ? 'established-bounded' : 'evidence-only',
      result: { ...result, graphId: graph.graphId, revision: graph.repositoryRevision,
        analyzerVersion: graph.analyzerVersion },
    };
  }
  const outboundQuestion = !input.sourceId ? parseFileOutboundQuestion(text) : null;
  if (outboundQuestion) {
    const graph = await currentGraph(input.project, input.ref, input.graphId);
    const result = fileOutboundProjection(graph, outboundQuestion, input.scope);
    return {
      intent: 'file-outbound',
      subject: result.sourceNodeId ? { id: result.sourceNodeId, name: result.sourcePath, kind: 'file' } : null,
      routing: {
        tool: 'canonical-graph-relationships', direction: 'outbound', projection: 'file-callees',
        questionPlan: { ...plan, lane: 'trace', proofMode: 'evidence', subjectStrategy: 'entity-or-query' },
        targetResolution: { strategy: 'exact-source-file', mode: 'file', query: result.sourcePath,
          scope: result.sourcePath, ambiguous: result.reason === 'ambiguous-source' },
      },
      answer: fileOutboundAnswer(result),
      answerClassification: result.status === 'supported' ? 'established-bounded' : 'evidence-only',
      result: { ...result, graphId: graph.graphId, revision: graph.repositoryRevision,
        analyzerVersion: graph.analyzerVersion },
    };
  }
  const target = await resolveInvestigationTarget(input, text, plan);
  const result = await (async (): Promise<Record<string, unknown>> => {

  // The existence of a nearby token in the graph cannot establish the
  // requested subject or any causal behavior. Keep suggestions, but fail closed.
  if (target.implicitOnly && (plan.lane === 'entity' || plan.lane === 'trace')) {
    return {
      intent: 'unproven',
      subject: subjectDescriptor(null, target.query, false, target.candidates),
      routing: { tool: 'none', reason: 'subject-not-exactly-identified' },
      answer: 'The question does not identify a unique code subject. Nearby names are suggestions, not proof of the requested behavior or relationship.',
      answerClassification: 'evidence-only',
      result: { outcome: 'unproven-subject', reason: 'incidental-lexical-match',
        candidates: target.candidates.map(node => ({ id: node.id, name: node.name, kind: node.kind })) },
    };
  }
  if (target.exactUnresolved) {
    return {
      intent: 'unresolved',
      subject: subjectDescriptor(null, target.query, false, target.candidates),
      routing: { tool: 'none', reason: 'exact-identity-not-resolved' },
      answer: 'The exact requested identifier was not resolved in this graph revision. Similar matches are candidates, not proof of the requested identity.',
      result: { outcome: 'unresolved-input', candidates: target.candidates.map(node => ({ id: node.id, name: node.name, kind: node.kind })) },
    };
  }

  if (input.sourceId) {
    const external = await queryTechnicalSource({ project: input.project, sourceId: input.sourceId, capability: input.capability, query: text });
    return { intent: 'source-query', subject: null, routing: { tool: 'query_source', sourceId: input.sourceId }, answer: `Read-only query sent to ${input.sourceId}.`, result: external };
  }

  const sourceFallback = await unsupportedPathSourceFallback(input, text);
  if (sourceFallback) return sourceFallback;
  const specificSemantic = specificSemanticQuestion(text);
  if (specificSemantic) return await explainSpecificSemanticQuestion(input.project, (await currentGraph(input.project,input.ref,input.graphId)).graphId, text, specificSemantic, input.scope);

  if (plan.lane === 'implementation-explanation') {
    const result = await implementationMechanismProjection({
      project: input.project,
      text,
      ref: input.ref,
      graphId: input.graphId,
      scope: input.scope,
      limit: 100,
    }) as any;
    return {
      intent: 'implementation-explanation',
      subject: null,
      routing: {
        tool: 'search_code',
        projection: 'implementation-mechanism',
      },
      answer: String(result.summary ?? 'Implementation mechanism evidence loaded.'),
      result,
    };
  }

  if (plan.lane === 'change') {
    const result = await diffAcceptedToWorking(input.project, input.ref);
    const counts = semanticDiffCounts(result);
    return { intent: 'change', subject: null, routing: { tool: 'diff_graph' }, answer: `Accepted → working semantic change: ${counts.added} added, ${counts.removed} removed, ${counts.changed} changed records.`, result };
  }

  if (plan.lane === 'coverage') {
    const result = await graphCoverage(input.project, input.ref, input.graphId);
    const coverage = result as any;
    return { intent: 'coverage', subject: null, routing: { tool: 'check_graph_coverage' }, answer: `Coverage: ${coverage.completeFiles ?? '?'} complete, ${coverage.partialFiles ?? '?'} partial, ${coverage.failedFiles ?? '?'} failed, ${coverage.skippedFiles ?? '?'} skipped files.`, result };
  }

  if (plan.lane === 'parity') {
    const resolved = target;
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

  if (plan.lane === 'code') {
    const resolved = target;
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

  if (plan.lane === 'implementation-claim') {
    const resolved = target;
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

  if (plan.lane === 'interface') {
    if (target.ambiguous) {
      return {
        intent: 'interface',
        subject: subjectDescriptor(null, target.query, true, target.candidates),
        routing: { tool: 'inspect_interface' },
        answer: 'The interface subject is ambiguous; choose an exact scope or entity.',
        result: { ambiguous: true, candidates: target.candidates },
      };
    }
    if (target.mode === 'scope-required') {
      return {
        intent: 'interface',
        subject: null,
        routing: { tool: 'inspect_interface', scopeRequired: true },
        answer: 'A concrete file, path, route, feature, or entity scope is required for this interface question.',
        result: { scopeRequired: true, supportedScopes: ['repository','path','file','entity','feature/route'] },
      };
    }
    const requestedScope = target.scope ?? '';
    const result = await interfaceProjection({
      project: input.project,
      scope: requestedScope || undefined,
      ref: input.ref,
      graphId: input.graphId,
    });
    return {
      intent: 'interface',
      subject: requestedScope ? { query: requestedScope } : null,
      routing: { tool: 'inspect_interface' },
      answer: String((result as any).summary ?? 'Interface / interaction projection complete.'),
      result,
    };
  }

  if (plan.lane === 'semantic-lifecycle') {
    const result = await semanticLifecycleOverview(input.project);
    return {
      intent: 'semantic-lifecycle',
      subject: null,
      routing: { tool: 'investigate', projection: 'semantic-lifecycle' },
      answer: semanticLifecycleAnswer(text, result),
      result,
    };
  }

  if (plan.lane === 'semantic-audit') {
    const result = await semanticAudit({
      project: input.project,
      ref: input.ref,
      graphId: input.graphId,
      limit: 40,
      candidateLimit: 200,
    });
    return {
      intent: 'semantic-audit',
      subject: null,
      routing: { tool: 'audit_semantics' },
      answer: String((result as any).summary ?? 'Semantic factuality/core audit complete.'),
      result,
    };
  }

  if (plan.lane === 'orientation') {
    if (target.mode === 'scope-required') {
      return {
        intent: 'orientation',
        subject: null,
        routing: { tool: 'orient_scope', scopeRequired: true },
        answer: 'A concrete file, path, entity, or feature scope is required for “this” orientation questions.',
        result: { scopeRequired: true, supportedScopes: ['repository','path','file','entity','feature/route/api'] },
      };
    }
    const requestedScope = target.ambiguous ? '' : (target.scope ?? '');
    const semanticDepth = semanticDepthForQuestion(text, input.semanticDepth);
    const result = await scopeOrientation({
      project: input.project,
      scope: requestedScope || undefined,
      ref: input.ref,
      graphId: input.graphId,
      rankBy: input.rankBy,
      semanticDepth,
      orientationReuse: input.orientationReuse,
    });
    return {
      intent: 'orientation',
      subject: requestedScope ? { query: requestedScope } : null,
      routing: { tool: 'orient_scope', rankBy: input.rankBy ?? 'cross-file', semanticDepth },
      answer: String((result as any).summary ?? 'Scoped orientation complete.'),
      result,
    };
  }

  if (plan.lane === 'trace') {
    const resolved = target;
    if (resolved.ambiguous) {
      return { intent: 'trace', subject: subjectDescriptor(null, resolved.query, true, resolved.candidates), routing: { tool: 'trace_path' }, answer: 'The relationship subject is ambiguous; choose an exact entity.', result: { ambiguous: true, candidates: resolved.candidates } };
    }
    const subject = resolved.node?.id ?? resolved.query;
    if (subject) {
      const outboundCall = /\b(?:what|which)\s+(?:functions?\s+)?(?:does|do)\b[^?]*\bcall\b/u.test(lower);
      const inboundCall = /^\s*(?:what|who|which)\s+(?:functions?\s+)?calls?\b/u.test(lower)
        || /\b(?:callers?|called by)\b/u.test(lower);
      const isCallQuestion = outboundCall || inboundCall;
      const direction = outboundCall ? 'outbound' : inboundCall ? 'inbound'
        : /used by|consumers?|^\s*what\s+depends?\s+on\b|^\s*which\b[^?]*\bdepends?\s+on\b|\bwhich\b.*\buses?\b|\bwhat\b.*\bconstructs?\b/u.test(lower)
          ? 'inbound'
          : /depend(?:s)? on|uses/u.test(lower) ? 'outbound' : 'both';
      const result = await traceGraph({
        project: input.project, ref: input.ref, graphId: input.graphId,
        node: subject, direction, depth: isCallQuestion ? 1 : 2,
        ...(isCallQuestion ? { relationshipKinds: ['calls'] } : {}),
        statuses: ['resolved'], limit: 250,
      }) as any;
      const callEdges = isCallQuestion && !result.ambiguous
        ? (result.edges ?? []).filter((edge: any) => edge.kind === 'calls'
          && (direction === 'outbound' ? edge.from === subject : edge.to === subject))
        : [];
      const names = new Map<string, string>((result.nodes ?? []).map((node: any) => [node.id, node.name || node.id]));
      const observed = [...new Set<string>(callEdges.map((edge: any) =>
        names.get(direction === 'outbound' ? edge.to : edge.from) ?? String(direction === 'outbound' ? edge.to : edge.from)))].sort();
      const answer = result.ambiguous
        ? 'The requested graph subject is ambiguous; choose an exact entity.'
        : isCallQuestion
          ? observed.length
            ? 'Observed resolved direct ' + (direction === 'outbound' ? 'callees' : 'callers')
              + ' of “' + displayName(resolved.node ?? undefined, subject) + '”: ' + observed.join(', ')
              + '. These source relationships do not establish exhaustive runtime behavior.'
            : 'No resolved direct call relationship was observed for the selected subject and direction; this does not prove an absence of runtime calls.'
          : (result.nodes?.length ?? 0) + ' entities and ' + (result.edges?.length ?? 0)
            + ' resolved relationships are in the traced neighborhood of “' + displayName(resolved.node ?? undefined, subject) + '”.';
      return {
        intent: 'trace',
        subject: subjectDescriptor(resolved.node, resolved.query),
        routing: { tool: 'trace_path', direction, ...(isCallQuestion ? { relationshipKinds: ['calls'] } : {}) },
        answer,
        answerClassification: result.ambiguous ? 'unresolved-input' : isCallQuestion && observed.length ? 'established-bounded' : 'evidence-only',
        result,
      };
    }
  }

  if (plan.lane === 'evidence') {
    const resolved = target;
    const claimNeedsAssessment = plan.proofMode === 'claim';
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

  if (plan.lane === 'repository-audit') {
    const result = await repositoryAudit({
      project: input.project,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.graphId ? { graphId: input.graphId } : {}),
      limit: 40,
    }) as any;
    return {
      intent: 'repository-audit',
      subject: null,
      routing: { tool: 'audit_repository' },
      answer: repositoryAuditAnswer(result),
      result,
    };
  }

  if (plan.lane === 'statistics') {
    const result = await projectStatistics(input.project, input.ref, input.graphId);
    return { intent: 'statistics', subject: null, routing: { tool: 'project_statistics' }, answer: String(result.summary ?? `${input.project} statistics`), result };
  }

  if (plan.lane === 'overview') {
    const result = await projectOverview(input.project, input.ref, input.graphId);
    return { intent: 'overview', subject: null, routing: { tool: 'project_overview' }, answer: String(result.summary ?? `${input.project} overview`), result };
  }

  const resolved = target;
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
  })();
  const routing = result.routing && typeof result.routing === 'object'
    ? result.routing as Record<string, unknown>
    : {};
  return {
    ...result,
    routing: {
      ...routing,
      questionPlan: plan,
      targetResolution: targetResolutionForRouting(target),
    },
  };
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
  if (remainder && pieces.length && /^(?:(?:and|also)\s+)?(?:what|which|where|when|why|how|who|show|find|inspect|tell|explain|trace|list|does|do|is|are|can|could|would)\b/iu.test(remainder)) {
    pieces.push(remainder);
  }
  if (pieces.length > 1) return pieces;
  return [trimmed];
}

function continuityReferenceOnly(query: string | null): boolean {
  if (!query) return true;
  return /^(?:it|those answers|that answer|this (?:entity|feature|function|class|page|route|api|subject))$/iu.test(query.trim());
}

function hasContinuityReference(question: string): boolean {
  return /\b(?:it|those answers|that answer|this (?:entity|feature|function|class|page|route|api|subject))\b/iu.test(question);
}

function hasQuotedContinuityReference(question: string): boolean {
  return /(["'`])(?:it|those answers|that answer|this (?:entity|feature|function|class|page|route|api|subject))\1/iu.test(question);
}

async function inheritedQuestion(
  input: { project: string; ref?: string | undefined; graphId?: string | undefined; scope?: string | undefined; sourceId?: string | undefined; semanticDepth?: SemanticQueryDepth | undefined },
  question: string,
  subjectId: string | null,
): Promise<{ text: string; inherited: boolean }> {
  if (!subjectId) return { text: question, inherited: false };
  const plan = planInvestigationQuestion({
    text: question,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.semanticDepth ? { semanticDepth: input.semanticDepth } : {}),
  });
  if (plan.subjectStrategy !== 'entity-or-query' && plan.subjectStrategy !== 'scope-or-entity') {
    return { text: question, inherited: false };
  }
  const referenceQuery = querySubject(question, subjectMarkersForLane(plan.lane));
  const quotedReference = hasQuotedContinuityReference(question);
  if (!quotedReference && hasContinuityReference(question) && continuityReferenceOnly(referenceQuery)) {
    return inheritQuestionReference(question, subjectId);
  }
  const target = await resolveInvestigationTarget(input, question, plan);
  if (quotedReference || target.node || target.ambiguous || !continuityReferenceOnly(target.query)) {
    return { text: question, inherited: false };
  }

  return inheritQuestionReference(question, subjectId);
}

function inheritQuestionReference(question: string, subjectId: string): { text: string; inherited: boolean } {
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
  semanticDepth?: SemanticQueryDepth | undefined;
}): Promise<Record<string, unknown>> {
  // Preserve explicit positions: a blank item is an isolated failure, never a silently removed question.
  const explicit = (input.questions ?? []).map(question => question.trim());
  if (explicit.length > 10) throw new Error('questions supports at most 10 items');
  const originalText = input.text?.trim() ?? '';
  if (explicit.length && originalText) throw new Error('provide text or questions, not both');

  const questions = explicit.length ? explicit : decomposeQuestionText(originalText);
  if (!questions.length) throw new Error('text or questions must contain at least one question');
  if (questions.length > 10) throw new Error('investigation supports at most 10 questions');

  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const mode = explicit.length ? 'explicit' : questions.length > 1 ? 'decomposed' : 'single';
  const orientationReuse: OrientationQueryReuse = { graph };

  if (questions.length === 1 && questions[0] !== '') {
    const result = await queryWorkbench({
      project: input.project,
      text: questions[0]!,
      graphId: graph.graphId,
      sourceId: input.sourceId,
      capability: input.capability,
      scope: input.scope,
      rankBy: input.rankBy,
      semanticDepth: input.semanticDepth,
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
    let inherited = { text: originalQuestion, inherited: false };
    let inheritedFromSubjectId: string | null = null;
    try {
      inherited = await inheritedQuestion({
        project: input.project,
        graphId: graph.graphId,
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        ...(input.semanticDepth ? { semanticDepth: input.semanticDepth } : {}),
      }, originalQuestion, inheritedSubjectId);
      inheritedFromSubjectId = inherited.inherited ? inheritedSubjectId : null;
      const result = await queryWorkbench({
        project: input.project,
        text: inherited.text,
        graphId: graph.graphId,
        sourceId: input.sourceId,
        capability: input.capability,
        scope: input.scope,
        rankBy: input.rankBy,
        semanticDepth: input.semanticDepth,
        orientationReuse,
      }) as any;
      const subjectId = result?.subject && result.subject.ambiguous !== true && typeof result.subject.id === 'string'
        ? result.subject.id
        : null;
      inheritedSubjectId = subjectId;
      items.push({
        index,
        question: originalQuestion,
        resolvedQuestion: inherited.text,
        inheritedSubject: inheritedFromSubjectId,
        status: 'ok',
        intent: result.intent ?? null,
        subject: result.subject ?? null,
        routing: result.routing ?? null,
        answer: result.answer ?? null,
        result: result.result ?? null,
      });
    } catch (error) {
      inheritedSubjectId = null;
      items.push({
        index,
        question: originalQuestion,
        resolvedQuestion: inherited.text,
        inheritedSubject: inheritedFromSubjectId,
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
      inheritedSubjectOnlyFromImmediateExactPriorResult: true,
      explicitCurrentSubjectPrecedesInheritance: true,
      failedOrSubjectlessQuestionClearsInheritance: true,
      failureIsolation: true,
      persisted: false,
      note: 'Each question is routed independently over one pinned graph context. An explicit current subject is resolved before continuity. Only the immediately prior successful exact subject may resolve a reference-only continuation; failed, ambiguous, unknown, repository-level, and other subjectless questions clear inheritance.',
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
