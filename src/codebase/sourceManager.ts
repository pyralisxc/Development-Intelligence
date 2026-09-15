import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectConfig, loadRegistry } from '../config/registry.js';
import { ephemeralDir, safeSegment } from '../config/paths.js';
import type { ParityScan, ProjectConfig, ProjectState, RevisionBundleManifest } from '../types.js';
import { ensureDir, pathExists } from '../util/fs.js';
import { runChecked } from '../util/process.js';
import { stableHash } from '../util/hash.js';
import { sha256File } from '../util/checksum.js';
import { artifactExists, deleteArtifactPrefix, projectArtifactPrefix, uploadArtifact, writeArtifactJson } from '../storage/artifacts.js';
import { deleteStoredProjectState, patchStoredProjectState, readStoredProjectState, writeStoredProjectState } from '../storage/control.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from '../parity/resolver.js';
import { scanRepositoryPath } from '../parity/repository.js';
import { saveScan } from '../parity/store.js';
import { cbmCall, codebaseSummary, isHealthyIndexResult } from './cbm.js';
import { BUNDLE_SCHEMA_VERSION, DEFAULT_CBM_VERSION, PARITY_SCHEMA_VERSION, bundleManifestKey, bundlePrefix, loadBundleManifest } from './bundles.js';
import { dispatchIndexJob } from './dispatch.js';
import { gitAuth } from './gitAuth.js';

function defaultState(project: string, config: ProjectConfig): ProjectState {
  return {
    project,
    repository: config.repository,
    ref: config.defaultRef,
    selectedSha: null,
    selectedBundleId: null,
    indexedAt: null,
    refreshedAt: null,
    lastFetchAt: null,
    lastError: null,
    lastIndexStatus: 'idle',
    lastIndexOperation: null,
    lastIndexRequestedAt: null,
    lastIndexStartedAt: null,
    lastIndexFinishedAt: null,
    indexingSha: null,
    latestParityScanId: null,
    recentParityScans: [],
  };
}

export async function readProjectState(project: string): Promise<ProjectState> {
  const config = await getProjectConfig(project);
  const stored = await readStoredProjectState(project);
  const defaults = defaultState(project, config);
  if (!stored) return defaults;
  return {
    ...defaults,
    ...stored,
    project,
    repository: config.repository,
    ref: typeof stored.ref === 'string' && stored.ref ? stored.ref : config.defaultRef,
    recentParityScans: Array.isArray(stored.recentParityScans) ? stored.recentParityScans : [],
  };
}

function assertAllowedRef(project: string, config: ProjectConfig, ref: string): void {
  const allowed = config.allowedRefs?.length ? config.allowedRefs : [config.defaultRef];
  if (!allowed.includes(ref)) throw new Error(`Ref is not allowlisted for ${project}: ${ref}`);
}

export async function upstreamStatus(project: string, ref?: string): Promise<{ ref: string; upstreamSha: string | null; error?: string }> {
  const config = await getProjectConfig(project);
  const selectedRef = ref ?? config.defaultRef;
  assertAllowedRef(project, config, selectedRef);
  const auth = await gitAuth(config);
  try {
    const result = await runChecked('git', ['ls-remote', config.repository, selectedRef], { env: auth.env, timeoutMs: 60_000 });
    const sha = result.stdout.trim().split(/\s+/)[0] || null;
    return { ref: selectedRef, upstreamSha: sha };
  } catch (error) {
    return { ref: selectedRef, upstreamSha: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await auth.cleanup();
  }
}

function branchName(ref: string): string | null {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

async function prepareSource(project: string, config: ProjectConfig, selectedRef: string, root: string): Promise<{ sourceDir: string; sha: string }> {
  const sourceDir = path.join(root, 'source');
  await runChecked('git', ['init', '--initial-branch=devint', sourceDir], { timeoutMs: 60_000 });
  await runChecked('git', ['-C', sourceDir, 'remote', 'add', 'origin', config.repository]);
  const depth = Math.min(Math.max(Number(process.env.DEVINT_SOURCE_HISTORY_DEPTH ?? 32), 1), 500);
  const auth = await gitAuth(config);
  try {
    await runChecked('git', ['-C', sourceDir, 'fetch', `--depth=${depth}`, 'origin', selectedRef], { env: auth.env, timeoutMs: 5 * 60_000 });
    const sha = (await runChecked('git', ['-C', sourceDir, 'rev-parse', 'FETCH_HEAD'])).stdout.trim();
    await runChecked('git', ['-C', sourceDir, 'checkout', '--detach', sha], { timeoutMs: 2 * 60_000 });
    const selectedBranch = branchName(selectedRef);
    if (selectedBranch) await runChecked('git', ['-C', sourceDir, 'branch', '-f', selectedBranch, sha]);

    if (config.defaultRef !== selectedRef) {
      await runChecked('git', ['-C', sourceDir, 'fetch', `--depth=${depth}`, 'origin', config.defaultRef], { env: auth.env, timeoutMs: 5 * 60_000 });
      const baseSha = (await runChecked('git', ['-C', sourceDir, 'rev-parse', 'FETCH_HEAD'])).stdout.trim();
      const baseBranch = branchName(config.defaultRef);
      if (baseBranch) await runChecked('git', ['-C', sourceDir, 'branch', '-f', baseBranch, baseSha]);
    }
    return { sourceDir, sha };
  } finally {
    await auth.cleanup();
  }
}

function repositoryParityScan(project: string, createdAt: string, revision: string, source: Awaited<ReturnType<typeof scanRepositoryPath>>): ParityScan {
  const resolutions = resolveCrossSource(source.observations, source.resolutions);
  return {
    scanId: `${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${stableHash([project, revision, 'repository']).slice(0, 8)}`,
    project,
    createdAt,
    repositoryRevision: revision,
    sources: [source.source],
    observations: source.observations,
    resolutions,
    namingDivergences: deriveNamingDivergences(source.observations, resolutions),
    explicitValueConflicts: [],
    unmatchedObservationIds: deriveUnmatched(source.observations, resolutions),
    unavailableSourceIds: [],
  };
}

function makeBundleId(project: string, sha: string, cbmVersion: string): string {
  const fingerprint = stableHash([project, sha, `bundle:${BUNDLE_SCHEMA_VERSION}`, `cbm:${cbmVersion}`, `parity:${PARITY_SCHEMA_VERSION}`]).slice(0, 16);
  return `${sha.slice(0, 16)}-${fingerprint}`;
}

export async function indexRevisionNow(project: string, ref?: string): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(project);
  const selectedRef = ref ?? config.defaultRef;
  assertAllowedRef(project, config, selectedRef);
  const previous = await readProjectState(project);
  const requestedAt = previous.lastIndexRequestedAt ?? new Date().toISOString();
  const startedAt = new Date().toISOString();
  await patchStoredProjectState(project, { ref: selectedRef, lastIndexStatus: 'running', lastIndexStartedAt: startedAt, lastError: null });

  const rootBase = ephemeralDir();
  await ensureDir(rootBase);
  const root = await fs.mkdtemp(path.join(rootBase, `index-${safeSegment(project)}-`));
  try {
    const prepared = await prepareSource(project, config, selectedRef, root);
    const { sourceDir, sha } = prepared;
    await patchStoredProjectState(project, { indexingSha: sha });

    const cbmVersion = process.env.DEVINT_CBM_VERSION ?? DEFAULT_CBM_VERSION;
    const bundleId = makeBundleId(project, sha, cbmVersion);
    const manifestKey = bundleManifestKey(project, bundleId);
    if (await artifactExists(manifestKey)) {
      const existing = await loadBundleManifest(project, bundleId);
      const current = await upstreamStatus(project, selectedRef);
      const now = new Date().toISOString();
      if (current.upstreamSha === sha) {
        await writeStoredProjectState(project, {
          ...previous,
          project,
          repository: config.repository,
          ref: selectedRef,
          selectedSha: sha,
          selectedBundleId: bundleId,
          indexedAt: existing.createdAt,
          refreshedAt: now,
          lastFetchAt: now,
          lastError: null,
          lastIndexStatus: 'succeeded',
          lastIndexRequestedAt: requestedAt,
          lastIndexStartedAt: startedAt,
          lastIndexFinishedAt: now,
          indexingSha: null,
        });
      }
      return { project, ref: selectedRef, accepted: true, changed: previous.selectedSha !== sha, reused: true, promoted: current.upstreamSha === sha, upstreamSha: current.upstreamSha, indexedSha: sha, bundleId };
    }

    const cbmCache = path.join(root, 'cbm-cache');
    await ensureDir(cbmCache);
    const internalProject = `devint-index-${safeSegment(project)}-${bundleId}`;
    const cbmEnv = { CBM_CACHE_DIR: cbmCache, CBM_ALLOWED_ROOT: sourceDir };
    const indexResult = await cbmCall('index_repository', {
      repo_path: sourceDir,
      mode: 'full',
      name: internalProject,
      persistence: true,
    }, { timeoutMs: Number(process.env.DEVINT_INDEX_TIMEOUT_MS ?? 20 * 60_000), env: cbmEnv });
    if (!isHealthyIndexResult(indexResult)) throw new Error(`Codebase Memory did not produce a healthy index for ${project}@${sha}: ${JSON.stringify(indexResult).slice(0, 1000)}`);
    const indexStatus = await cbmCall('index_status', { project: internalProject }, { env: cbmEnv });
    if (!isHealthyIndexResult(indexStatus)) throw new Error(`Codebase Memory status is not healthy for ${project}@${sha}: ${JSON.stringify(indexStatus).slice(0, 1000)}`);

    const graphFile = path.join(sourceDir, '.codebase-memory', 'graph.db.zst');
    if (!await pathExists(graphFile) || (await fs.stat(graphFile)).size <= 0) {
      throw new Error(`Codebase Memory reported a healthy index but did not produce the required portable graph artifact for ${project}@${sha}`);
    }

    const createdAt = new Date().toISOString();
    const repositoryAnalysis = await scanRepositoryPath({ project, repository: config.repository, revision: sha, sourceDir, observedAt: createdAt });
    const repoScan = repositoryParityScan(project, createdAt, sha, repositoryAnalysis);
    const parityFile = path.join(root, 'repository-parity.json');
    await fs.writeFile(parityFile, JSON.stringify(repoScan, null, 2) + '\n', { mode: 0o600 });

    const sourceArchive = path.join(root, 'source.tgz');
    await runChecked('tar', ['--exclude=.codebase-memory', '-czf', sourceArchive, '-C', sourceDir, '.'], { timeoutMs: 5 * 60_000 });

    const prefix = bundlePrefix(project, bundleId);
    const sourceKey = `${prefix}/source.tgz`;
    const graphKey = `${prefix}/graph.db.zst`;
    const parityKey = `${prefix}/repository-parity.json`;
    const sourceDigest = await sha256File(sourceArchive);
    const graphDigest = await sha256File(graphFile);
    const parityDigest = await sha256File(parityFile);
    await uploadArtifact(sourceKey, sourceArchive);
    await uploadArtifact(graphKey, graphFile);
    await uploadArtifact(parityKey, parityFile);

    const summary = codebaseSummary(indexStatus);
    const manifest: RevisionBundleManifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      bundleId,
      project,
      repository: config.repository,
      ref: selectedRef,
      sourceSha: sha,
      createdAt,
      cbmVersion,
      parityVersion: PARITY_SCHEMA_VERSION,
      codebase: summary,
      artifacts: {
        sourceArchive: { key: sourceKey, ...sourceDigest },
        graph: { key: graphKey, ...graphDigest },
        repositoryParity: { key: parityKey, ...parityDigest },
      },
    };
    await writeArtifactJson(manifestKey, manifest);
    await loadBundleManifest(project, bundleId);

    const current = await upstreamStatus(project, selectedRef);
    const finishedAt = new Date().toISOString();
    const promoted = current.upstreamSha === sha;
    if (promoted) {
      await writeStoredProjectState(project, {
        ...previous,
        project,
        repository: config.repository,
        ref: selectedRef,
        selectedSha: sha,
        selectedBundleId: bundleId,
        indexedAt: createdAt,
        refreshedAt: finishedAt,
        lastFetchAt: finishedAt,
        lastError: null,
        lastIndexStatus: 'succeeded',
        lastIndexRequestedAt: requestedAt,
        lastIndexStartedAt: startedAt,
        lastIndexFinishedAt: finishedAt,
        indexingSha: null,
      });
      await saveScan(repoScan);
    } else {
      await patchStoredProjectState(project, {
        lastIndexStatus: 'succeeded',
        lastIndexFinishedAt: finishedAt,
        indexingSha: null,
        lastError: current.error ?? `Indexed ${sha}, but ${selectedRef} moved before promotion`,
      });
    }
    return {
      project,
      ref: selectedRef,
      accepted: true,
      changed: previous.selectedSha !== sha,
      promoted,
      upstreamSha: current.upstreamSha,
      indexedSha: sha,
      bundleId,
      codebase: summary,
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await patchStoredProjectState(project, {
      lastIndexStatus: 'failed',
      lastIndexFinishedAt: finishedAt,
      indexingSha: null,
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function refreshCodebase(project: string, ref?: string): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(project);
  const selectedRef = ref ?? config.defaultRef;
  assertAllowedRef(project, config, selectedRef);
  const state = await readProjectState(project);
  const upstream = await upstreamStatus(project, selectedRef);
  if (!upstream.upstreamSha) throw new Error(`Unable to resolve ${project}@${selectedRef}: ${upstream.error ?? 'no revision returned'}`);
  if (state.selectedSha === upstream.upstreamSha && state.selectedBundleId) {
    try {
      await loadBundleManifest(project, state.selectedBundleId);
      return { project, ref: selectedRef, accepted: true, changed: false, promoted: true, upstreamSha: upstream.upstreamSha, indexedSha: state.selectedSha, bundleId: state.selectedBundleId };
    } catch {
      // A missing/corrupt manifest is derived-state damage: rebuild the same immutable revision.
    }
  }

  const requestedAt = new Date().toISOString();
  if (process.env.DEVINT_CLOUD_RUN_JOB_RESOURCE && process.env.DEVINT_INDEX_EXECUTION !== '1') {
    await patchStoredProjectState(project, {
      project,
      repository: config.repository,
      ref: selectedRef,
      lastFetchAt: requestedAt,
      lastIndexStatus: 'queued',
      lastIndexRequestedAt: requestedAt,
      lastIndexStartedAt: null,
      lastIndexFinishedAt: null,
      lastError: null,
      indexingSha: upstream.upstreamSha,
    });
    try {
      const dispatched = await dispatchIndexJob(project, selectedRef);
      await patchStoredProjectState(project, { lastIndexOperation: dispatched.operationName });
      return { project, ref: selectedRef, accepted: true, queued: true, upstreamSha: upstream.upstreamSha, operationName: dispatched.operationName };
    } catch (error) {
      await patchStoredProjectState(project, { lastIndexStatus: 'failed', lastIndexFinishedAt: new Date().toISOString(), indexingSha: null, lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  await patchStoredProjectState(project, { lastIndexRequestedAt: requestedAt, indexingSha: upstream.upstreamSha });
  return await indexRevisionNow(project, selectedRef);
}

export async function indexStatus(project: string): Promise<Record<string, unknown>> {
  const state = await readProjectState(project);
  let bundle: RevisionBundleManifest | null = null;
  if (state.selectedBundleId) {
    try { bundle = await loadBundleManifest(project, state.selectedBundleId); } catch { bundle = null; }
  }
  return {
    project,
    ref: state.ref,
    status: state.lastIndexStatus,
    indexingSha: state.indexingSha,
    selectedSha: state.selectedSha,
    selectedBundleId: state.selectedBundleId,
    indexedAt: state.indexedAt,
    requestedAt: state.lastIndexRequestedAt,
    startedAt: state.lastIndexStartedAt,
    finishedAt: state.lastIndexFinishedAt,
    operationName: state.lastIndexOperation,
    error: state.lastError,
    bundle: bundle ? { schemaVersion: bundle.schemaVersion, cbmVersion: bundle.cbmVersion, parityVersion: bundle.parityVersion, codebase: bundle.codebase } : null,
  };
}

export async function listPublicProjects(): Promise<Array<Record<string, unknown>>> {
  const registry = await loadRegistry();
  return await Promise.all(Object.keys(registry).sort().map(async project => {
    const state = await readProjectState(project);
    return {
      project,
      repository: registry[project]?.repository,
      defaultRef: registry[project]?.defaultRef,
      selectedSha: state.selectedSha,
      selectedBundleId: state.selectedBundleId,
      indexedAt: state.indexedAt,
      hasCodebaseIndex: Boolean(state.selectedBundleId),
      indexStatus: state.lastIndexStatus,
    };
  }));
}

export async function removeDerivedProjectState(project: string): Promise<Record<string, unknown>> {
  await getProjectConfig(project);
  await deleteArtifactPrefix(projectArtifactPrefix(project));
  await deleteStoredProjectState(project);
  return { project, deletedDerivedState: true };
}
