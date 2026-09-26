import type {
  EvidenceRecord,
  ExplicitValueConflict,
  GraphEdge,
  GraphNode,
  IntelligenceGraph,
  NamingDivergence,
  SourceDescriptor,
} from '../types.js';

export const QUERY_DETAIL_BUCKETS = 16;
export const QUERY_BLOOM_BYTES = 64 * 1024;
export const QUERY_BLOOM_HASHES = 4;
const BUCKET_KEYS = '0123456789abcdef'.split('');
const HASH_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];

export interface CanonicalQueryBucketFilter {
  encoding: 'base64';
  bitCount: number;
  hashCount: number;
  bits: string;
  setBits: number;
  nodeCount: number;
  edgeCount: number;
}

export interface CanonicalQueryIndexArtifact {
  formatVersion: 2;
  graphSchemaVersion: 2;
  project: string;
  revision: string;
  analyzerVersion: string;
  graphId: string;
  sourceFingerprint: string | null;
  topologyFingerprint: string | null;
  evidenceFingerprint: string | null;
  bucketCount: 16;
  bucketFilters: Record<string, CanonicalQueryBucketFilter>;
  semanticNodes: GraphNode[];
  semanticEdges: GraphEdge[];
  coverage: {
    completeForEligibleSources: boolean;
    eligibleFiles: number | null;
    analyzedFiles: number | null;
    partialFiles: number | null;
    failedFiles: number | null;
    skippedFiles: number | null;
  };
  sources: SourceDescriptor[];
  namingDivergences: NamingDivergence[];
  explicitValueConflicts: ExplicitValueConflict[];
  unmatchedNodeIds: string[];
  unavailableSourceIds: string[];
  counts: {
    nodes: number;
    edges: number;
    evidence: number;
  };
}

export interface CanonicalQueryDetailShard {
  formatVersion: 2;
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

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function queryBucketForSource(sourceId: string): string {
  return BUCKET_KEYS[hash32(sourceId, HASH_SEEDS[0]!) & 0x0f]!;
}

function nodeSearchText(node: GraphNode): string {
  return [node.id, node.kind, node.layer, node.locator, node.field, node.name, node.raw, JSON.stringify(node.value)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function edgeSearchText(edge: GraphEdge): string {
  return [edge.id, edge.kind, edge.layer, edge.strategy, edge.status, ...edge.evidence]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function trigrams(value: string): string[] {
  if (value.length < 3) return [];
  const out = new Set<string>();
  for (let index = 0; index <= value.length - 3; index += 1) out.add(value.slice(index, index + 3));
  return [...out];
}

function bitSet(bits: Uint8Array, bit: number): boolean {
  return Boolean(bits[bit >>> 3]! & (1 << (bit & 7)));
}

function setBit(bits: Uint8Array, bit: number): boolean {
  const index = bit >>> 3;
  const mask = 1 << (bit & 7);
  const before = bits[index]!;
  bits[index] = before | mask;
  return before !== bits[index];
}

function bloomPositions(token: string, bitCount: number): number[] {
  return HASH_SEEDS.slice(0, QUERY_BLOOM_HASHES).map(seed => hash32(token, seed) % bitCount);
}

function addSearchText(bits: Uint8Array, text: string): number {
  let added = 0;
  const bitCount = bits.byteLength * 8;
  for (const token of trigrams(text)) {
    for (const position of bloomPositions(token, bitCount)) if (setBit(bits, position)) added += 1;
  }
  return added;
}

function maybeContains(bits: Uint8Array, query: string): boolean {
  const tokens = trigrams(query);
  if (!tokens.length) return true;
  const bitCount = bits.byteLength * 8;
  return tokens.every(token => bloomPositions(token, bitCount).every(position => bitSet(bits, position)));
}

function base64Encode(bits: Uint8Array): string {
  return Buffer.from(bits).toString('base64');
}

function base64Decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
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

export function buildCanonicalQueryArtifacts(graph: IntelligenceGraph): CanonicalQueryArtifacts {
  const revision = requireRevision(graph);
  const nodeSource = new Map(graph.nodes.map(node => [node.id, node.sourceId]));
  const evidenceById = new Map(graph.evidence.map(item => [item.id, item]));

  const shardNodes = new Map<string, Map<string, GraphNode>>();
  const shardEdges = new Map<string, Map<string, GraphEdge>>();
  const shardEvidence = new Map<string, Map<string, EvidenceRecord>>();
  const shardSources = new Map<string, Set<string>>();
  const boundaryBuckets = new Map<string, Record<string, { from: string | null; to: string | null }>>();
  const bloomBits = new Map<string, Uint8Array>();
  const bloomSetBits = new Map<string, number>();
  for (const bucket of BUCKET_KEYS) {
    shardNodes.set(bucket, new Map());
    shardEdges.set(bucket, new Map());
    shardEvidence.set(bucket, new Map());
    shardSources.set(bucket, new Set());
    boundaryBuckets.set(bucket, {});
    bloomBits.set(bucket, new Uint8Array(QUERY_BLOOM_BYTES));
    bloomSetBits.set(bucket, 0);
  }

  const addBloom = (bucket: string, text: string): void => {
    const added = addSearchText(bloomBits.get(bucket)!, text);
    bloomSetBits.set(bucket, bloomSetBits.get(bucket)! + added);
  };
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
    addBloom(bucket, nodeSearchText(node));
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
    if (!buckets.size) buckets.add(BUCKET_KEYS[hash32(edge.id, HASH_SEEDS[1]!) & 0x0f]!);

    for (const bucket of buckets) {
      shardEdges.get(bucket)!.set(edge.id, edge);
      boundaryBuckets.get(bucket)![edge.id] = { from: fromBucket, to: toBucket };
      addBloom(bucket, edgeSearchText(edge));
      for (const evidenceId of edge.evidenceIds ?? []) addEvidence(bucket, evidenceId);
      if (fromSource) shardSources.get(bucket)!.add(fromSource);
      if (toSource) shardSources.get(bucket)!.add(toSource);
    }
  }

  const common = {
    formatVersion: 2 as const,
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

  const bucketFilters = Object.fromEntries(BUCKET_KEYS.map(bucket => {
    const bits = bloomBits.get(bucket)!;
    return [bucket, {
      encoding: 'base64' as const,
      bitCount: bits.byteLength * 8,
      hashCount: QUERY_BLOOM_HASHES,
      bits: base64Encode(bits),
      setBits: bloomSetBits.get(bucket)!,
      nodeCount: shardNodes.get(bucket)!.size,
      edgeCount: shardEdges.get(bucket)!.size,
    } satisfies CanonicalQueryBucketFilter];
  }));

  return {
    index: {
      ...common,
      sourceFingerprint: graph.sourceFingerprint,
      topologyFingerprint: graph.topologyFingerprint,
      evidenceFingerprint: graph.evidenceFingerprint,
      bucketCount: QUERY_DETAIL_BUCKETS,
      bucketFilters,
      semanticNodes: graph.nodes.filter(node => node.layer === 'semantic'),
      semanticEdges: graph.edges.filter(edge => edge.layer === 'semantic'),
      coverage: coverageSummary(graph),
      sources: [...graph.sources],
      namingDivergences: [...graph.namingDivergences],
      explicitValueConflicts: [...graph.explicitValueConflicts],
      unmatchedNodeIds: [...graph.unmatchedNodeIds],
      unavailableSourceIds: [...graph.unavailableSourceIds],
      counts: { nodes: graph.nodes.length, edges: graph.edges.length, evidence: graph.evidence.length },
    },
    shards,
  };
}

export function candidateQueryBuckets(index: CanonicalQueryIndexArtifact, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 3) return [...BUCKET_KEYS];
  return BUCKET_KEYS.filter(bucket => {
    const filter = index.bucketFilters[bucket];
    if (!filter || filter.encoding !== 'base64' || filter.bitCount !== QUERY_BLOOM_BYTES * 8 || filter.hashCount !== QUERY_BLOOM_HASHES) {
      throw new Error(`Unsupported canonical query bucket filter: ${bucket}`);
    }
    return maybeContains(base64Decode(filter.bits), needle);
  });
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
  maxFilterSaturation: number;
} {
  const encoder = new TextEncoder();
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const shardBytes = Object.fromEntries(Object.entries(artifacts.shards).map(([key, shard]) => [key, size(shard)]));
  const values = Object.values(shardBytes);
  const saturations = Object.values(artifacts.index.bucketFilters).map(filter => filter.setBits / filter.bitCount);
  return {
    indexBytes: size(artifacts.index),
    shardBytes,
    totalShardBytes: values.reduce((sum, value) => sum + value, 0),
    maxShardBytes: Math.max(0, ...values),
    maxFilterSaturation: Math.max(0, ...saturations),
  };
}
