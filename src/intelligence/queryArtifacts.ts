import type {
  EvidenceRecord,
  ExplicitValueConflict,
  GraphEdge,
  GraphNode,
  IntelligenceGraph,
  NamingDivergence,
  SourceDescriptor,
} from '../types.js';
import { stableHash } from '../util/hash.js';
import {
  buildGlobalQueryIndex,
  type GlobalQueryEdgeEntry,
  type GlobalQueryIndex,
  type GlobalQueryNodeEntry,
} from './adaptiveQueryPlanner.js';

export const QUERY_DETAIL_BUCKETS = 16;
const BUCKET_KEYS = '0123456789abcdef'.split('');

export interface CanonicalQueryIndexArtifact {
  formatVersion: 1;
  graphSchemaVersion: 2;
  project: string;
  revision: string;
  analyzerVersion: string;
  graphId: string;
  sourceFingerprint: string | null;
  topologyFingerprint: string | null;
  evidenceFingerprint: string | null;
  bucketCount: 16;
  sourceBuckets: Record<string, string>;
  nodes: GlobalQueryNodeEntry[];
  edges: GlobalQueryEdgeEntry[];
  coverage: GlobalQueryIndex['coverage'];
  sources: SourceDescriptor[];
  namingDivergences: NamingDivergence[];
  explicitValueConflicts: ExplicitValueConflict[];
  unmatchedNodeIds: string[];
  unavailableSourceIds: string[];
}

export interface CanonicalQueryDetailShard {
  formatVersion: 1;
  graphSchemaVersion: 2;
  project: string;
  revision: string;
  analyzerVersion: string;
  graphId: string;
  bucket: string;
  sourceIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: EvidenceRecord[];
}

export interface CanonicalQueryArtifacts {
  index: CanonicalQueryIndexArtifact;
  shards: Record<string, CanonicalQueryDetailShard>;
}

export interface MaterializedQueryDetail {
  bucketIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: EvidenceRecord[];
}

function requireRevision(graph: IntelligenceGraph): string {
  const revision = graph.repositoryRevision;
  if (!revision || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(revision)) {
    throw new Error('Canonical query artifacts require an exact repository revision');
  }
  return revision;
}

export function queryBucketForSource(sourceId: string): string {
  return stableHash([sourceId])[0]!;
}

function sourceIds(graph: IntelligenceGraph): string[] {
  return [...new Set([
    ...graph.sources.map(source => source.id),
    ...graph.nodes.map(node => node.sourceId),
    ...graph.evidence.map(item => item.sourceId),
  ])].sort();
}

function sortedValues<T extends { id: string }>(values: Map<string, T>): T[] {
  return [...values.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildCanonicalQueryArtifacts(graph: IntelligenceGraph): CanonicalQueryArtifacts {
  const revision = requireRevision(graph);
  const global = buildGlobalQueryIndex(graph);
  const sourceBuckets = Object.fromEntries(sourceIds(graph).map(sourceId => [sourceId, queryBucketForSource(sourceId)]));
  const nodeSource = new Map(graph.nodes.map(node => [node.id, node.sourceId]));
  const evidenceById = new Map(graph.evidence.map(item => [item.id, item]));

  const shardNodes = new Map<string, Map<string, GraphNode>>();
  const shardEdges = new Map<string, Map<string, GraphEdge>>();
  const shardEvidence = new Map<string, Map<string, EvidenceRecord>>();
  const shardSources = new Map<string, Set<string>>();
  for (const bucket of BUCKET_KEYS) {
    shardNodes.set(bucket, new Map());
    shardEdges.set(bucket, new Map());
    shardEvidence.set(bucket, new Map());
    shardSources.set(bucket, new Set());
  }

  const addEvidence = (bucket: string, id: string): void => {
    const item = evidenceById.get(id);
    if (!item) return;
    shardEvidence.get(bucket)!.set(item.id, item);
    shardSources.get(bucket)!.add(item.sourceId);
  };

  for (const node of graph.nodes) {
    const bucket = queryBucketForSource(node.sourceId);
    shardNodes.get(bucket)!.set(node.id, node);
    shardSources.get(bucket)!.add(node.sourceId);
    for (const id of node.evidenceIds ?? []) addEvidence(bucket, id);
  }

  for (const item of graph.evidence) {
    const bucket = queryBucketForSource(item.sourceId);
    shardEvidence.get(bucket)!.set(item.id, item);
    shardSources.get(bucket)!.add(item.sourceId);
  }

  for (const edge of graph.edges) {
    const buckets = new Set<string>();
    for (const endpoint of [edge.from, edge.to]) {
      if (!endpoint) continue;
      const sourceId = nodeSource.get(endpoint);
      if (sourceId) buckets.add(queryBucketForSource(sourceId));
    }
    for (const evidenceId of edge.evidenceIds ?? []) {
      const sourceId = evidenceById.get(evidenceId)?.sourceId;
      if (sourceId) buckets.add(queryBucketForSource(sourceId));
    }
    if (!buckets.size) buckets.add(stableHash([edge.id])[0]!);

    for (const bucket of buckets) {
      shardEdges.get(bucket)!.set(edge.id, edge);
      for (const evidenceId of edge.evidenceIds ?? []) addEvidence(bucket, evidenceId);
      const fromSource = edge.from ? nodeSource.get(edge.from) : null;
      const toSource = edge.to ? nodeSource.get(edge.to) : null;
      if (fromSource) shardSources.get(bucket)!.add(fromSource);
      if (toSource) shardSources.get(bucket)!.add(toSource);
    }
  }

  const common = {
    formatVersion: 1 as const,
    graphSchemaVersion: 2 as const,
    project: graph.project,
    revision,
    analyzerVersion: graph.analyzerVersion,
    graphId: graph.graphId,
  };

  const shards = Object.fromEntries(BUCKET_KEYS.map(bucket => [bucket, {
    ...common,
    bucket,
    sourceIds: [...shardSources.get(bucket)!].sort(),
    nodes: sortedValues(shardNodes.get(bucket)!),
    edges: sortedValues(shardEdges.get(bucket)!),
    evidence: sortedValues(shardEvidence.get(bucket)!),
  } satisfies CanonicalQueryDetailShard]));

  return {
    index: {
      ...common,
      sourceFingerprint: graph.sourceFingerprint,
      topologyFingerprint: graph.topologyFingerprint,
      evidenceFingerprint: graph.evidenceFingerprint,
      bucketCount: QUERY_DETAIL_BUCKETS,
      sourceBuckets,
      nodes: [...global.nodes],
      edges: [...global.edges],
      coverage: global.coverage,
      sources: [...graph.sources],
      namingDivergences: [...graph.namingDivergences],
      explicitValueConflicts: [...graph.explicitValueConflicts],
      unmatchedNodeIds: [...graph.unmatchedNodeIds],
      unavailableSourceIds: [...graph.unavailableSourceIds],
    },
    shards,
  };
}

export function hydrateGlobalQueryIndex(index: CanonicalQueryIndexArtifact): GlobalQueryIndex {
  const nodeById = new Map(index.nodes.map(node => [node.id, node]));
  const incident = new Map<string, GlobalQueryEdgeEntry[]>();
  const append = (id: string, edge: GlobalQueryEdgeEntry): void => {
    const current = incident.get(id);
    if (current) current.push(edge);
    else incident.set(id, [edge]);
  };
  for (const edge of index.edges) {
    if (edge.from) append(edge.from, edge);
    if (edge.to && edge.to !== edge.from) append(edge.to, edge);
  }
  return {
    graphId: index.graphId,
    revision: index.revision,
    nodes: index.nodes,
    edges: index.edges,
    nodeById,
    incidentByNode: incident,
    coverage: index.coverage,
  };
}

export function materializeQueryDetail(
  artifacts: CanonicalQueryArtifacts,
  selectedSourceIds: Iterable<string>,
): MaterializedQueryDetail {
  const bucketIds = [...new Set([...selectedSourceIds]
    .map(sourceId => artifacts.index.sourceBuckets[sourceId])
    .filter((value): value is string => Boolean(value)))].sort();
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const evidence = new Map<string, EvidenceRecord>();
  for (const bucket of bucketIds) {
    const shard = artifacts.shards[bucket];
    if (!shard) throw new Error(`Canonical query detail shard is missing: ${bucket}`);
    for (const node of shard.nodes) nodes.set(node.id, node);
    for (const edge of shard.edges) edges.set(edge.id, edge);
    for (const item of shard.evidence) evidence.set(item.id, item);
  }
  return {
    bucketIds,
    nodes: sortedValues(nodes),
    edges: sortedValues(edges),
    evidence: sortedValues(evidence),
  };
}

export function serializedQueryArtifactBytes(artifacts: CanonicalQueryArtifacts): {
  indexBytes: number;
  shardBytes: Record<string, number>;
  totalShardBytes: number;
  maxShardBytes: number;
} {
  const encoder = new TextEncoder();
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const shardBytes = Object.fromEntries(Object.entries(artifacts.shards).map(([key, shard]) => [key, size(shard)]));
  const values = Object.values(shardBytes);
  return {
    indexBytes: size(artifacts.index),
    shardBytes,
    totalShardBytes: values.reduce((sum, value) => sum + value, 0),
    maxShardBytes: Math.max(0, ...values),
  };
}
