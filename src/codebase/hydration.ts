import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ephemeralDir, safeSegment } from '../config/paths.js';
import type { RevisionBundleManifest } from '../types.js';
import { ensureDir } from '../util/fs.js';
import { runChecked } from '../util/process.js';
import { sha256File } from '../util/checksum.js';
import { downloadArtifact } from '../storage/artifacts.js';
import { readStoredProjectState } from '../storage/control.js';
import { cbmCall, isHealthyIndexResult } from './cbm.js';
import { loadBundleManifest } from './bundles.js';

export interface HydratedBundle {
  project: string;
  manifest: RevisionBundleManifest;
  sourceDir: string;
  cbmProject: string;
  cbmEnv: NodeJS.ProcessEnv;
  root: string;
}

interface CacheEntry {
  promise: Promise<HydratedBundle>;
  refs: number;
  lastUsed: number;
}

const cache = new Map<string, CacheEntry>();

async function verifyFile(file: string, expectedSha: string, expectedBytes: number): Promise<void> {
  const actual = await sha256File(file);
  if (actual.sha256 !== expectedSha || actual.bytes !== expectedBytes) {
    throw new Error(`Revision bundle checksum mismatch for ${path.basename(file)}`);
  }
}

async function hydrate(project: string, manifest: RevisionBundleManifest): Promise<HydratedBundle> {
  const rootBase = path.join(ephemeralDir(), 'hydrated');
  await ensureDir(rootBase);
  const root = path.join(rootBase, `${safeSegment(project)}-${safeSegment(manifest.bundleId)}`);
  await fs.rm(root, { recursive: true, force: true });
  await ensureDir(root);
  try {
    const archive = path.join(root, 'source.tgz');
    await downloadArtifact(manifest.artifacts.sourceArchive.key, archive);
    await verifyFile(archive, manifest.artifacts.sourceArchive.sha256, manifest.artifacts.sourceArchive.bytes);

    const sourceDir = path.join(root, 'source');
    await ensureDir(sourceDir);
    await runChecked('tar', ['-xzf', archive, '-C', sourceDir], { timeoutMs: 5 * 60_000 });

    const graphDir = path.join(sourceDir, '.codebase-memory');
    await ensureDir(graphDir);
    const graph = path.join(graphDir, 'graph.db.zst');
    await downloadArtifact(manifest.artifacts.graph.key, graph);
    await verifyFile(graph, manifest.artifacts.graph.sha256, manifest.artifacts.graph.bytes);

    const cacheDir = path.join(root, 'cbm-cache');
    await ensureDir(cacheDir);
    const cbmProject = `devint-query-${safeSegment(project)}-${safeSegment(manifest.bundleId)}`.slice(0, 180);
    const cbmEnv = { CBM_CACHE_DIR: cacheDir, CBM_ALLOWED_ROOT: sourceDir };
    const indexed = await cbmCall('index_repository', { repo_path: sourceDir, mode: 'full', name: cbmProject, persistence: false }, { env: cbmEnv, timeoutMs: Number(process.env.DEVINT_HYDRATE_TIMEOUT_MS ?? 10 * 60_000) });
    if (!isHealthyIndexResult(indexed)) throw new Error(`Codebase Memory failed to hydrate revision bundle ${project}/${manifest.bundleId}: ${JSON.stringify(indexed).slice(0, 1000)}`);
    const status = await cbmCall('index_status', { project: cbmProject }, { env: cbmEnv });
    if (!isHealthyIndexResult(status)) throw new Error(`Codebase Memory hydrated bundle is not queryable: ${project}/${manifest.bundleId}`);

    return { project, manifest, sourceDir, cbmProject, cbmEnv, root };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function prune(): Promise<void> {
  const max = Math.max(1, Number(process.env.DEVINT_HYDRATION_CACHE_SIZE ?? 3));
  if (cache.size <= max) return;
  const candidates = [...cache.entries()].filter(([, entry]) => entry.refs === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (cache.size > max && candidates.length > 0) {
    const [key, entry] = candidates.shift()!;
    cache.delete(key);
    try {
      const hydrated = await entry.promise;
      await fs.rm(hydrated.root, { recursive: true, force: true });
    } catch { /* failed hydrations already clean themselves */ }
  }
}

export async function withHydratedBundle<T>(project: string, fn: (bundle: HydratedBundle) => Promise<T>): Promise<T> {
  const state = await readStoredProjectState(project);
  if (!state?.selectedBundleId) throw new Error(`${project} has no selected revision bundle. Run refresh_codebase first.`);
  const manifest = await loadBundleManifest(project, state.selectedBundleId);
  if (state.selectedSha && manifest.sourceSha !== state.selectedSha) throw new Error(`Selected revision bundle provenance mismatch for ${project}`);
  const key = `${project}:${manifest.bundleId}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = { promise: hydrate(project, manifest), refs: 0, lastUsed: Date.now() };
    cache.set(key, entry);
    entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  }
  entry.refs += 1;
  try {
    const hydrated = await entry.promise;
    entry.lastUsed = Date.now();
    return await fn(hydrated);
  } finally {
    entry.refs -= 1;
    entry.lastUsed = Date.now();
    await prune();
  }
}
