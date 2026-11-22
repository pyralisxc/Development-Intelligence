import { graphFamilyMemberships } from './graphFamilies.js';
import { indexedIncidentEdges, materializeIndexedQuestionGraph } from './localGraphIndex.js';
import { investigationSelection, questionSelection } from './investigation.js';
import { listAuthorizedGithubOwners, loadRegistry } from '../config/registry.js';
import { projectStatus } from '../projectStatus.js';
import { listPublicProjects } from '../source/git.js';
import type { GraphEdge, GraphNode, IntelligenceGraph, RelationshipStatus, TechnicalSourceCapability } from '../types.js';
import { getCodeSnippet } from './code.js';
import { currentGraph, withIndexedLocalGraph } from './service.js';
import { diffDefaultToSelected, findGraphNodeCandidates, searchGraph } from './query.js';
import { listTechnicalSources, queryTechnicalSource } from './technicalSources.js';
import { assessGraph, auditGraph, type AuditFinding } from './assessment.js';
import { bootstrapSemanticCandidates } from './semanticBootstrap.js';
import { auditSemanticCandidates } from './semanticAudit.js';
import { deriveCurrentSemanticTruth } from './semanticCurrentTruth.js';
import { graphRecordWeight } from './capacity.js';
import { interfaceRuntimeObservationContract, isInterfaceRuntimeObservationSource } from './interfaceRuntimeObservation.js';
import { filterGraph, interpretGraphLanguage, planGraphSubjects, rememberGraphSubjects, type GraphFilterInput } from './graphFilter.js';

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
  const producerNote = graph.producerCoverage?.length
    ? ' Language producer coverage: ' + graph.producerCoverage.map(item => `${item.producer} ${item.state}${item.reason ? ` (${item.reason})` : ''}`).join('; ') + '.'
    : '';
  if (coverage.failedFiles || coverage.partialFiles || coverage.skippedFiles) {
    return `Coverage is incomplete: ${coverage.completeFiles}/${coverage.eligibleFiles} eligible files complete, ${coverage.partialFiles} partial, ${coverage.failedFiles} failed, ${coverage.skippedFiles} skipped.${producerNote}`;
  }
  return `Source-file analysis is complete for ${coverage.eligibleFiles} eligible files (${coverage.trackedFiles} ${graph.sourceState ? 'working source files' : 'tracked files'} total).${producerNote}`;
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
  return { ...summary, producerCoverage: graph.producerCoverage ?? [] };
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
  const incident = indexedIncidentEdges(graph, [selected.id]) ?? graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id);
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
  const candidateLimit = Math.max(input.candidateLimit ?? 200, 1);
  const bootstrap = bootstrapSemanticCandidates(graph, { limit: candidateLimit });
  const audit = auditSemanticCandidates(graph, bootstrap, { limit: input.limit ?? 30 });
  const audited = audit.counts.audited;
  const displayed = audit.items.length;
  const core = audit.counts.coreCandidates;
  const needsReview = audit.counts.factualityNeedsReview;
  return {
    project: input.project,
    graphId: graph.graphId,
    // Total evaluated and bounded detail presentation are different populations.
    summary: `${audit.candidateUniverse.eligible} evidence-qualified semantic candidate(s); ${audited} audited, ${core} meeting the explicit core-candidate facets and ${needsReview} requiring factuality review; ${displayed} detailed item(s) displayed. ${audit.candidateUniverse.truncated ? 'The eligible candidate population is truncated by the requested source-candidate budget.' : 'The eligible candidate population is complete for this request.'}`,
    ...audit,
    coverage: compactCoverage(graph),
    policyNote: 'Core/supporting is an evidence-grounded audit classification; source facts retain their evidence and scope.',
  };
}

export async function projectOverview(project: string, ref?: string | undefined, graphId?: string | undefined, subjects: string[] = []): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref, graphId);
  const local = Boolean(process.env.DEVINT_LOCAL_GRAPH_DIR);
  const [status, diff, sources] = await Promise.all([
    graphId || local ? Promise.resolve(null) : projectStatus(project, false),
    graphId || local ? Promise.resolve(null) : diffDefaultToSelected(project, ref),
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
  if (!graphId && !local) notes.push(diffCounts.added || diffCounts.removed || diffCounts.changed
    ? `Default → selected semantic change: ${diffCounts.added} added, ${diffCounts.removed} removed, ${diffCounts.changed} changed records.`
    : 'No semantic change is detected between the default and selected source states.');
  if (graph.explicitValueConflicts.length) notes.push(`${graph.explicitValueConflicts.length} explicit semantic value conflict(s) need attention.`);
  if (findings.length) notes.push(`${findings.length} deterministic evidence finding(s) currently deserve attention; findings remain revision-bound projections rather than accepted graph truth.`);
  return {
    project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    ...(graph.sourceState ? { sourceState: graph.sourceState } : {}),
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
  const incident = indexedIncidentEdges(graph, [selected.id]) ?? graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const memberships = graphFamilyMemberships(graph);
  const families = (memberships.get(selected.id) ?? []).map(family => ({ ...family,
    subject: byId.has(family.id) ? { id: family.id, name: displayName(byId.get(family.id)!),
      kind: byId.get(family.id)!.kind, locator: byId.get(family.id)!.locator } : null }));
  const facts = incident.filter(edge => edge.from === selected.id && edge.to
    && ['has-condition', 'has-effect', 'has-source-control'].includes(edge.kind))
    .flatMap(edge => {
      const fact = edge.to ? byId.get(edge.to) : undefined;
      return fact ? [{ relationship: edge, fact }] : [];
    });
  const familyMembers = graph.nodes.flatMap(node => {
    if (node.id === selected.id) return [];
    const membership = memberships.get(node.id)?.find(family => family.id === selected.id);
    return membership ? [{ id: node.id, name: displayName(node), kind: node.kind,
      locator: node.locator, roles: membership.roles, via: membership.via }] : [];
  }).sort((a, b) => a.locator.localeCompare(b.locator) || a.id.localeCompare(b.id));
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
      strategy: edge.strategy ?? null,
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
    try { change = changeForNode(await diffDefaultToSelected(input.project, input.ref), selected.id); } catch { change = null; }
  }
  return {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    ...(graph.sourceState ? { sourceState: graph.sourceState } : {}),
    sourceFingerprint: graph.sourceFingerprint,
    ambiguous: false,
    investigation: investigationSelection(graph, 'inspect-node', { nodeIds: [selected.id], edgeIds: incident.map(edge => edge.id) }),
    entity: selected,
    families,
    familyMembers,
    facts,
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

  const candidates = findGraphNodeCandidates(graph, scope, Number.MAX_SAFE_INTEGER);
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
  incident: readonly GraphEdge[],
  rankBy: ScopeRankBy,
  neighborLocation: (node: GraphNode) => { file: string | null; area: string | null },
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
  // One incident-edge pass, not separate resolved/candidate/inbound/outbound
  // filters plus repeated locator parsing for both incident endpoints.
  const neighborFiles = new Set<string>();
  const neighborAreas = new Set<string>();
  const resolvedKinds = new Set<string>();
  let fanIn = 0, fanOut = 0, candidate = 0, unresolved = 0;
  let semanticLinks = 0, representationLinks = 0, callers = 0, callees = 0;
  for (const edge of incident) {
    if (edge.status === 'candidate') { candidate += 1; continue; }
    if (edge.status === 'unresolved') { unresolved += 1; continue; }
    if (edge.status !== 'resolved') continue;
    resolvedKinds.add(edge.kind);
    if (edge.to === node.id) fanIn += 1;
    if (edge.from === node.id) fanOut += 1;
    const neighborId = edge.from === node.id ? edge.to : edge.from;
    const neighbor = neighborId ? byId.get(neighborId) : undefined;
    if (neighbor) {
      const { file, area } = neighborLocation(neighbor);
      if (file) neighborFiles.add(file);
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
    fanIn, fanOut, crossFileReach: neighborFiles.size,
    crossAreaReach: neighborAreas.size, relationshipDiversity: resolvedKinds.size,
    candidate, unresolved, semanticLinks, representationLinks, callers, callees,
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
  const candidateLimit = depth === 'exhaustive' ? derivedAll.length
    : depth === 'expanded' ? Math.max(limit * 6,64)
    : Math.max(limit * 2,24);
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
  const sourceIdentity = graph.sourceState?.kind === 'working-tree'
    ? 'working tree ' + graph.sourceFingerprint + ' (HEAD ' + graph.sourceState.headRevision + ')'
    : graph.repositoryRevision ?? 'an unavailable revision';
  const summary = primary.length
    ? 'Current source understanding of ' + project + ' at ' + sourceIdentity
      + ': ' + truth.counts.provenTechnicalScopes + ' independently proven technical source scope(s), '
      + truth.counts.sourceDeclaredConcepts + ' source-declared semantic concept(s), '
      + truth.counts.supportedInterpretations + ' source-supported interpretation(s). '
      + 'Leading evidence-backed areas: ' + semanticNameList(primary,6) + '. '
      + coverageNote + ' These facts do not establish desired product intent or runtime execution.'
    : 'No currently source-proven technical scopes or semantic declarations were found for '
      + project + '. ' + coverageNote + ' DI must not reuse older acceptance as current truth.';
  const supportingLimit=Math.max(limit*2,24);
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
      candidateOperationalLimit: null,
      eligibleSourceCoverageComplete: truth.exclusions.completeForEligibleSources,
      unsupportedFiles: truth.exclusions.unsupportedFiles,
      claim: depth === 'exhaustive'
        ? (censusExhausted ? 'exhaustive-derived-candidate-census' : 'exhaustive-request-incomplete')
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
  semanticSummaryOnly?: boolean | undefined;
}): Promise<Record<string, unknown>> {
  // Reuse is valid only for an exact graph identity selected by the caller.
  // A ref selector needs fresh resolution: never infer ref equivalence from
  // project identity or carry indexes from an unrelated graph snapshot.
  const orientationStarted = Date.now();
  // Request-local timings: no second graph, persisted trace or question text.
  const phaseMs = { graphAccess: 0, scopeSelection: 0, adjacencyIndex: 0,
    rankingAndRoles: 0, semanticUnderstanding: 0 };
  const candidateReuse = input.orientationReuse;
  const reusable = candidateReuse && candidateReuse.graph.project === input.project
    && !input.ref
    && input.graphId === candidateReuse.graph.graphId
    ? candidateReuse : undefined;
  const graph = reusable?.graph ?? await currentGraph(input.project, input.ref, input.graphId);
  phaseMs.graphAccess = Date.now() - orientationStarted;
  const rankBy = input.rankBy ?? 'cross-file';
  const limit = Math.max(input.limit ?? 12, 1);
  const selected = scopeNodeIds(graph, input.scope);
  phaseMs.scopeSelection = Date.now() - orientationStarted - phaseMs.graphAccess;

  if (selected.kind === 'ambiguous') {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: true,
      scope: { kind: selected.kind, value: selected.value },
      candidates: selected.candidates.map(node => ({ id: node.id, name: displayName(node), kind: node.kind, layer: node.layer ?? 'structural', locator: node.locator })),
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

  // Ordinary repository-description questions need the source-backed semantic
  // explanation, not a complete ranking of every structural node in W.
  // Direct orient_scope still returns full ranked entities and boundaries.
  if (selected.kind === 'repository' && input.semanticSummaryOnly) {
    const semanticStarted = Date.now();
    const understanding = await repositorySemanticUnderstanding(
      input.project, graph, limit, input.semanticDepth ?? 'nucleus', reusable);
    phaseMs.semanticUnderstanding = Date.now() - semanticStarted;
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: false,
      scope: { kind: 'repository', value: selected.value,
        nodeCount: selected.ids.size, resolvedBoundaryCount: 0 },
      rankBy,
      summary: understanding.summary,
      semanticUnderstanding: understanding,
      projection: { kind: 'repository-semantic-summary',
        structuralOrientationMaterialized: false, detailTool: 'orient_scope' },
      observability: {
        owner: 'di-query-orientation', graphId: graph.graphId,
        revision: graph.repositoryRevision, phaseMs,
        totalMeasuredMs: Date.now() - orientationStarted,
        ephemeral: true,
        note: 'Request-local timings; no source content, credentials or question text are logged or retained.',
      },
      coverage: compactCoverage(graph),
      policy: {
        subjectiveImportanceScore: false, rankFacet: rankBy,
        evidenceLinked: true, summaryInfersProductIntent: false,
        persisted: false,
        note: 'Semantic summary selects current graph evidence; detailed structural ranking is available through orient_scope.',
      },
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

  phaseMs.adjacencyIndex = Date.now() - orientationStarted
    - phaseMs.graphAccess - phaseMs.scopeSelection;
  // The ranked list and role summaries inspect the same scoped nodes at the
  // same graph revision/rank criterion. Reuse metrics per node within this
  // single orientation, never across revisions or distinct graph contexts.
  if (reusable && reusable.rankBy !== rankBy) {
    delete reusable.metrics;
    reusable.rankBy = rankBy;
  }
  const metricCache = reusable?.metrics ?? new Map<string, ReturnType<typeof orientationMetric>>();
  if (reusable) reusable.metrics = metricCache;
  // Node locations are stable inside the same exact-revision graph. Derive
  // path/area once rather than parsing the same neighbor locator for each edge.
  const sourceLocationById = new Map<string, { file: string | null; area: string | null }>();
  const neighborLocation = (node: GraphNode) => {
    const cached = sourceLocationById.get(node.id);
    if (cached) return cached;
    const file = sourceFile(node.locator);
    const area = file ? (() => {
      const parts = (file.startsWith('./') ? file.slice(2) : file).split('/');
      return parts[0] === 'src' && parts[1] ? 'src/' + parts[1] : parts[0] ?? null;
    })() : null;
    const location = { file, area };
    sourceLocationById.set(node.id, location);
    return location;
  };
  const scopedMetrics = (node: GraphNode): ReturnType<typeof orientationMetric> => {
    const existing = metricCache.get(node.id);
    if (existing) return existing;
    const calculated = orientationMetric(node, byId, incidentByNode.get(node.id) ?? [], rankBy, neighborLocation);
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
    .filter(edge => edge.status === 'resolved' && edge.from && edge.to && scopedSet.has(edge.from) !== scopedSet.has(edge.to));
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
  const roleMembers = new Map<OrientationRole, GraphNode[]>();
  // Group once, in original graph order so stable tied rankings remain exact.
  for (const node of nodes) {
    const role = orientationRole(node);
    const members = roleMembers.get(role);
    if (members) members.push(node);
    else roleMembers.set(role, [node]);
  }
  const roleGroups = roleOrder.flatMap(role => {
    const members = roleMembers.get(role) ?? [];
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
      entities: sorted.slice(0, limit).map(({ node, metrics }) => ({
        id: node.id,
        name: displayName(node),
        kind: node.kind,
        layer: node.layer ?? 'structural',
        locator: node.locator,
        metrics,
      })),
      evidenceNodeIds: members.map(node => node.id).sort(),
    }];
  });
  const dependencies = {
    outbound: orientationDependencies(boundarySummaries, 'outbound', limit),
    inbound: orientationDependencies(boundarySummaries, 'inbound', limit),
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
    .slice(0, limit)
    .map(({node,metrics}) => ({ id: node.id, name: displayName(node), kind: node.kind, locator: node.locator, candidate: metrics.candidate, unresolved: metrics.unresolved }));

  phaseMs.rankingAndRoles = Date.now() - orientationStarted
    - phaseMs.graphAccess - phaseMs.scopeSelection - phaseMs.adjacencyIndex;
  const semanticStarted = Date.now();
  const semanticUnderstanding = selected.kind === 'repository'
    ? await repositorySemanticUnderstanding(input.project, graph, limit, input.semanticDepth ?? 'nucleus', reusable)
    : null;
  phaseMs.semanticUnderstanding = Date.now() - semanticStarted;

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
    observability: {
      owner: 'di-query-orientation',
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      phaseMs,
      totalMeasuredMs: Date.now() - orientationStarted,
      ephemeral: true,
      note: 'Request-local timings; no source content, credentials or question text are logged or retained.',
    },
    responsibilities,
    roleGroups,
    dependencies,
    nodeKinds: Object.entries(nodeKinds).sort((a,b) => b[1]-a[1]).map(([kind,count]) => ({kind,count})),
    relationshipKinds: Object.entries(relationshipKinds).sort((a,b) => b[1]-a[1]).map(([kind,count]) => ({kind,count})),
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


const INTERFACE_SURFACE_KINDS = new Set(['surface', 'route', 'ui-element', 'dom-interaction']);
const INTERFACE_STATE_KINDS = new Set(['state-binding', 'state-write']);
const INTERFACE_INTERACTION_KINDS = new Set(['ui-element', 'dom-interaction', 'interaction-handler', 'component-prop-handler', 'component-prop-binding']);
const INTERFACE_TRANSITION_KINDS = new Set(['navigation-call', 'route-reference', 'route']);
const INTERFACE_EFFECT_KINDS = new Set(['http-call', 'rpc-call', 'sql-reference', 'mcp-tool']);
const INTERFACE_REPRESENTATION_KINDS = new Set(['css-class-reference', 'css-selector', 'css-at-rule', 'css-custom-property']);
const INTERACTION_MECHANISM_NODE_KINDS = new Set(['component-prop-binding', 'component-prop-handler', 'interaction-handler', 'dom-interaction']);
const DIRECT_CONSEQUENCE_KINDS = new Set(['state-write', 'navigation-call', 'http-call', 'rpc-call']);
const INTERACTION_FAMILY_ORDER = ['pointer', 'drop', 'drag', 'scroll', 'click', 'focus', 'keyboard', 'input', 'submit', 'context-menu', 'touch', 'mouse'] as const;
type InteractionFamily = typeof INTERACTION_FAMILY_ORDER[number];

function interactionFamily(prop: string): InteractionFamily | null {
  if (/^on(?:Stage)?Pointer[A-Z]/u.test(prop)) return 'pointer';
  if (prop === 'onDrop') return 'drop';
  if (/^onDrag[A-Z]?/u.test(prop)) return 'drag';
  if (/^on(?:Scroll|Wheel)/u.test(prop)) return 'scroll';
  if (/^on(?:Double)?Click(?:Capture)?$/u.test(prop)) return 'click';
  if (prop === 'onFocus' || prop === 'onBlur') return 'focus';
  if (/^onKey[A-Z]/u.test(prop)) return 'keyboard';
  if (['onChange', 'onInput', 'onBeforeInput'].includes(prop) || /^on[A-Za-z0-9]*Change$/u.test(prop)) return 'input';
  if (prop === 'onSubmit' || prop === 'onSubmitCapture') return 'submit';
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
  const limit = Math.max(input.limit ?? 20, 1);
  const selected = scopeNodeIds(graph, input.scope);

  if (selected.kind === 'ambiguous') {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: true,
      scope: { kind: selected.kind, value: selected.value },
      candidates: selected.candidates.map(node => ({
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
  const mechanismSampleLimit = limit;
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
    investigation: investigationSelection(graph, 'interface', { nodeIds: combined.map(item => item.id), edgeIds: combined.flatMap(item => item.links.map(link => link.edgeId)), scope: { kind: selected.kind, value: selected.value }, page: { limit } }),
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
      examples: uncertaintyEdges.slice(0, limit).map(edge => ({
        edgeId: edge.id,
        kind: edge.kind,
        status: edge.status,
        from: edge.from,
        to: edge.to,
      })),
      unknowns,
    },
    nextInspections: combined.slice(0, limit).map((item: any) => ({
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

function normalizedMention(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_./:@-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
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
  offset?: number | undefined;
  limit?: number | undefined;
  nodeKinds?: string[] | undefined;
  relationshipKinds?: string[] | undefined;
  statuses?: string[] | undefined;
  direction?: 'inbound' | 'outbound' | 'both' | undefined;
  comparisonIds?: string[] | undefined;
  comparisonScope?: string | undefined;
  comparisonKinds?: string[] | undefined;
  conditionContains?: string | undefined;
  conditionTruth?: boolean | undefined;
  effectKinds?: string[] | undefined;
  depth?: number | undefined;
}): Promise<Record<string, unknown>> {
  // Preserve explicit positions: a blank item is an isolated failure, never a silently removed question.
  const explicit = (input.questions ?? []).map(question => question.trim());
  if (explicit.length > 10) throw new Error('questions supports at most 10 items');
  const originalText = input.text?.trim() ?? '';
  if (explicit.length && originalText) throw new Error('provide text or questions, not both');

  const questions = explicit.length ? explicit : decomposeQuestionText(originalText);
  if (!questions.length) throw new Error('text or questions must contain at least one question');
  if (questions.length > 10) throw new Error('investigation supports at most 10 questions');

  const filterInput = (question: string, effectiveScope?: string): GraphFilterInput => ({ text: question,
        ...(effectiveScope ? { scope: effectiveScope } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.nodeKinds?.length ? { nodeKinds: input.nodeKinds } : {}),
        ...(input.relationshipKinds?.length ? { relationshipKinds: input.relationshipKinds } : {}),
        ...(input.statuses?.length ? { statuses: input.statuses } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.comparisonIds?.length ? { comparisonIds: input.comparisonIds } : {}),
        ...(input.comparisonScope ? { comparisonScope: input.comparisonScope } : {}),
        ...(input.comparisonKinds?.length ? { comparisonKinds: input.comparisonKinds } : {}),
        ...(input.conditionContains ? { conditionContains: input.conditionContains } : {}),
        ...(input.conditionTruth !== undefined ? { conditionTruth: input.conditionTruth } : {}),
        ...(input.effectKinds?.length ? { effectKinds: input.effectKinds } : {}),
        ...(input.depth !== undefined ? { depth: input.depth } : {}),
  });

  const run = async (graph: IntelligenceGraph): Promise<Record<string, unknown>> => {
  const mode = explicit.length ? 'explicit' : questions.length > 1 ? 'decomposed' : 'single';

  // All ordinary language questions use one graph selection and navigation
  // contract. Explicit technical-source queries retain their source adapter.
  if (!input.sourceId) {
    let previousSubject: string | undefined;
    const items: Array<Record<string, any>> = [];
    for (const [index, question] of questions.entries()) {
      if (!question) { previousSubject = undefined; items.push({ index, question, status: 'error', error: 'Question is empty' }); continue; }
      const inheritedScope = !input.scope && previousSubject && /\b(?:it|its|itself)\b/iu.test(question)
        ? previousSubject : undefined;
      const effectiveScope = input.scope ?? inheritedScope;
      const result = filterGraph(graph, filterInput(question, effectiveScope)) as any;
      if (result.interpretation.selection === 'repository' && !result.navigation.operation) {
        const orientation = await scopeOrientation({ project: input.project, graphId: graph.graphId, semanticSummaryOnly: true, orientationReuse: { graph }, rankBy: input.rankBy, semanticDepth: input.semanticDepth, limit: input.limit });
        previousSubject = undefined;
        items.push({ index, question, status: 'ok', intent: 'graph-filter', subject: null,
          answer: orientation.summary, investigation: questionSelection(graph, result), routing: { tool: 'graph-filter', selection: 'repository' },
          result: { ...orientation, interpretation: result.interpretation } });
        continue;
      }
      const subject = ['exact-name', 'scope'].includes(result.interpretation.selection) && result.subjectTotal === 1
        ? result.subjects[0] : null;
      previousSubject = subject?.id;
      const focus = subject && !result.interpretation.negated && (result.interpretation.requestedEffects.length || result.interpretation.requestedFactKinds.length)
        && (!result.navigation.relationshipKinds.length || result.navigation.direction === 'outbound')
        ? (result.sourceFamilies.find((family: any) => family.subjectId === subject.id)?.focusedFacts ?? [])
          .filter((fact: any) => fact.matchedKind || (fact.effectKind && result.interpretation.requestedEffects.some((effect: string) => fact.effectKind.split('-').includes(effect))))
        : [];
      const related = result.navigation.relationships.filter((item: any) => item.edge.status === 'resolved' || item.edge.status === 'candidate');
      const relationshipAnswer = !result.interpretation.negated && result.interpretation.selection !== 'terms' && result.navigation.relationshipKinds.length && related.length
        ? related.map((item: any) => item.edge.kind === 'calls-site'
          ? `${item.from?.name ?? item.edge.from} has ${item.edge.status === 'candidate' ? 'possible source call' : 'source call'} ${item.to?.name ?? item.edge.to} at ${item.to?.locator ?? item.edge.evidence?.[0] ?? 'source'}${item.to?.value?.interpretation === 'call-or-conversion' ? ' (may be a type conversion)' : ''}`
          : `${item.from?.name ?? item.edge.from}${item.from?.locator ? ` (${item.from.locator})` : ''} ${item.edge.kind}${item.edge.status === 'candidate' ? ' (candidate)' : ''} ${item.to?.name ?? item.edge.to}${item.to?.locator ? ` (${item.to.locator})` : ''}`).join('; ')
          + (related.some((item: any) => item.edge.kind === 'calls-site') ? '. Source call occurrences do not by themselves bind target declarations.' : '')
          + ((result.page.offset + result.navigation.relationships.length < result.navigation.total)
            ? `; showing ${result.page.offset + 1}–${result.page.offset + result.navigation.relationships.length} of ${result.navigation.total} matching relationships (continue at offset ${result.page.offset + result.page.limit})` : '')
        : '';
      const comparisonAnswer = result.comparison?.state === 'evaluated'
          ? `Compared ${result.comparison.total} subjects: ${result.comparison.counts.related} related, ${result.comparison.counts.candidate} candidate, ${result.comparison.counts.notRelated} established not related, and ${result.comparison.counts.unknown} unknown.`
          : result.comparison?.reason ?? '';
      const describeFamily = (item: any, groupIds?: Set<string>, includeSource = true): string => {
        const family = result.families.find((value: any) => value.id === item.id);
        const linked = (family?.members ?? []).filter((member: any) =>
          member.roles.some((role: string) => ['dependency', 'caller', 'callback', 'related', 'candidate'].includes(role)));
        const additional = groupIds ? linked.filter((member: any) => !groupIds.has(member.id)
          && !member.roles.includes('caller')) : [];
        const groupedConnections = new Map<string, number>();
        for (const member of additional.filter((value: any) => value.matchedGroups > 0)) {
          const roles = member.roles.filter((role: string) => ['dependency', 'caller', 'callback', 'related', 'candidate'].includes(role)).join('/');
          const label = `${roles} ${member.name ?? member.kind}`;
          groupedConnections.set(label, (groupedConnections.get(label) ?? 0) + 1);
        }
        const connectionLabels = [...groupedConnections].map(([label, count]) => `${label}${count > 1 ? ` (${count} locations)` : ''}`);
        const matchedAdditional = additional.filter((member: any) => member.matchedGroups > 0).length;
        const connections = groupIds
          ? [connectionLabels.join(', '), additional.length > matchedAdditional ? `${additional.length - matchedAdditional} other connected subjects in details` : ''].filter(Boolean).join(', ')
          : linked.map((member: any) => `${member.roles.filter((role: string) => ['dependency', 'caller', 'callback', 'related', 'candidate'].includes(role)).join('/')} ${member.name ?? member.kind} (${member.locator})`).join(', ');
        const familyIds = new Set([item.id, ...linked.filter((member: any) => member.roles.includes('callback')).map((member: any) => member.id)]);
        const families = result.sourceFamilies.filter((value: any) => familyIds.has(value.subjectId));
        const available = families.flatMap((value: any) => value.facts ?? [])
          .filter((fact: any) => typeof fact.expression === 'string');
        const subjectGroups = new Set<number>(result.sourceFamilies.find((value: any) => value.subjectId === item.id)?.subjectMatchedGroups ?? []);
        const minimumGroups = Math.min(2, result.interpretation.termGroups.length);
        const matchingFacts = (includeSource ? available : []).flatMap((fact: any) => {
          // Calls, conditions and direct effects have distinct graph identities.
          // Do not summarize nested callable bodies as effects of their creator.
          if (fact.nestedCallable || !(fact.kind === 'call-reference' || fact.kind === 'source-condition'
            || (fact.kind === 'source-effect' && ['write', 'return', 'throw'].includes(fact.effectKind)))) return [];
          const matches = (fact.matchedLines ?? []).filter((line: any) => {
            const groups: number[] = line.groupIndexes ?? [];
            const combined = new Set([...subjectGroups, ...groups]);
            return combined.size >= minimumGroups
              && (groups.some(group => !subjectGroups.has(group)) || subjectGroups.size >= result.interpretation.termGroups.length);
          });
          return matches.length ? [{ ...fact, matchedLines: matches }] : [];
        });
        // Prefer expressions that directly mention more distinct concepts in
        // the question. Keep every tied fact and all graph records in details;
        // the owner's name alone must not promote every incidental expression.
        const directGroups = (fact: any): number => fact.matchedLines.reduce((best: number, line: any) => Math.max(best, (line.groupIndexes ?? []).length), 0);
        const strongestDirectMatch = matchingFacts.reduce((best: number, fact: any) => Math.max(best, directGroups(fact)), 0);
        const facts = groupIds ? matchingFacts.filter((fact: any) => fact.kind !== 'call-reference'
          || directGroups(fact) === strongestDirectMatch) : matchingFacts;
        // Name each distinct condition once so a sequence of guarded effects
        // remains readable without discarding which condition governs which fact.
        const conditions = new Map<string, number>();
        const shownLines = new Set<string>();
        let shownFacts = 0;
        const details = facts.flatMap((fact: any) => {
          const matches = Array.isArray(fact.matchedLines) ? fact.matchedLines : [];
          const qualification = JSON.stringify([(fact.requirements ?? []).map((requirement: any) => [requirement.predicate ?? requirement.conditionId, requirement.expectedTruth]),
            fact.requirementsComplete, fact.kind === 'call-reference' && fact.relationship?.status === 'candidate']);
          const unique = matches.filter((line: any) => {
            const key = JSON.stringify([fact.sourceId, line.line, line.text, qualification]);
            if (shownLines.has(key)) return false;
            shownLines.add(key); return true;
          });
          if (matches.length && !unique.length) return [];
          const expression = matches.length ? unique.map((line: any) => `${line.text}${line.line ? ` (line ${line.line})` : ''}`).join(' / ') : fact.expression;
          const requires = (fact.requirements ?? []).map((requirement: any) => {
            const text = String(requirement.predicate ?? requirement.conditionId);
            if (!conditions.has(text)) conditions.set(text, conditions.size + 1);
            return `${requirement.expectedTruth ? '' : 'not '}C${conditions.get(text)}`;
          });
          const prefix = fact.kind === 'call-reference' && fact.relationship?.status === 'candidate'
            ? fact.interpretation === 'call-or-conversion' ? 'possible invocation or conversion: ' : 'possible source call: '
            : '';
          shownFacts += 1;
          return [`${prefix}expression at ${fact.locator}${requires.length ? ` when ${requires.join(' and ')}` : ''}${fact.requirementsComplete ? '' : ' (additional control requirements not yet derived)'}: ${expression}`];
        }).join('; ');
        const remainingFacts = available.length - shownFacts;
        const otherMatchingFacts = matchingFacts.length - facts.length;
        const conditionDetails = [...conditions].map(([condition, number]) => `C${number}: ${condition}`).join('; ');
        const description = typeof item.value?.description === 'string' ? item.value.description : '';
        const interaction = item.kind === 'interaction-handler' && typeof item.value?.expression === 'string' ? item.value.expression : '';
        const sourceCalls = result.sourceFamilies.find((value: any) => value.subjectId === item.id)?.sourceCalls ?? [];
        const callSequence = sourceCalls.map((call: any) => {
          const line = /:(\d+)(?::|$)/u.exec(call.locator)?.[1];
          const target = call.name === call.targetName ? '' : ` → ${call.targetName}`;
          const status = call.occurrenceStatus === 'candidate' || call.bindingStatus === 'candidate' ? ' [candidate]' : '';
          return `${call.name}${line ? ` (line ${line})` : ''}${target}${status}`;
        }).join('; ');
        return `${item.name ?? item.id} (${item.locator})${description ? `: ${description}` : ''}${interaction ? `; handler expression: ${interaction}` : ''}${connections ? `; connected: ${connections}${groupIds ? ' (locations in connection details)' : ''}` : ''}${callSequence ? `; bound call sites in source order (branches and loops may apply): ${callSequence}` : ''}${details ? `; matching lines from source expressions: ${details}` : ''}${conditionDetails ? `; conditions: ${conditionDetails}` : ''}${remainingFacts ? `; ${remainingFacts} other source facts in details${otherMatchingFacts ? ` (${otherMatchingFacts} additional matching expressions)` : ''}` : ''}${family?.nextOffset !== null && family?.nextOffset !== undefined ? `; more related subjects at offset ${family.nextOffset}` : ''}`;
      };
      // Broad term matches are a ranked source scope, not one bound subject.
      // Compose visible source facts for that scope instead of asserting that
      // every incident relationship answers the question.
      const describedSubjects = new Map<string, boolean>();
      // Sibling paths with the same actual target, relationship and status
      // can share one presentation. Keep every original node and edge; this
      // neither merges entities nor treats candidate edges as resolved.
      const displayGroups: any[] = [];
      const siblingGroups = new Map<string, any>();
      for (const group of result.connectedGroups ?? []) {
        const edge = group.links?.length === 1 ? group.links[0] : null;
        const ids = new Set((group.subjects ?? []).map((node: any) => node.id));
        const sibling = edge && edge.from !== edge.to && ids.size === 2 && ids.has(edge.from) && ids.has(edge.to)
          && !(group.linkNodes?.length) ? JSON.stringify([group.sourceCategory, edge.kind, edge.status, edge.to]) : null;
        const existing = sibling ? siblingGroups.get(sibling) : null;
        if (!existing) {
          const copy = { ...group, subjects: [...group.subjects], links: [...group.links], linkNodes: [...(group.linkNodes ?? [])] };
          displayGroups.push(copy);
          if (sibling) siblingGroups.set(sibling, copy);
        } else {
          const members = new Set(existing.subjects.map((node: any) => node.id));
          for (const node of group.subjects) if (!members.has(node.id)) { members.add(node.id); existing.subjects.push(node); }
          const links = new Set(existing.links.map((item: any) => item.id));
          for (const item of group.links) if (!links.has(item.id)) { links.add(item.id); existing.links.push(item); }
        }
      }
      const scopedAnswer = !result.interpretation.negated && result.interpretation.selection === 'terms' && result.subjects.length
        ? (Array.isArray(result.connectedGroups)
          ? `Connected source paths (${result.connectedGroups.length} shown of ${result.connectedGroupTotal}; ${result.subjectTotal} matching subjects):\n\n`
            + displayGroups.map((group: any) => {
              const members: any[] = [...group.subjects, ...(group.linkNodes ?? [])];
              const names = new Map(members.map((item: any) => [item.id, item.name ?? item.id]));
              const groupIds = new Set<string>(members.map((item: any) => item.id));
              const outgoing = new Map<string, any[]>();
              const incoming = new Set<string>();
              for (const edge of group.links) {
                const rows = outgoing.get(edge.from) ?? [];
                rows.push(edge); outgoing.set(edge.from, rows); incoming.add(edge.to);
              }
              // Order graph connections from entry subjects through their
              // neighbors. This is navigational order, not execution order.
              const queue: string[] = members.filter(item => !incoming.has(item.id)).map(item => item.id);
              const visitedNodes = new Set<string>(), visitedEdges = new Set<string>(), ordered: any[] = [];
              let nextIndex = 0;
              const walk = (): void => {
                while (nextIndex < queue.length) {
                  const id = queue[nextIndex++]!;
                  if (visitedNodes.has(id)) continue;
                  visitedNodes.add(id);
                  for (const edge of outgoing.get(id) ?? []) {
                    if (!visitedEdges.has(edge.id)) { ordered.push(edge); visitedEdges.add(edge.id); }
                    if (!visitedNodes.has(edge.to)) queue.push(edge.to);
                  }
                }
              };
              walk();
              for (const item of members) if (!visitedNodes.has(item.id)) { queue.push(item.id); walk(); }
              const links = ordered.map((edge: any) => `${names.get(edge.from) ?? edge.from} ${edge.kind}${edge.status === 'candidate' ? ' (candidate)' : ''} ${names.get(edge.to) ?? edge.to}`).join('; ');
              return `${group.sourceCategory === 'test-source' ? 'Test source' : 'Source'}${links ? ` — relationships: ${links}` : ''}\n${group.subjects.map((item: any) => {
                const includeSource = true;
                const previous = describedSubjects.get(item.id);
                if (previous === true || (previous === false && !includeSource)) return `• ${item.name ?? item.id} (${item.locator}; described above)`;
                describedSubjects.set(item.id, includeSource);
                return `• ${describeFamily(item, groupIds, includeSource)}`;
              }).join('\n')}`;
            }).join('\n\n')
          : `Relevant source subjects (${result.subjects.length} shown of ${result.subjectTotal}): ${result.subjects.map((item: any) => describeFamily(item)).join(' | ')}`)
          + '. Paths follow source relationships; a subject can appear in multiple paths, and candidate links identify possible handoffs. Inspect source and connection details for full records.'
        : '';
      const familyAnswer = !result.interpretation.negated && subject && !result.navigation.operation
        && result.families.some((family: any) => family.id === subject.id && family.total)
        ? `${describeFamily(subject)}. Inspect the related subjects and source details for the complete records.` : '';
      const ambiguousAnswer = result.interpretation.selection === 'exact-name' && result.subjectTotal > 1 && !related.length
        ? `The name matches ${result.subjectTotal} source subjects: ${result.subjects.map((item: any) => `${item.name ?? item.id} (${item.locator})`).join('; ')}. Select a subject or scope to investigate it${result.page.nextOffset !== null ? `; more subjects at offset ${result.page.nextOffset}` : ''}.`
        : '';
      const answer = comparisonAnswer || (result.interpretation.negated
        ? 'The graph matches subjects for this question, but the requested negative conclusion is not established. Narrow the subject and relationship or supply a comparison scope.'
        : '') || relationshipAnswer || scopedAnswer || (focus.length
        ? `${subject.name ?? subject.id}: ${focus.map((fact: any) => `${fact.expression}${fact.locator ? ` at ${fact.locator}` : ''}${fact.requirements.length ? ` when ${fact.requirements.map((requirement: any) => `${requirement.expectedTruth ? '' : 'not '}(${requirement.predicate ?? requirement.conditionId})`).join(' and ')}` : ''}${fact.controlContext.length ? ` within ${fact.controlContext.map((context: any) => `${context.kind}${context.expression ? ` (${context.expression}${context.caseValue ? `; case ${context.caseValue}` : ''})` : ''}`).join(' > ')}` : ''}${fact.requirementsComplete ? '' : ' (additional control requirements not yet derived)'}`).join('; ')}`
        : '') || familyAnswer || ambiguousAnswer || `Found ${result.subjectTotal} matching subjects and ${result.navigation.total} matching relationships in the ${result.navigation.direction} direction.${result.interpretation.negated ? ' The question’s negative wording is retained in the result.' : ''}`;
      const sourceAnalysis = (result.sourceAnalysis ?? []).map((item: any) => `${item.technology}: ${item.precision}`).join('; ');
      const lexicalCoverage = result.interpretation.lexicalCoverage;
      const selectionNote = lexicalCoverage && lexicalCoverage.bestDisplayedSubject < lexicalCoverage.termGroups
        ? `\n\nSelection is incomplete: the strongest displayed subject matches ${lexicalCoverage.bestDisplayedSubject} of ${lexicalCoverage.termGroups} question-term groups. These sources may not answer the full question; refine the subject or inspect more results.` : '';
      const excludedNote = lexicalCoverage?.excludedWeakerMatches
        ? `\n\n${lexicalCoverage.excludedWeakerMatches} subjects matched fewer question concepts and were excluded from this selection; refine the question or scope to inspect them.` : '';
      items.push({ index, question, status: 'ok', intent: 'graph-filter', subject,
        ...(inheritedScope ? { inheritedSubject: inheritedScope } : {}),
        answer: `${answer}${selectionNote}${excludedNote}${sourceAnalysis ? `\n\nSource analysis: ${sourceAnalysis}.` : ''}` ,
        routing: { tool: 'graph-filter', selection: result.interpretation.selection }, investigation: questionSelection(graph, result), result });
    }
    const request = { mode, graphId: graph.graphId, revision: graph.repositoryRevision, ...(graph.sourceState ? { sourceState: graph.sourceState } : {}),
      questionCount: questions.length, originalText: originalText || null,
      ...((input.rankBy || input.semanticDepth) && items.some(item => item.intent === 'graph-filter') ? { unappliedOptions: [
        ...(input.rankBy ? ['rankBy'] : []), ...(input.semanticDepth ? ['semanticDepth'] : []),
      ] } : {}) };
    if (items.length === 1 && items[0]!.status === 'ok') return { ...items[0], request };
    return { project: input.project, graphId: graph.graphId, revision: graph.repositoryRevision, request, items };
  }

  const items: Array<Record<string, unknown>> = [];
  for (const [index, question] of questions.entries()) {
    try {
      if (!question) throw new Error('Question is empty');
      const result = await queryTechnicalSource({ project: input.project, sourceId: input.sourceId,
        capability: input.capability, query: question });
      items.push({ index, question, status: 'ok', intent: 'source-query', subject: null,
        routing: { tool: 'query_source', sourceId: input.sourceId },
        answer: `Read-only query sent to ${input.sourceId}.`, result });
    } catch (error) {
      items.push({ index, question, status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }
  const request = { mode, graphId: graph.graphId, revision: graph.repositoryRevision, ...(graph.sourceState ? { sourceState: graph.sourceState } : {}),
    questionCount: questions.length, originalText: originalText || null };
  if (items.length === 1 && items[0]!.status === 'ok') return { ...items[0], request };
  return { project: input.project, graphId: graph.graphId, revision: graph.repositoryRevision, request, items };
  };

  if (!input.sourceId && !input.rankBy && !input.semanticDepth && questions.length === 1 && questions.every(Boolean)) {
    const analyzed = questions.map(text => ({ text, terms: interpretGraphLanguage(text).terms }));
    const repositoryWords = new Set(['project', 'repository', 'repo', 'codebase']);
    const needsRepository = analyzed.some(item => item.terms.length && item.terms.every(term => repositoryWords.has(term)));
    if (!needsRepository) {
      let candidateSource: IntelligenceGraph | undefined;
      const result = await withIndexedLocalGraph(input.project, { ref: input.ref, graphId: input.graphId }, async envelope => {
        candidateSource = envelope;
        const plannedInput = filterInput(questions[0]!, input.scope);
        let planned: ReturnType<typeof planGraphSubjects> | undefined;
        const graph = materializeIndexedQuestionGraph(envelope, analyzed, {
          selectSubjects(candidate) { planned = planGraphSubjects(candidate, plannedInput); return planned.subjects.map(node => node.id); },
          rememberSelection(selected) {
            if (!planned) return;
            const fullSubjects = new Map(selected.nodes.map(node => [node.id, node]));
            planned.subjects = planned.subjects.map(node => {
              const full = fullSubjects.get(node.id);
              if (!full) throw new Error(`Selected graph subject is unavailable: ${node.id}`);
              return full;
            });
            rememberGraphSubjects(selected, plannedInput, planned);
          },
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          ...(input.scope ? { scope: input.scope } : {}),
          ...(input.comparisonIds?.length ? { comparisonIds: input.comparisonIds } : {}),
          ...(input.comparisonScope ? { comparisonScope: input.comparisonScope } : {}),
          ...(input.comparisonKinds?.length ? { comparisonKinds: input.comparisonKinds } : {}),
        });
        return graph ? await run(graph) : null;
      }, run);
      if (result) return result;
      if (candidateSource) {
        const graph = await currentGraph(input.project, input.ref, input.graphId);
        return await run(graph);
      }
    }
  }
  return await run(await currentGraph(input.project, input.ref, input.graphId));
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
    note: 'Technical sources are operational read-only inputs. Query results retain their own evidence and observation provenance.',
  };
}
