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

  const edgesById = new Map<string, GraphEdge>();
  const edgesByKind = new Map<string, GraphEdge[]>();
  const edgesByStatus = new Map<RelationshipStatus, GraphEdge[]>();
  for (const edge of graph.edges) {
    edgesById.set(edge.id, edge);
    append(edgesByKind, edge.kind, edge);
    append(edgesByStatus, edge.status, edge);
  }

  // The source graph already owns every edge. Index references in source
  // order, including loops and unresolved edges with only one endpoint.
  // Non-traversal queries never need this index.
  let incidentById: Map<string, GraphEdge[]> | undefined;
  function incident(id: string): readonly GraphEdge[] {
    if (!incidentById) {
      incidentById = new Map();
      for (const edge of graph.edges) {
        if (edge.from) append(incidentById, edge.from, edge);
        if (edge.to && edge.to !== edge.from) append(incidentById, edge.to, edge);
      }
    }
    return incidentById.get(id) ?? EMPTY_EDGES;
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
    incoming: id => incident(id).filter(edge => edge.to === id),
    outgoing: id => incident(id).filter(edge => edge.from === id),
    incident,
  };
  CACHE.set(graph, context);
  return context;
}
