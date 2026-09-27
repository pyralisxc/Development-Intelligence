import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
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
export const QUERY_ARTIFACT_FORMAT_VERSION = 4;
const QUERY_ARTIFACT_SLOT_RESERVATION_STALE_MS = 60 * 60 * 1000;

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
  bucketIds: string[];
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

interface CanonicalQueryArtifactSlotReservation {
  formatVersion: 1;
  artifactFormatVersion: 4;
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
  shards?: Record<string, CanonicalQueryDetailShard>;
  error?: string;
}

export interface CanonicalQueryArtifactPointer {
  formatVersion: 1;
  artifactFormatVersion: 4;
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
    || item.artifactFormatVersion !== QUERY_ARTIFACT_FORMAT_VERSION
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
  slotOverride?: number,
): PreparedCanonicalQueryArtifactGeneration {
  if (!graph.repositoryRevision) throw new Error('Canonical query artifact publication requires an exact repository revision');
  const generation = generationId(graph);
  const slot = slotOverride ?? slotAfter(previous);
  const prefix = slotPrefix(slot);
  const artifacts = buildCanonicalQueryArtifacts(graph);
  const objects: PreparedCanonicalQueryArtifactGeneration['objects'] = [];

  const encodedIndex = encodeArtifact(artifacts.index);
  const index = descriptor(`${prefix}/index.json.gz`, encodedIndex);
  objects.push({ descriptor: index, body: encodedIndex.body });

  const bucketIds = populatedQueryBuckets(artifacts.index);
  const shards: Record<string, CanonicalQueryArtifactDescriptor> = {};
  for (const bucket of bucketIds) {
    const shard = artifacts.shards[bucket];
    if (!shard) throw new Error(`Canonical query detail shard is missing during publication: ${bucket}`);
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
    bucketIds,
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
  options: { repository?: string } = {},
): Promise<CanonicalQueryArtifactPublishResult> {
  const startedAt = Date.now();
  const storage = canonicalDerivedStorageInfo();
  if (!storage.durable) return { state: 'not-configured', saveMs: 0, ref: null };
  let reservedRef: CanonicalQueryArtifactGenerationRef | null = null;
  try {
    const slot = await reserveCanonicalQueryArtifactSlot(graph, previous, options.repository);
    const prepared = prepareCanonicalQueryArtifactGeneration(graph, previous, slot);
    reservedRef = prepared.ref;
    await persistPreparedCanonicalQueryArtifacts(graph.project, prepared);
    return { state: 'stored', saveMs: Math.max(0, Date.now() - startedAt), ref: prepared.ref };
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
  const body = await readCanonicalDerivedObject(project, item.path, Math.max(item.bytes + 1024, 1024));
  if (!body) throw new Error(`Canonical query artifact object is missing: ${item.path}`);
  if (body.byteLength !== item.bytes || sha256(body) !== item.sha256) throw new Error(`Canonical query artifact object failed integrity validation: ${item.path}`);
  const raw = gunzipSync(body);
  if (raw.byteLength !== item.uncompressedBytes) throw new Error(`Canonical query artifact object size is invalid: ${item.path}`);
  return JSON.parse(Buffer.from(raw).toString('utf8'));
}

export async function loadCanonicalQueryArtifacts(
  graph: CanonicalQueryArtifactIdentity,
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
    const shards: Record<string, CanonicalQueryDetailShard> = {};
    for (const bucket of [...new Set(bucketIds)].sort()) {
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
    return { state: 'hit', loadMs: Math.max(0, Date.now() - startedAt), index, shards };
  } catch (error) {
    return {
      state: 'invalid',
      loadMs: Math.max(0, Date.now() - startedAt),
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
  bucketIds: string[] = [],
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
  }, pointer.ref, bucketIds);
}
