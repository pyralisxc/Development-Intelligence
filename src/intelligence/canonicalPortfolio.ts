import { clearGraphCache, graphStatus } from './service.js';
import { authorizedInstallationPortfolio } from './installationPortfolio.js';
import type { GithubInstallationRepository } from '../source/repositoryCredential.js';

export interface CanonicalPortfolioReconcileOptions {
  owners?: string[];
  repositories?: string[];
  includeArchived?: boolean;
  limit?: number;
  rotationEpochMs?: number;
  rotationIntervalMs?: number;
  recentActivityWindowMs?: number;
}

export function canonicalPortfolioRotationIndex(epochMs: number, candidateCount: number, intervalMs = 60_000): number {
  if (!Number.isFinite(epochMs) || epochMs < 0) throw new Error('rotation epoch must be a finite non-negative timestamp');
  if (!Number.isInteger(candidateCount) || candidateCount <= 0) throw new Error('rotation candidate count must be a positive integer');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('rotation interval must be positive');
  return Math.floor(epochMs / intervalMs) % candidateCount;
}

export function canonicalPortfolioRecentActivityCandidate(
  candidates: GithubInstallationRepository[],
  epochMs: number,
  windowMs = 5 * 60_000,
): GithubInstallationRepository | null {
  if (!Number.isFinite(epochMs) || epochMs < 0) throw new Error('recent activity epoch must be a finite non-negative timestamp');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('recent activity window must be positive');
  const threshold = epochMs - windowMs;
  const futureToleranceMs = 60_000;
  return candidates
    .flatMap(repository => {
      const pushedAtMs = repository.pushedAt ? Date.parse(repository.pushedAt) : Number.NaN;
      if (!Number.isFinite(pushedAtMs) || pushedAtMs < threshold || pushedAtMs > epochMs + futureToleranceMs) return [];
      return [{ repository, pushedAtMs }];
    })
    .sort((a, b) => b.pushedAtMs - a.pushedAtMs || a.repository.fullName.localeCompare(b.repository.fullName))
    [0]?.repository ?? null;
}

export interface CanonicalPortfolioReconcileItem {
  project: string;
  defaultBranch: string;
  revision?: string;
  outcome: 'hit' | 'stored' | 'not-configured' | 'error' | 'skipped';
  durationMs: number;
  persistence?: Record<string, unknown>;
  coldBuildMs?: number | null;
  reason?: string;
}

export async function reconcileCanonicalProject(repository: GithubInstallationRepository): Promise<CanonicalPortfolioReconcileItem> {
  const project = repository.fullName;
  const startedAt = Date.now();
  console.info(JSON.stringify({ event: 'canonical-reconcile-start', project, defaultBranch: repository.defaultBranch }));
  let item: CanonicalPortfolioReconcileItem;
  try {
    const status = await graphStatus(project) as any;
    const persistence = status?.observability?.persistence ?? {};
    const coldBuildMs = typeof status?.observability?.coldBuild?.totalMs === 'number'
      ? status.observability.coldBuild.totalMs
      : null;
    const outcome: CanonicalPortfolioReconcileItem['outcome'] =
      persistence.loadState === 'hit'
        ? 'hit'
        : persistence.saveState === 'stored'
          ? 'stored'
          : persistence.durable === false
            ? 'not-configured'
            : persistence.loadState === 'error' || persistence.saveState === 'error'
              ? 'error'
              : 'not-configured';
    item = {
      project,
      defaultBranch: repository.defaultBranch,
      revision: typeof status?.revision === 'string' ? status.revision : undefined,
      outcome,
      durationMs: Math.max(0, Date.now() - startedAt),
      persistence,
      coldBuildMs,
      ...(outcome === 'error' && typeof persistence.error === 'string' ? { reason: persistence.error } : {}),
    };
  } catch (error) {
    item = {
      project,
      defaultBranch: repository.defaultBranch,
      outcome: 'error',
      durationMs: Math.max(0, Date.now() - startedAt),
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearGraphCache(project);
  }
  console.info(JSON.stringify({
    event: 'canonical-reconcile-complete',
    project,
    outcome: item.outcome,
    durationMs: Math.max(0, Date.now() - startedAt),
    cacheEvicted: true,
  }));
  return item;
}

export type CanonicalProjectReconciler = (repository: GithubInstallationRepository) => Promise<CanonicalPortfolioReconcileItem>;

export async function reconcileCanonicalPortfolio(
  options: CanonicalPortfolioReconcileOptions = {},
  reconcileProject: CanonicalProjectReconciler = reconcileCanonicalProject,
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 250);
  const portfolio = await authorizedInstallationPortfolio({
    ...(options.owners?.length ? { owners: options.owners } : {}),
    ...(options.repositories?.length ? { repositories: options.repositories } : {}),
  });
  const owners = portfolio.owners;
  const discovered = portfolio.discovered;
  const candidates = portfolio.selected;
  const activeCandidates = options.includeArchived === true
    ? candidates
    : candidates.filter(repository => !repository.archived && !repository.disabled);
  const rotationRequested = options.rotationEpochMs !== undefined;
  const rotationIntervalMs = Math.max(1, Math.trunc(options.rotationIntervalMs ?? 60_000));
  const rotationIndex = rotationRequested && activeCandidates.length
    ? canonicalPortfolioRotationIndex(options.rotationEpochMs!, activeCandidates.length, rotationIntervalMs)
    : null;
  const recentActivityWindowMs = Math.max(1, Math.trunc(options.recentActivityWindowMs ?? rotationIntervalMs));
  const recentActivityCandidate = rotationRequested && activeCandidates.length
    ? canonicalPortfolioRecentActivityCandidate(activeCandidates, options.rotationEpochMs!, recentActivityWindowMs)
    : null;
  const selectedCandidates = rotationIndex === null
    ? candidates.slice(0, limit)
    : [recentActivityCandidate ?? activeCandidates[rotationIndex]!];

  const items: CanonicalPortfolioReconcileItem[] = [];
  for (const repository of selectedCandidates) {
    const project = repository.fullName;
    if ((repository.archived || repository.disabled) && options.includeArchived !== true) {
      items.push({
        project,
        defaultBranch: repository.defaultBranch,
        outcome: 'skipped',
        durationMs: 0,
        reason: repository.disabled ? 'repository disabled' : 'repository archived',
      });
      continue;
    }
    items.push(await reconcileProject(repository));
  }

  const counts = Object.fromEntries(['hit', 'stored', 'not-configured', 'error', 'skipped'].map(outcome => [
    outcome,
    items.filter(item => item.outcome === outcome).length,
  ]));

  return {
    owners,
    discoveredRepositories: discovered.length,
    selectedRepositories: candidates.length,
    processedRepositories: items.length,
    truncated: rotationRequested ? activeCandidates.length > items.length : candidates.length > limit,
    counts,
    items,
    policy: {
      sourceAuthority: 'github',
      derivedState: 'canonical-current-graph',
      sequential: true,
      cacheEviction: 'per-repository',
      selection: rotationRequested
        ? recentActivityCandidate ? 'recent-provider-activity' : 'rotating-single-repository'
        : 'bounded-prefix',
      ...(rotationRequested ? {
        rotationIndex,
        rotationSize: activeCandidates.length,
        rotationIntervalMs,
        recentActivityWindowMs,
        recentActivityProject: recentActivityCandidate?.fullName ?? null,
        recentActivityPushedAt: recentActivityCandidate?.pushedAt ?? null,
        providerActivityIsHintOnly: true,
        canonicalRevisionAlwaysReresolved: true,
      } : {}),
      historicalRevisionsPersisted: false,
    },
  };
}
