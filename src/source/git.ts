import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectConfig, loadRegistry } from '../config/registry.js';
import type { ProjectConfig } from '../types.js';
import { runChecked } from '../util/process.js';
import { gitAuth } from './gitAuth.js';

export interface ProjectRevision {
  project: string;
  repository: string;
  ref: string;
  sha: string;
}

function assertAllowedRef(project: string, config: ProjectConfig, ref: string): void {
  const allowed = config.allowedRefs?.length ? config.allowedRefs : [config.defaultRef];
  if (!allowed.includes(ref)) throw new Error(`Ref is not allowlisted for ${project}: ${ref}`);
}

export async function resolveProjectRevision(project: string, ref?: string): Promise<ProjectRevision> {
  const config = await getProjectConfig(project);
  const selectedRef = ref ?? config.defaultRef;
  assertAllowedRef(project, config, selectedRef);
  const auth = await gitAuth(config);
  try {
    const result = await runChecked('git', ['ls-remote', config.repository, selectedRef], { env: auth.env, timeoutMs: 60_000 });
    const sha = result.stdout.trim().split(/\s+/)[0];
    if (!sha) throw new Error(`No revision returned for ${selectedRef}`);
    return { project, repository: config.repository, ref: selectedRef, sha };
  } finally {
    await auth.cleanup();
  }
}

export async function upstreamStatus(project: string, ref?: string): Promise<{ ref: string; upstreamSha: string | null; error?: string }> {
  try {
    const revision = await resolveProjectRevision(project, ref);
    return { ref: revision.ref, upstreamSha: revision.sha };
  } catch (error) {
    const config = await getProjectConfig(project);
    return { ref: ref ?? config.defaultRef, upstreamSha: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function withProjectCheckout<T>(
  project: string,
  ref: string | undefined,
  fn: (input: ProjectRevision & { root: string }) => Promise<T>,
): Promise<T> {
  const config = await getProjectConfig(project);
  const revision = await resolveProjectRevision(project, ref);
  const scratchRoot = path.resolve(process.env.DEVINT_SCRATCH_DIR ?? os.tmpdir());
  await fs.mkdir(scratchRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratchRoot, `devint-${project.replace(/[^a-zA-Z0-9._-]+/g, '-')}-`));
  const auth = await gitAuth(config);
  try {
    await runChecked('git', ['init', '--initial-branch=devint', root], { timeoutMs: 60_000 });
    await runChecked('git', ['-C', root, 'remote', 'add', 'origin', config.repository]);
    await runChecked('git', ['-C', root, 'fetch', '--depth=1', 'origin', revision.ref], { env: auth.env, timeoutMs: 5 * 60_000 });
    const fetched = (await runChecked('git', ['-C', root, 'rev-parse', 'FETCH_HEAD'])).stdout.trim();
    if (fetched !== revision.sha) throw new Error(`Repository ref moved while reading ${project}: expected ${revision.sha}, fetched ${fetched}`);
    await runChecked('git', ['-C', root, 'checkout', '--detach', fetched], { timeoutMs: 2 * 60_000 });
    return await fn({ ...revision, root });
  } finally {
    await auth.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function listPublicProjects(): Promise<Array<Record<string, unknown>>> {
  const registry = await loadRegistry();
  return Object.entries(registry).sort(([a], [b]) => a.localeCompare(b)).map(([project, config]) => ({
    project,
    repository: config.repository,
    defaultRef: config.defaultRef,
    allowedRefs: config.allowedRefs ?? [config.defaultRef],
  }));
}
