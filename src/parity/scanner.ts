import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProjectConfig } from '../config/registry.js';
import { readProjectState } from '../codebase/sourceManager.js';
import type { Observation, ParityScan, Resolution, SourceDescriptor } from '../types.js';
import { runChecked } from '../util/process.js';
import { stableHash } from '../util/hash.js';
import { analyzeByTechnology, analyzeHtml, analyzeJson } from './analyzers/index.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from './resolver.js';
import { saveScan } from './store.js';

const MAX_FILE_BYTES = Number(process.env.DEVINT_PARITY_MAX_FILE_BYTES ?? 1_000_000);
const MAX_FILES = Number(process.env.DEVINT_PARITY_MAX_FILES ?? 5000);
const MAX_RUNTIME_BYTES = Number(process.env.DEVINT_PARITY_MAX_RUNTIME_BYTES ?? 2_000_000);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.html', '.htm']);

async function trackedFiles(worktree: string): Promise<{ files: string[]; eligible: number }> {
  const result = await runChecked('git', ['-C', worktree, 'ls-files', '-z']);
  const eligibleFiles = result.stdout.split('\0').filter(Boolean).filter(file => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()));
  return { files: eligibleFiles.slice(0, MAX_FILES), eligible: eligibleFiles.length };
}

async function scanRepository(project: string): Promise<{ source: SourceDescriptor; observations: Observation[]; resolutions: Resolution[] }> {
  const state = await readProjectState(project);
  const now = new Date().toISOString();
  if (!state.selectedWorktree || !state.selectedSha) {
    return {
      source: { id: 'repository', kind: 'repository', locator: state.repository, revision: null, observedAt: now, available: false, error: 'No selected managed source generation. Run refresh_codebase first.' },
      observations: [],
      resolutions: [],
    };
  }
  const tracked = await trackedFiles(state.selectedWorktree);
  const warnings: string[] = [];
  if (tracked.eligible > tracked.files.length) warnings.push(`Parity scan file limit reached: analyzed ${tracked.files.length} of ${tracked.eligible} eligible tracked files.`);
  let oversizedFiles = 0;
  const source: SourceDescriptor = { id: 'repository', kind: 'repository', locator: state.repository, revision: state.selectedSha, observedAt: now, available: true };
  const observations: Observation[] = [];
  const resolutions: Resolution[] = [];
  for (const relative of tracked.files) {
    const worktreeRoot = path.resolve(state.selectedWorktree);
    const absolute = path.resolve(worktreeRoot, relative);
    if (absolute !== worktreeRoot && !absolute.startsWith(`${worktreeRoot}${path.sep}`)) { warnings.push(`Skipped tracked path outside managed source root: ${relative}`); continue; }
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) { warnings.push(`Skipped non-regular tracked file: ${relative}`); continue; }
    if (stat.size > MAX_FILE_BYTES) { oversizedFiles += 1; continue; }
    const text = await fs.readFile(absolute, 'utf8');
    const fileSource: SourceDescriptor = { id: `repo:${relative}`, kind: 'repository-file', locator: relative, revision: state.selectedSha, observedAt: now, available: true };
    const result = analyzeByTechnology({ source: fileSource, text, locatorBase: relative });
    observations.push(...result.observations);
    resolutions.push(...result.resolutions);
  }
  if (oversizedFiles > 0) warnings.push(`Skipped ${oversizedFiles} tracked files larger than ${MAX_FILE_BYTES} bytes.`);
  if (warnings.length > 0) source.warnings = warnings;
  return { source, observations, resolutions };
}

function runtimeHeaders(projectHeaders: Array<{ name: string; valueEnv: string }> | undefined): HeadersInit {
  const headers: Record<string, string> = {};
  for (const item of projectHeaders ?? []) {
    const value = process.env[item.valueEnv];
    if (!value) throw new Error(`Missing configured runtime credential environment variable: ${item.valueEnv}`);
    headers[item.name] = value;
  }
  return headers;
}

async function scanRuntimeUrl(project: string, urlText: string): Promise<{ source: SourceDescriptor; observations: Observation[]; resolutions: Resolution[] }> {
  const config = await getProjectConfig(project);
  const requested = new URL(urlText);
  const allowed = new Set((config.runtimeOrigins ?? []).map(value => new URL(value).origin));
  if (!allowed.has(requested.origin)) throw new Error(`Runtime origin is not allowlisted for ${project}: ${requested.origin}`);
  if (!['http:', 'https:'].includes(requested.protocol) || requested.username || requested.password) throw new Error('Runtime URL must be credential-free HTTP(S)');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DEVINT_RUNTIME_TIMEOUT_MS ?? 15_000));
  const observedAt = new Date().toISOString();
  try {
    let current = requested;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!allowed.has(current.origin)) throw new Error(`Runtime redirect origin is not allowlisted for ${project}: ${current.origin}`);
      response = await fetch(current, { method: 'GET', headers: runtimeHeaders(config.runtimeHeaders), redirect: 'manual', signal: controller.signal });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) break;
      const next = new URL(location, current);
      if (next.username || next.password) throw new Error('Runtime redirect URL must not contain credentials');
      if ((config.runtimeHeaders?.length ?? 0) > 0 && next.origin !== requested.origin) throw new Error('Authenticated runtime redirects must remain on the originally requested origin');
      current = next;
      if (redirects === 5) throw new Error('Runtime redirect limit exceeded');
    }
    if (!response) throw new Error('Runtime request produced no response');
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RUNTIME_BYTES) throw new Error(`Runtime response exceeds ${MAX_RUNTIME_BYTES} bytes`);
    const text = new TextDecoder().decode(body);
    const revision = response.headers.get('etag') ?? response.headers.get('last-modified');
    const source: SourceDescriptor = { id: `runtime:${requested.href}`, kind: 'runtime-http', locator: requested.href, revision, observedAt, available: true };
    const statusObs: Observation = {
      id: stableHash([source.id, 'http-status']), sourceId: source.id, kind: 'http-status', locator: `${requested.href}:status`, field: 'status', name: String(response.status), value: response.status, raw: String(response.status),
    };
    const contentType = response.headers.get('content-type') ?? '';
    const result = /text\/html/i.test(contentType)
      ? analyzeHtml({ source, text, locatorBase: requested.href })
      : /application\/(?:[^;]+\+)?json/i.test(contentType)
        ? analyzeJson({ source, text, locatorBase: requested.href })
        : { observations: [], resolutions: [] };
    return { source, observations: [statusObs, ...result.observations], resolutions: result.resolutions };
  } catch (error) {
    return {
      source: { id: `runtime:${requested.href}`, kind: 'runtime-http', locator: requested.href, revision: null, observedAt, available: false, error: error instanceof Error ? error.message : String(error) },
      observations: [],
      resolutions: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function scanParity(project: string, urls: string[] = []): Promise<ParityScan> {
  const createdAt = new Date().toISOString();
  const repo = await scanRepository(project);
  const sources = [repo.source];
  const observations = [...repo.observations];
  let resolutions = [...repo.resolutions];
  for (const url of urls) {
    const runtime = await scanRuntimeUrl(project, url);
    sources.push(runtime.source);
    observations.push(...runtime.observations);
    resolutions.push(...runtime.resolutions);
  }
  resolutions = resolveCrossSource(observations, resolutions);
  const scan: ParityScan = {
    scanId: `${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${stableHash([project, createdAt, observations.length]).slice(0, 8)}`,
    project,
    createdAt,
    repositoryRevision: repo.source.revision,
    sources,
    observations,
    resolutions,
    namingDivergences: deriveNamingDivergences(observations, resolutions),
    explicitValueConflicts: [],
    unmatchedObservationIds: deriveUnmatched(observations, resolutions),
    unavailableSourceIds: sources.filter(source => !source.available).map(source => source.id),
  };
  await saveScan(scan);
  return scan;
}
