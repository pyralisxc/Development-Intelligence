import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IntelligenceGraph } from '../types.js';
import { stableHash } from '../util/hash.js';
import { assertGraphIntegrity } from './integrity.js';
import { ANALYZER_VERSION } from './repository.js';
import { currentVercelOidcToken } from '../vercelRequestContext.js';
import { assertAuthorityWritesAllowed, previewRuntime } from '../config/runtimeRole.js';
import { assertProjectAccessCurrent, projectAccessCanonical, projectAccessConfig, projectAccessScopeKey } from '../config/projectAccess.js';
import { positiveIntegerSetting } from './capacity.js';

export interface CanonicalGraphCurrentness {
  acceptedSemanticCurrent: boolean;
  sourceCurrent: boolean;
  topologyCurrent: boolean;
  evidenceCurrent: boolean;
  analyzerCurrent: boolean;
  schemaSupported: boolean;
  integrityCurrent: boolean;
  checkpointError: string | null;
}

export interface CanonicalQueryArtifactGenerationRef {
  formatVersion: 1;
  artifactFormatVersion: number;
  generationId: string;
  slot: number;
  objectCount: number;
  manifestSha256: string;
}

export interface CanonicalGraphRecord {
  formatVersion: 1;
  project: string;
  repository: string;
  revision: string;
  analyzerVersion: string;
  graphSchemaVersion: 2;
  storedAt: string;
  sourceFingerprint: string | null;
  topologyFingerprint: string | null;
  evidenceFingerprint: string | null;
  working: IntelligenceGraph;
  accepted: IntelligenceGraph | null;
  /** Opaque legacy accepted-graph shards retained for recovery, not source truth. */
  legacyAcceptedParts?: CanonicalGraphPart[];
  currentness: CanonicalGraphCurrentness;
  queryArtifacts?: CanonicalQueryArtifactGenerationRef | null;
}

export type CanonicalLoadState = 'not-configured' | 'hit' | 'stale' | 'miss' | 'invalid' | 'error';
export type CanonicalSaveState = 'not-configured' | 'stored' | 'error' | 'skipped';

export interface CanonicalPersistenceDiagnostics {
  mode: 'process-only' | 'canonical-file' | 'vercel-private-blob';
  scope?: 'canonical' | 'preview-replay';
  durable: boolean;
  loadState: CanonicalLoadState;
  saveState: CanonicalSaveState;
  loadMs: number;
  saveMs: number;
  error?: string;
  conflict?: boolean;
}

export interface CanonicalLoadResult {
  diagnostics: CanonicalPersistenceDiagnostics;
  record?: CanonicalGraphRecord;
  staleRecord?: CanonicalGraphRecord;
  previewManifestEtag?: string;
}

interface FileBackend { kind: 'file'; root: string; }
interface BlobBackend {
  kind: 'vercel-private-blob';
  storeId: string;
  token: string | null;
  apiUrl: string;
  baseUrl: string;
}
type CanonicalBackend = FileBackend | BlobBackend | null;

const MAX_DERIVED_OBJECT_BYTES = positiveIntegerSetting(process.env.DEVINT_DERIVED_OBJECT_MAX_BYTES, Number.MAX_SAFE_INTEGER, 'DEVINT_DERIVED_OBJECT_MAX_BYTES');
const require = createRequire(import.meta.url);

/** SQLite provides process-lifetime file locks for the local CAS operation.
 * A busy lock yields to other work; a terminated writer releases it through
 * the operating system without a second lease or stale-lock file. */
async function withLocalConditionalWrite<T>(directory: string, write: () => Promise<T>): Promise<T> {
  await fs.mkdir(directory, { recursive: true });
  const Database = require('node:sqlite').DatabaseSync;
  const database = new Database(path.join(directory, '.conditional-writes.sqlite'));
  let acquired = false;
  try {
    database.exec('PRAGMA busy_timeout=0');
    for (;;) {
      try { database.exec('BEGIN IMMEDIATE'); acquired = true; break; }
      catch (error) {
        const e = error as { errcode?: number; message?: string };
        if (e.errcode !== 5 && !/database is locked/iu.test(e.message ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const result = await write();
    database.exec('COMMIT'); acquired = false;
    return result;
  } finally {
    if (acquired) { try { database.exec('ROLLBACK'); } catch {} }
    database.close();
  }
}

interface CanonicalGraphPart {
  graph: 'working' | 'accepted';
  field: 'nodes' | 'edges' | 'evidence';
  path: string;
  sha256: string;
}
interface ShardedCanonicalRecord {
  format: 'canonical-graph-shards-v1';
  record: CanonicalGraphRecord;
  parts: CanonicalGraphPart[];
}

/** Store large populations in independent objects, then publish the small
 * manifest last. No graph-wide JSON string or total-size ceiling is needed. */
async function shardCanonicalRecord(record: CanonicalGraphRecord, write = writeCanonicalDerivedObject): Promise<string> {
  const generation = stableHash([record.revision, record.working.graphId, record.storedAt, Math.random()]);
  const parts: CanonicalGraphPart[] = [...(record.legacyAcceptedParts ?? [])];
  const skeleton = { ...record,
    working: { ...record.working, nodes: [], edges: [], evidence: [] },
    accepted: record.accepted ? { ...record.accepted, nodes: [], edges: [], evidence: [] } : null,
  } as CanonicalGraphRecord;
  const targetBytes = 16 * 1024 * 1024;
  for (const graphName of ['working', 'accepted'] as const) {
    if (graphName === 'accepted' && record.legacyAcceptedParts) continue;
    const graph = record[graphName];
    if (!graph) continue;
    for (const field of ['nodes', 'edges', 'evidence'] as const) {
      let batch: string[] = [];
      let size = 2;
      let index = 0;
      const flush = async (): Promise<void> => {
        if (!batch.length) return;
        const body = '[' + batch.join(',') + ']';
        const partPath = `graph-shards/${generation}/${graphName}-${field}-${index++}.json`;
        if (!await write(record.project, partPath, body, 'application/json')) {
          throw new Error('Canonical graph shard could not be stored');
        }
        parts.push({ graph: graphName, field, path: partPath,
          sha256: createHash('sha256').update(body).digest('hex') });
        batch = [];
        size = 2;
      };
      for (const item of graph[field]) {
        const json = JSON.stringify(item);
        const bytes = Buffer.byteLength(json, 'utf8') + 1;
        if (batch.length && size + bytes > targetBytes) await flush();
        batch.push(json);
        size += bytes;
      }
      await flush();
    }
  }
  return JSON.stringify({ format: 'canonical-graph-shards-v1', record: skeleton, parts } satisfies ShardedCanonicalRecord);
}

async function unshardCanonicalRecord(value: unknown, project: string, read = readCanonicalDerivedObject): Promise<unknown> {
  if (!value || typeof value !== 'object' || (value as { format?: unknown }).format !== 'canonical-graph-shards-v1') return value;
  const manifest = value as ShardedCanonicalRecord;
  if (!manifest.record || manifest.record.project !== project || !Array.isArray(manifest.parts)) {
    throw new Error('Canonical graph shard manifest is malformed');
  }
  // Preserve legacy references without loading them into current source
  // understanding. An unavailable historical shard must not block W.
  const legacy = manifest.parts.filter(part => part?.graph === 'accepted');
  if (legacy.length) manifest.record.legacyAcceptedParts = legacy;
  for (const part of manifest.parts) {
    if (part?.graph === 'accepted') continue;
    if (!['working', 'accepted'].includes(part.graph) || !['nodes', 'edges', 'evidence'].includes(part.field)
      || typeof part.path !== 'string' || !/^graph-shards\/[0-9a-f]{24}\/(?:working|accepted)-(?:nodes|edges|evidence)-\d+\.json$/u.test(part.path)
      || !/^[0-9a-f]{64}$/u.test(part.sha256)) throw new Error('Canonical graph shard reference is malformed');
    const graph = manifest.record[part.graph];
    if (!graph || !Array.isArray(graph[part.field])) throw new Error('Canonical graph shard target is malformed');
    const body = await read(project, part.path);
    if (!body || createHash('sha256').update(body).digest('hex') !== part.sha256) throw new Error('Canonical graph shard is missing or mismatched');
    const items: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!Array.isArray(items)) throw new Error('Canonical graph shard is not a list');
    for (const item of items) (graph[part.field] as unknown[]).push(item);
  }
  return manifest.record;
}
const BLOB_API_VERSION = '12';

function configuredRoot(): string | null {
  const access = projectAccessCanonical();
  if (access !== undefined) return access?.kind === 'file' ? path.resolve(access.root) : null;
  const value = process.env.DEVINT_CANONICAL_GRAPH_DIR?.trim();
  return value ? path.resolve(value) : null;
}

function normalizeStoreId(value: string): string {
  return value.startsWith('store_') ? value.slice('store_'.length) : value;
}

function readWriteTokenStoreId(token: string): string | null {
  const parts = token.split('_');
  return parts.length >= 4 && parts[0] === 'vercel' && parts[1] === 'blob' && parts[2] === 'rw' ? parts[3] ?? null : null;
}

function configuredBlobBackend(): BlobBackend | null {
  const access = projectAccessCanonical();
  if (access !== undefined) return access?.kind === 'vercel-private-blob' ? access : null;
  const explicitStoreId = process.env.DEVINT_CANONICAL_BLOB_STORE_ID?.trim();
  const oidcStoreId = process.env.BLOB_STORE_ID?.trim();
  const explicitToken = process.env.DEVINT_CANONICAL_BLOB_TOKEN?.trim();
  const oidcToken = currentVercelOidcToken() ?? process.env.VERCEL_OIDC_TOKEN?.trim();
  const readWriteToken = process.env.BLOB_READ_WRITE_TOKEN?.trim();

  let storeId = explicitStoreId || oidcStoreId || '';
  const token = explicitToken || oidcToken || readWriteToken || null;
  if (!storeId && readWriteToken) storeId = readWriteTokenStoreId(readWriteToken) ?? '';
  if (!storeId) return null;
  storeId = normalizeStoreId(storeId);

  const apiUrl = (process.env.DEVINT_CANONICAL_BLOB_API_URL?.trim()
    || process.env.VERCEL_BLOB_API_URL?.trim()
    || 'https://vercel.com/api/blob').replace(/\/$/u, '');
  const baseUrl = (process.env.DEVINT_CANONICAL_BLOB_BASE_URL?.trim()
    || `https://${storeId}.private.blob.vercel-storage.com`).replace(/\/$/u, '');
  return { kind: 'vercel-private-blob', storeId, token, apiUrl, baseUrl };
}

function backend(): CanonicalBackend {
  const root = configuredRoot();
  if (root) return { kind: 'file', root };
  return configuredBlobBackend();
}

export function canonicalProjectStorageKey(project: string): string {
  projectAccessConfig(project);
  const readable = project.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'project';
  return `${readable}-${stableHash([project]).slice(0, 12)}`;
}

function assertExactRevision(revision: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(revision)) throw new Error('Canonical graph revisions require an exact Git object id');
}

export function canonicalGraphFilePath(project: string, revision: string): string | null {
  const root = configuredRoot();
  if (!root) return null;
  assertExactRevision(revision);
  return path.join(root, canonicalProjectStorageKey(project), `${revision}.json`);
}

export function canonicalGraphBlobPath(project: string): string {
  return `development-intelligence/canonical/${canonicalProjectStorageKey(project)}/current.json`;
}

function assertDerivedRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('..') || relativePath.includes('\\')) {
    throw new Error('Canonical derived object path must be a safe relative path');
  }
  for (const segment of relativePath.split('/')) {
    if (!segment || !/^[A-Za-z0-9._-]+$/u.test(segment)) throw new Error('Canonical derived object path contains an invalid segment');
  }
}

export function canonicalDerivedObjectBlobPath(project: string, relativePath: string): string {
  assertDerivedRelativePath(relativePath);
  return `development-intelligence/canonical/${canonicalProjectStorageKey(project)}/derived/${relativePath}`;
}

export function canonicalDerivedObjectFilePath(project: string, relativePath: string): string | null {
  const root = configuredRoot();
  if (!root) return null;
  assertDerivedRelativePath(relativePath);
  return path.join(root, canonicalProjectStorageKey(project), 'derived', ...relativePath.split('/'));
}

export function canonicalDerivedStorageInfo(): { mode: CanonicalPersistenceDiagnostics['mode']; durable: boolean } {
  const selected = backend();
  const diagnostics = baseDiagnostics(selected);
  return { mode: diagnostics.mode, durable: diagnostics.durable };
}

function baseDiagnostics(selected: CanonicalBackend = backend()): CanonicalPersistenceDiagnostics {
  if (!selected) {
    return { mode: 'process-only', durable: false, loadState: 'not-configured', saveState: 'not-configured', loadMs: 0, saveMs: 0 };
  }
  if (selected.kind === 'file') {
    return { mode: 'canonical-file', durable: true, loadState: 'miss', saveState: 'skipped', loadMs: 0, saveMs: 0 };
  }
  const usable = Boolean(selected.token);
  return {
    mode: 'vercel-private-blob',
    durable: usable,
    loadState: usable ? 'miss' : 'error',
    saveState: usable ? 'skipped' : 'error',
    loadMs: 0,
    saveMs: 0,
    ...(!usable ? { error: 'Vercel canonical Blob store is configured but no OIDC/read-write credential is available' } : {}),
  };
}

function validCurrentness(value: unknown): value is CanonicalGraphCurrentness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ['acceptedSemanticCurrent','sourceCurrent','topologyCurrent','evidenceCurrent','analyzerCurrent','schemaSupported','integrityCurrent']
    .every(key => typeof item[key] === 'boolean')
    && (item.checkpointError === null || typeof item.checkpointError === 'string');
}

function recordIdentity(value: unknown): { formatVersion?: unknown; project?: unknown; repository?: unknown; revision?: unknown } | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as { formatVersion?: unknown; project?: unknown; repository?: unknown; revision?: unknown }
    : null;
}


function validQueryArtifactRef(value: unknown): value is CanonicalQueryArtifactGenerationRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.formatVersion === 1
    && typeof item.artifactFormatVersion === 'number'
    && Number.isInteger(item.artifactFormatVersion)
    && item.artifactFormatVersion > 0
    && typeof item.generationId === 'string'
    && /^[0-9a-f]{24}$/u.test(item.generationId)
    && typeof item.slot === 'number'
    && Number.isInteger(item.slot)
    && item.slot >= 0
    && item.slot < 4
    && typeof item.objectCount === 'number'
    && Number.isInteger(item.objectCount)
    && item.objectCount > 0
    && typeof item.manifestSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(item.manifestSha256);
}

function validateRecord(record: unknown, expected: { project: string; repository: string; revision: string }): CanonicalGraphRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Canonical graph record must be an object');
  const value = record as CanonicalGraphRecord;
  if (value.formatVersion !== 1) throw new Error('Unsupported canonical graph record format');
  if (value.project !== expected.project || value.repository !== expected.repository || value.revision !== expected.revision) {
    throw new Error('Canonical graph identity does not match the requested repository revision');
  }
  if (value.analyzerVersion !== ANALYZER_VERSION || value.graphSchemaVersion !== 2) throw new Error('Canonical graph analyzer/schema identity is stale');
  if (!validCurrentness(value.currentness)) throw new Error('Canonical graph currentness is malformed');
  if (value.queryArtifacts !== undefined && value.queryArtifacts !== null && !validQueryArtifactRef(value.queryArtifacts)) {
    throw new Error('Canonical query artifact generation reference is malformed');
  }
  const working = value.working;
  if (!working || working.schemaVersion !== 2 || working.project !== expected.project || working.repositoryRevision !== expected.revision || working.analyzerVersion !== ANALYZER_VERSION) {
    throw new Error('Canonical working graph identity is stale or malformed');
  }
  if (working.sourceFingerprint !== value.sourceFingerprint || working.topologyFingerprint !== value.topologyFingerprint || working.evidenceFingerprint !== value.evidenceFingerprint) {
    throw new Error('Canonical graph manifest fingerprints do not match the working graph');
  }
  assertGraphIntegrity(working);
  // accepted is retained solely as legacy data; current graph validity is
  // established by the selected source graph above.
  return value;
}

function classifyCanonicalRecord(parsed: unknown, expected: { project: string; repository: string; revision: string }):
  | { state: 'hit'; record: CanonicalGraphRecord }
  | { state: 'stale'; record: CanonicalGraphRecord } {
  const identity = recordIdentity(parsed);
  if (
    identity?.formatVersion === 1
    && identity.project === expected.project
    && identity.repository === expected.repository
    && typeof identity.revision === 'string'
    && identity.revision !== expected.revision
  ) {
    assertExactRevision(identity.revision);
    return {
      state: 'stale',
      record: validateRecord(parsed, { project: expected.project, repository: expected.repository, revision: identity.revision }),
    };
  }
  return { state: 'hit', record: validateRecord(parsed, expected) };
}

function encodedBlobPath(pathname: string): string {
  return pathname.split('/').map(part => encodeURIComponent(part)).join('/');
}

function blobObjectUrl(config: BlobBackend, pathname: string): string {
  return `${config.baseUrl}/${encodedBlobPath(pathname)}?cache=0`;
}

function blobHeaders(config: BlobBackend): Record<string, string> {
  if (!config.token) throw new Error('Vercel canonical Blob credential is unavailable');
  return { authorization: `Bearer ${config.token}`, 'x-vercel-blob-store-id': config.storeId };
}

function derivedObjectByteLength(body: string | Uint8Array): number {
  return typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
}

export interface CanonicalDerivedObjectVersion {
  body: Uint8Array;
  etag: string | null;
}

function localDerivedEtag(body: Uint8Array): string {
  return `"${stableHash([Buffer.from(body).toString('base64')])}"`;
}

/** Read the authoritative strong object version, not the weak CDN content ETag.
 * A weak entity tag cannot satisfy a conditional If-Match write. */
async function readCanonicalDerivedStrongEtag(config: BlobBackend, pathname: string): Promise<string> {
  const requestUrl = new URL(config.apiUrl);
  requestUrl.searchParams.set('url', pathname);
  const response = await fetch(requestUrl, {
    method: 'GET',
    headers: { ...blobHeaders(config), 'x-api-version': BLOB_API_VERSION },
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Vercel canonical derived metadata read failed with HTTP ${response.status}`);
  const metadata = await response.json() as { pathname?: unknown; etag?: unknown };
  if (metadata.pathname !== pathname || typeof metadata.etag !== 'string' || !/^"[^"]+"$/u.test(metadata.etag)) {
    throw new Error('Vercel canonical derived metadata has no exact path-bound strong ETag');
  }
  return metadata.etag;
}

export async function readCanonicalDerivedObjectVersioned(
  project: string,
  relativePath: string,
  maxBytes = MAX_DERIVED_OBJECT_BYTES,
): Promise<CanonicalDerivedObjectVersion | null> {
  await assertProjectAccessCurrent(project);
  assertDerivedRelativePath(relativePath);
  const selected = backend();
  if (!selected || (selected.kind === 'vercel-private-blob' && !selected.token)) return null;
  const bounded = Math.min(Math.max(maxBytes, 1), MAX_DERIVED_OBJECT_BYTES);
  if (selected.kind === 'file') {
    const target = canonicalDerivedObjectFilePath(project, relativePath)!;
    const stat = await fs.stat(target).catch((error: any) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.size > bounded) throw new Error('Canonical derived object is not a bounded regular file');
    const body = new Uint8Array(await fs.readFile(target));
    return { body, etag: localDerivedEtag(body) };
  }

  const response = await fetch(blobObjectUrl(selected, canonicalDerivedObjectBlobPath(project, relativePath)), {
    headers: blobHeaders(selected),
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Vercel canonical derived object read failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > bounded) throw new Error('Canonical derived object exceeds the bounded storage size');
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > bounded) throw new Error('Canonical derived object exceeds the bounded storage size');
  const pathname = canonicalDerivedObjectBlobPath(project, relativePath);
  const contentEtag = response.headers.get('etag');
  const strongEtag = await readCanonicalDerivedStrongEtag(selected, pathname);
  // Compare the opaque tag only to detect stale CDN content; never forward a
  // weak content validator as an If-Match token for authority writes.
  if (!contentEtag || contentEtag.replace(/^W\//u, '') !== strongEtag) {
    throw new Error('Vercel canonical derived content and authoritative version disagree');
  }
  return { body, etag: strongEtag };
}

export async function readCanonicalDerivedObject(
  project: string,
  relativePath: string,
  maxBytes = MAX_DERIVED_OBJECT_BYTES,
): Promise<Uint8Array | null> {
  await assertProjectAccessCurrent(project);
  assertDerivedRelativePath(relativePath);
  const selected = backend();
  if (!selected || (selected.kind === 'vercel-private-blob' && !selected.token)) return null;
  const bounded = Math.min(Math.max(maxBytes, 1), MAX_DERIVED_OBJECT_BYTES);
  if (selected.kind === 'file') {
    const target = canonicalDerivedObjectFilePath(project, relativePath)!;
    const stat = await fs.stat(target).catch((error: any) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.size > bounded) throw new Error('Canonical derived object is not a bounded regular file');
    return new Uint8Array(await fs.readFile(target));
  }

  const response = await fetch(blobObjectUrl(selected, canonicalDerivedObjectBlobPath(project, relativePath)), {
    headers: blobHeaders(selected),
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Vercel canonical derived object read failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > bounded) throw new Error('Canonical derived object exceeds the bounded storage size');
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > bounded) throw new Error('Canonical derived object exceeds the bounded storage size');
  return body;
}

export interface CanonicalDerivedConditionalWriteResult {
  state: 'stored' | 'conflict' | 'not-configured';
  etag: string | null;
}

export async function writeCanonicalDerivedObjectConditional(
  project: string,
  relativePath: string,
  body: string | Uint8Array,
  contentType: string,
  expectedEtag: string | null,
): Promise<CanonicalDerivedConditionalWriteResult> {
  assertAuthorityWritesAllowed();
  return await writeDerivedObjectConditional(project, relativePath, body, contentType, expectedEtag);
}

async function writeDerivedObjectConditional(
  project: string,
  relativePath: string,
  body: string | Uint8Array,
  contentType: string,
  expectedEtag: string | null,
): Promise<CanonicalDerivedConditionalWriteResult> {
  await assertProjectAccessCurrent(project);
  assertDerivedRelativePath(relativePath);
  const selected = backend();
  if (!selected || (selected.kind === 'vercel-private-blob' && !selected.token)) {
    return { state: 'not-configured', etag: null };
  }
  const size = derivedObjectByteLength(body);
  if (size > MAX_DERIVED_OBJECT_BYTES) throw new Error('Canonical derived object exceeds the bounded storage size');

  if (selected.kind === 'file') {
    const target = canonicalDerivedObjectFilePath(project, relativePath)!;
    const lockDir = path.dirname(canonicalDerivedObjectFilePath(project, '.conditional-writes.sqlite')!);
    return await withLocalConditionalWrite(lockDir, async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const current = await fs.readFile(target).catch((error: any) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      const currentEtag = current ? localDerivedEtag(new Uint8Array(current)) : null;
      if (currentEtag !== expectedEtag) return { state: 'conflict', etag: currentEtag };
      const temporary = `${target}.${process.pid ?? 'process'}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, body, { mode: 0o600 });
      await fs.rename(temporary, target);
      const nextBody = typeof body === 'string' ? new Uint8Array(Buffer.from(body, 'utf8')) : body;
      return { state: 'stored', etag: localDerivedEtag(nextBody) };
    });
  }

  const requestUrl = new URL(selected.apiUrl);
  requestUrl.searchParams.set('pathname', canonicalDerivedObjectBlobPath(project, relativePath));
  const requestId = `${selected.storeId}:${Date.now()}:${stableHash([project, relativePath, size, expectedEtag, Date.now()]).slice(0, 12)}`;
  const response = await fetch(requestUrl, {
    method: 'PUT',
    headers: {
      ...blobHeaders(selected),
      'x-api-blob-request-id': requestId,
      'x-api-blob-request-attempt': '0',
      'x-api-version': BLOB_API_VERSION,
      'x-vercel-blob-access': 'private',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': expectedEtag === null ? '0' : '1',
      ...(expectedEtag === null ? {} : { 'x-if-match': expectedEtag }),
      'x-content-type': contentType,
      'x-cache-control-max-age': '60',
      'content-type': contentType,
    },
    body,
  });
  if (response.status === 409 || response.status === 412) return { state: 'conflict', etag: response.headers.get('etag') };
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Vercel canonical conditional derived object write failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return { state: 'stored', etag: response.headers.get('etag') };
}

export async function writeCanonicalDerivedObject(
  project: string,
  relativePath: string,
  body: string | Uint8Array,
  contentType = 'application/octet-stream',
): Promise<boolean> {
  assertAuthorityWritesAllowed();
  return await writeDerivedObject(project, relativePath, body, contentType);
}

async function writeDerivedObject(
  project: string,
  relativePath: string,
  body: string | Uint8Array,
  contentType = 'application/octet-stream',
): Promise<boolean> {
  await assertProjectAccessCurrent(project);
  assertDerivedRelativePath(relativePath);
  const selected = backend();
  if (!selected || (selected.kind === 'vercel-private-blob' && !selected.token)) return false;
  const size = derivedObjectByteLength(body);
  if (size > MAX_DERIVED_OBJECT_BYTES) throw new Error('Canonical derived object exceeds the bounded storage size');

  if (selected.kind === 'file') {
    const target = canonicalDerivedObjectFilePath(project, relativePath)!;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid ?? 'process'}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, body, { mode: 0o600 });
    await fs.rename(temporary, target);
    return true;
  }

  const requestUrl = new URL(selected.apiUrl);
  requestUrl.searchParams.set('pathname', canonicalDerivedObjectBlobPath(project, relativePath));
  const requestId = `${selected.storeId}:${Date.now()}:${stableHash([project, relativePath, size, Date.now()]).slice(0, 12)}`;
  const response = await fetch(requestUrl, {
    method: 'PUT',
    headers: {
      ...blobHeaders(selected),
      'x-api-blob-request-id': requestId,
      'x-api-blob-request-attempt': '0',
      'x-api-version': BLOB_API_VERSION,
      'x-vercel-blob-access': 'private',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
      'x-content-type': contentType,
      'x-cache-control-max-age': '60',
      'content-type': contentType,
    },
    body,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Vercel canonical derived object write failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return true;
}

/** A disposable Preview cache, never a canonical graph or current pointer.
 * The namespace binds every object to its grant, repository, exact revision,
 * analyzer and deployed engine. A deployment cannot consume another engine's
 * output merely because the source revision happens to match. */
function previewReplayPrefix(expected: { project: string; repository: string; revision: string }): string {
  if (!previewRuntime()) throw new Error('Preview replay storage is only available in Preview');
  assertExactRevision(expected.revision);
  const engine = process.env.VERCEL_GIT_COMMIT_SHA || process.env.DEVINT_PREVIEW_ENGINE_REVISION || process.env.DEVINT_BUILD_SHA
    || process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || ANALYZER_VERSION;
  const limits = [process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? process.env.DEVINT_PARITY_MAX_FILE_BYTES,
    process.env.DEVINT_GRAPH_MAX_FILES ?? process.env.DEVINT_PARITY_MAX_FILES];
  const scope = stableHash([projectAccessScopeKey(), expected.project, expected.repository, expected.revision, ANALYZER_VERSION, engine,
    ...(limits.some(value => value !== undefined) ? limits : [])]);
  return `preview-replay/${scope}`;
}

/** Reuse the normal derived-object protocol inside the isolated Preview
 * revision namespace. These functions cannot address canonical objects. */
export function previewReplayDerivedStorage(expected: { project: string; repository: string; revision: string }) {
  const accessScope = projectAccessScopeKey();
  const prefix = previewReplayPrefix(expected);
  const scoped = (project: string, relativePath: string): string => {
    if (project !== expected.project || projectAccessScopeKey() !== accessScope) throw new Error('Preview replay project identity mismatch');
    assertDerivedRelativePath(relativePath);
    return `${prefix}/${relativePath}`;
  };
  return {
    read: (project: string, relativePath: string, maxBytes?: number) =>
      readCanonicalDerivedObject(project, scoped(project, relativePath), maxBytes),
    readVersioned: (project: string, relativePath: string, maxBytes?: number) =>
      readCanonicalDerivedObjectVersioned(project, scoped(project, relativePath), maxBytes),
    write: (project: string, relativePath: string, body: string | Uint8Array, contentType?: string) =>
      writeDerivedObject(project, scoped(project, relativePath), body, contentType),
    writeConditional: (project: string, relativePath: string, body: string | Uint8Array, contentType: string, etag: string | null) =>
      writeDerivedObjectConditional(project, scoped(project, relativePath), body, contentType, etag),
  };
}

export async function loadPreviewReplayGraph(expected: { project: string; repository: string; revision: string }): Promise<CanonicalLoadResult> {
  await assertProjectAccessCurrent(expected.project);
  const prefix = previewReplayPrefix(expected);
  const diagnostics = { ...baseDiagnostics(), scope: 'preview-replay' as const };
  if (!diagnostics.durable) return { diagnostics };
  const started = Date.now();
  try {
    const read = (project: string, relativePath: string, maxBytes?: number) =>
      readCanonicalDerivedObject(project, `${prefix}/${relativePath}`, maxBytes);
    const manifest = await readCanonicalDerivedObjectVersioned(expected.project, `${prefix}/manifest.json`);
    if (!manifest) return { diagnostics: { ...diagnostics, loadMs: Date.now() - started } };
    if (!manifest.etag) throw new Error('Preview graph manifest has no version');
    const parsed = await unshardCanonicalRecord(JSON.parse(new TextDecoder().decode(manifest.body)), expected.project, read);
    const record = validateRecord(parsed, expected);
    await assertProjectAccessCurrent(expected.project);
    return { record, previewManifestEtag: manifest.etag, diagnostics: { ...diagnostics, loadState: 'hit', loadMs: Date.now() - started } };
  } catch (error) {
    await assertProjectAccessCurrent(expected.project);
    return { diagnostics: { ...diagnostics, loadState: 'error', loadMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error) } };
  }
}

/** Replace only the retained Preview graph's index reference. Graph shards
 * stay untouched; a concurrent publication cannot overwrite a newer record. */
export async function replacePreviewReplayQueryArtifacts(
  expected: { project: string; repository: string; revision: string; graphId: string },
  ref: CanonicalQueryArtifactGenerationRef,
  expectedEtag: string,
): Promise<{ state: 'stored' | 'conflict' | 'error'; saveMs: number; error?: string }> {
  const started = Date.now();
  try {
    await assertProjectAccessCurrent(expected.project);
    const relativePath = `${previewReplayPrefix(expected)}/manifest.json`;
    const manifest = await readCanonicalDerivedObjectVersioned(expected.project, relativePath);
    if (!manifest || manifest.etag !== expectedEtag) return { state: 'conflict', saveMs: Date.now() - started };
    const payload = JSON.parse(new TextDecoder().decode(manifest.body)) as ShardedCanonicalRecord | CanonicalGraphRecord;
    const record = 'format' in payload && payload.format === 'canonical-graph-shards-v1'
      ? (Array.isArray(payload.parts) ? payload.record : null) : payload as CanonicalGraphRecord;
    if (!record || record.project !== expected.project || record.repository !== expected.repository
      || record.revision !== expected.revision || record.working?.graphId !== expected.graphId) {
      throw new Error('Preview graph manifest identity does not match the selected generation');
    }
    record.queryArtifacts = ref;
    const written = await writeDerivedObjectConditional(expected.project, relativePath, JSON.stringify(payload), 'application/json', expectedEtag);
    await assertProjectAccessCurrent(expected.project);
    return written.state === 'stored' ? { state: 'stored', saveMs: Date.now() - started }
      : written.state === 'conflict' ? { state: 'conflict', saveMs: Date.now() - started }
      : { state: 'error', saveMs: Date.now() - started, error: 'Preview graph storage is unavailable' };
  } catch (error) {
    await assertProjectAccessCurrent(expected.project);
    return { state: 'error', saveMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function savePreviewReplayGraph(record: CanonicalGraphRecord, options?: { expectedEtag: string | null }): Promise<CanonicalPersistenceDiagnostics> {
  await assertProjectAccessCurrent(record.project);
  const prefix = previewReplayPrefix(record);
  const diagnostics = { ...baseDiagnostics(), scope: 'preview-replay' as const };
  if (!diagnostics.durable) return diagnostics;
  const failed = record.working.producerCoverage?.find(item => item.state === 'failed');
  if (failed) return { ...diagnostics, saveState: 'skipped', error: `${failed.producer} did not finish: ${failed.reason ?? 'unknown failure'}` };
  const started = Date.now();
  try {
    const validated = validateRecord(record, record);
    const write = (project: string, relativePath: string, body: string | Uint8Array, contentType?: string) =>
      writeDerivedObject(project, `${prefix}/${relativePath}`, body, contentType);
    const payload = await shardCanonicalRecord(validated, write);
    await assertProjectAccessCurrent(record.project);
    if (options) {
      const publication = await writeDerivedObjectConditional(record.project, `${prefix}/manifest.json`, payload, 'application/json', options.expectedEtag);
      await assertProjectAccessCurrent(record.project);
      if (publication.state === 'conflict') return { ...diagnostics, saveState: 'error', saveMs: Date.now() - started,
        conflict: true, error: 'Preview replay manifest changed during publication' };
      if (publication.state !== 'stored') throw new Error('Preview replay manifest could not be stored');
    } else if (!await write(record.project, 'manifest.json', payload, 'application/json')) throw new Error('Preview replay manifest could not be stored');
    await assertProjectAccessCurrent(record.project);
    return { ...diagnostics, saveState: 'stored', saveMs: Date.now() - started };
  } catch (error) {
    await assertProjectAccessCurrent(record.project);
    return { ...diagnostics, saveState: 'error', saveMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadFromFile(
  selected: FileBackend,
  expected: { project: string; repository: string; revision: string },
  diagnostics: CanonicalPersistenceDiagnostics,
): Promise<CanonicalLoadResult> {
  const directory = path.join(selected.root, canonicalProjectStorageKey(expected.project));
  const exact = path.join(directory, `${expected.revision}.json`);
  const current = path.join(directory, 'current.json');

  const readRecord = async (target: string): Promise<unknown | null> => {
    const stat = await fs.stat(target).catch((error: any) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile()) throw new Error('Canonical graph record is not a regular file');
    return await unshardCanonicalRecord(JSON.parse(await fs.readFile(target, 'utf8')), expected.project);
  };

  const exactParsed = await readRecord(exact);
  if (exactParsed) {
    return { diagnostics: { ...diagnostics, loadState: 'hit' }, record: validateRecord(exactParsed, expected) };
  }

  // Mirror the Blob backend's current-record semantics so local/file
  // persistence can carry historical records forward while source advances
  // to a new exact Git revision. Revision snapshots remain available beside it.
  const currentParsed = await readRecord(current);
  if (!currentParsed) return { diagnostics };
  const classified = classifyCanonicalRecord(currentParsed, expected);
  return classified.state === 'stale'
    ? { diagnostics: { ...diagnostics, loadState: 'stale' }, staleRecord: classified.record }
    : { diagnostics: { ...diagnostics, loadState: 'hit' }, record: classified.record };
}

async function loadFromBlob(
  selected: BlobBackend,
  expected: { project: string; repository: string; revision: string },
  diagnostics: CanonicalPersistenceDiagnostics,
): Promise<CanonicalLoadResult> {
  if (!selected.token) return { diagnostics };
  const response = await fetch(blobObjectUrl(selected, canonicalGraphBlobPath(expected.project)), {
    headers: blobHeaders(selected),
    cache: 'no-store',
  });
  if (response.status === 404) return { diagnostics };
  if (!response.ok) throw new Error(`Vercel canonical Blob read failed with HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  const parsed = await unshardCanonicalRecord(JSON.parse(new TextDecoder().decode(body)), expected.project);
  const classified = classifyCanonicalRecord(parsed, expected);
  if (classified.state === 'stale') {
    return { diagnostics: { ...diagnostics, loadState: 'stale' }, staleRecord: classified.record };
  }
  return { diagnostics: { ...diagnostics, loadState: 'hit' }, record: classified.record };
}

export async function loadCanonicalGraph(expected: { project: string; repository: string; revision: string }): Promise<CanonicalLoadResult> {
  await assertProjectAccessCurrent(expected.project);
  assertExactRevision(expected.revision);
  const selected = backend();
  const diagnostics = baseDiagnostics(selected);
  if (!selected || (selected.kind === 'vercel-private-blob' && !selected.token)) return { diagnostics };
  const startedAt = Date.now();
  try {
    const result = selected.kind === 'file'
      ? await loadFromFile(selected, expected, diagnostics)
      : await loadFromBlob(selected, expected, diagnostics);
    result.diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
    return result;
  } catch (error) {
    diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.error = message;
    diagnostics.loadState = message.includes('Canonical') || error instanceof SyntaxError ? 'invalid' : 'error';
    return { diagnostics };
  }
}

async function saveToFile(selected: FileBackend, record: CanonicalGraphRecord, payload: string): Promise<void> {
  const directory = path.join(selected.root, canonicalProjectStorageKey(record.project));
  const revisionTarget = path.join(directory, `${record.revision}.json`);
  const currentTarget = path.join(directory, 'current.json');
  await fs.mkdir(directory, { recursive: true });

  const atomicWrite = async (target: string): Promise<void> => {
    const temporary = `${target}.${process.pid ?? 'process'}.${Date.now()}.${stableHash([record.revision, target]).slice(0, 8)}.tmp`;
    await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
  };

  // Keep immutable exact-revision evidence and a current pointer/copy. The
  // latter provides the same stale-record handoff that hosted Blob already
  // provides when the repository advances.
  await atomicWrite(revisionTarget);
  await atomicWrite(currentTarget);
}

async function saveToBlob(selected: BlobBackend, record: CanonicalGraphRecord, payload: string): Promise<void> {
  if (!selected.token) throw new Error('Vercel canonical Blob credential is unavailable');
  const requestUrl = new URL(selected.apiUrl);
  requestUrl.searchParams.set('pathname', canonicalGraphBlobPath(record.project));
  const requestId = `${selected.storeId}:${Date.now()}:${stableHash([record.project, record.revision, Date.now()]).slice(0, 12)}`;
  const response = await fetch(requestUrl, {
    method: 'PUT',
    headers: {
      ...blobHeaders(selected),
      'x-api-blob-request-id': requestId,
      'x-api-blob-request-attempt': '0',
      'x-api-version': BLOB_API_VERSION,
      'x-vercel-blob-access': 'private',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
      'x-content-type': 'application/json',
      'x-cache-control-max-age': '60',
      'content-type': 'application/json',
    },
    body: payload,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Vercel canonical Blob write failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
}

export async function saveCanonicalGraph(record: CanonicalGraphRecord): Promise<CanonicalPersistenceDiagnostics> {
  assertAuthorityWritesAllowed();
  assertExactRevision(record.revision);
  const selected = backend();
  const diagnostics = baseDiagnostics(selected);
  if (!selected || (selected.kind === 'vercel-private-blob' && !selected.token)) return diagnostics;
  const failedProducer = record.working.producerCoverage?.find(item => item.state === 'failed');
  if (failedProducer) {
    diagnostics.saveState = 'skipped';
    diagnostics.error = `${failedProducer.producer} did not finish: ${failedProducer.reason ?? 'unknown failure'}`;
    return diagnostics;
  }
  const startedAt = Date.now();
  try {
    const validated = validateRecord(record, { project: record.project, repository: record.repository, revision: record.revision });
    const payload = await shardCanonicalRecord(validated);
    if (selected.kind === 'file') await saveToFile(selected, validated, payload);
    else await saveToBlob(selected, validated, payload);
    diagnostics.saveState = 'stored';
  } catch (error) {
    diagnostics.saveState = 'error';
    diagnostics.error = error instanceof Error ? error.message : String(error);
  }
  diagnostics.saveMs = Math.max(0, Date.now() - startedAt);
  return diagnostics;
}

export function makeCanonicalGraphRecord(input: {
  project: string;
  repository: string;
  revision: string;
  working: IntelligenceGraph;
  accepted: IntelligenceGraph | null;
  legacyAcceptedParts?: CanonicalGraphPart[];
  currentness: CanonicalGraphCurrentness;
  queryArtifacts?: CanonicalQueryArtifactGenerationRef | null;
}): CanonicalGraphRecord {
  return {
    formatVersion: 1,
    project: input.project,
    repository: input.repository,
    revision: input.revision,
    analyzerVersion: ANALYZER_VERSION,
    graphSchemaVersion: 2,
    storedAt: new Date().toISOString(),
    sourceFingerprint: input.working.sourceFingerprint,
    topologyFingerprint: input.working.topologyFingerprint,
    evidenceFingerprint: input.working.evidenceFingerprint,
    working: input.working,
    accepted: input.accepted,
    ...(input.legacyAcceptedParts ? { legacyAcceptedParts: input.legacyAcceptedParts } : {}),
    currentness: input.currentness,
    ...(input.queryArtifacts !== undefined ? { queryArtifacts: input.queryArtifacts } : {}),
  };
}
