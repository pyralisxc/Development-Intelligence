import { clearGraphCache, graphStatus } from './service.js';
import { authorizedInstallationPortfolio } from './installationPortfolio.js';

export interface CanonicalPortfolioReconcileOptions {
  owners?: string[];
  repositories?: string[];
  includeArchived?: boolean;
  limit?: number;
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

export async function reconcileCanonicalPortfolio(options: CanonicalPortfolioReconcileOptions = {}): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 250);
  const portfolio = await authorizedInstallationPortfolio({
    ...(options.owners?.length ? { owners: options.owners } : {}),
    ...(options.repositories?.length ? { repositories: options.repositories } : {}),
  });
  const owners = portfolio.owners;
  const discovered = portfolio.discovered;
  const candidates = portfolio.selected;

  const items: CanonicalPortfolioReconcileItem[] = [];
  for (const repository of candidates.slice(0, limit)) {
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

    const startedAt = Date.now();
    console.info(JSON.stringify({ event: 'canonical-reconcile-start', project, defaultBranch: repository.defaultBranch }));
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
      items.push({
        project,
        defaultBranch: repository.defaultBranch,
        revision: typeof status?.revision === 'string' ? status.revision : undefined,
        outcome,
        durationMs: Math.max(0, Date.now() - startedAt),
        persistence,
        coldBuildMs,
        ...(outcome === 'error' && typeof persistence.error === 'string' ? { reason: persistence.error } : {}),
      });
    } catch (error) {
      items.push({
        project,
        defaultBranch: repository.defaultBranch,
        outcome: 'error',
        durationMs: Math.max(0, Date.now() - startedAt),
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearGraphCache(project);
      const item = items.at(-1);
      console.info(JSON.stringify({
        event: 'canonical-reconcile-complete',
        project,
        outcome: item?.project === project ? item.outcome : 'unknown',
        durationMs: Math.max(0, Date.now() - startedAt),
        cacheEvicted: true,
      }));
    }
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
    truncated: candidates.length > limit,
    counts,
    items,
    policy: {
      sourceAuthority: 'github',
      derivedState: 'canonical-current-graph',
      sequential: true,
      cacheEviction: 'per-repository',
      historicalRevisionsPersisted: false,
    },
  };
}
