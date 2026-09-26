import type { GraphEdge, GraphNode, GraphNodeLayer, IntelligenceGraph, RelationshipStatus } from '../types.js';

export type AdaptiveQueryMode = 'search' | 'trace' | 'global';

export interface GlobalQueryNodeEntry {
  id: string;
  sourceId: string;
  kind: string;
  layer: GraphNodeLayer;
  locator: string;
  name: string | null;
  searchable: string;
}

export interface GlobalQueryEdgeEntry {
  id: string;
  kind: string;
  layer: GraphNodeLayer;
  status: RelationshipStatus;
  strategy: string;
  from: string | null;
  to: string | null;
  fromSourceId: string | null;
  toSourceId: string | null;
  searchable: string;
}

export interface GlobalQueryIndex {
  graphId: string;
  revision: string | null;
  nodes: readonly GlobalQueryNodeEntry[];
  edges: readonly GlobalQueryEdgeEntry[];
  nodeById: ReadonlyMap<string, GlobalQueryNodeEntry>;
  incidentByNode: ReadonlyMap<string, readonly GlobalQueryEdgeEntry[]>;
  coverage: {
    completeForEligibleSources: boolean;
    eligibleFiles: number | null;
    analyzedFiles: number | null;
    partialFiles: number | null;
    failedFiles: number | null;
    skippedFiles: number | null;
  };
}

export interface AdaptiveQueryPlanInput {
  mode: AdaptiveQueryMode;
  query?: string;
  depth?: number;
  statuses?: RelationshipStatus[];
  layers?: GraphNodeLayer[];
  maxSelectedSources?: number;
}

export interface AdaptiveQueryPlan {
  mode: AdaptiveQueryMode;
  query: string | null;
  candidateNodeIds: string[];
  candidateEdgeIds: string[];
  selectedSourceIds: string[];
  globallyDisjoint: boolean;
  ambiguous: boolean;
  indexOnly: boolean;
  requiresFullGraph: boolean;
  reasons: string[];
  coverageComplete: boolean;
}

const EMPTY_EDGES: readonly GlobalQueryEdgeEntry[] = Object.freeze([]);

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function nodeSearchText(node: GraphNode): string {
  return [node.id, node.kind, node.layer, node.locator, node.field, node.name, node.raw, JSON.stringify(node.value)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function edgeSearchText(edge: GraphEdge): string {
  return [edge.id, edge.kind, edge.layer, edge.strategy, edge.status, ...edge.evidence]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function layerOf(value: { layer?: GraphNodeLayer }): GraphNodeLayer {
  return value.layer ?? 'structural';
}

function coverageSummary(graph: IntelligenceGraph): GlobalQueryIndex['coverage'] {
  const coverage = graph.coverage;
  if (!coverage) return {
    completeForEligibleSources: false,
    eligibleFiles: null,
    analyzedFiles: null,
    partialFiles: null,
    failedFiles: null,
    skippedFiles: null,
  };
  return {
    completeForEligibleSources:
      coverage.failedFiles === 0
      && coverage.partialFiles === 0
      && coverage.skippedFiles === 0
      && coverage.analyzedFiles === coverage.eligibleFiles,
    eligibleFiles: coverage.eligibleFiles,
    analyzedFiles: coverage.analyzedFiles,
    partialFiles: coverage.partialFiles,
    failedFiles: coverage.failedFiles,
    skippedFiles: coverage.skippedFiles,
  };
}

export function buildGlobalQueryIndex(graph: IntelligenceGraph): GlobalQueryIndex {
  const nodes: GlobalQueryNodeEntry[] = graph.nodes.map(node => ({
    id: node.id,
    sourceId: node.sourceId,
    kind: node.kind,
    layer: layerOf(node),
    locator: node.locator,
    name: node.name ?? null,
    searchable: nodeSearchText(node),
  }));
  const nodeById = new Map(nodes.map(node => [node.id, node]));

  const edges: GlobalQueryEdgeEntry[] = graph.edges.map(edge => ({
    id: edge.id,
    kind: edge.kind,
    layer: layerOf(edge),
    status: edge.status,
    strategy: edge.strategy,
    from: edge.from,
    to: edge.to,
    fromSourceId: edge.from ? nodeById.get(edge.from)?.sourceId ?? null : null,
    toSourceId: edge.to ? nodeById.get(edge.to)?.sourceId ?? null : null,
    searchable: edgeSearchText(edge),
  }));

  const incidentByNode = new Map<string, GlobalQueryEdgeEntry[]>();
  for (const edge of edges) {
    if (edge.from) append(incidentByNode, edge.from, edge);
    if (edge.to && edge.to !== edge.from) append(incidentByNode, edge.to, edge);
  }

  return {
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    nodes,
    edges,
    nodeById,
    incidentByNode,
    coverage: coverageSummary(graph),
  };
}

function allowedLayer(layer: GraphNodeLayer, layers: Set<GraphNodeLayer>): boolean {
  return !layers.size || layers.has(layer);
}

function sourceIdsForNodes(index: GlobalQueryIndex, ids: Iterable<string>): Set<string> {
  const sources = new Set<string>();
  for (const id of ids) {
    const sourceId = index.nodeById.get(id)?.sourceId;
    if (sourceId) sources.add(sourceId);
  }
  return sources;
}

function traceNodeIds(
  index: GlobalQueryIndex,
  startId: string,
  depth: number,
  statuses: Set<RelationshipStatus>,
  layers: Set<GraphNodeLayer>,
): Set<string> {
  const visited = new Set<string>([startId]);
  let frontier = [startId];
  for (let hop = 0; hop < depth && frontier.length; hop += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of index.incidentByNode.get(current) ?? EMPTY_EDGES) {
        if (!statuses.has(edge.status) || !allowedLayer(edge.layer, layers)) continue;
        const neighbor = edge.from === current ? edge.to : edge.to === current ? edge.from : null;
        if (!neighbor || visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return visited;
}

function candidateSources(index: GlobalQueryIndex, nodeIds: string[], edgeIds: string[]): Set<string> {
  const sources = sourceIdsForNodes(index, nodeIds);
  const edges = new Map(index.edges.map(edge => [edge.id, edge]));
  for (const id of edgeIds) {
    const edge = edges.get(id);
    if (!edge) continue;
    if (edge.fromSourceId) sources.add(edge.fromSourceId);
    if (edge.toSourceId) sources.add(edge.toSourceId);
  }
  return sources;
}

export function planAdaptiveQuery(index: GlobalQueryIndex, input: AdaptiveQueryPlanInput): AdaptiveQueryPlan {
  const query = input.query?.trim() ?? '';
  const needle = query.toLowerCase();
  const maxSelectedSources = Math.min(Math.max(input.maxSelectedSources ?? 32, 1), 256);
  const layers = new Set(input.layers ?? []);
  const statuses = new Set(input.statuses ?? ['resolved']);
  const reasons: string[] = [];
  let requiresFullGraph = false;
  let indexOnly = false;

  if (input.mode === 'global' || !needle) {
    return {
      mode: input.mode,
      query: query || null,
      candidateNodeIds: [],
      candidateEdgeIds: [],
      selectedSourceIds: [],
      globallyDisjoint: false,
      ambiguous: false,
      indexOnly: false,
      requiresFullGraph: true,
      reasons: ['broad-or-global-query-requires-complete-canonical-view'],
      coverageComplete: index.coverage.completeForEligibleSources,
    };
  }

  const exactId = index.nodeById.get(query);
  const exactNames = exactId ? [] : index.nodes.filter(node => allowedLayer(node.layer, layers) && node.name?.toLowerCase() === needle);
  const matchingNodes = exactId
    ? [exactId]
    : exactNames.length
      ? exactNames
      : index.nodes.filter(node => allowedLayer(node.layer, layers) && node.searchable.includes(needle));
  const matchingEdges = index.edges.filter(edge =>
    statuses.has(edge.status)
    && allowedLayer(edge.layer, layers)
    && edge.searchable.includes(needle));

  const candidateNodeIds = matchingNodes.map(node => node.id);
  const candidateEdgeIds = matchingEdges.map(edge => edge.id);
  const ambiguous = input.mode === 'trace' && !exactId && exactNames.length > 1;

  let selected = candidateSources(index, candidateNodeIds, candidateEdgeIds);

  if (ambiguous) {
    indexOnly = true;
    reasons.push('ambiguous-trace-can-return-global-candidates-without-detail-shards');
  } else if (input.mode === 'trace' && matchingNodes.length === 1) {
    const depth = Math.min(Math.max(input.depth ?? 3, 0), 10);
    const visited = traceNodeIds(index, matchingNodes[0]!.id, depth, statuses, layers);
    selected = sourceIdsForNodes(index, visited);
    reasons.push('trace-frontier-derived-from-global-edge-index');
  } else {
    reasons.push('global-index-seeded-all-lexical-candidates-before-local-materialization');
  }

  for (const edge of matchingEdges) {
    if (!edge.from || !edge.to || !edge.fromSourceId || !edge.toSourceId) {
      requiresFullGraph = true;
      reasons.push('matched-edge-has-unbound-endpoint');
      break;
    }
  }

  const globallyDisjoint = selected.size > 1;
  if (globallyDisjoint) reasons.push('candidate-sources-are-globally-disjoint');

  if (selected.size > maxSelectedSources) {
    requiresFullGraph = true;
    reasons.push('selected-source-count-exceeds-adaptive-bound');
  }

  if (!matchingNodes.length && !matchingEdges.length) {
    indexOnly = true;
    reasons.push(index.coverage.completeForEligibleSources
      ? 'global-index-proves-no-match-across-covered-sources'
      : 'global-index-found-no-match-but-source-coverage-is-incomplete');
  }

  return {
    mode: input.mode,
    query,
    candidateNodeIds,
    candidateEdgeIds,
    selectedSourceIds: [...selected].sort(),
    globallyDisjoint,
    ambiguous,
    indexOnly,
    requiresFullGraph,
    reasons: [...new Set(reasons)],
    coverageComplete: index.coverage.completeForEligibleSources,
  };
}
