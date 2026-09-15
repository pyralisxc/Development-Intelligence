import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphCheckpointMeta, GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { GRAPH_CHECKPOINT_PATH } from './repository.js';

export interface ParsedCheckpoint {
  meta: GraphCheckpointMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function stableNode(node: GraphNode): GraphNode {
  return {
    id: node.id,
    sourceId: node.sourceId,
    kind: node.kind,
    locator: node.locator,
    ...(node.field === undefined ? {} : { field: node.field }),
    ...(node.name === undefined ? {} : { name: node.name }),
    value: node.value,
    raw: node.raw,
    ...(node.tags?.length ? { tags: [...node.tags].sort() } : {}),
  };
}

function stableEdge(edge: GraphEdge): GraphEdge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    strategy: edge.strategy,
    confidence: edge.confidence,
    status: edge.status,
    evidence: [...edge.evidence].sort(),
  };
}

export function checkpointMeta(graph: IntelligenceGraph): GraphCheckpointMeta {
  if (!graph.sourceFingerprint) throw new Error('Repository graph is missing a source fingerprint');
  const kinds: Record<string, number> = {};
  for (const node of graph.nodes) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
  return {
    type: 'meta',
    schemaVersion: 1,
    sourceFingerprint: graph.sourceFingerprint,
    summary: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      unresolved: graph.edges.filter(edge => edge.status === 'unresolved').length,
      candidate: graph.edges.filter(edge => edge.status === 'candidate').length,
      kinds: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

export function serializeCheckpoint(graph: IntelligenceGraph): string {
  const records: unknown[] = [
    checkpointMeta(graph),
    ...[...graph.nodes].map(stableNode).sort((a, b) => a.id.localeCompare(b.id)).map(node => ({ type: 'node', ...node })),
    ...[...graph.edges].map(stableEdge).sort((a, b) => a.id.localeCompare(b.id)).map(edge => ({ type: 'edge', ...edge })),
  ];
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
}

export function parseCheckpoint(content: string): ParsedCheckpoint {
  const records = content.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const meta = records.find(record => record.type === 'meta') as GraphCheckpointMeta | undefined;
  if (!meta || meta.schemaVersion !== 1 || typeof meta.sourceFingerprint !== 'string') {
    throw new Error('Development Intelligence graph checkpoint is missing a supported meta record');
  }
  const nodes = records.filter(record => record.type === 'node').map(({ type: _type, ...node }) => node as unknown as GraphNode);
  const edges = records.filter(record => record.type === 'edge').map(({ type: _type, ...edge }) => edge as unknown as GraphEdge);
  return { meta, nodes, edges };
}

export async function readCheckpoint(root: string): Promise<ParsedCheckpoint | null> {
  try {
    return parseCheckpoint(await fs.readFile(path.join(root, GRAPH_CHECKPOINT_PATH), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeCheckpoint(root: string, graph: IntelligenceGraph): Promise<string> {
  const target = path.join(root, GRAPH_CHECKPOINT_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const content = serializeCheckpoint({ ...graph, role: 'B' });
  await fs.writeFile(target, content, 'utf8');
  return target;
}

export function checkpointToGraph(input: {
  project: string;
  repository: string;
  revision: string | null;
  checkpoint: ParsedCheckpoint;
}): IntelligenceGraph {
  return {
    schemaVersion: 1,
    graphId: `accepted-${input.checkpoint.meta.sourceFingerprint.slice(0, 16)}`,
    project: input.project,
    role: 'A',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: input.revision,
    sourceFingerprint: input.checkpoint.meta.sourceFingerprint,
    sources: [{ id: 'repository', kind: 'repository-checkpoint', locator: input.repository, revision: input.revision, observedAt: new Date(0).toISOString(), available: true }],
    nodes: input.checkpoint.nodes,
    edges: input.checkpoint.edges,
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
  };
}
