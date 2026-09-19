import path from 'node:path';
import { getProjectConfig } from '../config/registry.js';
import { changedFilesBetweenRevisions, revisionIdentity } from '../source/git.js';
import type { GraphEdge, GraphNode, GraphNodeLayer, GraphCoverageStatus, IntelligenceGraph, RelationshipStatus } from '../types.js';
import { checkpointProjection, stableEdgeShape, stableNodeShape } from './repository.js';
import { currentGraph, graphContext, repositoryGraphs } from './service.js';
import { SOURCE_ANALYSIS_SUPPORT } from './analyzers/index.js';
import { graphQueryContext, type GraphQueryContext } from './queryContext.js';

function nodeText(node: GraphNode): string {
  return [node.id, node.kind, node.layer, node.locator, node.field, node.name, node.raw, JSON.stringify(node.value)].filter(Boolean).join(' ').toLowerCase();
}

function edgeText(edge: GraphEdge): string {
  return [edge.id, edge.kind, edge.layer, edge.strategy, edge.status, ...edge.evidence].join(' ').toLowerCase();
}

function layersMatch(layer: GraphNodeLayer | undefined, layers: Set<GraphNodeLayer>): boolean {
  return !layers.size || layers.has(layer ?? 'structural');
}

function coverageSummary(graph: IntelligenceGraph): Record<string, unknown> | null {
  const coverage = graph.coverage;
  if (!coverage) return null;
  return {
    trackedFiles: coverage.trackedFiles,
    eligibleFiles: coverage.eligibleFiles,
    analyzedFiles: coverage.analyzedFiles,
    completeFiles: coverage.completeFiles,
    partialFiles: coverage.partialFiles,
    failedFiles: coverage.failedFiles,
    skippedFiles: coverage.skippedFiles,
    unsupportedFiles: coverage.unsupportedFiles,
    completeForEligibleSources: coverage.failedFiles === 0 && coverage.partialFiles === 0 && coverage.skippedFiles === 0 && coverage.analyzedFiles === coverage.eligibleFiles,
  };
}

export function findGraphNodeCandidates(graph: IntelligenceGraph, query: string, limit = 20): GraphNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const exactId = graph.nodes.find(node => node.id === query);
  if (exactId) return [exactId];
  const exactName = graph.nodes.filter(node => node.name?.toLowerCase() === needle);
  if (exactName.length) return exactName.slice(0, limit);
  return graph.nodes.filter(node => nodeText(node).includes(needle)).slice(0, limit);
}

function comparableItem<T extends { id: string }>(item: T): unknown {
  const node = item as unknown as GraphNode;
  if ('sourceId' in (item as any) && node.layer === 'semantic') return stableNodeShape(node);
  const edge = item as unknown as GraphEdge;
  if ('status' in (item as any) && edge.layer === 'semantic') return stableEdgeShape(edge);
  return item;
}

function diffById<T extends { id: string }>(left: T[], right: T[]) {
  const a = new Map(left.map(item => [item.id, item]));
  const b = new Map(right.map(item => [item.id, item]));
  const added: T[] = [];
  const removed: T[] = [];
  const changed: Array<{ before: T; after: T }> = [];
  for (const [id, item] of b) {
    const previous = a.get(id);
    if (!previous) added.push(item);
    else if (JSON.stringify(comparableItem(previous)) !== JSON.stringify(comparableItem(item))) changed.push({ before: previous, after: item });
  }
  for (const [id, item] of a) if (!b.has(id)) removed.push(item);
  return { added, removed, changed };
}

function filteredGraph(graph: IntelligenceGraph, layers?: GraphNodeLayer[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const allowed = new Set(layers ?? []);
  const nodes = graph.nodes.filter(node => layersMatch(node.layer, allowed));
  const ids = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => layersMatch(edge.layer, allowed) && (!edge.from || ids.has(edge.from)) && (!edge.to || ids.has(edge.to)));
  return { nodes, edges };
}

export function diffGraphs(base: IntelligenceGraph, head: IntelligenceGraph, layers?: GraphNodeLayer[]): Record<string, unknown> {
  const left = filteredGraph(base, layers);
  const right = filteredGraph(head, layers);
  return {
    project: head.project,
    layers: layers?.length ? layers : ['semantic', 'structural', 'representation'],
    base: { graphId: base.graphId, role: base.role, revision: base.repositoryRevision, sourceFingerprint: base.sourceFingerprint, topologyFingerprint: base.topologyFingerprint, evidenceFingerprint: base.evidenceFingerprint, analyzerVersion: base.analyzerVersion },
    head: { graphId: head.graphId, role: head.role, revision: head.repositoryRevision, sourceFingerprint: head.sourceFingerprint, topologyFingerprint: head.topologyFingerprint, evidenceFingerprint: head.evidenceFingerprint, analyzerVersion: head.analyzerVersion },
    topologyChanged: base.topologyFingerprint !== head.topologyFingerprint,
    evidenceChanged: base.evidenceFingerprint !== head.evidenceFingerprint,
    analyzerChanged: base.analyzerVersion !== head.analyzerVersion,
    nodes: diffById(left.nodes, right.nodes),
    edges: diffById(left.edges, right.edges),
  };
}

export async function diffAcceptedToWorking(project: string, ref?: string): Promise<Record<string, unknown>> {
  const { accepted, working, acceptedCurrent, currentness } = await repositoryGraphs(project, ref);
  const projection = checkpointProjection(working);
  const workingSemantic: IntelligenceGraph = { ...working, nodes: projection.nodes, edges: projection.edges };
  if (!accepted) return {
    project,
    base: null,
    head: { graphId: working.graphId, role: working.role, revision: working.repositoryRevision, topologyFingerprint: working.topologyFingerprint, evidenceFingerprint: working.evidenceFingerprint },
    acceptedCurrent: false,
    currentness,
    semantic: {
      nodes: { added: projection.nodes, removed: [], changed: [] },
      edges: { added: projection.edges, removed: [], changed: [] },
    },
    note: 'Accepted checkpoints persist stable semantic topology only. Use a ref-to-ref diff for structural/code change analysis.',
  };
  const semantic = diffGraphs(accepted, workingSemantic, ['semantic']);
  return { project, acceptedCurrent, currentness, semantic, note: 'Accepted A/B checkpoints are semantic topology projections; provenance/evidence drift is reported separately and structural diffs require two Git revisions analyzed with the same current analyzer.' };
}

export async function diffRevisions(input: {
  project: string;
  ref?: string;
  baseRef?: string;
  layers?: GraphNodeLayer[];
}): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(input.project);
  const headRef = input.ref ?? config.defaultRef;
  const baseRef = input.baseRef ?? config.defaultRef;
  const [base, head] = await Promise.all([
    graphContext(input.project, { ref: baseRef }),
    graphContext(input.project, { ref: headRef }),
  ]);
  const result = diffGraphs(base.graph, head.graph, input.layers) as any;
  return {
    ...result,
    comparisonMode: 'current-analyzer-replay',
    base: { ...result.base, identity: revisionIdentity(base.revision) },
    head: { ...result.head, identity: revisionIdentity(head.revision) },
  };
}

interface ImpactTraversalOptions {
  direction?: 'inbound' | 'outbound' | 'both';
  depth?: number;
  relationshipKinds?: string[];
  statuses?: RelationshipStatus[];
  layers?: GraphNodeLayer[];
  limit?: number;
}

function nodePath(node: GraphNode): string {
  if (node.sourceId.startsWith('repo:')) return node.sourceId.slice('repo:'.length);
  return locatorFileAndLine(node.locator).file;
}

function changedPathSets(files: Array<{ status: string; path: string; previousPath?: string }>): { base: Set<string>; head: Set<string> } {
  const base = new Set<string>();
  const head = new Set<string>();
  for (const file of files) {
    const kind = file.status.charAt(0);
    if (kind !== 'A') base.add(file.previousPath ?? file.path);
    if (kind !== 'D') head.add(file.path);
  }
  return { base, head };
}

function nodesForChangedPaths(graph: IntelligenceGraph, paths: ReadonlySet<string>, layers?: GraphNodeLayer[]): GraphNode[] {
  const allowedLayers = new Set(layers ?? []);
  return graph.nodes.filter(node => paths.has(nodePath(node)) && layersMatch(node.layer, allowedLayers));
}

function impactNeighborhood(
  graph: IntelligenceGraph,
  seeds: GraphNode[],
  options: ImpactTraversalOptions,
): Record<string, unknown> {
  const context = graphQueryContext(graph);
  const direction = options.direction ?? 'inbound';
  const maxDepth = Math.min(Math.max(options.depth ?? 3, 0), 10);
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
  const allowedKinds = new Set(options.relationshipKinds ?? []);
  const allowedStatuses = new Set(options.statuses ?? ['resolved']);
  const allowedLayers = new Set(options.layers ?? []);
  const uniqueSeeds = [...new Map(seeds.map(node => [node.id, node])).values()];
  const boundedSeeds = uniqueSeeds.slice(0, limit);
  const visited = new Set(boundedSeeds.map(node => node.id));
  const hops = new Map(boundedSeeds.map(node => [node.id, 0]));
  const selectedEdges: GraphEdge[] = [];
  const selectedEdgeIds = new Set<string>();
  let frontier = boundedSeeds.map(node => node.id);
  let reachedLimit = uniqueSeeds.length > boundedSeeds.length;

  for (let depth = 0; depth < maxDepth && frontier.length && !reachedLimit; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      const candidates = direction === 'inbound'
        ? context.incoming(current)
        : direction === 'outbound'
          ? context.outgoing(current)
          : context.incident(current);
      for (const edge of candidates) {
        if (!allowedStatuses.has(edge.status) || !edge.from || !edge.to) continue;
        if (allowedKinds.size && !allowedKinds.has(edge.kind)) continue;
        if (!layersMatch(edge.layer, allowedLayers)) continue;
        let neighbor: string | null = null;
        if ((direction === 'outbound' || direction === 'both') && edge.from === current) neighbor = edge.to;
        if (!neighbor && (direction === 'inbound' || direction === 'both') && edge.to === current) neighbor = edge.from;
        if (!neighbor) continue;
        if (!selectedEdgeIds.has(edge.id)) {
          selectedEdgeIds.add(edge.id);
          selectedEdges.push(edge);
        }
        if (visited.has(neighbor)) continue;
        if (visited.size >= limit) {
          reachedLimit = true;
          break;
        }
        visited.add(neighbor);
        hops.set(neighbor, depth + 1);
        next.push(neighbor);
      }
      if (reachedLimit) break;
    }
    frontier = next;
  }

  const nodes = [...visited].map(id => context.node(id)).filter((node): node is GraphNode => Boolean(node));
  const pathSet = new Set(nodes.map(node => nodePath(node)));
  return {
    seedTotal: uniqueSeeds.length,
    seedIds: boundedSeeds.map(node => node.id),
    seedTruncated: uniqueSeeds.length > boundedSeeds.length,
    direction,
    depth: maxDepth,
    limit,
    truncated: reachedLimit,
    nodeTotal: nodes.length,
    edgeTotal: selectedEdges.length,
    paths: [...pathSet].sort(),
    hops: Object.fromEntries([...hops.entries()]),
    nodes,
    edges: selectedEdges,
  };
}

export async function analyzeImpact(input: {
  project: string;
  baseRef: string;
  ref?: string;
  direction?: 'inbound' | 'outbound' | 'both';
  depth?: number;
  relationshipKinds?: string[];
  statuses?: RelationshipStatus[];
  layers?: GraphNodeLayer[];
  limit?: number;
}): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(input.project);
  const headRef = input.ref ?? config.defaultRef;
  const changes = await changedFilesBetweenRevisions(input.project, input.baseRef, headRef);
  const [base, head] = await Promise.all([
    graphContext(input.project, { ref: input.baseRef }),
    graphContext(input.project, { ref: headRef }),
  ]);
  if (base.graph.repositoryRevision !== changes.base.sha || head.graph.repositoryRevision !== changes.head.sha) {
    throw new Error('Repository revision changed while preparing impact analysis; retry against immutable selectors');
  }

  const paths = changedPathSets(changes.files);
  const baseSeeds = nodesForChangedPaths(base.graph, paths.base, input.layers);
  const headSeeds = nodesForChangedPaths(head.graph, paths.head, input.layers);
  const mappedBasePaths = new Set(baseSeeds.map(node => nodePath(node)));
  const mappedHeadPaths = new Set(headSeeds.map(node => nodePath(node)));
  const graphDiff = diffGraphs(base.graph, head.graph, input.layers) as any;

  return {
    project: input.project,
    comparisonMode: 'current-analyzer-replay',
    base: {
      graphId: base.graph.graphId,
      revision: base.graph.repositoryRevision,
      identity: revisionIdentity(changes.base),
      coverage: coverageSummary(base.graph),
    },
    head: {
      graphId: head.graph.graphId,
      revision: head.graph.repositoryRevision,
      identity: revisionIdentity(changes.head),
      coverage: coverageSummary(head.graph),
    },
    changedFiles: changes.files,
    changedFileCount: changes.files.length,
    mapping: {
      baseUnmappedPaths: [...paths.base].filter(path => !mappedBasePaths.has(path)).sort(),
      headUnmappedPaths: [...paths.head].filter(path => !mappedHeadPaths.has(path)).sort(),
    },
    topology: {
      topologyChanged: graphDiff.topologyChanged,
      evidenceChanged: graphDiff.evidenceChanged,
      analyzerChanged: graphDiff.analyzerChanged,
      nodeCounts: {
        added: graphDiff.nodes.added.length,
        removed: graphDiff.nodes.removed.length,
        changed: graphDiff.nodes.changed.length,
      },
      edgeCounts: {
        added: graphDiff.edges.added.length,
        removed: graphDiff.edges.removed.length,
        changed: graphDiff.edges.changed.length,
      },
    },
    beforeImpact: impactNeighborhood(base.graph, baseSeeds, input),
    afterImpact: impactNeighborhood(head.graph, headSeeds, input),
    note: 'Impact is seeded from actual Git changed paths, then projected through the selected revision graphs. Resolved relationships are used by default; candidate or unresolved relationships are included only when explicitly requested. Coverage and unmapped changed paths remain explicit.',
  };
}

interface SearchGraphInput {
  project: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  query?: string | undefined;
  queries?: string[] | undefined;
  kinds?: string[] | undefined;
  sourceIds?: string[] | undefined;
  statuses?: RelationshipStatus[] | undefined;
  layers?: GraphNodeLayer[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function searchGraphResult(graph: IntelligenceGraph, input: SearchGraphInput, requestedQuery?: string): Record<string, unknown> {
  const query = requestedQuery?.trim().toLowerCase();
  const kinds = new Set(input.kinds ?? []);
  const sourceIds = new Set(input.sourceIds ?? []);
  const statuses = new Set(input.statuses ?? []);
  const layers = new Set(input.layers ?? []);
  const nodes = graph.nodes.filter(node => {
    if (kinds.size && !kinds.has(node.kind)) return false;
    if (sourceIds.size && !sourceIds.has(node.sourceId)) return false;
    if (!layersMatch(node.layer, layers)) return false;
    return !query || nodeText(node).includes(query);
  });
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => {
    if (statuses.size && !statuses.has(edge.status)) return false;
    if (!layersMatch(edge.layer, layers)) return false;
    if (query && !edgeText(edge).includes(query) && !(edge.from && nodeIds.has(edge.from)) && !(edge.to && nodeIds.has(edge.to))) return false;
    return true;
  });
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const offset = Math.max(input.offset ?? 0, 0);
  return {
    ...(requestedQuery === undefined ? {} : { query: requestedQuery }),
    nodeTotal: nodes.length,
    edgeTotal: edges.length,
    nodes: nodes.slice(offset, offset + limit),
    edges: edges.slice(offset, offset + limit),
  };
}

export async function searchGraph(input: SearchGraphInput): Promise<Record<string, unknown>> {
  if (input.query && input.queries?.length) throw new Error('Use either query or queries, not both');
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const common = {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    role: graph.role,
    coverage: coverageSummary(graph),
    explicitValueConflicts: graph.explicitValueConflicts,
  };
  if (input.queries) {
    const queries = input.queries.map(query => query.trim()).filter(Boolean);
    if (!queries.length) throw new Error('queries must contain at least one non-empty string');
    return { ...common, results: queries.map(query => searchGraphResult(graph, input, query)) };
  }
  return { ...common, ...searchGraphResult(graph, input, input.query) };
}

export async function traceGraph(input: {
  project: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  node?: string | undefined;
  direction?: 'inbound' | 'outbound' | 'both' | undefined;
  depth?: number | undefined;
  relationshipKinds?: string[] | undefined;
  statuses?: RelationshipStatus[] | undefined;
  layers?: GraphNodeLayer[] | undefined;
  limit?: number | undefined;
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const query = input.node?.trim();
  if (!query) throw new Error('node must be a non-empty graph node id/name/query');
  const candidates = findGraphNodeCandidates(graph, query, 20);
  if (!candidates.length) throw new Error(`Graph node not found: ${input.node}`);
  if (candidates.length > 1 && !candidates.some(node => node.id === query)) {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: true,
      query,
      candidates: candidates.map(node => ({ id: node.id, kind: node.kind, layer: node.layer ?? 'structural', name: node.name ?? null, locator: node.locator })),
      instruction: 'Retry trace_path with an exact node id.',
      nodes: [],
      edges: [],
    };
  }
  const start = candidates.find(node => node.id === query) ?? candidates[0]!;
  const context = graphQueryContext(graph);
  const allowedKinds = new Set(input.relationshipKinds ?? []);
  const allowedStatuses = new Set(input.statuses ?? ['resolved']);
  const allowedLayers = new Set(input.layers ?? []);
  const maxDepth = Math.min(Math.max(input.depth ?? 3, 0), 10);
  const limit = Math.min(Math.max(input.limit ?? 250, 1), 2000);
  const direction = input.direction ?? 'both';
  const visited = new Set<string>([start.id]);
  const selectedEdges: GraphEdge[] = [];
  const selectedEdgeIds = new Set<string>();
  let frontier = [start.id];
  for (let depth = 0; depth < maxDepth && frontier.length && visited.size < limit; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of context.incident(current)) {
        if (!allowedStatuses.has(edge.status) || !edge.from || !edge.to) continue;
        if (allowedKinds.size && !allowedKinds.has(edge.kind)) continue;
        if (!layersMatch(edge.layer, allowedLayers)) continue;
        let neighbor: string | null = null;
        if ((direction === 'outbound' || direction === 'both') && edge.from === current) neighbor = edge.to;
        else if ((direction === 'inbound' || direction === 'both') && edge.to === current) neighbor = edge.from;
        if (!neighbor) continue;
        if (!selectedEdgeIds.has(edge.id)) { selectedEdgeIds.add(edge.id); selectedEdges.push(edge); }
        if (!visited.has(neighbor) && visited.size < limit) { visited.add(neighbor); next.push(neighbor); }
      }
    }
    frontier = next;
  }
  return {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    coverage: coverageSummary(graph),
    ambiguous: false,
    start,
    nodes: [...visited].map(id => context.node(id)).filter(Boolean),
    edges: selectedEdges,
  };
}

function architectureArea(node: GraphNode): string {
  const file = locatorFileAndLine(node.locator).file;
  const parts = file.split('/');
  if (parts[0] === 'src' && parts[1] === 'features' && parts[2]) return `feature:${parts[2]}`;
  if (parts[0] === 'src' && parts[1] === 'app') return 'app';
  if (parts[0] === 'src' && parts[1]) return `src/${parts[1]}`;
  return parts[0] || '(root)';
}

export async function graphArchitecture(project: string, ref?: string, graphId?: string): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref, graphId);
  const context = graphQueryContext(graph);
  const kinds: Record<string, number> = {};
  const relationshipKinds: Record<string, number> = {};
  const relationshipStatuses: Record<string, number> = {};
  const layers: Record<string, number> = {};
  for (const node of graph.nodes) {
    kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
    const layer = node.layer ?? 'structural';
    layers[layer] = (layers[layer] ?? 0) + 1;
  }
  for (const edge of graph.edges) {
    relationshipKinds[edge.kind] = (relationshipKinds[edge.kind] ?? 0) + 1;
    relationshipStatuses[edge.status] = (relationshipStatuses[edge.status] ?? 0) + 1;
  }

  const semanticFeatures = graph.nodes.filter(node => node.layer === 'semantic' && node.kind === 'feature');
  const featureIds = new Set(semanticFeatures.map(node => node.id));
  const features = semanticFeatures.map(feature => {
    const outgoing = context.outgoing(feature.id).filter(edge => edge.status === 'resolved');
    const incoming = context.incoming(feature.id).filter(edge => edge.status === 'resolved');
    const related = context.incident(feature.id);
    return {
      id: feature.id,
      name: feature.name ?? feature.id.slice('feature:'.length),
      dependsOn: outgoing.filter(edge => edge.kind === 'depends-on' && edge.to && featureIds.has(edge.to)).map(edge => edge.to),
      usedBy: incoming.filter(edge => edge.kind === 'depends-on' && edge.from && featureIds.has(edge.from)).map(edge => edge.from),
      apiCount: incoming.filter(edge => edge.kind === 'uses-feature' && edge.from?.startsWith('api:')).length,
      routeCount: incoming.filter(edge => edge.kind === 'composes' && edge.from?.startsWith('route:')).length,
      mcpCount: incoming.filter(edge => edge.kind === 'implemented-by' && edge.from?.startsWith('mcp:')).length,
      providerCount: outgoing.filter(edge => edge.kind === 'integrates-with' && edge.to?.startsWith('provider:')).length,
      candidateRelations: related.filter(edge => edge.status === 'candidate').length,
      unresolvedRelations: related.filter(edge => edge.status === 'unresolved').length,
    };
  }).sort((a, b) => (b.dependsOn.length + b.usedBy.length + b.apiCount + b.routeCount + b.mcpCount) - (a.dependsOn.length + a.usedBy.length + a.apiCount + a.routeCount + a.mcpCount));

  const areas = new Map<string, { nodes: number; kinds: Record<string, number> }>();
  for (const node of graph.nodes.filter(node => node.layer !== 'semantic')) {
    const area = architectureArea(node);
    const bucket = areas.get(area) ?? { nodes: 0, kinds: {} };
    bucket.nodes += 1;
    bucket.kinds[node.kind] = (bucket.kinds[node.kind] ?? 0) + 1;
    areas.set(area, bucket);
  }

  return {
    project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    sourceFingerprint: graph.sourceFingerprint,
    topologyFingerprint: graph.topologyFingerprint,
    analyzerVersion: graph.analyzerVersion,
    coverage: coverageSummary(graph),
    explicitValueConflicts: graph.explicitValueConflicts,
    summary: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      semanticNodes: graph.nodes.filter(node => node.layer === 'semantic').length,
      structuralNodes: graph.nodes.filter(node => (node.layer ?? 'structural') === 'structural').length,
      representationNodes: graph.nodes.filter(node => node.layer === 'representation').length,
      resolvedEdges: context.edgesByStatus.get('resolved')?.length ?? 0,
      candidateEdges: context.edgesByStatus.get('candidate')?.length ?? 0,
      unresolvedEdges: context.edgesByStatus.get('unresolved')?.length ?? 0,
      nodeKinds: kinds,
      relationshipKinds,
      relationshipStatuses,
      layers,
    },
    features,
    areas: [...areas.entries()].sort((a, b) => b[1].nodes - a[1].nodes).map(([name, value]) => ({ name, ...value })),
  };
}

export async function graphSchema(project: string, ref?: string, graphId?: string): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref, graphId);
  return {
    schemaVersion: graph.schemaVersion,
    analyzerVersion: graph.analyzerVersion,
    nodeKinds: [...new Set(graph.nodes.map(node => node.kind))].sort(),
    relationshipKinds: [...new Set(graph.edges.map(edge => edge.kind))].sort(),
    relationshipStatuses: ['resolved', 'candidate', 'unresolved'],
    layers: ['semantic', 'structural', 'representation'],
    coverageStatuses: ['complete', 'partial', 'unsupported', 'skipped', 'failed'],
    sourceAnalysisSupport: SOURCE_ANALYSIS_SUPPORT,
    nodeFields: ['id', 'sourceId', 'kind', 'locator', 'field?', 'name?', 'value', 'raw', 'tags?', 'layer?', 'checkpoint?', 'evidenceIds?'],
    edgeFields: ['id', 'from', 'to', 'kind', 'strategy', 'confidence', 'status', 'evidence', 'layer?', 'checkpoint?', 'evidenceIds?'],
    evidenceFields: ['id', 'sourceId', 'kind', 'locator', 'message?', 'field?', 'value?'],
  };
}

export async function graphCoverage(project: string, ref?: string, graphId?: string, pathPrefix?: string, statuses?: GraphCoverageStatus[]): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref, graphId);
  const selectedStatuses = new Set(statuses ?? []);
  const normalizedPrefix = pathPrefix?.replace(/^\.\//u, '');
  const files = (graph.coverage?.files ?? []).filter(file => (!normalizedPrefix || file.path.startsWith(normalizedPrefix)) && (!selectedStatuses.size || selectedStatuses.has(file.status)));
  return {
    project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    coverage: graph.coverage ? { ...graph.coverage, files } : null,
    summary: coverageSummary(graph),
    unavailableSourceIds: graph.unavailableSourceIds,
  };
}

function semanticNeighborhood(graph: IntelligenceGraph, context: GraphQueryContext, entityIds: Set<string>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const edgeIds = new Set<string>();
  for (const entityId of entityIds) for (const edge of context.incident(entityId)) if (edge.layer === 'semantic') edgeIds.add(edge.id);
  const edges = graph.edges.filter(edge => edgeIds.has(edge.id));
  const ids = new Set(entityIds);
  for (const edge of edges) {
    if (edge.from) ids.add(edge.from);
    if (edge.to) ids.add(edge.to);
  }
  return { nodes: graph.nodes.filter(node => ids.has(node.id)), edges };
}

interface ParityLensInput {
  project: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  query?: string | undefined;
  queries?: string[] | undefined;
  kinds?: string[] | undefined;
  sourceIds?: string[] | undefined;
  status?: RelationshipStatus[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function parityLensResult(graph: IntelligenceGraph, context: GraphQueryContext, input: ParityLensInput, requestedQuery?: string): Record<string, unknown> {
  const query = requestedQuery?.trim().toLowerCase();
  const kinds = new Set(input.kinds ?? []);
  const offset = Math.max(input.offset ?? 0, 0);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  let semantic = graph.nodes.filter(node => node.layer === 'semantic' && (!kinds.size || kinds.has(node.kind)) && (!query || nodeText(node).includes(query)));
  if (input.sourceIds?.length) {
    const sourceIds = new Set(input.sourceIds);
    semantic = semantic.filter(node => sourceIds.has(node.sourceId));
  }
  const selected = semantic.slice(offset, offset + limit);
  const neighborhood = semanticNeighborhood(graph, context, new Set(selected.map(node => node.id)));
  const status = new Set(input.status ?? []);
  const relationships = neighborhood.edges.filter(edge => !status.size || status.has(edge.status));
  const representations = selected.map(entity => {
    const related = context.incident(entity.id);
    const resolved = related.filter(edge => edge.status === 'resolved');
    const connected = (prefix: string) => [...new Set(resolved.flatMap(edge => [edge.from, edge.to]).filter((id): id is string => Boolean(id && id.startsWith(prefix))))];
    return {
      entityId: entity.id,
      kind: entity.kind,
      name: entity.name ?? entity.id,
      surfaces: connected('surface:'),
      actions: connected('action:'),
      routes: connected('route:'),
      apis: connected('api:'),
      mcp: connected('mcp:'),
      providers: connected('provider:'),
      tools: connected('tool:'),
      candidateRelationships: related.filter(edge => edge.status === 'candidate'),
      unresolvedRelationships: related.filter(edge => edge.status === 'unresolved'),
    };
  });
  return {
    ...(requestedQuery === undefined ? {} : { query: requestedQuery }),
    entityTotal: semantic.length,
    entities: selected,
    relationships,
    representations,
    namingDivergences: graph.namingDivergences.filter(item => !query || `${item.fromName} ${item.toName}`.toLowerCase().includes(query)).slice(offset, offset + limit),
    unmatchedNodeIds: graph.unmatchedNodeIds.slice(offset, offset + limit),
    unavailableSourceIds: graph.unavailableSourceIds,
  };
}

export async function parityLens(input: ParityLensInput): Promise<Record<string, unknown>> {
  if (input.query && input.queries?.length) throw new Error('Use either query or queries, not both');
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const context = graphQueryContext(graph);
  const common = {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    topologyFingerprint: graph.topologyFingerprint,
    coverage: coverageSummary(graph),
    explicitValueConflicts: graph.explicitValueConflicts,
  };
  if (input.queries) {
    const queries = input.queries.map(query => query.trim()).filter(Boolean);
    if (!queries.length) throw new Error('queries must contain at least one non-empty string');
    return { ...common, results: queries.map(query => parityLensResult(graph, context, input, query)) };
  }
  return { ...common, ...parityLensResult(graph, context, input, input.query) };
}

function boundedNeighborhood(graph: IntelligenceGraph, context: GraphQueryContext, seedIds: string[], depth: number, limit: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const visited = new Set(seedIds);
  let frontier = [...seedIds];
  for (let d = 0; d < depth && frontier.length && visited.size < limit; d += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of context.incident(current)) {
        if (edge.status !== 'resolved' || !edge.from || !edge.to) continue;
        const neighbor = edge.from === current ? edge.to : edge.from;
        if (!visited.has(neighbor) && visited.size < limit) { visited.add(neighbor); next.push(neighbor); }
      }
    }
    frontier = next;
  }
  const edges = graph.edges.filter(edge => {
    const fromSelected = Boolean(edge.from && visited.has(edge.from));
    const toSelected = Boolean(edge.to && visited.has(edge.to));
    if (edge.from && edge.to) return fromSelected && toSelected;
    return fromSelected || toSelected;
  });
  return { nodes: graph.nodes.filter(node => visited.has(node.id)), edges };
}

export async function viewerProjection(input: {
  project: string;
  ref?: string;
  graphId?: string;
  view?: 'architecture' | 'parity' | 'code' | 'change';
  query?: string;
  node?: string;
  depth?: number;
  limit?: number;
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const context = graphQueryContext(graph);
  const view = input.view ?? 'architecture';
  const limit = Math.min(Math.max(input.limit ?? 700, 50), 2000);
  const depth = Math.min(Math.max(input.depth ?? 2, 1), 5);
  const requested = input.node ?? input.query;
  if (requested) {
    const candidates = findGraphNodeCandidates(graph, requested, 25);
    if (!candidates.length) return { project: input.project, graphId: graph.graphId, revision: graph.repositoryRevision, view, query: requested, nodes: [], edges: [], candidates: [] };
    if (candidates.length > 1 && !candidates.some(node => node.id === requested)) {
      return { project: input.project, graphId: graph.graphId, revision: graph.repositoryRevision, view, query: requested, ambiguous: true, candidates: candidates.map(node => ({ id: node.id, kind: node.kind, layer: node.layer ?? 'structural', name: node.name ?? null, locator: node.locator })), nodes: [], edges: [] };
    }
    const selected = candidates.find(node => node.id === requested) ?? candidates[0]!;
    const neighborhood = boundedNeighborhood(graph, context, [selected.id], depth, limit);
    const evidenceIds = new Set([
      ...neighborhood.nodes.flatMap(node => node.evidenceIds ?? []),
      ...neighborhood.edges.flatMap(edge => edge.evidenceIds ?? []),
    ]);
    return { project: input.project, graphId: graph.graphId, revision: graph.repositoryRevision, view, selected: selected.id, nodes: neighborhood.nodes, edges: neighborhood.edges, evidence: graph.evidence.filter(item => evidenceIds.has(item.id)), coverage: coverageSummary(graph) };
  }

  let seedNodes: GraphNode[];
  if (view === 'architecture') seedNodes = graph.nodes.filter(node => node.layer === 'semantic' && ['feature', 'api', 'route', 'provider', 'mcp'].includes(node.kind));
  else if (view === 'parity') seedNodes = graph.nodes.filter(node => node.layer === 'semantic' && ['surface', 'capability', 'action', 'feature', 'api', 'route', 'provider', 'mcp', 'tool'].includes(node.kind));
  else if (view === 'code') seedNodes = graph.nodes.filter(node => node.kind === 'file' || SYMBOL_KINDS_FOR_VIEW.has(node.kind));
  else {
    if (input.graphId) throw new Error('Change view compares accepted A to canonical source W and does not accept a runtime graphId');
    const delta = await diffAcceptedToWorking(input.project, input.ref) as any;
    const changedIds = new Set<string>([
      ...(delta.semantic?.nodes?.added ?? []).map((node: GraphNode) => node.id),
      ...(delta.semantic?.nodes?.removed ?? []).map((node: GraphNode) => node.id),
      ...(delta.semantic?.nodes?.changed ?? []).flatMap((entry: { before: GraphNode; after: GraphNode }) => [entry.before.id, entry.after.id]),
    ]);
    seedNodes = graph.nodes.filter(node => changedIds.has(node.id));
  }
  seedNodes = seedNodes.slice(0, limit);
  const ids = new Set(seedNodes.map(node => node.id));
  const edges = graph.edges.filter(edge => edge.from && edge.to && ids.has(edge.from) && ids.has(edge.to)).slice(0, limit * 4);
  return { project: input.project, graphId: graph.graphId, revision: graph.repositoryRevision, view, nodes: seedNodes, edges, coverage: coverageSummary(graph), truncated: seedNodes.length >= limit };
}

const SYMBOL_KINDS_FOR_VIEW = new Set(['function', 'method', 'class', 'interface', 'type', 'declaration']);

export function locatorFileAndLine(locator: string): { file: string; line: number | null } {
  const match = /^(.*?):(\d+)(?::.*)?$/u.exec(locator);
  return match ? { file: match[1]!, line: Number(match[2]) } : { file: locator, line: null };
}

export function nodeArea(node: GraphNode): string {
  const { file } = locatorFileAndLine(node.locator);
  return path.dirname(file);
}

export async function graphEvidence(input: {
  project: string;
  ref?: string;
  graphId?: string;
  node?: string;
  edge?: string;
  evidenceIds?: string[];
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  const ids = new Set(input.evidenceIds ?? []);
  let node: GraphNode | undefined;
  let edge: GraphEdge | undefined;
  if (input.node) {
    const candidates = findGraphNodeCandidates(graph, input.node, 20);
    if (candidates.length > 1 && !candidates.some(item => item.id === input.node)) {
      return {
        project: input.project,
        graphId: graph.graphId,
        revision: graph.repositoryRevision,
        ambiguous: true,
        query: input.node,
        candidates: candidates.map(item => ({ id: item.id, kind: item.kind, layer: item.layer ?? 'structural', name: item.name ?? null, locator: item.locator })),
        evidence: [],
      };
    }
    node = candidates.find(item => item.id === input.node) ?? candidates[0];
    for (const id of node?.evidenceIds ?? []) ids.add(id);
  }
  if (input.edge) {
    edge = graph.edges.find(item => item.id === input.edge);
    for (const id of edge?.evidenceIds ?? []) ids.add(id);
  }
  const evidence = graph.evidence.filter(item => ids.has(item.id));
  return { project: input.project, graphId: graph.graphId, revision: graph.repositoryRevision, coverage: coverageSummary(graph), ambiguous: false, node: node ?? null, edge: edge ?? null, evidence };
}

