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
  mode: 'process-only' | 'canonical-file' | 'vercel-blob';
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

interface BlobConfig {
  storeId: string;
  token: string;
  apiBase: string;
  readBase: string;
}

const MAX_CANONICAL_BYTES = 200 * 1024 * 1024;
const BLOB_API_VERSION = '12';

function configuredRoot(): string | null {
  const value = process.env.DEVINT_CANONICAL_GRAPH_DIR?.trim();
  return value ? path.resolve(value) : null;
}

function blobRequested(): boolean {
  return process.env.DEVINT_CANONICAL_GRAPH_STORE?.trim().toLowerCase() === 'vercel-blob';
}

function normalizeStoreId(value: string): string {
  return value.startsWith('store_') ? value.slice('store_'.length) : value;
}

function storeIdFromReadWriteToken(token: string): string | null {
  const [, , , storeId = ''] = token.split('_');
  return storeId ? normalizeStoreId(storeId) : null;
}

function blobConfig(): BlobConfig | null {
  if (!blobRequested()) return null;
  const oidc = process.env.VERCEL_OIDC_TOKEN?.trim() ?? '';
  const readWrite = process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? '';
  const token = oidc || readWrite;
  const storeId = normalizeStoreId(process.env.BLOB_STORE_ID?.trim() || storeIdFromReadWriteToken(readWrite) || '');
  if (!token || !storeId) return null;
  const apiBase = (process.env.VERCEL_BLOB_API_URL?.trim() || 'https://vercel.com/api/blob').replace(/\/+$/u, '');
  const configuredReadBase = process.env.DEVINT_CANONICAL_BLOB_READ_BASE_URL?.trim();
  const readBase = (configuredReadBase || `https://${storeId}.private.blob.vercel-storage.com`).replace(/\/+$/u, '');
  if (!/^https:\/\//u.test(apiBase) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?(?:\/|$)/u.test(apiBase)) {
    throw new Error('Vercel Blob API base must use HTTPS except for loopback tests');
  }
  if (!/^https:\/\//u.test(readBase) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?(?:\/|$)/u.test(readBase)) {
    throw new Error('Vercel Blob read base must use HTTPS except for loopback tests');
  }
  return { storeId, token, apiBase, readBase };
}

function projectStorageKey(project: string): string {
  const readable = project.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'project';
  return `${readable}-${stableHash([project]).slice(0, 12)}`;
}

function assertRevision(revision: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(revision)) throw new Error('Canonical graph revisions require an exact Git object id');
}

export function canonicalGraphObjectPath(project: string, revision: string): string {
  assertRevision(revision);
  const analyzer = encodeURIComponent(ANALYZER_VERSION);
  return `development-intelligence/canonical/v1/${projectStorageKey(project)}/${analyzer}/${revision}.json`;
}

export function canonicalGraphFilePath(project: string, revision: string): string | null {
  const root = configuredRoot();
  if (!root) return null;
  assertRevision(revision);
  return path.join(root, projectStorageKey(project), `${revision}.json`);
}

function mode(): CanonicalPersistenceDiagnostics['mode'] {
  if (blobRequested()) return 'vercel-blob';
  if (configuredRoot()) return 'canonical-file';
  return 'process-only';
}

function baseDiagnostics(): CanonicalPersistenceDiagnostics {
  const selected = mode();
  const ready = selected === 'canonical-file' ? true : selected === 'vercel-blob' ? Boolean(blobConfig()) : false;
  return {
    mode: selected,
    durable: ready,
    loadState: selected === 'process-only' ? 'not-configured' : ready ? 'miss' : 'error',
    saveState: selected === 'process-only' ? 'not-configured' : ready ? 'skipped' : 'error',
    loadMs: 0,
    saveMs: 0,
    ...(!ready && selected === 'vercel-blob' ? { error: 'Vercel Blob canonical storage requires BLOB_STORE_ID plus VERCEL_OIDC_TOKEN or BLOB_READ_WRITE_TOKEN' } : {}),
  };
}

function validCurrentness(value: unknown): value is CanonicalGraphCurrentness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return ['acceptedSemanticCurrent','sourceCurrent','topologyCurrent','evidenceCurrent','analyzerCurrent','schemaSupported','integrityCurrent']
    .every(key => typeof item[key] === 'boolean')
    && (item.checkpointError === null || typeof item.checkpointError === 'string');
}

function validateRecord(
  record: unknown,
  expected: { project: string; repository: string; revision: string },
): CanonicalGraphRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Canonical graph record must be an object');
  const value = record as CanonicalGraphRecord;
  if (value.formatVersion !== 1) throw new Error('Unsupported canonical graph record format');
  if (value.project !== expected.project || value.repository !== expected.repository || value.revision !== expected.revision) {
    throw new Error('Canonical graph identity does not match the requested repository revision');
  }
  if (value.analyzerVersion !== ANALYZER_VERSION || value.graphSchemaVersion !== 2) {
    throw new Error('Canonical graph analyzer/schema identity is stale');
  }
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

function classifyLoadError(error: unknown): CanonicalLoadState {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Canonical') || error instanceof SyntaxError ? 'invalid' : 'error';
}

function parseBoundedJson(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_CANONICAL_BYTES) throw new Error('Canonical graph record exceeds the bounded storage size');
  return JSON.parse(text);
}

async function loadFile(
  expected: { project: string; repository: string; revision: string },
  diagnostics: CanonicalPersistenceDiagnostics,
): Promise<CanonicalLoadResult> {
  const target = canonicalGraphFilePath(expected.project, expected.revision);
  if (!target) return { diagnostics };
  const startedAt = Date.now();
  try {
    const stat = await fs.stat(target).catch((error: any) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) {
      diagnostics.loadState = 'miss';
      diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
      return { diagnostics };
    }
    if (!stat.isFile() || stat.size > MAX_CANONICAL_BYTES) throw new Error('Canonical graph record is not a bounded regular file');
    const record = validateRecord(parseBoundedJson(await fs.readFile(target, 'utf8')), expected);
    diagnostics.loadState = 'hit';
    diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
    return { diagnostics, record };
  } catch (error) {
    diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
    diagnostics.error = error instanceof Error ? error.message : String(error);
    diagnostics.loadState = classifyLoadError(error);
    return { diagnostics };
  }
}

function blobHeaders(config: BlobConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.token}`,
    'x-vercel-blob-store-id': config.storeId,
    'x-api-version': BLOB_API_VERSION,
  };
}

async function loadBlob(
  expected: { project: string; repository: string; revision: string },
  diagnostics: CanonicalPersistenceDiagnostics,
): Promise<CanonicalLoadResult> {
  const config = blobConfig();
  if (!config) return { diagnostics };
  const startedAt = Date.now();
  const objectPath = canonicalGraphObjectPath(expected.project, expected.revision);
  try {
    const url = `${config.readBase}/${objectPath}?cache=0`;
    const response = await fetch(url, { method: 'GET', headers: blobHeaders(config), redirect: 'error' });
    if (response.status === 404) {
      diagnostics.loadState = 'miss';
      diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
      return { diagnostics };
    }
    if (!response.ok) throw new Error(`Vercel Blob canonical read failed with HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_CANONICAL_BYTES) throw new Error('Canonical graph record exceeds the bounded storage size');
    const record = validateRecord(parseBoundedJson(await response.text()), expected);
    diagnostics.loadState = 'hit';
    diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
    return { diagnostics, record };
  } catch (error) {
    diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
    diagnostics.error = error instanceof Error ? error.message : String(error);
    diagnostics.loadState = classifyLoadError(error);
    return { diagnostics };
  }
}

export async function loadCanonicalGraph(
  expected: { project: string; repository: string; revision: string },
): Promise<CanonicalLoadResult> {
  const diagnostics = baseDiagnostics();
  if (diagnostics.mode === 'canonical-file') return await loadFile(expected, diagnostics);
  if (diagnostics.mode === 'vercel-blob') return await loadBlob(expected, diagnostics);
  return { diagnostics };
}

async function saveFile(record: CanonicalGraphRecord, diagnostics: CanonicalPersistenceDiagnostics, payload: string): Promise<CanonicalPersistenceDiagnostics> {
  const target = canonicalGraphFilePath(record.project, record.revision);
  if (!target) return diagnostics;
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${target}.${process.pid ?? 'process'}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
  diagnostics.saveState = 'stored';
  return diagnostics;
}

async function saveBlob(record: CanonicalGraphRecord, diagnostics: CanonicalPersistenceDiagnostics, payload: string): Promise<CanonicalPersistenceDiagnostics> {
  const config = blobConfig();
  if (!config) return diagnostics;
  const objectPath = canonicalGraphObjectPath(record.project, record.revision);
  const params = new URLSearchParams({ pathname: objectPath });
  const response = await fetch(`${config.apiBase}/?${params.toString()}`, {
    method: 'PUT',
    body: payload,
    redirect: 'error',
    headers: {
      ...blobHeaders(config),
      'content-type': 'application/json',
      'x-content-type': 'application/json',
      'x-access': 'private',
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
      'x-cache-control-max-age': '31536000',
      'x-content-length': String(Buffer.byteLength(payload, 'utf8')),
    },
  });
  if (!response.ok) throw new Error(`Vercel Blob canonical write failed with HTTP ${response.status}`);
  diagnostics.saveState = 'stored';
  return diagnostics;
}

export async function saveCanonicalGraph(record: CanonicalGraphRecord): Promise<CanonicalPersistenceDiagnostics> {
  const diagnostics = baseDiagnostics();
  if (diagnostics.mode === 'process-only' || !diagnostics.durable) return diagnostics;
  const startedAt = Date.now();
  try {
    const validated = validateRecord(record, { project: record.project, repository: record.repository, revision: record.revision });
    const payload = JSON.stringify(validated);
    if (Buffer.byteLength(payload, 'utf8') > MAX_CANONICAL_BYTES) throw new Error('Canonical graph record exceeds the bounded storage size');
    if (diagnostics.mode === 'canonical-file') await saveFile(record, diagnostics, payload);
    else await saveBlob(record, diagnostics, payload);
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
