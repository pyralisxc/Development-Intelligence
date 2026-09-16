import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { GraphCheckpointMeta, GraphCheckpointMetaV2, GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { ANALYZER_VERSION, GRAPH_DIRECTORY, checkpointProjection, semanticTopologyFingerprint } from './repository.js';
import { stringifyValue } from './model.js';

const GRAPH_MANIFEST_PATH = `${GRAPH_DIRECTORY}/manifest.json`;
const GRAPH_SHARD_DIRECTORY = `${GRAPH_DIRECTORY}/graph`;

export interface ParsedCheckpoint {
  meta: GraphCheckpointMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  integrity: {
    countsValid: boolean;
    topologyValid: boolean | null;
  };
}

function stableNode(node: GraphNode): GraphNode {
  const tags = [...new Set(node.tags ?? [])].filter(tag => tag !== 'referenced').sort();
  const value = node.value;
  return {
    id: node.id,
    sourceId: 'checkpoint',
    kind: node.kind,
    locator: node.id,
    ...(node.name === undefined ? {} : { name: node.name }),
    value,
    raw: stringifyValue(value),
    ...(tags.length ? { tags } : {}),
    layer: 'semantic',
    checkpoint: true,
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
    evidence: [],
    layer: 'semantic',
    checkpoint: true,
  };
}

function shardKey(id: string): string {
  return createHash('sha256').update(id).digest('hex')[0]!;
}

function groupShards(graph: IntelligenceGraph): Map<string, Array<Record<string, unknown>>> {
  const projection = checkpointProjection(graph);
  const shards = new Map<string, Array<Record<string, unknown>>>();
  const add = (key: string, record: Record<string, unknown>) => {
    const current = shards.get(key) ?? [];
    current.push(record);
    shards.set(key, current);
  };
  for (const node of projection.nodes.map(stableNode).sort((a, b) => a.id.localeCompare(b.id))) add(shardKey(node.id), { type: 'node', ...node });
  for (const edge of projection.edges.map(stableEdge).sort((a, b) => a.id.localeCompare(b.id))) add(shardKey(edge.id), { type: 'edge', ...edge });
  return shards;
}

export function checkpointMeta(graph: IntelligenceGraph, shards: string[]): GraphCheckpointMetaV2 {
  if (!graph.sourceFingerprint) throw new Error('Repository graph is missing a source fingerprint');
  if (!graph.topologyFingerprint || !graph.evidenceFingerprint) throw new Error('Repository graph is missing stable graph fingerprints');
  const projection = checkpointProjection(graph);
  const kinds: Record<string, number> = {};
  for (const node of projection.nodes) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
  return {
    type: 'meta',
    schemaVersion: 2,
    format: 'sharded-ndjson',
    analyzerVersion: graph.analyzerVersion,
    sourceFingerprint: graph.sourceFingerprint,
    topologyFingerprint: graph.topologyFingerprint,
    evidenceFingerprint: graph.evidenceFingerprint,
    shards,
    summary: {
      nodes: projection.nodes.length,
      edges: projection.edges.length,
      unresolved: projection.edges.filter(edge => edge.status === 'unresolved').length,
      candidate: projection.edges.filter(edge => edge.status === 'candidate').length,
      kinds: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

function parseManifest(content: string): GraphCheckpointMeta {
  const meta = JSON.parse(content) as GraphCheckpointMeta;
  if (meta.type !== 'meta' || meta.format !== 'sharded-ndjson' || typeof meta.sourceFingerprint !== 'string' || !Array.isArray(meta.shards)) {
    throw new Error('Development Intelligence graph checkpoint is missing a supported manifest');
  }
  if (meta.schemaVersion !== 1 && meta.schemaVersion !== 2) throw new Error(`Unsupported Development Intelligence checkpoint schema: ${String((meta as any).schemaVersion)}`);
  if (meta.schemaVersion === 2 && (typeof meta.topologyFingerprint !== 'string' || typeof meta.evidenceFingerprint !== 'string' || typeof meta.analyzerVersion !== 'string')) {
    throw new Error('Development Intelligence v2 checkpoint is missing graph/analyzer fingerprints');
  }
  for (const shard of meta.shards) if (!/^[0-9a-f]\.ndjson$/u.test(shard)) throw new Error(`Invalid Development Intelligence graph shard: ${shard}`);
  return meta;
}

function parseShard(content: string, nodes: GraphNode[], edges: GraphEdge[]): void {
  for (const line of content.split(/\r?\n/u).filter(Boolean)) {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.type === 'node') {
      const { type: _type, ...node } = record;
      nodes.push(node as unknown as GraphNode);
    } else if (record.type === 'edge') {
      const { type: _type, ...edge } = record;
      edges.push(edge as unknown as GraphEdge);
    } else {
      throw new Error(`Unsupported Development Intelligence graph record type: ${String(record.type)}`);
    }
  }
}

export async function readCheckpoint(root: string): Promise<ParsedCheckpoint | null> {
  try {
    const meta = parseManifest(await fs.readFile(path.join(root, GRAPH_MANIFEST_PATH), 'utf8'));
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const shard of meta.shards) parseShard(await fs.readFile(path.join(root, GRAPH_SHARD_DIRECTORY, shard), 'utf8'), nodes, edges);
    nodes.sort((a, b) => a.id.localeCompare(b.id));
    edges.sort((a, b) => a.id.localeCompare(b.id));
    const countsValid = nodes.length === meta.summary.nodes && edges.length === meta.summary.edges;
    if (!countsValid) throw new Error('Development Intelligence graph checkpoint counts do not match its manifest');
    const topologyValid = meta.schemaVersion === 2 ? semanticTopologyFingerprint(nodes, edges) === meta.topologyFingerprint : null;
    if (topologyValid === false) throw new Error('Development Intelligence graph checkpoint topology fingerprint does not match shard contents');
    return { meta, nodes, edges, integrity: { countsValid, topologyValid } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeCheckpoint(root: string, graph: IntelligenceGraph): Promise<string> {
  const checkpointRoot = path.join(root, GRAPH_DIRECTORY);
  const shardRoot = path.join(root, GRAPH_SHARD_DIRECTORY);
  await fs.rm(checkpointRoot, { recursive: true, force: true });
  await fs.mkdir(shardRoot, { recursive: true });
  const grouped = groupShards({ ...graph, role: 'B' });
  const shards = [...grouped.keys()].sort().map(key => `${key}.ndjson`);
  for (const shard of shards) {
    const key = shard.slice(0, 1);
    const records = grouped.get(key) ?? [];
    await fs.writeFile(path.join(shardRoot, shard), `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  }
  const meta = checkpointMeta(graph, shards);
  const manifest = path.join(root, GRAPH_MANIFEST_PATH);
  await fs.writeFile(manifest, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return manifest;
}

export function checkpointToGraph(input: {
  project: string;
  repository: string;
  revision: string | null;
  checkpoint: ParsedCheckpoint;
}): IntelligenceGraph {
  const v2 = input.checkpoint.meta.schemaVersion === 2 ? input.checkpoint.meta : null;
  const nodes = input.checkpoint.nodes.map(node => ({
    ...node,
    sourceId: node.sourceId ?? 'checkpoint',
    locator: node.locator ?? node.id,
    layer: node.layer ?? 'semantic',
    checkpoint: node.checkpoint ?? true,
  }));
  const edges = input.checkpoint.edges.map(edge => ({ ...edge, layer: edge.layer ?? 'semantic', checkpoint: edge.checkpoint ?? true, evidence: edge.evidence ?? [] }));
  return {
    schemaVersion: 2,
    analyzerVersion: v2?.analyzerVersion ?? 'legacy-1',
    graphId: `accepted-${input.checkpoint.meta.sourceFingerprint.slice(0, 16)}`,
    project: input.project,
    role: 'A',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: input.revision,
    sourceFingerprint: input.checkpoint.meta.sourceFingerprint,
    topologyFingerprint: v2?.topologyFingerprint ?? null,
    evidenceFingerprint: v2?.evidenceFingerprint ?? null,
    sources: [{ id: 'repository', kind: 'repository-checkpoint', locator: input.repository, revision: input.revision, observedAt: new Date(0).toISOString(), available: true }],
    evidence: [],
    nodes,
    edges,
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
  };
}

export function checkpointAnalyzerCurrent(meta: GraphCheckpointMeta): boolean {
  return meta.schemaVersion === 2 && meta.analyzerVersion === ANALYZER_VERSION;
}
