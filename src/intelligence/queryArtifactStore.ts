import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { IntelligenceGraph } from '../types.js';
import { stableHash } from '../util/hash.js';
import {
  canonicalDerivedStorageInfo,
  readCanonicalDerivedObject,
  writeCanonicalDerivedObject,
  type CanonicalQueryArtifactGenerationRef,
} from './canonicalStore.js';
import {
  buildCanonicalQueryArtifacts,
  type CanonicalQueryArtifacts,
  type CanonicalQueryDetailShard,
  type CanonicalQueryIndexArtifact,
} from './queryArtifacts.js';

export const QUERY_ARTIFACT_SLOT_COUNT = 4;
export const QUERY_ARTIFACT_FORMAT_VERSION = 4;

export interface CanonicalQueryArtifactDescriptor {
  path: string;
  sha256: string;
  bytes: number;
  uncompressedBytes: number;
  encoding: 'gzip';
}

export interface CanonicalQueryArtifactManifest {
  formatVersion: 1;
  artifactFormatVersion: 4;
  generationId: string;
  slot: number;
  project: string;
  revision: string;
  analyzerVersion: string;
  graphSchemaVersion: 2;
  graphId: string;
  sourceFingerprint: string | null;
  topologyFingerprint: string | null;
  evidenceFingerprint: string | null;
  createdAt: string;
  index: CanonicalQueryArtifactDescriptor;
  shards: Record<string, CanonicalQueryArtifactDescriptor>;
}

export interface PreparedCanonicalQueryArtifactGeneration {
  ref: CanonicalQueryArtifactGenerationRef;
  manifest: CanonicalQueryArtifactManifest;
  manifestPath: string;
  manifestPayload: string;
  objects: Array<{ descriptor: CanonicalQueryArtifactDescriptor; body: Uint8Array }>;
}

export interface CanonicalQueryArtifactPublishResult {
  state: 'not-configured' | 'stored' | 'error';
  saveMs: number;
  ref: CanonicalQueryArtifactGenerationRef | null;
  error?: string;
}

export interface CanonicalQueryArtifactLoadResult {
  state: 'not-configured' | 'miss' | 'hit' | 'invalid' | 'error';
  loadMs: number;
  index?: CanonicalQueryIndexArtifact;
  shards?: Record<string, CanonicalQueryDetailShard>;
  error?: string;
}

function sha256(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function generationId(graph: IntelligenceGraph): string {
  return stableHash([
    graph.project,
    graph.repositoryRevision,
    graph.analyzerVersion,
    graph.schemaVersion,
    graph.sourceFingerprint,
    graph.topologyFingerprint,
    graph.evidenceFingerprint,
    QUERY_ARTIFACT_FORMAT_VERSION,
  ]);
}

function slotAfter(previous: CanonicalQueryArtifactGenerationRef | null | undefined): number {
  return previous ? (previous.slot + 1) % QUERY_ARTIFACT_SLOT_COUNT : 0;
}

function slotPrefix(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= QUERY_ARTIFACT_SLOT_COUNT) throw new Error('Invalid canonical query artifact slot');
  return `query-slots/${slot}`;
}

function encodeArtifact(value: unknown): { body: Uint8Array; bytes: number; uncompressedBytes: number; sha256: string } {
  const raw = Buffer.from(JSON.stringify(value), 'utf8');
  const body = new Uint8Array(gzipSync(raw, { level: 6 }));
  return { body, bytes: body.byteLength, uncompressedBytes: raw.byteLength, sha256: sha256(body) };
}

function descriptor(path: string, encoded: ReturnType<typeof encodeArtifact>): CanonicalQueryArtifactDescriptor {
  return { path, sha256: encoded.sha256, bytes: encoded.bytes, uncompressedBytes: encoded.uncompressedBytes, encoding: 'gzip' };
}

export function prepareCanonicalQueryArtifactGeneration(
  graph: IntelligenceGraph,
  previous: CanonicalQueryArtifactGenerationRef | null | undefined = null,
): PreparedCanonicalQueryArtifactGeneration {
  if (!graph.repositoryRevision) throw new Error('Canonical query artifact publication requires an exact repository revision');
  const generation = generationId(graph);
  const slot = slotAfter(previous);
  const prefix = slotPrefix(slot);
  const artifacts = buildCanonicalQueryArtifacts(graph);
  const objects: PreparedCanonicalQueryArtifactGeneration['objects'] = [];

  const encodedIndex = encodeArtifact(artifacts.index);
  const index = descriptor(`${prefix}/index.json.gz`, encodedIndex);
  objects.push({ descriptor: index, body: encodedIndex.body });

  const shards: Record<string, CanonicalQueryArtifactDescriptor> = {};
  for (const [bucket, shard] of Object.entries(artifacts.shards).sort(([a], [b]) => a.localeCompare(b))) {
    const encoded = encodeArtifact(shard);
    const item = descriptor(`${prefix}/shards/${bucket}.json.gz`, encoded);
    shards[bucket] = item;
    objects.push({ descriptor: item, body: encoded.body });
  }

  const manifest: CanonicalQueryArtifactManifest = {
    formatVersion: 1,
    artifactFormatVersion: QUERY_ARTIFACT_FORMAT_VERSION,
    generationId: generation,
    slot,
    project: graph.project,
    revision: graph.repositoryRevision,
    analyzerVersion: graph.analyzerVersion,
    graphSchemaVersion: 2,
    graphId: graph.graphId,
    sourceFingerprint: graph.sourceFingerprint,
    topologyFingerprint: graph.topologyFingerprint,
    evidenceFingerprint: graph.evidenceFingerprint,
    createdAt: new Date().toISOString(),
    index,
    shards,
  };
  const manifestPayload = JSON.stringify(manifest);
  const ref: CanonicalQueryArtifactGenerationRef = {
    formatVersion: 1,
    artifactFormatVersion: QUERY_ARTIFACT_FORMAT_VERSION,
    generationId: generation,
    slot,
    objectCount: objects.length,
    manifestSha256: sha256(manifestPayload),
  };
  return {
    ref,
    manifest,
    manifestPath: `${prefix}/manifest.json`,
    manifestPayload,
    objects,
  };
}

async function writeBatches<T>(items: T[], size: number, operation: (item: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(operation));
  }
}

export async function persistPreparedCanonicalQueryArtifacts(
  project: string,
  prepared: PreparedCanonicalQueryArtifactGeneration,
  options: { publishManifest?: boolean } = {},
): Promise<void> {
  await writeBatches(prepared.objects, 8, async item => {
    const stored = await writeCanonicalDerivedObject(project, item.descriptor.path, item.body, 'application/gzip');
    if (!stored) throw new Error('Canonical derived storage is not configured');
  });
  if (options.publishManifest !== false) {
    const stored = await writeCanonicalDerivedObject(project, prepared.manifestPath, prepared.manifestPayload, 'application/json');
    if (!stored) throw new Error('Canonical derived storage is not configured');
  }
}

export async function publishCanonicalQueryArtifacts(
  graph: IntelligenceGraph,
  previous: CanonicalQueryArtifactGenerationRef | null | undefined = null,
): Promise<CanonicalQueryArtifactPublishResult> {
  const startedAt = Date.now();
  const storage = canonicalDerivedStorageInfo();
  if (!storage.durable) return { state: 'not-configured', saveMs: 0, ref: null };
  try {
    const prepared = prepareCanonicalQueryArtifactGeneration(graph, previous);
    await persistPreparedCanonicalQueryArtifacts(graph.project, prepared);
    return { state: 'stored', saveMs: Math.max(0, Date.now() - startedAt), ref: prepared.ref };
  } catch (error) {
    return {
      state: 'error',
      saveMs: Math.max(0, Date.now() - startedAt),
      ref: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateManifest(
  value: unknown,
  graph: IntelligenceGraph,
  ref: CanonicalQueryArtifactGenerationRef,
): CanonicalQueryArtifactManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Canonical query artifact manifest must be an object');
  const manifest = value as CanonicalQueryArtifactManifest;
  if (
    manifest.formatVersion !== 1
    || manifest.artifactFormatVersion !== QUERY_ARTIFACT_FORMAT_VERSION
    || manifest.generationId !== ref.generationId
    || manifest.slot !== ref.slot
    || manifest.project !== graph.project
    || manifest.revision !== graph.repositoryRevision
    || manifest.analyzerVersion !== graph.analyzerVersion
    || manifest.graphSchemaVersion !== 2
    || manifest.graphId !== graph.graphId
    || manifest.sourceFingerprint !== graph.sourceFingerprint
    || manifest.topologyFingerprint !== graph.topologyFingerprint
    || manifest.evidenceFingerprint !== graph.evidenceFingerprint
  ) throw new Error('Canonical query artifact manifest identity is stale or malformed');
  if (!manifest.index || !manifest.shards || Object.keys(manifest.shards).length !== 64) {
    throw new Error('Canonical query artifact manifest inventory is incomplete');
  }
  return manifest;
}

async function readDescriptor(project: string, item: CanonicalQueryArtifactDescriptor): Promise<unknown> {
  const body = await readCanonicalDerivedObject(project, item.path, Math.max(item.bytes + 1024, 1024));
  if (!body) throw new Error(`Canonical query artifact object is missing: ${item.path}`);
  if (body.byteLength !== item.bytes || sha256(body) !== item.sha256) throw new Error(`Canonical query artifact object failed integrity validation: ${item.path}`);
  const raw = gunzipSync(body);
  if (raw.byteLength !== item.uncompressedBytes) throw new Error(`Canonical query artifact object size is invalid: ${item.path}`);
  return JSON.parse(Buffer.from(raw).toString('utf8'));
}

export async function loadCanonicalQueryArtifacts(
  graph: IntelligenceGraph,
  ref: CanonicalQueryArtifactGenerationRef | null | undefined,
  bucketIds: string[] = [],
): Promise<CanonicalQueryArtifactLoadResult> {
  const startedAt = Date.now();
  const storage = canonicalDerivedStorageInfo();
  if (!storage.durable) return { state: 'not-configured', loadMs: 0 };
  if (!ref) return { state: 'miss', loadMs: 0 };
  try {
    const manifestPath = `${slotPrefix(ref.slot)}/manifest.json`;
    const manifestBody = await readCanonicalDerivedObject(graph.project, manifestPath, 4 * 1024 * 1024);
    if (!manifestBody) return { state: 'miss', loadMs: Math.max(0, Date.now() - startedAt) };
    const manifestText = Buffer.from(manifestBody).toString('utf8');
    if (sha256(manifestText) !== ref.manifestSha256) throw new Error('Canonical query artifact manifest integrity does not match the canonical graph reference');
    const manifest = validateManifest(JSON.parse(manifestText), graph, ref);

    const index = await readDescriptor(graph.project, manifest.index) as CanonicalQueryIndexArtifact;
    const shards: Record<string, CanonicalQueryDetailShard> = {};
    for (const bucket of [...new Set(bucketIds)].sort()) {
      const item = manifest.shards[bucket];
      if (!item) throw new Error(`Canonical query artifact shard is not declared: ${bucket}`);
      const shard = await readDescriptor(graph.project, item) as CanonicalQueryDetailShard;
      if (
        shard.formatVersion !== QUERY_ARTIFACT_FORMAT_VERSION
        || shard.project !== graph.project
        || shard.revision !== graph.repositoryRevision
        || shard.graphId !== graph.graphId
        || shard.bucket !== bucket
      ) throw new Error(`Canonical query artifact shard identity is invalid: ${bucket}`);
      shards[bucket] = shard;
    }
    if (
      index.formatVersion !== QUERY_ARTIFACT_FORMAT_VERSION
      || index.project !== graph.project
      || index.revision !== graph.repositoryRevision
      || index.graphId !== graph.graphId
    ) throw new Error('Canonical query artifact index identity is invalid');
    return { state: 'hit', loadMs: Math.max(0, Date.now() - startedAt), index, shards };
  } catch (error) {
    return {
      state: 'invalid',
      loadMs: Math.max(0, Date.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
