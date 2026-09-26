import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectConfig, loadRegistry } from '../config/registry.js';
import type { ProjectConfig } from '../types.js';
import { runChecked } from '../util/process.js';
import { gitAuth } from './gitAuth.js';
import { resolveRepositoryCredential } from './repositoryCredential.js';

export interface ProjectRevision {
  project: string;
  repository: string;
  ref: string;
  selectorKind: RevisionSelectorKind;
  resolvedRef: string;
  sha: string;
  pullRequest?: PullRequestRevision;
}

export type RevisionSelectorKind = 'default' | 'git-ref' | 'commit' | 'branch' | 'tag' | 'pr-head' | 'pr-base' | 'pr-result';

export interface PullRequestRevision {
  number: number;
  state: string;
  merged: boolean;
  baseSha: string;
  headSha: string;
  mergeCommitSha: string | null;
}

export interface ParsedRevisionSelector {
  input: string;
  kind: RevisionSelectorKind;
  value: string;
  pullRequestNumber?: number;
}

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const GIT_NAME_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\]/;

function assertGitName(value: string, label: string): void {
  const components = value.split('/');
  if (!value || value === '@' || (label === 'branch' && value.startsWith('-')) || value.endsWith('.')
    || components.some(component => !component || component.startsWith('.') || /\.lock$/i.test(component))
    || value.includes('..') || value.includes('@{') || GIT_NAME_FORBIDDEN.test(value)) {
    throw new Error(`Invalid ${label} revision selector: ${value}`);
  }
}

export function parseRevisionSelector(ref: string, defaultRef = 'HEAD'): ParsedRevisionSelector {
  const input = ref.trim();
  if (!input) throw new Error('Revision selector must be non-empty');
  if (input === defaultRef) return { input, kind: 'default', value: input };
  if (input.startsWith('commit:')) {
    const value = input.slice('commit:'.length);
    if (!FULL_SHA.test(value)) throw new Error('commit revision selectors require a full hexadecimal Git object id');
    return { input, kind: 'commit', value: value.toLowerCase() };
  }
  if (input.startsWith('branch:')) {
    const value = input.slice('branch:'.length);
    assertGitName(value, 'branch');
    return { input, kind: 'branch', value };
  }
  if (input.startsWith('tag:')) {
    const value = input.slice('tag:'.length);
    assertGitName(value, 'tag');
    return { input, kind: 'tag', value };
  }
  const pullRequest = /^pr:([1-9][0-9]*)\/(head|base|result)$/.exec(input);
  if (pullRequest) {
    const number = Number(pullRequest[1]);
    if (!Number.isSafeInteger(number)) throw new Error(`Invalid pull request revision selector: ${input}`);
    const state = pullRequest[2] as 'head' | 'base' | 'result';
    return { input, kind: `pr-${state}` as RevisionSelectorKind, value: state, pullRequestNumber: number };
  }
  return { input, kind: 'git-ref', value: input };
}

function assertAllowedRef(project: string, config: ProjectConfig, parsed: ParsedRevisionSelector): void {
  const allowed = config.allowedRefs?.length ? config.allowedRefs : [config.defaultRef];
  if (allowed.includes(parsed.input)) return;
  if (config.revisionPolicy === 'repository-history' && parsed.kind !== 'git-ref' && parsed.kind !== 'default') return;
  throw new Error(`Revision selector is not allowed for ${project}: ${parsed.input}`);
}

async function lsRemote(config: ProjectConfig, patterns: string[]): Promise<Array<{ sha: string; ref: string }>> {
  const auth = await gitAuth(config);
  try {
    const result = await runChecked('git', ['ls-remote', config.repository, ...patterns], { env: auth.env, timeoutMs: 60_000 });
    return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [sha, ref] = line.trim().split(/\s+/, 2);
      if (!sha || !ref) throw new Error(`Malformed git ls-remote response for ${config.repository}`);
      return { sha, ref };
    });
  } finally {
    await auth.cleanup();
  }
}

function githubRepository(repository: string): { owner: string; name: string } | null {
  try {
    const url = new URL(repository);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
    const segments = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
    return { owner: segments[0], name: segments[1] };
  } catch {
    return null;
  }
}

async function githubPullRequest(config: ProjectConfig, number: number): Promise<PullRequestRevision> {
  const repository = githubRepository(config.repository);
  if (!repository) throw new Error('Pull request revision selectors require a github.com HTTPS repository');
  const resolved = await resolveRepositoryCredential(config);
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'development-intelligence',
      ...(resolved ? { authorization: `Bearer ${resolved.token}` } : {}),
    },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub could not resolve pull request #${number} for ${repository.owner}/${repository.name}: HTTP ${response.status}`);
  const body = await response.json() as any;
  const baseSha = typeof body?.base?.sha === 'string' ? body.base.sha : '';
  const headSha = typeof body?.head?.sha === 'string' ? body.head.sha : '';
  const mergeCommitSha = typeof body?.merge_commit_sha === 'string' ? body.merge_commit_sha : null;
  if (!FULL_SHA.test(baseSha) || !FULL_SHA.test(headSha) || (mergeCommitSha && !FULL_SHA.test(mergeCommitSha))) {
    throw new Error(`GitHub returned invalid revision identity for pull request #${number}`);
  }
  return {
    number,
    state: typeof body.state === 'string' ? body.state : 'unknown',
    merged: Boolean(body.merged_at),
    baseSha: baseSha.toLowerCase(),
    headSha: headSha.toLowerCase(),
    mergeCommitSha: mergeCommitSha?.toLowerCase() ?? null,
  };
}

export function revisionIdentity(revision: ProjectRevision): Record<string, unknown> {
  return {
    selector: revision.ref,
    kind: revision.selectorKind,
    resolvedRef: revision.resolvedRef,
    sha: revision.sha,
    ...(revision.pullRequest ? { pullRequest: revision.pullRequest } : {}),
  };
}

export async function resolveProjectRevision(project: string, ref?: string): Promise<ProjectRevision> {
  const config = await getProjectConfig(project);
  const selectedRef = ref ?? config.defaultRef;
  const parsed = parseRevisionSelector(selectedRef, config.defaultRef);
  assertAllowedRef(project, config, parsed);

  if (parsed.kind === 'commit') {
    return { project, repository: config.repository, ref: selectedRef, selectorKind: parsed.kind, resolvedRef: parsed.value, sha: parsed.value };
  }

  if (parsed.kind.startsWith('pr-')) {
    const pullRequest = await githubPullRequest(config, parsed.pullRequestNumber!);
    let sha = pullRequest.headSha;
    if (parsed.kind === 'pr-base') sha = pullRequest.baseSha;
    if (parsed.kind === 'pr-result') {
      if (!pullRequest.merged || !pullRequest.mergeCommitSha) throw new Error(`Pull request #${pullRequest.number} has no accepted result; use pr:${pullRequest.number}/head or pr:${pullRequest.number}/base`);
      sha = pullRequest.mergeCommitSha;
    }
    return { project, repository: config.repository, ref: selectedRef, selectorKind: parsed.kind, resolvedRef: sha, sha, pullRequest };
  }

  const lookup = parsed.kind === 'branch' ? `refs/heads/${parsed.value}` : parsed.kind === 'tag' ? `refs/tags/${parsed.value}` : parsed.value;
  const patterns = parsed.kind === 'tag' ? [lookup, `${lookup}^{}`] : [lookup];
  const matches = await lsRemote(config, patterns);
  const match = parsed.kind === 'tag' ? matches.find(item => item.ref === `${lookup}^{}`) ?? matches.find(item => item.ref === lookup) : matches[0];
  if (!match?.sha || !FULL_SHA.test(match.sha)) throw new Error(`No revision returned for ${selectedRef}`);
  return { project, repository: config.repository, ref: selectedRef, selectorKind: parsed.kind, resolvedRef: match.ref, sha: match.sha.toLowerCase() };
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

export interface RepositoryChangedFile {
  status: string;
  path: string;
  previousPath?: string;
}

export async function changedFilesBetweenRevisions(
  project: string,
  baseRef: string | undefined,
  headRef: string | undefined,
): Promise<{ base: ProjectRevision; head: ProjectRevision; files: RepositoryChangedFile[] }> {
  const [base, head] = await Promise.all([
    resolveProjectRevision(project, baseRef),
    resolveProjectRevision(project, headRef),
  ]);
  if (base.repository !== head.repository) throw new Error(`Repository changed while comparing ${project}`);
  const config = await getProjectConfig(project);
  const scratchRoot = path.resolve(process.env.DEVINT_SCRATCH_DIR ?? os.tmpdir());
  await fs.mkdir(scratchRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratchRoot, `devint-diff-${project.replace(/[^a-zA-Z0-9._-]+/g, '-')}-`));
  const auth = await gitAuth(config);
  try {
    await runChecked('git', ['init', '--initial-branch=devint', root], { timeoutMs: 60_000 });
    await runChecked('git', ['-C', root, 'remote', 'add', 'origin', config.repository]);
    for (const sha of new Set([base.sha, head.sha])) {
      await runChecked('git', ['-C', root, 'fetch', '--depth=1', 'origin', sha], { env: auth.env, timeoutMs: 5 * 60_000 });
    }
    const result = await runChecked('git', ['-C', root, 'diff', '--name-status', '-M', base.sha, head.sha, '--'], { timeoutMs: 2 * 60_000 });
    const files = result.stdout.trim()
      ? result.stdout.trim().split(/\r?\n/u).filter(Boolean).map(line => {
        const [status = '', first = '', second] = line.split('\t');
        if (!status || !first) throw new Error(`Malformed git diff name-status row: ${line}`);
        if (/^[RC]/u.test(status)) {
          if (!second) throw new Error(`Malformed git rename/copy row: ${line}`);
          return { status, previousPath: first, path: second };
        }
        return { status, path: first };
      })
      : [];
    return { base, head, files };
  } finally {
    await auth.cleanup();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export interface ProjectCheckoutTiming {
  setupMs: number;
  fetchMs: number;
  checkoutMs: number;
  bodyMs: number;
  cleanupMs: number;
  totalMs: number;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export async function withResolvedProjectCheckoutObserved<T>(
  revision: ProjectRevision,
  fn: (input: ProjectRevision & { root: string }) => Promise<T>,
): Promise<{ value: T; timing: ProjectCheckoutTiming }> {
  const totalStarted = Date.now();
  const setupStarted = Date.now();
  const config = await getProjectConfig(revision.project);
  if (config.repository !== revision.repository) throw new Error(`Repository configuration changed while reading ${revision.project}`);
  assertAllowedRef(revision.project, config, parseRevisionSelector(revision.ref, config.defaultRef));
  const scratchRoot = path.resolve(process.env.DEVINT_SCRATCH_DIR ?? os.tmpdir());
  await fs.mkdir(scratchRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratchRoot, `devint-${revision.project.replace(/[^a-zA-Z0-9._-]+/g, '-')}-`));
  const auth = await gitAuth(config);
  let setupMs = 0;
  let fetchMs = 0;
  let checkoutMs = 0;
  let bodyMs = 0;
  let cleanupMs = 0;
  let value!: T;
  try {
    await runChecked('git', ['init', '--initial-branch=devint', root], { timeoutMs: 60_000 });
    await runChecked('git', ['-C', root, 'remote', 'add', 'origin', config.repository]);
    setupMs = elapsedMs(setupStarted);

    const fetchStarted = Date.now();
    await runChecked('git', ['-C', root, 'fetch', '--depth=1', 'origin', revision.sha], { env: auth.env, timeoutMs: 5 * 60_000 });
    const fetched = (await runChecked('git', ['-C', root, 'rev-parse', 'FETCH_HEAD'])).stdout.trim();
    fetchMs = elapsedMs(fetchStarted);
    if (fetched !== revision.sha) throw new Error(`Repository revision changed while reading ${revision.project}: expected ${revision.sha}, fetched ${fetched}`);

    const checkoutStarted = Date.now();
    await runChecked('git', ['-C', root, 'checkout', '--detach', fetched], { timeoutMs: 2 * 60_000 });
    checkoutMs = elapsedMs(checkoutStarted);

    const bodyStarted = Date.now();
    value = await fn({ ...revision, root });
    bodyMs = elapsedMs(bodyStarted);
  } finally {
    const cleanupStarted = Date.now();
    await auth.cleanup();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    cleanupMs = elapsedMs(cleanupStarted);
  }
  return {
    value,
    timing: {
      setupMs,
      fetchMs,
      checkoutMs,
      bodyMs,
      cleanupMs,
      totalMs: elapsedMs(totalStarted),
    },
  };
}

export async function withResolvedProjectCheckout<T>(
  revision: ProjectRevision,
  fn: (input: ProjectRevision & { root: string }) => Promise<T>,
): Promise<T> {
  return (await withResolvedProjectCheckoutObserved(revision, fn)).value;
}

export async function withProjectCheckout<T>(
  project: string,
  ref: string | undefined,
  fn: (input: ProjectRevision & { root: string }) => Promise<T>,
): Promise<T> {
  const revision = await resolveProjectRevision(project, ref);
  return await withResolvedProjectCheckout(revision, fn);
}

export async function listPublicProjects(): Promise<Array<Record<string, unknown>>> {
  const registry = await loadRegistry();
  return Object.entries(registry).sort(([a], [b]) => a.localeCompare(b)).map(([project, config]) => ({
    project,
    repository: config.repository,
    defaultRef: config.defaultRef,
    allowedRefs: config.allowedRefs ?? [config.defaultRef],
    revisionPolicy: config.revisionPolicy ?? 'allowlisted',
  }));
}
