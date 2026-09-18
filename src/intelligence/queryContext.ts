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
  readonly nodesByKind: ReadonlyMap<string, readonly GraphNode[]>;
  readonly nodesByLayer: ReadonlyMap<string, readonly GraphNode[]>;
  readonly nodesBySource: ReadonlyMap<string, readonly GraphNode[]>;
  readonly inboundByNode: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly outboundByNode: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly incidentByNode: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly edgesByKind: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly edgesByStatus: ReadonlyMap<RelationshipStatus, readonly GraphEdge[]>;
  node(id: string): GraphNode | undefined;
  nodes(kind: string): readonly GraphNode[];
  incoming(id: string): readonly GraphEdge[];
  outgoing(id: string): readonly GraphEdge[];
  incident(id: string): readonly GraphEdge[];
}

const CACHE = new WeakMap<IntelligenceGraph, GraphQueryContext>();

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

  const inboundByNode = new Map<string, GraphEdge[]>();
  const outboundByNode = new Map<string, GraphEdge[]>();
  const incidentByNode = new Map<string, GraphEdge[]>();
  const edgesByKind = new Map<string, GraphEdge[]>();
  const edgesByStatus = new Map<RelationshipStatus, GraphEdge[]>();
  for (const edge of graph.edges) {
    append(edgesByKind, edge.kind, edge);
    append(edgesByStatus, edge.status, edge);
    if (edge.from) {
      append(outboundByNode, edge.from, edge);
      append(incidentByNode, edge.from, edge);
    }
    if (edge.to) {
      append(inboundByNode, edge.to, edge);
      if (edge.to !== edge.from) append(incidentByNode, edge.to, edge);
    }
  }

  const context: GraphQueryContext = {
    graph,
    nodesById,
    nodesByKind,
    nodesByLayer,
    nodesBySource,
    inboundByNode,
    outboundByNode,
    incidentByNode,
    edgesByKind,
    edgesByStatus,
    node: id => nodesById.get(id),
    nodes: kind => nodesByKind.get(kind) ?? EMPTY_NODES,
    incoming: id => inboundByNode.get(id) ?? EMPTY_EDGES,
    outgoing: id => outboundByNode.get(id) ?? EMPTY_EDGES,
    incident: id => incidentByNode.get(id) ?? EMPTY_EDGES,
  };
  CACHE.set(graph, context);
  return context;
}
