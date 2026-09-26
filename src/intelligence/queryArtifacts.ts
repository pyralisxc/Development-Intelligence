import type {
  EvidenceRecord,
  GraphEdge,
  GraphNode,
  IntelligenceGraph,
} from '../types.js';

export const QUERY_DETAIL_BUCKETS = 16;
const BUCKET_KEYS = '0123456789abcdef'.split('');
const HASH_SEED = 0x811c9dc5;

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
  status: 'resolved' | 'candidate' | 'unresolved';
  layer: 'semantic';
}

export interface CanonicalQueryBucketSummary {
  nodeCount: number;
  edgeCount: number;
  evidenceCount: number;
}

export interface CanonicalQueryIndexArtifact {
  formatVersion: 3;
  graphSchemaVersion: 2;
  project: string;
  revision: string;
  analyzerVersion: string;
  graphId: string;
  sourceFingerprint: string | null;
  topologyFingerprint: string | null;
  evidenceFingerprint: string | null;
  bucketCount: 16;
  exactBuckets: Record<string, number>;
  trigramBuckets: Record<string, number>;
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
  formatVersion: 3;
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

function lexicalAtoms(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const original = typeof value === 'string' ? value : JSON.stringify(value);
  if (!original) return [];
  const normalized = original.trim().toLowerCase();
  const atoms = new Set<string>();
  if (normalized) atoms.add(normalized);
  for (const token of original
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9_./:@#-]+/u)
    .flatMap(part => part.split(/[\\/]/u))
    .map(part => part.trim().toLowerCase())
    .filter(Boolean)) {
    atoms.add(token);
    const dotted = token.split(/[.:@#_-]+/u).filter(Boolean);
    for (const part of dotted) atoms.add(part);
  }
  return [...atoms].filter(atom => atom.length >= 2 && atom.length <= 512);
}

function nodeAtoms(node: GraphNode): string[] {
  return [...new Set([
    ...lexicalAtoms(node.id),
    ...lexicalAtoms(node.kind),
    ...lexicalAtoms(node.layer),
    ...lexicalAtoms(node.locator),
    ...lexicalAtoms(node.field),
    ...lexicalAtoms(node.name),
    ...lexicalAtoms(node.raw),
    ...lexicalAtoms(node.value),
  ])];
}

function edgeAtoms(edge: GraphEdge): string[] {
  return [...new Set([
    ...lexicalAtoms(edge.id),
    ...lexicalAtoms(edge.kind),
    ...lexicalAtoms(edge.layer),
    ...lexicalAtoms(edge.strategy),
    ...lexicalAtoms(edge.status),
    ...edge.evidence.flatMap(lexicalAtoms),
  ])];
}

function addMask(masks: Map<string, number>, value: string, bit: number): void {
  masks.set(value, (masks.get(value) ?? 0) | bit);
}

function addSearchMasks(
  exactMasks: Map<string, number>,
  trigramMasks: Map<string, number>,
  text: string,
  atoms: string[],
  bucket: string,
): void {
  const bit = 1 << Number.parseInt(bucket, 16);
  for (const atom of atoms) addMask(exactMasks, atom, bit);
  for (const gram of trigrams(text)) addMask(trigramMasks, gram, bit);
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
  const exactMasks = new Map<string, number>();
  const trigramMasks = new Map<string, number>();

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
    addSearchMasks(exactMasks, trigramMasks, nodeSearchText(node), nodeAtoms(node), bucket);
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

    for (const bucket of buckets) {
      shardEdges.get(bucket)!.set(edge.id, edge);
      boundaryBuckets.get(bucket)![edge.id] = { from: fromBucket, to: toBucket };
      addSearchMasks(exactMasks, trigramMasks, edgeSearchText(edge), edgeAtoms(edge), bucket);
      for (const evidenceId of edge.evidenceIds ?? []) addEvidence(bucket, evidenceId);
      if (fromSource) shardSources.get(bucket)!.add(fromSource);
      if (toSource) shardSources.get(bucket)!.add(toSource);
    }
  }

  const common = {
    formatVersion: 3 as const,
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
      exactBuckets: Object.fromEntries([...exactMasks.entries()].sort(([a], [b]) => a.localeCompare(b))),
      trigramBuckets: Object.fromEntries([...trigramMasks.entries()].sort(([a], [b]) => a.localeCompare(b))),
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
  if (needle.length < 3) return [...BUCKET_KEYS];

  const exactMask = index.exactBuckets[needle];
  if (exactMask !== undefined) return bucketsFromMask(exactMask);

  const grams = trigrams(needle);
  let mask = 0xffff;
  for (const gram of grams) {
    const gramMask = index.trigramBuckets[gram] ?? 0;
    mask &= gramMask;
    if (mask === 0) return [];
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
  exactAtomCount: number;
  trigramCount: number;
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
    exactAtomCount: Object.keys(artifacts.index.exactBuckets).length,
    trigramCount: Object.keys(artifacts.index.trigramBuckets).length,
  };
}
