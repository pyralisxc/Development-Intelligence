import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IntelligenceGraph } from '../types.js';
import { stableHash } from '../util/hash.js';
import { assertGraphIntegrity } from './integrity.js';
import { ANALYZER_VERSION } from './repository.js';

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
}

export type CanonicalLoadState = 'not-configured' | 'hit' | 'miss' | 'invalid' | 'error';
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
  const oidcToken = process.env.VERCEL_OIDC_TOKEN?.trim();
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

function projectStorageKey(project: string): string {
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
  return path.join(root, projectStorageKey(project), `${revision}.json`);
}

export function canonicalGraphBlobPath(project: string): string {
  return `development-intelligence/canonical/${projectStorageKey(project)}/current.json`;
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

function validateRecord(record: unknown, expected: { project: string; repository: string; revision: string }): CanonicalGraphRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Canonical graph record must be an object');
  const value = record as CanonicalGraphRecord;
  if (value.formatVersion !== 1) throw new Error('Unsupported canonical graph record format');
  if (value.project !== expected.project || value.repository !== expected.repository || value.revision !== expected.revision) {
    throw new Error('Canonical graph identity does not match the requested repository revision');
  }
  if (value.analyzerVersion !== ANALYZER_VERSION || value.graphSchemaVersion !== 2) throw new Error('Canonical graph analyzer/schema identity is stale');
  if (!validCurrentness(value.currentness)) throw new Error('Canonical graph currentness is malformed');
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
  | { state: 'miss' } {
  const identity = recordIdentity(parsed);
  if (
    identity?.formatVersion === 1
    && identity.project === expected.project
    && identity.repository === expected.repository
    && typeof identity.revision === 'string'
    && identity.revision !== expected.revision
  ) return { state: 'miss' };
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

async function loadFromFile(
  selected: FileBackend,
  expected: { project: string; repository: string; revision: string },
  diagnostics: CanonicalPersistenceDiagnostics,
): Promise<CanonicalLoadResult> {
  const target = path.join(selected.root, projectStorageKey(expected.project), `${expected.revision}.json`);
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
  if (classified.state === 'miss') return { diagnostics };
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
  const target = path.join(selected.root, projectStorageKey(record.project), `${record.revision}.json`);
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
  };
}
