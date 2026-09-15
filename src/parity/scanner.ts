import { getProjectConfig } from '../config/registry.js';
import type { Observation, ParityScan, Resolution, SourceDescriptor } from '../types.js';
import { stableHash } from '../util/hash.js';
import { analyzeHtml, analyzeJson } from './analyzers/index.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from './resolver.js';
import { saveScan } from './store.js';
import { loadSelectedBundleManifest } from '../codebase/bundles.js';
import { readArtifactJson } from '../storage/artifacts.js';

const MAX_RUNTIME_BYTES = Number(process.env.DEVINT_PARITY_MAX_RUNTIME_BYTES ?? 2_000_000);

function runtimeHeaders(projectHeaders: Array<{ name: string; valueEnv: string }> | undefined): HeadersInit {
  const headers: Record<string, string> = {};
  for (const item of projectHeaders ?? []) {
    const value = process.env[item.valueEnv];
    if (!value) throw new Error(`Missing configured runtime credential environment variable: ${item.valueEnv}`);
    headers[item.name] = value;
  }
  return headers;
}

async function repositoryBaseline(project: string): Promise<ParityScan> {
  const config = await getProjectConfig(project);
  const manifest = await loadSelectedBundleManifest(project);
  if (!manifest) {
    const createdAt = new Date().toISOString();
    return {
      scanId: `${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${stableHash([project, createdAt, 'unavailable']).slice(0, 8)}`,
      project,
      createdAt,
      repositoryRevision: null,
      sources: [{ id: 'repository', kind: 'repository', locator: config.repository, revision: null, observedAt: createdAt, available: false, error: 'No selected revision bundle. Run refresh_codebase first.' }],
      observations: [],
      resolutions: [],
      namingDivergences: [],
      explicitValueConflicts: [],
      unmatchedObservationIds: [],
      unavailableSourceIds: ['repository'],
    };
  }
  const scan = await readArtifactJson<ParityScan>(manifest.artifacts.repositoryParity.key);
  if (scan.repositoryRevision !== manifest.sourceSha) throw new Error(`Repository parity revision mismatch for ${project}/${manifest.bundleId}`);
  return scan;
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
  const baseline = await repositoryBaseline(project);
  if (urls.length === 0 && baseline.repositoryRevision) return baseline;

  const createdAt = new Date().toISOString();
  const sources = [...baseline.sources];
  const observations = [...baseline.observations];
  let resolutions = [...baseline.resolutions];
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
    repositoryRevision: baseline.repositoryRevision,
    sources,
    observations,
    resolutions,
    namingDivergences: deriveNamingDivergences(observations, resolutions),
    explicitValueConflicts: baseline.explicitValueConflicts,
    unmatchedObservationIds: deriveUnmatched(observations, resolutions),
    unavailableSourceIds: sources.filter(source => !source.available).map(source => source.id),
  };
  await saveScan(scan);
  return scan;
}
