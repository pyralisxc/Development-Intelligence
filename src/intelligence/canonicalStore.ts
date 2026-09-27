import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IntelligenceGraph } from '../types.js';
import { stableHash } from '../util/hash.js';
import { assertGraphIntegrity } from './integrity.js';
import { ANALYZER_VERSION } from './repository.js';
import { currentVercelOidcToken } from '../vercelRequestContext.js';

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
  currentness: CanonicalGraphCurrentness;
  queryArtifacts?: CanonicalQueryArtifactGenerationRef | null;
}

export type CanonicalLoadState = 'not-configured' | 'hit' | 'stale' | 'miss' | 'invalid' | 'error';
export type CanonicalSaveState = 'not-configured' | 'stored' | 'error' | 'skipped';

export interface CanonicalPersistenceDiagnostics {
  mode: 'process-only' | 'canonical-file' | 'vercel-private-blob';
  durable: boolean;
  loadState: CanonicalLoadState;
  saveState: CanonicalSaveState;
  loadMs: number;
  saveMs: number;
  error?: string;
}

export interface CanonicalLoadResult {
  diagnostics: CanonicalPersistenceDiagnostics;
  record?: CanonicalGraphRecord;
  staleRecord?: CanonicalGraphRecord;
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

const MAX_CANONICAL_BYTES = 200 * 1024 * 1024;
const MAX_DERIVED_OBJECT_BYTES = 64 * 1024 * 1024;
const BLOB_API_VERSION = '12';

function configuredRoot(): string | null {
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
  if (value.accepted) {
    if (value.accepted.schemaVersion !== 2 || value.accepted.project !== expected.project || value.accepted.repositoryRevision !== expected.revision) {
      throw new Error('Canonical accepted graph identity is stale or malformed');
    }
    assertGraphIntegrity(value.accepted);
  }
  return value;
}

function classifyRecordForBlob(parsed: unknown, expected: { project: string; repository: string; revision: string }):
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

export async function readCanonicalDerivedObjectVersioned(
  project: string,
  relativePath: string,
  maxBytes = MAX_DERIVED_OBJECT_BYTES,
): Promise<CanonicalDerivedObjectVersion | null> {
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
  return { body, etag: response.headers.get('etag') };
}

export async function readCanonicalDerivedObject(
  project: string,
  relativePath: string,
  maxBytes = MAX_DERIVED_OBJECT_BYTES,
): Promise<Uint8Array | null> {
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
  assertDerivedRelativePath(relativePath);
  const selected = backend();
  if (!selected || (selected.kind === 'vercel-private-blob' && !selected.token)) {
    return { state: 'not-configured', etag: null };
  }
  const size = derivedObjectByteLength(body);
  if (size > MAX_DERIVED_OBJECT_BYTES) throw new Error('Canonical derived object exceeds the bounded storage size');

  if (selected.kind === 'file') {
    const target = canonicalDerivedObjectFilePath(project, relativePath)!;
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

async function loadFromFile(
  selected: FileBackend,
  expected: { project: string; repository: string; revision: string },
  diagnostics: CanonicalPersistenceDiagnostics,
): Promise<CanonicalLoadResult> {
  const target = path.join(selected.root, canonicalProjectStorageKey(expected.project), `${expected.revision}.json`);
  const stat = await fs.stat(target).catch((error: any) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return { diagnostics };
  if (!stat.isFile() || stat.size > MAX_CANONICAL_BYTES) throw new Error('Canonical graph record is not a bounded regular file');
  const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
  return { diagnostics: { ...diagnostics, loadState: 'hit' }, record: validateRecord(parsed, expected) };
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
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_CANONICAL_BYTES) throw new Error('Canonical graph record exceeds the bounded storage size');
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_CANONICAL_BYTES) throw new Error('Canonical graph record exceeds the bounded storage size');
  const parsed = JSON.parse(new TextDecoder().decode(body));
  const classified = classifyRecordForBlob(parsed, expected);
  if (classified.state === 'stale') {
    return { diagnostics: { ...diagnostics, loadState: 'stale' }, staleRecord: classified.record };
  }
  return { diagnostics: { ...diagnostics, loadState: 'hit' }, record: classified.record };
}

export async function loadCanonicalGraph(expected: { project: string; repository: string; revision: string }): Promise<CanonicalLoadResult> {
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
  const target = path.join(selected.root, canonicalProjectStorageKey(record.project), `${record.revision}.json`);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${target}.${process.pid ?? 'process'}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
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
  assertExactRevision(record.revision);
  const selected = backend();
  const diagnostics = baseDiagnostics(selected);
  if (!selected || (selected.kind === 'vercel-private-blob' && !selected.token)) return diagnostics;
  const startedAt = Date.now();
  try {
    const validated = validateRecord(record, { project: record.project, repository: record.repository, revision: record.revision });
    const payload = JSON.stringify(validated);
    if (Buffer.byteLength(payload, 'utf8') > MAX_CANONICAL_BYTES) throw new Error('Canonical graph record exceeds the bounded storage size');
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
    currentness: input.currentness,
    ...(input.queryArtifacts !== undefined ? { queryArtifacts: input.queryArtifacts } : {}),
  };
}
