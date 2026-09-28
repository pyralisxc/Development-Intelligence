import { loadCanonicalGraph } from './canonicalStore.js';
import { authorizedInstallationPortfolio } from './installationPortfolio.js';
import { inspectGithubRepositoryPathAtDefaultBranch } from '../source/repositoryCredential.js';

const LEGACY_AUTHORITY_PATH = '.development-intelligence';

export interface SemanticAuthorityPortfolioAuditOptions {
  owners?: string[];
  repositories?: string[];
  includeArchived?: boolean;
  limit?: number;
}

export type SemanticAuthorityMigrationState = 'clean' | 'ready-to-remove' | 'blocked' | 'skipped' | 'error';

export function classifySemanticAuthorityMigration(input: {
  repositoryEntryCount: number;
  canonicalDurable: boolean;
  canonicalLoadState: string;
  acceptedPresent: boolean;
  acceptedCurrent: boolean;
}): SemanticAuthorityMigrationState {
  if (input.repositoryEntryCount === 0) return 'clean';
  return input.canonicalDurable
    && input.canonicalLoadState === 'hit'
    && input.acceptedPresent
    && input.acceptedCurrent
    ? 'ready-to-remove'
    : 'blocked';
}

export async function auditSemanticAuthorityPortfolio(
  options: SemanticAuthorityPortfolioAuditOptions = {},
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 250);
  const portfolio = await authorizedInstallationPortfolio({
    ...(options.owners?.length ? { owners: options.owners } : {}),
    ...(options.repositories?.length ? { repositories: options.repositories } : {}),
  });
  const items: Array<Record<string, unknown>> = [];

  for (const repository of portfolio.selected.slice(0, limit)) {
    if ((repository.archived || repository.disabled) && options.includeArchived !== true) {
      items.push({
        project: repository.fullName,
        defaultBranch: repository.defaultBranch,
        state: 'skipped',
        reason: repository.disabled ? 'repository disabled' : 'repository archived',
      });
      continue;
    }

    try {
      const inspected = await inspectGithubRepositoryPathAtDefaultBranch(repository, LEGACY_AUTHORITY_PATH);
      const entries = inspected.entries;
      const hasManifest = entries.some(entry => entry.path === `${LEGACY_AUTHORITY_PATH}/manifest.json`);
      const shardCount = entries.filter(entry => /^\.development-intelligence\/graph\/[0-9a-f]\.ndjson$/u.test(entry.path)).length;
      let canonical = {
        durable: false,
        loadState: 'not-required',
        acceptedPresent: false,
        acceptedCurrent: false,
        acceptedRevision: null as string | null,
        acceptedNodes: 0,
        acceptedEdges: 0,
        error: null as string | null,
      };

      if (entries.length) {
        const loaded = await loadCanonicalGraph({
          project: repository.fullName,
          repository: `https://github.com/${repository.fullName}.git`,
          revision: inspected.revision,
        });
        canonical = {
          durable: loaded.diagnostics.durable,
          loadState: loaded.diagnostics.loadState,
          acceptedPresent: Boolean(loaded.record?.accepted),
          acceptedCurrent: loaded.record?.currentness.acceptedSemanticCurrent === true,
          acceptedRevision: loaded.record?.accepted?.repositoryRevision ?? null,
          acceptedNodes: loaded.record?.accepted?.nodes.length ?? 0,
          acceptedEdges: loaded.record?.accepted?.edges.length ?? 0,
          error: loaded.diagnostics.error ?? null,
        };
      }

      const state = classifySemanticAuthorityMigration({
        repositoryEntryCount: entries.length,
        canonicalDurable: canonical.durable,
        canonicalLoadState: canonical.loadState,
        acceptedPresent: canonical.acceptedPresent,
        acceptedCurrent: canonical.acceptedCurrent,
      });
      items.push({
        project: repository.fullName,
        defaultBranch: repository.defaultBranch,
        revision: inspected.revision,
        private: repository.private,
        fork: repository.fork,
        state,
        repositoryOwnedAuthority: {
          path: LEGACY_AUTHORITY_PATH,
          entryCount: entries.length,
          hasManifest,
          shardCount,
          paths: entries.map(entry => entry.path),
        },
        canonical,
        action: state === 'ready-to-remove'
          ? 'Repository-local semantic authority is redundant and may be removed through that repository\'s normal Preview-first workflow.'
          : state === 'blocked'
            ? 'Preserve repository-local authority until DI canonical accepted A is durable and current for this exact default revision.'
            : 'No repository-local machine semantic authority is present.',
      });
    } catch (error) {
      items.push({
        project: repository.fullName,
        defaultBranch: repository.defaultBranch,
        state: 'error',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const states: SemanticAuthorityMigrationState[] = ['clean', 'ready-to-remove', 'blocked', 'skipped', 'error'];
  const counts = Object.fromEntries(states.map(state => [state, items.filter(item => item.state === state).length]));
  return {
    owners: portfolio.owners,
    discoveredRepositories: portfolio.discovered.length,
    selectedRepositories: portfolio.selected.length,
    processedRepositories: items.length,
    truncated: portfolio.selected.length > limit,
    counts,
    items,
    readyForRepositoryAuthorityRetirement: counts.blocked === 0 && counts.error === 0 && !portfolio.selected.length
      ? true
      : counts.blocked === 0 && counts.error === 0 && portfolio.selected.length <= limit,
    policy: {
      readOnly: true,
      providerAuthority: 'github-app-installation',
      exactDefaultRevision: true,
      canonicalGraphMaterialization: false,
      repositoryMutation: false,
      semanticAcceptanceMutation: false,
      cleanupRequiresRepositoryPreviewWorkflow: true,
    },
  };
}
