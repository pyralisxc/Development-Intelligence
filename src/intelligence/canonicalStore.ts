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
  mode: 'process-only' | 'canonical-file';
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

const MAX_CANONICAL_BYTES = 200 * 1024 * 1024;

function configuredRoot(): string | null {
  const value = process.env.DEVINT_CANONICAL_GRAPH_DIR?.trim();
  return value ? path.resolve(value) : null;
}

function projectStorageKey(project: string): string {
  const readable = project.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'project';
  return `${readable}-${stableHash(project).slice(0, 12)}`;
}

export function canonicalGraphFilePath(project: string, revision: string): string | null {
  const root = configuredRoot();
  if (!root) return null;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(revision)) throw new Error('Canonical graph revisions require an exact Git object id');
  return path.join(root, projectStorageKey(project), `${revision}.json`);
}

function baseDiagnostics(): CanonicalPersistenceDiagnostics {
  return {
    mode: configuredRoot() ? 'canonical-file' : 'process-only',
    durable: Boolean(configuredRoot()),
    loadState: configuredRoot() ? 'miss' : 'not-configured',
    saveState: configuredRoot() ? 'skipped' : 'not-configured',
    loadMs: 0,
    saveMs: 0,
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

export async function loadCanonicalGraph(
  expected: { project: string; repository: string; revision: string },
): Promise<CanonicalLoadResult> {
  const diagnostics = baseDiagnostics();
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
    const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
    const record = validateRecord(parsed, expected);
    diagnostics.loadState = 'hit';
    diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
    return { diagnostics, record };
  } catch (error) {
    diagnostics.loadMs = Math.max(0, Date.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.error = message;
    diagnostics.loadState = message.includes('Canonical') || error instanceof SyntaxError ? 'invalid' : 'error';
    return { diagnostics };
  }
}

export async function saveCanonicalGraph(record: CanonicalGraphRecord): Promise<CanonicalPersistenceDiagnostics> {
  const diagnostics = baseDiagnostics();
  const target = canonicalGraphFilePath(record.project, record.revision);
  if (!target) return diagnostics;
  const startedAt = Date.now();
  try {
    const validated = validateRecord(record, { project: record.project, repository: record.repository, revision: record.revision });
    const directory = path.dirname(target);
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${target}.${process.pid ?? 'process'}.${Date.now()}.tmp`;
    const payload = JSON.stringify(validated);
    if (Buffer.byteLength(payload, 'utf8') > MAX_CANONICAL_BYTES) throw new Error('Canonical graph record exceeds the bounded storage size');
    await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
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
