import { createHash } from 'node:crypto';
import { createGzip, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import type { IntelligenceGraph } from '../types.js';
import { stableHash } from '../util/hash.js';
import {
  canonicalDerivedStorageInfo,
  readCanonicalDerivedObject,
  readCanonicalDerivedObjectVersioned,
  writeCanonicalDerivedObject,
  writeCanonicalDerivedObjectConditional,
  type CanonicalQueryArtifactGenerationRef,
} from './canonicalStore.js';
import {
  buildCanonicalQueryArtifacts,
  populatedQueryBuckets,
  type CanonicalQueryArtifacts,
  type CanonicalQueryDetailShard,
  type CanonicalQueryIndexArtifact,
} from './queryArtifacts.js';

export const QUERY_ARTIFACT_SLOT_COUNT = 4;
export const QUERY_ARTIFACT_FORMAT_VERSION = 5;
const QUERY_ARTIFACT_SLOT_RESERVATION_STALE_MS = 60 * 60 * 1000;

export interface CanonicalQueryArtifactDescriptor {
  path: string;
  sha256: string;
  bytes: number;
  uncompressedBytes: number;
  encoding: 'gzip';
  parts?: Array<{ path: string; bytes: number; sha256: string }>;
}

export interface CanonicalQueryArtifactManifest {
  formatVersion: 1;
  artifactFormatVersion: 5;
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
  bucketIds: string[];
  shards: Record<string, CanonicalQueryArtifactDescriptor>;
}

export interface CanonicalQueryArtifactPublishResult {
  state: 'not-configured' | 'stored' | 'error';
  saveMs: number;
  ref: CanonicalQueryArtifactGenerationRef | null;
  error?: string;
}

interface CanonicalQueryArtifactSlotReservation {
  formatVersion: 1;
  artifactFormatVersion: number;
  project: string;
  revision: string;
  graphId: string;
  generationId: string;
  slot: number;
  state: 'reserved' | 'released';
  updatedAt: string;
}

export interface CanonicalQueryArtifactLoadResult {
  state: 'not-configured' | 'miss' | 'hit' | 'invalid' | 'error';
  loadMs: number;
  index?: CanonicalQueryIndexArtifact;
  bucketIds?: string[];
  shards?: Record<string, CanonicalQueryDetailShard>;
  error?: string;
}

export interface CanonicalQueryArtifactPointer {
  formatVersion: 1;
  artifactFormatVersion: 5;
  project: string;
  repository: string;
  revision: string;
  analyzerVersion: string;
  graphSchemaVersion: 2;
  graphId: string;
  sourceFingerprint: string | null;
  topologyFingerprint: string | null;
  evidenceFingerprint: string | null;
  ref: CanonicalQueryArtifactGenerationRef;
  publishedAt: string;
}

export interface CanonicalQueryArtifactPointerLoadResult {
  state: 'not-configured' | 'miss' | 'hit' | 'stale' | 'invalid' | 'error';
  loadMs: number;
  pointer?: CanonicalQueryArtifactPointer;
  error?: string;
}

export interface CanonicalQueryArtifactPointerPublishResult {
  state: 'not-configured' | 'stored' | 'conflict' | 'error';
  saveMs: number;
  pointer: CanonicalQueryArtifactPointer | null;
  etag?: string | null;
  error?: string;
}

export const CURRENT_QUERY_POINTER_PATH = 'current-query-generation.json';

type CanonicalQueryArtifactIdentity = Pick<
  IntelligenceGraph,
  'project' | 'repositoryRevision' | 'analyzerVersion' | 'schemaVersion' | 'graphId' | 'sourceFingerprint' | 'topologyFingerprint' | 'evidenceFingerprint'
>;

function sha256(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function validGenerationRef(value: unknown): value is CanonicalQueryArtifactGenerationRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.formatVersion === 1
    && item.artifactFormatVersion === QUERY_ARTIFACT_FORMAT_VERSION
    && typeof item.generationId === 'string'
    && /^[0-9a-f]{24}$/u.test(item.generationId)
    && typeof item.slot === 'number'
    && Number.isInteger(item.slot)
    && item.slot >= 0
    && item.slot < QUERY_ARTIFACT_SLOT_COUNT
    && typeof item.objectCount === 'number'
    && Number.isInteger(item.objectCount)
    && item.objectCount > 0
    && typeof item.manifestSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(item.manifestSha256);
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

function slotReservationPath(slot: number): string {
  return `${slotPrefix(slot)}/reservation.json`;
}

function parseSlotReservation(value: unknown, slot: number): CanonicalQueryArtifactSlotReservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.formatVersion !== 1
    || typeof item.artifactFormatVersion !== 'number' || !Number.isInteger(item.artifactFormatVersion) || item.artifactFormatVersion < 1
    || typeof item.project !== 'string'
    || typeof item.revision !== 'string'
    || typeof item.graphId !== 'string'
    || typeof item.generationId !== 'string'
    || !/^[0-9a-f]{24}$/u.test(item.generationId)
    || item.slot !== slot
    || !['reserved', 'released'].includes(String(item.state))
    || typeof item.updatedAt !== 'string'
  ) return null;
  return item as unknown as CanonicalQueryArtifactSlotReservation;
}

async function reserveCanonicalQueryArtifactSlot(
  graph: IntelligenceGraph,
  previous: CanonicalQueryArtifactGenerationRef | null | undefined,
  repository?: string,
): Promise<number> {
  if (!graph.repositoryRevision) throw new Error('Canonical query artifact slot reservation requires an exact repository revision');
  const generation = generationId(graph);
  const protectedSlots = new Set<number>();
  if (previous) protectedSlots.add(previous.slot);

  let pointerState: CanonicalQueryArtifactPointerLoadResult | null = null;
  if (repository) {
    pointerState = await loadCanonicalQueryArtifactPointer({
      project: graph.project,
      repository,
      revision: graph.repositoryRevision,
    });
    if (pointerState.pointer) protectedSlots.add(pointerState.pointer.ref.slot);
  }
  const mayReclaimStale = !pointerState || ['hit', 'stale', 'miss', 'not-configured'].includes(pointerState.state);
  const start = slotAfter(previous);

  for (let offset = 0; offset < QUERY_ARTIFACT_SLOT_COUNT; offset += 1) {
    const slot = (start + offset) % QUERY_ARTIFACT_SLOT_COUNT;
    if (protectedSlots.has(slot)) continue;
    const path = slotReservationPath(slot);
    const observed = await readCanonicalDerivedObjectVersioned(graph.project, path, 128 * 1024);
    let existing: CanonicalQueryArtifactSlotReservation | null = null;
    if (observed?.body) {
      try {
        existing = parseSlotReservation(JSON.parse(Buffer.from(observed.body).toString('utf8')), slot);
      } catch {
        existing = null;
      }
    }

    if (existing?.generationId === generation && existing.state === 'reserved') return slot;
    const updatedAt = existing ? Date.parse(existing.updatedAt) : Number.NaN;
    const stale = existing?.state === 'reserved'
      && mayReclaimStale
      && Number.isFinite(updatedAt)
      && Date.now() - updatedAt >= QUERY_ARTIFACT_SLOT_RESERVATION_STALE_MS;
    if (existing?.state === 'reserved' && !stale) continue;

    const reservation: CanonicalQueryArtifactSlotReservation = {
      formatVersion: 1,
      artifactFormatVersion: QUERY_ARTIFACT_FORMAT_VERSION,
      project: graph.project,
      revision: graph.repositoryRevision,
      graphId: graph.graphId,
      generationId: generation,
      slot,
      state: 'reserved',
      updatedAt: new Date().toISOString(),
    };
    const written = await writeCanonicalDerivedObjectConditional(
      graph.project,
      path,
      JSON.stringify(reservation),
      'application/json',
      observed?.etag ?? null,
    );
    if (written.state === 'stored') return slot;
    if (written.state === 'not-configured') throw new Error('Canonical derived storage is not configured');
  }
  throw new Error('No canonical query artifact slot is currently available; retry after an in-flight publication settles');
}

export async function releaseCanonicalQueryArtifactSlot(
  project: string,
  ref: CanonicalQueryArtifactGenerationRef | null | undefined,
): Promise<boolean> {
  if (!ref) return false;
  const path = slotReservationPath(ref.slot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = await readCanonicalDerivedObjectVersioned(project, path, 128 * 1024);
    if (!observed) return false;
    let reservation: CanonicalQueryArtifactSlotReservation | null = null;
    try {
      reservation = parseSlotReservation(JSON.parse(Buffer.from(observed.body).toString('utf8')), ref.slot);
    } catch {
      return false;
    }
    if (!reservation || reservation.generationId !== ref.generationId) return false;
    if (reservation.state === 'released') return true;
    const released: CanonicalQueryArtifactSlotReservation = {
      ...reservation,
      state: 'released',
      updatedAt: new Date().toISOString(),
    };
    const written = await writeCanonicalDerivedObjectConditional(
      project,
      path,
      JSON.stringify(released),
      'application/json',
      observed.etag,
    );
    if (written.state === 'stored') return true;
    if (written.state === 'not-configured') return false;
  }
  return false;
}

async function encodeArtifact(
  value: Record<string, unknown>,
  writePart: (body: Uint8Array, index: number) => Promise<{ path: string; bytes: number; sha256: string }>,
): Promise<{ bytes: number; uncompressedBytes: number; sha256: string; parts: Array<{ path: string; bytes: number; sha256: string }> }> {
  let uncompressedBytes = 0;
  // Artifact objects are records whose large fields are arrays. Serializing
  // each entry preserves JSON's values and order without creating another
  // graph-sized string and buffer before compression.
  function* jsonParts(): Generator<string> {
    let buffer = '';
    const pieces = function* (): Generator<string> {
      yield '{';
      let firstField = true;
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        if (!firstField) yield ',';
        firstField = false;
        yield JSON.stringify(key) + ':';
        if (Array.isArray(item)) {
          yield '[';
          for (let index = 0; index < item.length; index += 1) {
            if (index) yield ',';
            yield JSON.stringify(item[index]) ?? 'null';
          }
          yield ']';
        } else yield JSON.stringify(item);
      }
      yield '}';
    };
    for (const piece of pieces()) {
      buffer += piece;
      if (buffer.length >= 64 * 1024) {
        uncompressedBytes += Buffer.byteLength(buffer, 'utf8');
        yield buffer;
        buffer = '';
      }
    }
    if (buffer) { uncompressedBytes += Buffer.byteLength(buffer, 'utf8'); yield buffer; }
  }
  const compressedHash = createHash('sha256');
  const parts: Array<{ path: string; bytes: number; sha256: string }> = [];
  const partBytes = 32 * 1024 * 1024;
  let chunks: Buffer[] = [];
  let pendingBytes = 0;
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (!pendingBytes) return;
    const body: Uint8Array = Buffer.concat(chunks, pendingBytes);
    parts.push(await writePart(body, parts.length));
    chunks = [];
    pendingBytes = 0;
  };
  const input = Readable.from(jsonParts());
  const compressor = createGzip({ level: 6 });
  input.on('error', (error: Error) => compressor.destroy(error));
  try {
    for await (const chunk of input.pipe(compressor)) {
      compressedHash.update(chunk);
      bytes += chunk.byteLength;
      for (let offset = 0; offset < chunk.byteLength;) {
        const size = Math.min(partBytes - pendingBytes, chunk.byteLength - offset);
        chunks.push(chunk.subarray(offset, offset + size));
        pendingBytes += size;
        offset += size;
        if (pendingBytes === partBytes) await flush();
      }
    }
    await flush();
  } finally {
    input.destroy();
    compressor.destroy();
  }
  return { bytes, uncompressedBytes, sha256: compressedHash.digest('hex'), parts };
}

export async function publishCanonicalQueryArtifacts(
  graph: IntelligenceGraph,
  previous: CanonicalQueryArtifactGenerationRef | null | undefined = null,
  options: { repository?: string } = {},
): Promise<CanonicalQueryArtifactPublishResult> {
  const startedAt = Date.now();
  const storage = canonicalDerivedStorageInfo();
  if (!storage.durable) return { state: 'not-configured', saveMs: 0, ref: null };
  let reservedRef: CanonicalQueryArtifactGenerationRef | null = null;
  try {
    const slot = await reserveCanonicalQueryArtifactSlot(graph, previous, options.repository);
    const generation = generationId(graph);
    // Establish the reservation identity before doing any expensive work, so
    // a failed build or write can release the slot it already owns.
    reservedRef = { formatVersion: 1, artifactFormatVersion: QUERY_ARTIFACT_FORMAT_VERSION,
      generationId: generation, slot, objectCount: 0, manifestSha256: '0'.repeat(64) };
    const prefix = slotPrefix(slot);
    const artifacts = buildCanonicalQueryArtifacts(graph);
    const bucketIds = populatedQueryBuckets(artifacts.index);
    let objectCount = 0;
    const writeArtifact = async (path: string, value: object): Promise<CanonicalQueryArtifactDescriptor> => {
      const encoded = await encodeArtifact(value as Record<string, unknown>, async (body, part) => {
        const partPath = `${path}.part-${part}`;
        if (!await writeCanonicalDerivedObject(graph.project, partPath, body, 'application/octet-stream')) {
          throw new Error('Canonical derived storage is not configured');
        }
        objectCount += 1;
        return { path: partPath, bytes: body.byteLength, sha256: sha256(body) };
      });
      return { path, ...encoded, encoding: 'gzip' };
    };
    const index = await writeArtifact(`${prefix}/index.json.gz`, artifacts.index);
    // The persisted index has been written; it is no longer needed while the
    // detail buckets are encoded. Avoid retaining a second graph-sized index.
    artifacts.index.nodeSearch = [];
    artifacts.index.edgeSearch = [];
    artifacts.index.semanticNodes = [];
    artifacts.index.semanticEdges = [];
    artifacts.index.evidenceBucketById = [];
    const shards: Record<string, CanonicalQueryArtifactDescriptor> = {};
    for (const bucket of bucketIds) {
      const shard = artifacts.shards[bucket];
      if (!shard) throw new Error(`Canonical query detail shard is missing during publication: ${bucket}`);
      shards[bucket] = await writeArtifact(`${prefix}/shards/${bucket}.json.gz`, shard);
      delete artifacts.shards[bucket];
    }
    const manifest: CanonicalQueryArtifactManifest = {
      formatVersion: 1, artifactFormatVersion: QUERY_ARTIFACT_FORMAT_VERSION,
      generationId: generation, slot, project: graph.project, revision: graph.repositoryRevision!,
      analyzerVersion: graph.analyzerVersion, graphSchemaVersion: 2, graphId: graph.graphId,
      sourceFingerprint: graph.sourceFingerprint, topologyFingerprint: graph.topologyFingerprint,
      evidenceFingerprint: graph.evidenceFingerprint, createdAt: new Date().toISOString(),
      index, bucketIds, shards,
    };
    const payload = JSON.stringify(manifest);
    const ref: CanonicalQueryArtifactGenerationRef = { ...reservedRef,
      objectCount, manifestSha256: sha256(payload) };
    if (!await writeCanonicalDerivedObject(graph.project, `${prefix}/manifest.json`, payload, 'application/json')) {
      throw new Error('Canonical derived storage is not configured');
    }
    return { state: 'stored', saveMs: Math.max(0, Date.now() - startedAt), ref };
  } catch (error) {
    if (reservedRef) await releaseCanonicalQueryArtifactSlot(graph.project, reservedRef).catch(() => false);
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
  graph: CanonicalQueryArtifactIdentity,
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
  if (!manifest.index || !manifest.shards || !Array.isArray(manifest.bucketIds)) {
    throw new Error('Canonical query artifact manifest inventory is incomplete');
  }
  const bucketIds = [...new Set(manifest.bucketIds)];
  if (
    bucketIds.length !== manifest.bucketIds.length
    || bucketIds.some(bucket => !/^[0-9a-f]{2}$/u.test(bucket) || Number.parseInt(bucket, 16) >= 64)
    || bucketIds.join(',') !== [...bucketIds].sort().join(',')
    || Object.keys(manifest.shards).sort().join(',') !== bucketIds.join(',')
  ) throw new Error('Canonical query artifact manifest bucket inventory is malformed');
  return manifest;
}

async function readDescriptor(project: string, item: CanonicalQueryArtifactDescriptor): Promise<unknown> {
  let body: Uint8Array | null;
  if (item.parts?.length) {
    const chunks: Uint8Array[] = [];
    for (const [index, part] of item.parts.entries()) {
      if (part.path !== `${item.path}.part-${index}` || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > 32 * 1024 * 1024) {
        throw new Error(`Canonical query artifact part is invalid: ${part.path}`);
      }
      const chunk = await readCanonicalDerivedObject(project, part.path, part.bytes + 1024);
      if (!chunk || chunk.byteLength !== part.bytes || sha256(chunk) !== part.sha256) {
        throw new Error(`Canonical query artifact part failed integrity validation: ${part.path}`);
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } else body = await readCanonicalDerivedObject(project, item.path, Math.max(item.bytes + 1024, 1024));
  if (!body) throw new Error(`Canonical query artifact object is missing: ${item.path}`);
  if (body.byteLength !== item.bytes || sha256(body) !== item.sha256) throw new Error(`Canonical query artifact object failed integrity validation: ${item.path}`);
  const raw = gunzipSync(body);
  if (raw.byteLength !== item.uncompressedBytes) throw new Error(`Canonical query artifact object size is invalid: ${item.path}`);
  return JSON.parse(raw.toString('utf8'));
}

export async function loadCanonicalQueryArtifacts(
  graph: CanonicalQueryArtifactIdentity,
  ref: CanonicalQueryArtifactGenerationRef | null | undefined,
  buckets: string[] | ((index: CanonicalQueryIndexArtifact) => string[]) = [],
): Promise<CanonicalQueryArtifactLoadResult> {
  const startedAt = Date.now();
  const storage = canonicalDerivedStorageInfo();
  if (!storage.durable) return { state: 'not-configured', loadMs: 0 };
  if (!ref) return { state: 'miss', loadMs: 0 };
  let establishedIndex: CanonicalQueryIndexArtifact | undefined;
  let bucketIds: string[] = [];
  try {
    const manifestPath = `${slotPrefix(ref.slot)}/manifest.json`;
    const manifestBody = await readCanonicalDerivedObject(graph.project, manifestPath, 4 * 1024 * 1024);
    if (!manifestBody) return { state: 'miss', loadMs: Math.max(0, Date.now() - startedAt) };
    const manifestText = Buffer.from(manifestBody).toString('utf8');
    if (sha256(manifestText) !== ref.manifestSha256) throw new Error('Canonical query artifact manifest integrity does not match the canonical graph reference');
    const manifest = validateManifest(JSON.parse(manifestText), graph, ref);

    const index = await readDescriptor(graph.project, manifest.index) as CanonicalQueryIndexArtifact;
    if (
      index.formatVersion !== QUERY_ARTIFACT_FORMAT_VERSION
      || index.project !== graph.project
      || index.revision !== graph.repositoryRevision
      || index.graphId !== graph.graphId
    ) throw new Error('Canonical query artifact index identity is invalid');
    const populated = populatedQueryBuckets(index);
    if (populated.join(',') !== manifest.bucketIds.join(',')) {
      throw new Error('Canonical query artifact manifest does not match the index bucket inventory');
    }
    establishedIndex = index;
    bucketIds = [...new Set(typeof buckets === 'function' ? buckets(index) : buckets)].sort();
    const shards: Record<string, CanonicalQueryDetailShard> = {};
    for (const bucket of bucketIds) {
      const item = manifest.shards[bucket];
      if (!item) {
        const summary = index.buckets[bucket];
        if (summary && summary.nodeCount === 0 && summary.edgeCount === 0 && summary.evidenceCount === 0) continue;
        throw new Error(`Canonical query artifact shard is not declared: ${bucket}`);
      }
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
    return { state: 'hit', loadMs: Math.max(0, Date.now() - startedAt), index, bucketIds, shards };
  } catch (error) {
    return {
      state: 'invalid',
      loadMs: Math.max(0, Date.now() - startedAt),
      ...(establishedIndex ? { index: establishedIndex, bucketIds } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}


export async function loadCanonicalQueryDetailShardsFromPointer(
  pointer: CanonicalQueryArtifactPointer,
  index: CanonicalQueryIndexArtifact,
  bucketIds: string[],
): Promise<CanonicalQueryArtifactLoadResult> {
  const startedAt = Date.now();
  const storage = canonicalDerivedStorageInfo();
  if (!storage.durable) return { state: 'not-configured', loadMs: 0 };
  try {
    if (
      index.formatVersion !== QUERY_ARTIFACT_FORMAT_VERSION
      || index.project !== pointer.project
      || index.revision !== pointer.revision
      || index.graphId !== pointer.graphId
    ) throw new Error('Canonical query artifact expansion index identity is invalid');

    const identity: CanonicalQueryArtifactIdentity = {
      project: pointer.project,
      repositoryRevision: pointer.revision,
      analyzerVersion: pointer.analyzerVersion,
      schemaVersion: pointer.graphSchemaVersion,
      graphId: pointer.graphId,
      sourceFingerprint: pointer.sourceFingerprint,
      topologyFingerprint: pointer.topologyFingerprint,
      evidenceFingerprint: pointer.evidenceFingerprint,
    };
    const manifestPath = `${slotPrefix(pointer.ref.slot)}/manifest.json`;
    const manifestBody = await readCanonicalDerivedObject(pointer.project, manifestPath, 4 * 1024 * 1024);
    if (!manifestBody) return { state: 'miss', loadMs: Math.max(0, Date.now() - startedAt) };
    const manifestText = Buffer.from(manifestBody).toString('utf8');
    if (sha256(manifestText) !== pointer.ref.manifestSha256) {
      throw new Error('Canonical query artifact expansion manifest integrity does not match the current pointer');
    }
    const manifest = validateManifest(JSON.parse(manifestText), identity, pointer.ref);
    const populated = populatedQueryBuckets(index);
    if (populated.join(',') !== manifest.bucketIds.join(',')) {
      throw new Error('Canonical query artifact expansion manifest does not match the established index');
    }

    const shards: Record<string, CanonicalQueryDetailShard> = {};
    for (const bucket of [...new Set(bucketIds)].sort()) {
      const item = manifest.shards[bucket];
      if (!item) {
        const summary = index.buckets[bucket];
        if (summary && summary.nodeCount === 0 && summary.edgeCount === 0 && summary.evidenceCount === 0) continue;
        throw new Error(`Canonical query artifact expansion shard is not declared: ${bucket}`);
      }
      const shard = await readDescriptor(pointer.project, item) as CanonicalQueryDetailShard;
      if (
        shard.formatVersion !== QUERY_ARTIFACT_FORMAT_VERSION
        || shard.project !== pointer.project
        || shard.revision !== pointer.revision
        || shard.graphId !== pointer.graphId
        || shard.bucket !== bucket
      ) throw new Error(`Canonical query artifact expansion shard identity is invalid: ${bucket}`);
      shards[bucket] = shard;
    }
    return { state: 'hit', loadMs: Math.max(0, Date.now() - startedAt), index, shards };
  } catch (error) {
    return {
      state: 'invalid',
      loadMs: Math.max(0, Date.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function publishCanonicalQueryArtifactPointer(
  graph: IntelligenceGraph,
  repository: string,
  ref: CanonicalQueryArtifactGenerationRef,
  options: { expectedEtag?: string | null } = {},
): Promise<CanonicalQueryArtifactPointerPublishResult> {
  const startedAt = Date.now();
  const storage = canonicalDerivedStorageInfo();
  if (!storage.durable) return { state: 'not-configured', saveMs: 0, pointer: null };
  try {
    if (!graph.repositoryRevision) throw new Error('Canonical query pointer publication requires an exact repository revision');
    if (!validGenerationRef(ref)) throw new Error('Canonical query pointer generation reference is malformed');
    const pointer: CanonicalQueryArtifactPointer = {
      formatVersion: 1,
      artifactFormatVersion: QUERY_ARTIFACT_FORMAT_VERSION,
      project: graph.project,
      repository,
      revision: graph.repositoryRevision,
      analyzerVersion: graph.analyzerVersion,
      graphSchemaVersion: graph.schemaVersion,
      graphId: graph.graphId,
      sourceFingerprint: graph.sourceFingerprint,
      topologyFingerprint: graph.topologyFingerprint,
      evidenceFingerprint: graph.evidenceFingerprint,
      ref,
      publishedAt: new Date().toISOString(),
    };
    const observed = Object.prototype.hasOwnProperty.call(options, 'expectedEtag')
      ? null
      : await readCanonicalDerivedObjectVersioned(graph.project, CURRENT_QUERY_POINTER_PATH, 128 * 1024);
    const expectedEtag = Object.prototype.hasOwnProperty.call(options, 'expectedEtag')
      ? options.expectedEtag ?? null
      : observed?.etag ?? null;
    const stored = await writeCanonicalDerivedObjectConditional(
      graph.project,
      CURRENT_QUERY_POINTER_PATH,
      JSON.stringify(pointer),
      'application/json',
      expectedEtag,
    );
    if (stored.state === 'not-configured') {
      return { state: 'not-configured', saveMs: Math.max(0, Date.now() - startedAt), pointer: null };
    }
    if (stored.state === 'conflict') {
      return {
        state: 'conflict',
        saveMs: Math.max(0, Date.now() - startedAt),
        pointer: null,
        etag: stored.etag,
        error: 'Canonical query pointer optimistic write conflict',
      };
    }
    return { state: 'stored', saveMs: Math.max(0, Date.now() - startedAt), pointer, etag: stored.etag };
  } catch (error) {
    return {
      state: 'error',
      saveMs: Math.max(0, Date.now() - startedAt),
      pointer: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadCanonicalQueryArtifactPointer(expected: {
  project: string;
  repository: string;
  revision: string;
}): Promise<CanonicalQueryArtifactPointerLoadResult> {
  const startedAt = Date.now();
  const storage = canonicalDerivedStorageInfo();
  if (!storage.durable) return { state: 'not-configured', loadMs: 0 };
  try {
    const body = await readCanonicalDerivedObject(expected.project, CURRENT_QUERY_POINTER_PATH, 128 * 1024);
    if (!body) return { state: 'miss', loadMs: Math.max(0, Date.now() - startedAt) };
    const value = JSON.parse(Buffer.from(body).toString('utf8')) as CanonicalQueryArtifactPointer;
    if (
      value.formatVersion !== 1
      || value.artifactFormatVersion !== QUERY_ARTIFACT_FORMAT_VERSION
      || value.project !== expected.project
      || value.repository !== expected.repository
      || value.graphSchemaVersion !== 2
      || typeof value.analyzerVersion !== 'string'
      || typeof value.graphId !== 'string'
      || typeof value.publishedAt !== 'string'
      || !validGenerationRef(value.ref)
    ) throw new Error('Canonical query pointer identity is malformed');
    if (value.revision !== expected.revision) {
      return { state: 'stale', loadMs: Math.max(0, Date.now() - startedAt), pointer: value };
    }
    return { state: 'hit', loadMs: Math.max(0, Date.now() - startedAt), pointer: value };
  } catch (error) {
    return {
      state: error instanceof SyntaxError ? 'invalid' : 'error',
      loadMs: Math.max(0, Date.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadCanonicalQueryArtifactsFromPointer(
  pointer: CanonicalQueryArtifactPointer,
  buckets: string[] | ((index: CanonicalQueryIndexArtifact) => string[]) = [],
): Promise<CanonicalQueryArtifactLoadResult> {
  return await loadCanonicalQueryArtifacts({
    project: pointer.project,
    repositoryRevision: pointer.revision,
    analyzerVersion: pointer.analyzerVersion,
    schemaVersion: pointer.graphSchemaVersion,
    graphId: pointer.graphId,
    sourceFingerprint: pointer.sourceFingerprint,
    topologyFingerprint: pointer.topologyFingerprint,
    evidenceFingerprint: pointer.evidenceFingerprint,
  }, pointer.ref, buckets);
}
