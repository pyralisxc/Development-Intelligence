import path from 'node:path';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { currentGraph, repositoryGraphs } from './service.js';

function nodeText(node: GraphNode): string {
  return [node.id, node.kind, node.locator, node.field, node.name, node.raw, JSON.stringify(node.value)].filter(Boolean).join(' ').toLowerCase();
}

function edgeText(edge: GraphEdge): string {
  return [edge.id, edge.kind, edge.strategy, edge.status, ...edge.evidence].join(' ').toLowerCase();
}

export function diffGraphs(base: IntelligenceGraph, head: IntelligenceGraph): Record<string, unknown> {
  const diffById = <T extends { id: string }>(left: T[], right: T[]) => {
    const a = new Map(left.map(item => [item.id, item]));
    const b = new Map(right.map(item => [item.id, item]));
    const added: T[] = [];
    const removed: T[] = [];
    const changed: Array<{ before: T; after: T }> = [];
    for (const [id, item] of b) {
      const previous = a.get(id);
      if (!previous) added.push(item);
      else if (JSON.stringify(previous) !== JSON.stringify(item)) changed.push({ before: previous, after: item });
    }
    for (const [id, item] of a) if (!b.has(id)) removed.push(item);
    return { added, removed, changed };
  };
  return {
    project: head.project,
    base: { graphId: base.graphId, role: base.role, revision: base.repositoryRevision, sourceFingerprint: base.sourceFingerprint },
    head: { graphId: head.graphId, role: head.role, revision: head.repositoryRevision, sourceFingerprint: head.sourceFingerprint },
    nodes: diffById(base.nodes, head.nodes),
    edges: diffById(base.edges, head.edges),
  };
}

export async function diffAcceptedToWorking(project: string, ref?: string): Promise<Record<string, unknown>> {
  const { accepted, working, acceptedCurrent } = await repositoryGraphs(project, ref);
  if (!accepted) return {
    project,
    base: null,
    head: { graphId: working.graphId, role: working.role, revision: working.repositoryRevision },
    acceptedCurrent: false,
    nodes: { added: working.nodes, removed: [], changed: [] },
    edges: { added: working.edges, removed: [], changed: [] },
  };
  return { ...diffGraphs(accepted, working), acceptedCurrent };
}

export async function searchGraph(input: {
  project: string;
  ref?: string | undefined;
  query?: string | undefined;
  kinds?: string[] | undefined;
  sourceIds?: string[] | undefined;
  statuses?: Array<'resolved' | 'candidate' | 'unresolved'> | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref);
  const query = input.query?.trim().toLowerCase();
  const kinds = new Set(input.kinds ?? []);
  const sourceIds = new Set(input.sourceIds ?? []);
  const statuses = new Set(input.statuses ?? []);
  const nodes = graph.nodes.filter(node => {
    if (kinds.size && !kinds.has(node.kind)) return false;
    if (sourceIds.size && !sourceIds.has(node.sourceId)) return false;
    return !query || nodeText(node).includes(query);
  });
  const edges = graph.edges.filter(edge => {
    if (statuses.size && !statuses.has(edge.status)) return false;
    return !query || edgeText(edge).includes(query);
  });
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const offset = Math.max(input.offset ?? 0, 0);
  return {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    role: graph.role,
    nodeTotal: nodes.length,
    edgeTotal: edges.length,
    nodes: nodes.slice(offset, offset + limit),
    edges: edges.slice(offset, offset + limit),
  };
}

export async function traceGraph(input: {
  project: string;
  ref?: string | undefined;
  node?: string | undefined;
  direction?: 'inbound' | 'outbound' | 'both' | undefined;
  depth?: number | undefined;
  relationshipKinds?: string[] | undefined;
  limit?: number | undefined;
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref);
  const needle = input.node?.trim().toLowerCase();
  if (!needle) throw new Error('node must be a non-empty graph node id/name/query');
  const start = graph.nodes.find(node => node.id === input.node)
    ?? graph.nodes.find(node => node.name?.toLowerCase() === needle)
    ?? graph.nodes.find(node => nodeText(node).includes(needle));
  if (!start) throw new Error(`Graph node not found: ${input.node}`);

  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const allowedKinds = new Set(input.relationshipKinds ?? []);
  const maxDepth = Math.min(Math.max(input.depth ?? 3, 0), 10);
  const limit = Math.min(Math.max(input.limit ?? 250, 1), 2000);
  const direction = input.direction ?? 'both';
  const visited = new Set<string>([start.id]);
  const selectedEdges: GraphEdge[] = [];
  let frontier = [start.id];
  for (let depth = 0; depth < maxDepth && frontier.length && visited.size < limit; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of graph.edges) {
        if (edge.status !== 'resolved' || !edge.from || !edge.to) continue;
        if (allowedKinds.size && !allowedKinds.has(edge.kind)) continue;
        let neighbor: string | null = null;
        if ((direction === 'outbound' || direction === 'both') && edge.from === current) neighbor = edge.to;
        else if ((direction === 'inbound' || direction === 'both') && edge.to === current) neighbor = edge.from;
        if (!neighbor) continue;
        if (!selectedEdges.some(item => item.id === edge.id)) selectedEdges.push(edge);
        if (!visited.has(neighbor) && visited.size < limit) { visited.add(neighbor); next.push(neighbor); }
      }
    }
    frontier = next;
  }
  return {
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    start,
    nodes: [...visited].map(id => byId.get(id)).filter(Boolean),
    edges: selectedEdges,
  };
}

export async function graphArchitecture(project: string, ref?: string): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref);
  const kinds: Record<string, number> = {};
  const areas: Record<string, { nodes: number; kinds: Record<string, number> }> = {};
  for (const node of graph.nodes) {
    kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
    const file = node.locator.split(':')[0] ?? node.locator;
    const area = file.includes('/') ? file.split('/')[0]! : '(root)';
    const bucket = areas[area] ?? { nodes: 0, kinds: {} };
    bucket.nodes += 1;
    bucket.kinds[node.kind] = (bucket.kinds[node.kind] ?? 0) + 1;
    areas[area] = bucket;
  }
  const resolvedEdges = graph.edges.filter(edge => edge.status === 'resolved');
  const relationshipKinds: Record<string, number> = {};
  for (const edge of graph.edges) relationshipKinds[edge.kind] = (relationshipKinds[edge.kind] ?? 0) + 1;
  return {
    project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    sourceFingerprint: graph.sourceFingerprint,
    coverage: graph.coverage,
    summary: { nodes: graph.nodes.length, edges: graph.edges.length, resolvedEdges: resolvedEdges.length, nodeKinds: kinds, relationshipKinds },
    areas: Object.entries(areas).sort((a, b) => b[1].nodes - a[1].nodes).map(([name, value]) => ({ name, ...value })),
  };
}

export async function graphSchema(project: string, ref?: string): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref);
  return {
    schemaVersion: graph.schemaVersion,
    nodeKinds: [...new Set(graph.nodes.map(node => node.kind))].sort(),
    relationshipKinds: [...new Set(graph.edges.map(edge => edge.kind))].sort(),
    relationshipStatuses: ['resolved', 'candidate', 'unresolved'],
    nodeFields: ['id', 'sourceId', 'kind', 'locator', 'field?', 'name?', 'value', 'raw', 'tags?'],
    edgeFields: ['id', 'from', 'to', 'kind', 'strategy', 'confidence', 'status', 'evidence'],
  };
}

export async function graphCoverage(project: string, ref?: string): Promise<Record<string, unknown>> {
  const graph = await currentGraph(project, ref);
  return { project, graphId: graph.graphId, revision: graph.repositoryRevision, coverage: graph.coverage ?? null, unavailableSourceIds: graph.unavailableSourceIds };
}

export async function parityLens(input: {
  project: string;
  ref?: string | undefined;
  query?: string | undefined;
  kinds?: string[] | undefined;
  sourceIds?: string[] | undefined;
  status?: Array<'resolved' | 'candidate' | 'unresolved'> | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): Promise<Record<string, unknown>> {
  const result = await searchGraph({ ...input, statuses: input.status });
  const graph = await currentGraph(input.project, input.ref);
  const query = input.query?.trim().toLowerCase();
  const offset = Math.max(input.offset ?? 0, 0);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  return {
    ...result,
    namingDivergences: graph.namingDivergences.filter(item => !query || `${item.fromName} ${item.toName}`.toLowerCase().includes(query)).slice(offset, offset + limit),
    unmatchedNodeIds: graph.unmatchedNodeIds.slice(offset, offset + limit),
    unavailableSourceIds: graph.unavailableSourceIds,
  };
}

export function locatorFileAndLine(locator: string): { file: string; line: number | null } {
  const match = /^(.*?):(\d+)(?::.*)?$/u.exec(locator);
  return match ? { file: match[1]!, line: Number(match[2]) } : { file: locator, line: null };
}

export function nodeArea(node: GraphNode): string {
  const { file } = locatorFileAndLine(node.locator);
  return path.dirname(file);
}
