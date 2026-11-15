import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { graphQueryContext } from './queryContext.js';
import { relationshipKindContract, nodeKindsForFacet, type KnowledgeMechanism } from './graphKnowledge.js';

export type ReachDimension = 'implementation' | 'human' | 'agent' | 'transport' | 'persistence' | 'provider' | 'cross-feature';
export type ReachMechanism = KnowledgeMechanism;

export interface TypedReachPath {
  dimension: ReachDimension;
  targetId: string;
  targetKind: string;
  targetLayer: string;
  nodeIds: string[];
  edgeIds: string[];
  relationshipKinds: string[];
  mechanisms: ReachMechanism[];
}

export interface TypedReachDimension {
  observed: boolean;
  count: number;
  targetIds: string[];
  paths: TypedReachPath[];
}

export interface TypedReachProjection {
  root: { id: string; name: string; kind: string; layer: string };
  policy: {
    relationshipStatus: 'resolved';
    direction: 'both';
    depth: number;
    maxNodes: number;
    interpretation: string;
  };
  dimensions: Record<ReachDimension, TypedReachDimension>;
  mechanisms: Record<ReachMechanism, number>;
  relationshipKinds: Record<string, number>;
  totals: { reachableNodes: number; traversedEdges: number };
  excludedRelationships: { candidate: number; unresolved: number };
  note: string;
}

const DIMENSIONS: ReachDimension[] = ['implementation', 'human', 'agent', 'transport', 'persistence', 'provider', 'cross-feature'];

const HUMAN_KINDS = new Set(nodeKindsForFacet('human'));
const AGENT_KINDS = new Set(nodeKindsForFacet('agent'));
const TRANSPORT_KINDS = new Set(nodeKindsForFacet('transport'));
const IMPLEMENTATION_KINDS = new Set(nodeKindsForFacet('implementation'));
const PERSISTENCE_KINDS = new Set(nodeKindsForFacet('persistence'));
const CROSS_FEATURE_KINDS = new Set(['feature', 'capability', 'action']);

export function reachMechanism(kind: string): ReachMechanism {
  return relationshipKindContract(kind).mechanism;
}

function nodeDimensions(root: GraphNode, target: GraphNode): ReachDimension[] {
  const dimensions: ReachDimension[] = [];
  if (IMPLEMENTATION_KINDS.has(target.kind)) dimensions.push('implementation');
  if (HUMAN_KINDS.has(target.kind)) dimensions.push('human');
  if (AGENT_KINDS.has(target.kind)) dimensions.push('agent');
  if (TRANSPORT_KINDS.has(target.kind)) dimensions.push('transport');
  if (PERSISTENCE_KINDS.has(target.kind) || target.kind.startsWith('sql-')) dimensions.push('persistence');
  if (target.kind === 'provider') dimensions.push('provider');
  if (target.id !== root.id && target.layer === 'semantic' && CROSS_FEATURE_KINDS.has(target.kind)) dimensions.push('cross-feature');
  return dimensions;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export function projectTypedReach(
  graph: IntelligenceGraph,
  root: GraphNode,
  options: { depth?: number; maxNodes?: number } = {},
): TypedReachProjection {
  const depth = Math.min(Math.max(options.depth ?? 4, 0), 10);
  const maxNodes = Math.min(Math.max(options.maxNodes ?? 300, 1), 2000);
  // Graphs are immutable per exact revision. Reuse DI's existing indexed
  // neighborhood rather than rebuilding full maps for every assessment.
  const context = graphQueryContext(graph);
  const byId = context.nodesById;

  const pathByNode = new Map<string, { nodeIds: string[]; edgeIds: string[] }>([
    [root.id, { nodeIds: [root.id], edgeIds: [] }],
  ]);
  let frontier = [root.id];
  for (let level = 0; level < depth && frontier.length && pathByNode.size < maxNodes; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of context.incident(id)) {
        if (edge.status !== 'resolved' || !edge.from || !edge.to) continue;
        const neighbor = edge.from === id ? edge.to : edge.from;
        if (!neighbor || pathByNode.has(neighbor) || pathByNode.size >= maxNodes) continue;
        const parent = pathByNode.get(id)!;
        pathByNode.set(neighbor, {
          nodeIds: [...parent.nodeIds, neighbor],
          edgeIds: [...parent.edgeIds, edge.id],
        });
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  const edgesById = context.edgesById;
  const emptyDimension = (): TypedReachDimension => ({ observed: false, count: 0, targetIds: [], paths: [] });
  const dimensions: Record<ReachDimension, TypedReachDimension> = {
    implementation: emptyDimension(),
    human: emptyDimension(),
    agent: emptyDimension(),
    transport: emptyDimension(),
    persistence: emptyDimension(),
    provider: emptyDimension(),
    'cross-feature': emptyDimension(),
  };

  const usedEdgeIds = new Set<string>();
  for (const [targetId, path] of pathByNode) {
    if (targetId === root.id) continue;
    const target = byId.get(targetId);
    if (!target) continue;
    const pathEdges = path.edgeIds.map(id => edgesById.get(id)).filter((edge): edge is GraphEdge => Boolean(edge));
    for (const dimension of nodeDimensions(root, target)) {
      const item: TypedReachPath = {
        dimension,
        targetId,
        targetKind: target.kind,
        targetLayer: target.layer ?? 'structural',
        nodeIds: path.nodeIds,
        edgeIds: path.edgeIds,
        relationshipKinds: pathEdges.map(edge => edge.kind),
        mechanisms: pathEdges.map(edge => reachMechanism(edge.kind)),
      };
      dimensions[dimension].paths.push(item);
      dimensions[dimension].targetIds.push(targetId);
      for (const edgeId of path.edgeIds) usedEdgeIds.add(edgeId);
    }
  }

  for (const dimension of DIMENSIONS) {
    const bucket = dimensions[dimension];
    bucket.targetIds = [...new Set(bucket.targetIds)].sort();
    bucket.paths.sort((a, b) => a.edgeIds.length - b.edgeIds.length || a.targetId.localeCompare(b.targetId));
    bucket.count = bucket.targetIds.length;
    bucket.observed = bucket.count > 0;
  }

  const mechanisms = Object.fromEntries([
    'composition-context', 'dependency', 'execution', 'identity-resolution', 'surface', 'persistence', 'provider', 'authority', 'other',
  ].map(key => [key, 0])) as Record<ReachMechanism, number>;
  const relationshipKinds: Record<string, number> = {};
  for (const edgeId of usedEdgeIds) {
    const edge = edgesById.get(edgeId);
    if (!edge) continue;
    increment(mechanisms, reachMechanism(edge.kind));
    increment(relationshipKinds, edge.kind);
  }

  const reachedIds = new Set(pathByNode.keys());
  let candidate = 0;
  let unresolved = 0;
  const seenExcluded = new Set<string>();
  for (const id of reachedIds) for (const edge of context.incident(id)) {
    // A relationship whose endpoints are both reached is still one edge.
    if (seenExcluded.has(edge.id)) continue;
    seenExcluded.add(edge.id);
    if (edge.status === 'candidate') candidate += 1;
    if (edge.status === 'unresolved') unresolved += 1;
  }

  return {
    root: {
      id: root.id,
      name: root.name ?? root.id,
      kind: root.kind,
      layer: root.layer ?? 'structural',
    },
    policy: {
      relationshipStatus: 'resolved',
      direction: 'both',
      depth,
      maxNodes,
      interpretation: 'Reach reports observed connection mechanisms and shortest resolved paths. It does not score severity, likelihood, or product importance.',
    },
    dimensions,
    mechanisms,
    relationshipKinds,
    totals: {
      reachableNodes: Math.max(0, pathByNode.size - 1),
      traversedEdges: usedEdgeIds.size,
    },
    excludedRelationships: { candidate, unresolved },
    note: 'Typed reach is a revision-bound projection over resolved relationships. Candidate and unresolved relationships are excluded from reach paths and remain hypotheses or gaps.',
  };
}
