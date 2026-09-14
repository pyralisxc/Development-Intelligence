import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getProjectConfig, loadRegistry } from '../config/registry.js';
import { projectDataDir, safeSegment } from '../config/paths.js';
import type { ProjectGeneration, ProjectState } from '../types.js';
import { atomicWriteJson, ensureDir, pathExists, readJson, withDirectoryLock } from '../util/fs.js';
import { runChecked } from '../util/process.js';
import { cbmCall, isHealthyIndexResult } from './cbm.js';
import { gitAuth } from './gitAuth.js';

function stateFile(project: string): string { return path.join(projectDataDir(project), 'state.json'); }
function mirrorDir(project: string): string { return path.join(projectDataDir(project), 'repo.git'); }
function generationsDir(project: string): string { return path.join(projectDataDir(project), 'generations'); }
function lockDir(project: string): string { return path.join(projectDataDir(project), '.refresh-lock'); }
function internalProjectPrefix(project: string): string { return `devint-${safeSegment(project)}-`; }

export async function readProjectState(project: string): Promise<ProjectState> {
  const config = await getProjectConfig(project);
  return await readJson<ProjectState>(stateFile(project), {
    project,
    repository: config.repository,
    ref: config.defaultRef,
    selectedSha: null,
    selectedGeneration: null,
    selectedWorktree: null,
    selectedCbmProject: null,
    indexedAt: null,
    refreshedAt: null,
    lastFetchAt: null,
    generations: [],
  });
}

async function ensureMirror(project: string): Promise<void> {
  const config = await getProjectConfig(project);
  const mirror = mirrorDir(project);
  await ensureDir(projectDataDir(project));
  if (await pathExists(path.join(mirror, 'HEAD'))) return;
  const auth = await gitAuth(config);
  try {
    await runChecked('git', ['clone', '--mirror', config.repository, mirror], { env: auth.env, timeoutMs: 5 * 60_000 });
  } finally {
    await auth.cleanup();
  }
}

async function fetchMirror(project: string): Promise<void> {
  const config = await getProjectConfig(project);
  const auth = await gitAuth(config);
  try {
    await runChecked('git', ['--git-dir', mirrorDir(project), 'remote', 'update', '--prune'], { env: auth.env, timeoutMs: 5 * 60_000 });
  } finally {
    await auth.cleanup();
  }
}

async function resolveRef(project: string, ref: string): Promise<string> {
  const result = await runChecked('git', ['--git-dir', mirrorDir(project), 'rev-parse', `${ref}^{commit}`]);
  return result.stdout.trim();
}

async function materializeGeneration(project: string, sha: string): Promise<string> {
  const dir = path.join(generationsDir(project), sha);
  if (await pathExists(path.join(dir, '.git'))) return dir;
  await ensureDir(generationsDir(project));
  if (await pathExists(dir)) await fs.rm(dir, { recursive: true, force: true });
  await runChecked('git', ['--git-dir', mirrorDir(project), 'worktree', 'add', '--detach', dir, sha], { timeoutMs: 2 * 60_000 });
  return dir;
}

async function changedFileCount(project: string, previousSha: string | null, nextSha: string): Promise<number | null> {
  if (!previousSha || previousSha === nextSha) return previousSha === nextSha ? 0 : null;
  try {
    const result = await runChecked('git', ['--git-dir', mirrorDir(project), 'diff', '--name-only', previousSha, nextSha]);
    return result.stdout.split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

function makeGenerationId(sha: string): string {
  return `${sha.slice(0, 12)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function extractCbmProjectNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(item => typeof item === 'string' ? [item] : item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string' ? [(item as Record<string, unknown>).name as string] : []);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const candidates = record.projects ?? record.results ?? record.items;
  return Array.isArray(candidates) ? extractCbmProjectNames(candidates) : [];
}

async function deleteCbmProject(name: string): Promise<void> {
  try { await cbmCall('delete_project', { project: name }); } catch { /* derived-state cleanup is best effort */ }
}

async function pruneGenerations(project: string, state: ProjectState): Promise<ProjectState> {
  const keepCount = Math.max(1, Number(process.env.DEVINT_KEEP_GENERATIONS ?? 2));
  const history = (state.generations ?? []).slice(0, Math.max(keepCount, 1));
  const keptCbm = new Set(history.map(item => item.cbmProject));
  const keptWorktrees = new Set(history.map(item => item.worktree));
  const dropped = (state.generations ?? []).slice(history.length);
  for (const generation of dropped) {
    if (!keptCbm.has(generation.cbmProject)) await deleteCbmProject(generation.cbmProject);
  }

  // Also remove orphaned internal indexes left by failed/interrupted generations.
  try {
    const listed = await cbmCall('list_projects', {});
    for (const name of extractCbmProjectNames(listed)) {
      if (name.startsWith(internalProjectPrefix(project)) && !keptCbm.has(name)) await deleteCbmProject(name);
    }
  } catch { /* old Codebase Memory versions may not expose list_projects via CLI */ }

  if (await pathExists(generationsDir(project))) {
    const dirs = await fs.readdir(generationsDir(project), { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      const worktree = path.join(generationsDir(project), entry.name);
      if (keptWorktrees.has(worktree)) continue;
      try { await runChecked('git', ['--git-dir', mirrorDir(project), 'worktree', 'remove', '--force', worktree], { timeoutMs: 60_000 }); }
      catch { await fs.rm(worktree, { recursive: true, force: true }); }
    }
    try { await runChecked('git', ['--git-dir', mirrorDir(project), 'worktree', 'prune']); } catch { /* best effort */ }
  }
  return { ...state, generations: history };
}

export async function upstreamStatus(project: string, ref?: string): Promise<{ ref: string; upstreamSha: string | null; error?: string }> {
  const config = await getProjectConfig(project);
  const selectedRef = ref ?? config.defaultRef;
  if (!(config.allowedRefs ?? [config.defaultRef]).includes(selectedRef)) throw new Error(`Ref is not allowlisted for ${project}: ${selectedRef}`);
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

export async function refreshCodebase(project: string, ref?: string): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(project);
  const selectedRef = ref ?? config.defaultRef;
  if (!(config.allowedRefs ?? [config.defaultRef]).includes(selectedRef)) throw new Error(`Ref is not allowlisted for ${project}: ${selectedRef}`);

  return await withDirectoryLock(lockDir(project), async () => {
    const previous = await readProjectState(project);
    await ensureMirror(project);
    await fetchMirror(project);
    const fetchAt = new Date().toISOString();
    const sha = await resolveRef(project, selectedRef);
    if (previous.selectedSha === sha && previous.selectedCbmProject) {
      const status = await cbmCall('index_status', { project: previous.selectedCbmProject });
      if (isHealthyIndexResult(status)) {
        return {
          project,
          ref: selectedRef,
          changed: false,
          upstreamSha: sha,
          checkoutSha: sha,
          indexedSha: sha,
          indexStatus: status,
        };
      }
      // A selected generation can become unusable if its derived cache is damaged.
      // Re-index the same immutable checkout into a new generation rather than mutating the selected one in place.
    }

    const worktree = await materializeGeneration(project, sha);
    const generation = makeGenerationId(sha);
    const internalProject = `${internalProjectPrefix(project)}${generation}`;
    let indexResult: unknown;
    try {
      indexResult = await cbmCall('index_repository', {
        repo_path: worktree,
        mode: 'full',
        name: internalProject,
        persistence: false,
      }, { timeoutMs: Number(process.env.DEVINT_INDEX_TIMEOUT_MS ?? 20 * 60_000), env: { CBM_ALLOWED_ROOT: generationsDir(project) } });

      if (!isHealthyIndexResult(indexResult)) {
        throw new Error(`Codebase Memory did not produce a healthy index for ${project}@${sha}: ${JSON.stringify(indexResult).slice(0, 1000)}`);
      }
      const indexStatus = await cbmCall('index_status', { project: internalProject });
      if (!isHealthyIndexResult(indexStatus)) {
        throw new Error(`Codebase Memory status is not healthy for ${project}@${sha}: ${JSON.stringify(indexStatus).slice(0, 1000)}`);
      }

      const changedFiles = await changedFileCount(project, previous.selectedSha, sha);
      const now = new Date().toISOString();
      const record: ProjectGeneration = { generation, sha, worktree, cbmProject: internalProject, indexedAt: now };
      const next: ProjectState = {
        project,
        repository: config.repository,
        ref: selectedRef,
        selectedSha: sha,
        selectedGeneration: generation,
        selectedWorktree: worktree,
        selectedCbmProject: internalProject,
        indexedAt: now,
        refreshedAt: now,
        lastFetchAt: fetchAt,
        lastError: null,
        generations: [record, ...(previous.generations ?? []).filter(item => item.cbmProject !== internalProject && item.generation !== generation)],
      };
      const pruned = await pruneGenerations(project, next);
      await atomicWriteJson(stateFile(project), pruned);
      return {
        project,
        ref: selectedRef,
        changed: previous.selectedSha !== sha,
        reindexed: previous.selectedSha === sha,
        previousSha: previous.selectedSha,
        upstreamSha: sha,
        checkoutSha: sha,
        indexedSha: sha,
        changedFileCount: changedFiles,
        indexResult,
        indexStatus,
      };
    } catch (error) {
      await deleteCbmProject(internalProject);
      if (worktree !== previous.selectedWorktree) {
        try { await runChecked('git', ['--git-dir', mirrorDir(project), 'worktree', 'remove', '--force', worktree], { timeoutMs: 60_000 }); }
        catch { await fs.rm(worktree, { recursive: true, force: true }); }
        try { await runChecked('git', ['--git-dir', mirrorDir(project), 'worktree', 'prune']); } catch { /* best effort */ }
      }
      throw error;
    }
  });
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
      indexedAt: state.indexedAt,
      hasCodebaseIndex: Boolean(state.selectedCbmProject),
    };
  }));
}

export async function removeDerivedProjectState(project: string): Promise<Record<string, unknown>> {
  // Delete every internal generation rather than only the selected one.
  const prefix = internalProjectPrefix(project);
  const state = await readProjectState(project);
  const known = new Set((state.generations ?? []).map(item => item.cbmProject));
  if (state.selectedCbmProject) known.add(state.selectedCbmProject);
  try {
    const listed = await cbmCall('list_projects', {});
    for (const name of extractCbmProjectNames(listed)) if (name.startsWith(prefix)) known.add(name);
  } catch { /* best effort */ }
  for (const name of known) await deleteCbmProject(name);
  await fs.rm(projectDataDir(project), { recursive: true, force: true });
  return { project, deletedDerivedState: true, deletedCodebaseGenerations: known.size };
}
