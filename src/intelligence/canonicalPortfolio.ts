import { listAuthorizedGithubOwners } from '../config/registry.js';
import { listGithubInstallationRepositories, type GithubInstallationRepository } from '../source/repositoryCredential.js';
import { graphStatus } from './service.js';

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

function selectedOwners(requested: string[] | undefined): string[] {
  const allowed = listAuthorizedGithubOwners();
  if (!requested?.length) return allowed;
  const lookup = new Map(allowed.map(owner => [owner.toLowerCase(), owner]));
  return [...new Set(requested.map(owner => {
    const resolved = lookup.get(owner.toLowerCase());
    if (!resolved) throw new Error(`GitHub owner is not authorized for canonical reconciliation: ${owner}`);
    return resolved;
  }))].sort((a, b) => a.localeCompare(b));
}

function selectedRepository(repository: GithubInstallationRepository, requested: Set<string> | null): boolean {
  if (!requested) return true;
  return requested.has(repository.name.toLowerCase()) || requested.has(repository.fullName.toLowerCase());
}

export async function reconcileCanonicalPortfolio(options: CanonicalPortfolioReconcileOptions = {}): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 250);
  const owners = selectedOwners(options.owners);
  const requested = options.repositories?.length
    ? new Set(options.repositories.map(value => value.trim().toLowerCase()).filter(Boolean))
    : null;

  const discovered: GithubInstallationRepository[] = [];
  for (const owner of owners) discovered.push(...await listGithubInstallationRepositories(owner));

  const candidates = discovered
    .filter(repository => selectedRepository(repository, requested))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

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
      historicalRevisionsPersisted: false,
    },
  };
}
