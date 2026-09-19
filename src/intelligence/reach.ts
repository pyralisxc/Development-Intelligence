import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';

export type ReachDimension = 'implementation' | 'human' | 'agent' | 'transport' | 'persistence' | 'provider' | 'cross-feature';
export type ReachMechanism = 'composition-context' | 'dependency' | 'execution' | 'identity-resolution' | 'surface' | 'persistence' | 'provider' | 'authority' | 'other';

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

const HUMAN_KINDS = new Set(['surface', 'ui-element', 'component-prop-handler', 'component-prop-binding']);
const AGENT_KINDS = new Set(['mcp', 'tool', 'mcp-tool']);
const TRANSPORT_KINDS = new Set(['api', 'route', 'http-call', 'rpc-call', 'navigation-call']);
const IMPLEMENTATION_KINDS = new Set(['feature', 'function', 'method', 'class', 'sql-function']);
const PERSISTENCE_KINDS = new Set(['sql-table', 'sql-reference', 'state-binding', 'state-write']);
const CROSS_FEATURE_KINDS = new Set(['feature', 'capability', 'action']);

export function reachMechanism(kind: string): ReachMechanism {
  const value = kind.toLowerCase();
  if (/same_observed_|similar_identifier|equivalent|variant|canonical|identity/u.test(value)) return 'identity-resolution';
  if (/contains|declares|member|parent|child|owned?|part[-_ ]?of|context|nested|includes|reexports/u.test(value)) return 'composition-context';
  if (/imports|depends|requires|uses|references|resolves_to|connected-to|links?-to/u.test(value)) return 'dependency';
  if (/calls?|handled_by|implemented-by|automated-by|dispatch|invoke|trigger|responds|transitions|navigation|executes|routes?-to/u.test(value)) return 'execution';
  if (/exposed-on|available-on-surface|renders|presented|binds/u.test(value)) return 'surface';
  if (/writes?|reads?|persists?|state|stores?|loads?|sql/u.test(value)) return 'persistence';
  if (/integrates-with|provider/u.test(value)) return 'provider';
  if (/authority|auth|permission/u.test(value)) return 'authority';
  return 'other';
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
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const incident = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (edge.status !== 'resolved' || !edge.from || !edge.to) continue;
    for (const id of [edge.from, edge.to]) {
      const items = incident.get(id) ?? [];
      items.push(edge);
      incident.set(id, items);
    }
  }

  const pathByNode = new Map<string, { nodeIds: string[]; edgeIds: string[] }>([
    [root.id, { nodeIds: [root.id], edgeIds: [] }],
  ]);
  let frontier = [root.id];
  for (let level = 0; level < depth && frontier.length && pathByNode.size < maxNodes; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of incident.get(id) ?? []) {
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

  const edgesById = new Map(graph.edges.map(edge => [edge.id, edge]));
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
  for (const edge of graph.edges) {
    const touchesReach = (edge.from ? reachedIds.has(edge.from) : false) || (edge.to ? reachedIds.has(edge.to) : false);
    if (!touchesReach) continue;
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
