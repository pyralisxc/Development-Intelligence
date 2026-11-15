import { MultiDirectedGraph } from 'graphology';
import type { GraphEdge, GraphNode, IntelligenceGraph, RelationshipStatus } from '../types.js';

const EMPTY_NODES: readonly GraphNode[] = Object.freeze([]);
const EMPTY_EDGES: readonly GraphEdge[] = Object.freeze([]);

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

export interface GraphQueryContext {
  readonly graph: IntelligenceGraph;
  readonly nodesById: ReadonlyMap<string, GraphNode>;
  readonly edgesById: ReadonlyMap<string, GraphEdge>;
  readonly nodesByKind: ReadonlyMap<string, readonly GraphNode[]>;
  readonly nodesByLayer: ReadonlyMap<string, readonly GraphNode[]>;
  readonly nodesBySource: ReadonlyMap<string, readonly GraphNode[]>;
  readonly edgesByKind: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly edgesByStatus: ReadonlyMap<RelationshipStatus, readonly GraphEdge[]>;
  node(id: string): GraphNode | undefined;
  nodes(kind: string): readonly GraphNode[];
  incoming(id: string): readonly GraphEdge[];
  outgoing(id: string): readonly GraphEdge[];
  incident(id: string): readonly GraphEdge[];
}

const CACHE = new WeakMap<IntelligenceGraph, GraphQueryContext>();

/** Read an already-built exact-graph index without allocating a new one. */
export function existingGraphQueryContext(graph: IntelligenceGraph): GraphQueryContext | undefined {
  return CACHE.get(graph);
}

export function graphQueryContext(graph: IntelligenceGraph): GraphQueryContext {
  const cached = CACHE.get(graph);
  if (cached) return cached;

  const nodesById = new Map<string, GraphNode>();
  const nodesByKind = new Map<string, GraphNode[]>();
  const nodesByLayer = new Map<string, GraphNode[]>();
  const nodesBySource = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    nodesById.set(node.id, node);
    append(nodesByKind, node.kind, node);
    append(nodesByLayer, node.layer ?? 'structural', node);
    append(nodesBySource, node.sourceId, node);
  }

  // Graphology is the sole adjacency index for source-complete, directed edges.
  // This remains a disposable per-W query view: DI node/edge IDs and evidence
  // stay authoritative in the exact revision graph, never in Graphology.
  // Construct native adjacency only for investigations that actually traverse.
  // Index-only audit/coverage queries should not instantiate an entire second
  // in-memory topology just to read graph facts by kind or ID.
  let topology: MultiDirectedGraph | undefined;
  function nativeTopology(): MultiDirectedGraph {
    if (topology) return topology;
    const built = new MultiDirectedGraph();
    for (const node of graph.nodes) built.addNode(node.id);
    for (const edge of graph.edges) {
      if (edge.from && edge.to && built.hasNode(edge.from) && built.hasNode(edge.to)) {
        built.addDirectedEdgeWithKey(edge.id, edge.from, edge.to);
      }
    }
    topology = built;
    return built;
  }

  const edgesById = new Map<string, GraphEdge>();
  const edgesByKind = new Map<string, GraphEdge[]>();
  const edgesByStatus = new Map<RelationshipStatus, GraphEdge[]>();
  const sourceOrder = new Map<string, number>();
  // Unresolved source relationships can have only one endpoint. Graphology
  // cannot represent half-edges; retain them exactly for evidence/audits.
  const partialIncoming = new Map<string, GraphEdge[]>();
  const partialOutgoing = new Map<string, GraphEdge[]>();
  const partialIncident = new Map<string, GraphEdge[]>();
  for (const [position, edge] of graph.edges.entries()) {
    edgesById.set(edge.id, edge);
    sourceOrder.set(edge.id, position);
    append(edgesByKind, edge.kind, edge);
    append(edgesByStatus, edge.status, edge);
    if (edge.from && edge.to && nodesById.has(edge.from) && nodesById.has(edge.to)) {
      continue;
    }
    if (edge.from) {
      append(partialOutgoing, edge.from, edge);
      append(partialIncident, edge.from, edge);
    }
    if (edge.to) {
      append(partialIncoming, edge.to, edge);
      if (edge.to !== edge.from) append(partialIncident, edge.to, edge);
    }
  }

  // Materialize only actually requested neighborhoods, not three permanent
  // replicas of every edge. Keep original graph.edges ordering for stable
  // evidence projections, including parallel edges, loops and half-edges.
  const inboundCache = new Map<string, readonly GraphEdge[]>();
  const outboundCache = new Map<string, readonly GraphEdge[]>();
  const incidentCache = new Map<string, readonly GraphEdge[]>();
  function neighborhood(
    id: string,
    mode: 'inbound' | 'outbound' | 'incident',
  ): readonly GraphEdge[] {
    const cache = mode === 'inbound' ? inboundCache
      : mode === 'outbound' ? outboundCache : incidentCache;
    const cached = cache.get(id);
    if (cached) return cached;
    const native = nodesById.has(id) ? nativeTopology() : undefined;
    const ids = !native ? []
      : mode === 'inbound' ? native.inEdges(id)
        : mode === 'outbound' ? native.outEdges(id) : native.edges(id);
    const partial = mode === 'inbound' ? partialIncoming
      : mode === 'outbound' ? partialOutgoing : partialIncident;
    const results: GraphEdge[] = [];
    for (const edgeId of ids) {
      const edge = edgesById.get(edgeId);
      if (edge) results.push(edge);
    }
    results.push(...(partial.get(id) ?? EMPTY_EDGES));
    if (!results.length) return EMPTY_EDGES;
    results.sort((left, right) =>
      (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0));
    cache.set(id, results);
    return results;
  }

  const context: GraphQueryContext = {
    graph,
    nodesById,
    edgesById,
    nodesByKind,
    nodesByLayer,
    nodesBySource,
    edgesByKind,
    edgesByStatus,
    node: id => nodesById.get(id),
    nodes: kind => nodesByKind.get(kind) ?? EMPTY_NODES,
    incoming: id => neighborhood(id, 'inbound'),
    outgoing: id => neighborhood(id, 'outbound'),
    incident: id => neighborhood(id, 'incident'),
  };
  CACHE.set(graph, context);
  return context;
}
