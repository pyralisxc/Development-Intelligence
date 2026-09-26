import type {
  EvidenceRecord,
  GraphEdge,
  GraphNode,
  GraphNodeLayer,
  IntelligenceGraph,
  RelationshipStatus,
} from '../types.js';

export const QUERY_DETAIL_BUCKETS = 16;
const BUCKET_KEYS = '0123456789abcdef'.split('');
const HASH_SEED = 0x811c9dc5;

export type CanonicalNodeSearchRecord = [
  bucket: string,
  id: string,
  kind: string,
  layer: GraphNodeLayer,
  text: string,
];

export type CanonicalEdgeSearchRecord = [
  bucketMask: number,
  id: string,
  kind: string,
  strategy: string,
  status: RelationshipStatus,
  layer: GraphNodeLayer,
  text: string,
];

export interface CanonicalQuerySemanticNode {
  id: string;
  sourceId: string;
  kind: string;
  locator: string;
  name: string | null;
  layer: 'semantic';
}

export interface CanonicalQuerySemanticEdge {
  id: string;
  from: string | null;
  to: string | null;
  kind: string;
  strategy: string;
  status: RelationshipStatus;
  layer: 'semantic';
}

export interface CanonicalQueryBucketSummary {
  nodeCount: number;
  edgeCount: number;
  evidenceCount: number;
}

export interface CanonicalQueryIndexArtifact {
  formatVersion: 4;
  graphSchemaVersion: 2;
  project: string;
  revision: string;
  analyzerVersion: string;
  graphId: string;
  sourceFingerprint: string | null;
  topologyFingerprint: string | null;
  evidenceFingerprint: string | null;
  bucketCount: 16;
  nodeSearch: CanonicalNodeSearchRecord[];
  edgeSearch: CanonicalEdgeSearchRecord[];
  buckets: Record<string, CanonicalQueryBucketSummary>;
  semanticNodes: CanonicalQuerySemanticNode[];
  semanticEdges: CanonicalQuerySemanticEdge[];
  coverage: {
    completeForEligibleSources: boolean;
    eligibleFiles: number | null;
    analyzedFiles: number | null;
    partialFiles: number | null;
    failedFiles: number | null;
    skippedFiles: number | null;
  };
  counts: {
    nodes: number;
    edges: number;
    evidence: number;
    semanticNodes: number;
    semanticEdges: number;
    unmatchedNodes: number;
    namingDivergences: number;
    explicitValueConflicts: number;
    unavailableSources: number;
  };
}

export interface CanonicalQueryDetailShard {
  formatVersion: 4;
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
  boundaryBuckets: Record<string, { from: string | null; to: string | null }>;
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

function hash32(value: string): number {
  let hash = HASH_SEED >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function queryBucketForSource(sourceId: string): string {
  return BUCKET_KEYS[hash32(sourceId) & 0x0f]!;
}

function nodeTailText(node: GraphNode): string {
  return [node.locator, node.field, node.name, node.raw, JSON.stringify(node.value)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function edgeTailText(edge: GraphEdge): string {
  return edge.evidence.join(' ').toLowerCase();
}

function layerOf(value: { layer?: GraphNodeLayer }): GraphNodeLayer {
  return value.layer ?? 'structural';
}

function recordIncludes(
  needle: string,
  fields: Array<string | null | undefined>,
): boolean {
  return fields.some(value => typeof value === 'string' && value.toLowerCase().includes(needle));
}

function coverageSummary(graph: IntelligenceGraph): CanonicalQueryIndexArtifact['coverage'] {
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

function sortedValues<T extends { id: string }>(values: Map<string, T>): T[] {
  return [...values.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function compactSemanticNode(node: GraphNode): CanonicalQuerySemanticNode {
  return {
    id: node.id,
    sourceId: node.sourceId,
    kind: node.kind,
    locator: node.locator,
    name: node.name ?? null,
    layer: 'semantic',
  };
}

function compactSemanticEdge(edge: GraphEdge): CanonicalQuerySemanticEdge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    strategy: edge.strategy,
    status: edge.status,
    layer: 'semantic',
  };
}

export function buildCanonicalQueryArtifacts(graph: IntelligenceGraph): CanonicalQueryArtifacts {
  const revision = requireRevision(graph);
  const nodeSource = new Map(graph.nodes.map(node => [node.id, node.sourceId]));
  const evidenceById = new Map(graph.evidence.map(item => [item.id, item]));

  const shardNodes = new Map<string, Map<string, GraphNode>>();
  const shardEdges = new Map<string, Map<string, GraphEdge>>();
  const shardEvidence = new Map<string, Map<string, EvidenceRecord>>();
  const shardSources = new Map<string, Set<string>>();
  const boundaryBuckets = new Map<string, Record<string, { from: string | null; to: string | null }>>();
  for (const bucket of BUCKET_KEYS) {
    shardNodes.set(bucket, new Map());
    shardEdges.set(bucket, new Map());
    shardEvidence.set(bucket, new Map());
    shardSources.set(bucket, new Set());
    boundaryBuckets.set(bucket, {});
  }

  const nodeSearch: CanonicalNodeSearchRecord[] = [];
  const edgeSearch: CanonicalEdgeSearchRecord[] = [];

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
    nodeSearch.push([bucket, node.id, node.kind, layerOf(node), nodeTailText(node)]);
    for (const id of node.evidenceIds ?? []) addEvidence(bucket, id);
  }

  for (const item of graph.evidence) {
    const bucket = queryBucketForSource(item.sourceId);
    shardEvidence.get(bucket)!.set(item.id, item);
    shardSources.get(bucket)!.add(item.sourceId);
  }

  for (const edge of graph.edges) {
    const fromSource = edge.from ? nodeSource.get(edge.from) ?? null : null;
    const toSource = edge.to ? nodeSource.get(edge.to) ?? null : null;
    const fromBucket = fromSource ? queryBucketForSource(fromSource) : null;
    const toBucket = toSource ? queryBucketForSource(toSource) : null;
    const buckets = new Set<string>();
    if (fromBucket) buckets.add(fromBucket);
    if (toBucket) buckets.add(toBucket);
    for (const evidenceId of edge.evidenceIds ?? []) {
      const sourceId = evidenceById.get(evidenceId)?.sourceId;
      if (sourceId) buckets.add(queryBucketForSource(sourceId));
    }
    if (!buckets.size) buckets.add(BUCKET_KEYS[hash32(edge.id) & 0x0f]!);

    let bucketMask = 0;
    for (const bucket of buckets) {
      bucketMask |= 1 << Number.parseInt(bucket, 16);
      shardEdges.get(bucket)!.set(edge.id, edge);
      boundaryBuckets.get(bucket)![edge.id] = { from: fromBucket, to: toBucket };
      for (const evidenceId of edge.evidenceIds ?? []) addEvidence(bucket, evidenceId);
      if (fromSource) shardSources.get(bucket)!.add(fromSource);
      if (toSource) shardSources.get(bucket)!.add(toSource);
    }
    edgeSearch.push([bucketMask, edge.id, edge.kind, edge.strategy, edge.status, layerOf(edge), edgeTailText(edge)]);
  }

  const common = {
    formatVersion: 4 as const,
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
    boundaryBuckets: boundaryBuckets.get(bucket)!,
  } satisfies CanonicalQueryDetailShard]));

  const semanticNodes = graph.nodes.filter(node => node.layer === 'semantic').map(compactSemanticNode);
  const semanticEdges = graph.edges.filter(edge => edge.layer === 'semantic').map(compactSemanticEdge);

  return {
    index: {
      ...common,
      sourceFingerprint: graph.sourceFingerprint,
      topologyFingerprint: graph.topologyFingerprint,
      evidenceFingerprint: graph.evidenceFingerprint,
      bucketCount: QUERY_DETAIL_BUCKETS,
      nodeSearch,
      edgeSearch,
      buckets: Object.fromEntries(BUCKET_KEYS.map(bucket => [bucket, {
        nodeCount: shardNodes.get(bucket)!.size,
        edgeCount: shardEdges.get(bucket)!.size,
        evidenceCount: shardEvidence.get(bucket)!.size,
      }])),
      semanticNodes,
      semanticEdges,
      coverage: coverageSummary(graph),
      counts: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        evidence: graph.evidence.length,
        semanticNodes: semanticNodes.length,
        semanticEdges: semanticEdges.length,
        unmatchedNodes: graph.unmatchedNodeIds.length,
        namingDivergences: graph.namingDivergences.length,
        explicitValueConflicts: graph.explicitValueConflicts.length,
        unavailableSources: graph.unavailableSourceIds.length,
      },
    },
    shards,
  };
}

function bucketsFromMask(mask: number): string[] {
  return BUCKET_KEYS.filter((_, index) => Boolean(mask & (1 << index)));
}

export function candidateQueryBuckets(index: CanonicalQueryIndexArtifact, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...BUCKET_KEYS];
  let mask = 0;
  for (const [bucket, id, kind, layer, text] of index.nodeSearch) {
    if (recordIncludes(needle, [id, kind, layer, text])) mask |= 1 << Number.parseInt(bucket, 16);
  }
  for (const [bucketMask, id, kind, strategy, status, layer, text] of index.edgeSearch) {
    if (recordIncludes(needle, [id, kind, strategy, status, layer, text])) mask |= bucketMask;
  }
  return bucketsFromMask(mask);
}

export function materializeQueryBuckets(
  artifacts: CanonicalQueryArtifacts,
  bucketIds: Iterable<string>,
): MaterializedQueryDetail {
  const selected = [...new Set(bucketIds)].sort();
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const evidence = new Map<string, EvidenceRecord>();
  for (const bucket of selected) {
    const shard = artifacts.shards[bucket];
    if (!shard) throw new Error(`Canonical query detail shard is missing: ${bucket}`);
    for (const node of shard.nodes) nodes.set(node.id, node);
    for (const edge of shard.edges) edges.set(edge.id, edge);
    for (const item of shard.evidence) evidence.set(item.id, item);
  }
  return {
    bucketIds: selected,
    nodes: sortedValues(nodes),
    edges: sortedValues(edges),
    evidence: sortedValues(evidence),
  };
}

export function materializeQueryDetail(
  artifacts: CanonicalQueryArtifacts,
  selectedSourceIds: Iterable<string>,
): MaterializedQueryDetail {
  return materializeQueryBuckets(artifacts, [...selectedSourceIds].map(queryBucketForSource));
}

export function serializedQueryArtifactBytes(artifacts: CanonicalQueryArtifacts): {
  indexBytes: number;
  shardBytes: Record<string, number>;
  totalShardBytes: number;
  maxShardBytes: number;
  searchRecords: number;
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
    searchRecords: artifacts.index.nodeSearch.length + artifacts.index.edgeSearch.length,
  };
}
