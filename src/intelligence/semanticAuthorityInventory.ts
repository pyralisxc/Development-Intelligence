import { listAuthorizedGithubOwners } from '../config/registry.js';
import {
  inspectGithubInstallationRepositoryTree,
  listGithubInstallationRepositories,
  type GithubInstallationRepository,
} from '../source/repositoryCredential.js';

export interface SemanticAuthorityInventoryOptions {
  owners?: string[];
  repositories?: string[];
  includeArchived?: boolean;
  offset?: number;
  limit?: number;
}

type InventoryStatus =
  | 'repository-authority'
  | 'legacy-candidate'
  | 'clean'
  | 'incomplete'
  | 'di-self-metadata'
  | 'skipped'
  | 'error';

const CHECKPOINT_PREFIX = '.development-intelligence/';
const DI_SELF_REPOSITORY = 'development-intelligence';

function selectedOwners(requested: string[] | undefined): string[] {
  const allowed = listAuthorizedGithubOwners();
  if (!requested?.length) return allowed;
  const lookup = new Map(allowed.map(owner => [owner.toLowerCase(), owner]));
  return [...new Set(requested.map(owner => {
    const resolved = lookup.get(owner.trim().toLowerCase());
    if (!resolved) throw new Error(`GitHub owner is not authorized for semantic-authority inventory: ${owner}`);
    return resolved;
  }))].sort((a, b) => a.localeCompare(b));
}

function selectedRepository(repository: GithubInstallationRepository, requested: Set<string> | null): boolean {
  if (!requested) return true;
  return requested.has(repository.name.toLowerCase()) || requested.has(repository.fullName.toLowerCase());
}

function isCheckpointPath(path: string): boolean {
  return path === '.development-intelligence' || path.startsWith(CHECKPOINT_PREFIX);
}

function isLegacySemanticCandidate(path: string): boolean {
  if (isCheckpointPath(path)) return false;
  return path.split('/').some(segment => {
    const normalized = segment.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
    return /^semantic-(?:meaning|meanings|authority|graph|checkpoint)(?:-|$)/u.test(normalized);
  });
}

function migrationNote(status: InventoryStatus, complete: boolean): string {
  if (status === 'di-self-metadata') return 'Development Intelligence self-metadata is reported separately and is not treated as product-repository migration authority.';
  if (status === 'repository-authority') return complete
    ? 'Repository-owned Development Intelligence checkpoint material exists and must be migrated/verified before repository cleanup.'
    : 'Repository-owned checkpoint material exists, but the provider tree is truncated; migration is required and the inventory is not exhaustive.';
  if (status === 'legacy-candidate') return complete
    ? 'Legacy semantic-authority candidate paths require content inspection before any migration or deletion decision.'
    : 'Legacy semantic-authority candidate paths were observed, but the provider tree is truncated; additional candidates may exist.';
  if (status === 'clean') return 'No high-confidence repository semantic-authority paths were observed on the complete exact default-branch tree.';
  if (status === 'incomplete') return 'The provider tree was truncated, so absence cannot be used as proof that repository-local semantic authority does not exist.';
  if (status === 'skipped') return 'Archived/disabled repository was not inspected under the current inventory policy.';
  return 'Repository inventory failed; no absence or migration conclusion is supported.';
}

export async function inventorySemanticAuthority(
  options: SemanticAuthorityInventoryOptions = {},
): Promise<Record<string, unknown>> {
  const owners = selectedOwners(options.owners);
  const requested = options.repositories?.length
    ? new Set(options.repositories.map(value => value.trim().toLowerCase()).filter(Boolean))
    : null;
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);

  const discovered: GithubInstallationRepository[] = [];
  for (const owner of owners) discovered.push(...await listGithubInstallationRepositories(owner));
  const selected = discovered
    .filter(repository => selectedRepository(repository, requested))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  const page = selected.slice(offset, offset + limit);

  const items: Array<Record<string, unknown>> = [];
  for (const repository of page) {
    const project = repository.fullName;
    if ((repository.archived || repository.disabled) && options.includeArchived !== true) {
      items.push({
        project,
        defaultBranch: repository.defaultBranch,
        status: 'skipped',
        coverageComplete: false,
        repositoryAuthorityPaths: [],
        legacyCandidatePaths: [],
        migrationRequired: false,
        deletionAuthorized: false,
        note: migrationNote('skipped', false),
        reason: repository.disabled ? 'repository disabled' : 'repository archived',
      });
      continue;
    }

    try {
      const tree = await inspectGithubInstallationRepositoryTree(repository);
      const paths = tree.entries.map(entry => entry.path);
      const repositoryAuthorityPaths = paths.filter(isCheckpointPath);
      const legacyCandidatePaths = paths.filter(isLegacySemanticCandidate);
      const selfMetadata = repository.name.toLowerCase() === DI_SELF_REPOSITORY;
      const coverageComplete = !tree.truncated;
      let status: InventoryStatus;
      if (selfMetadata && repositoryAuthorityPaths.length) status = 'di-self-metadata';
      else if (repositoryAuthorityPaths.length) status = 'repository-authority';
      else if (legacyCandidatePaths.length) status = 'legacy-candidate';
      else status = coverageComplete ? 'clean' : 'incomplete';

      items.push({
        project,
        defaultBranch: repository.defaultBranch,
        revision: tree.revision,
        treeSha: tree.treeSha,
        status,
        coverageComplete,
        treeTruncated: tree.truncated,
        repositoryAuthorityPaths,
        legacyCandidatePaths,
        migrationRequired: !selfMetadata && (repositoryAuthorityPaths.length > 0 || legacyCandidatePaths.length > 0),
        deletionAuthorized: false,
        note: migrationNote(status, coverageComplete),
      });
    } catch (error) {
      items.push({
        project,
        defaultBranch: repository.defaultBranch,
        status: 'error',
        coverageComplete: false,
        repositoryAuthorityPaths: [],
        legacyCandidatePaths: [],
        migrationRequired: false,
        deletionAuthorized: false,
        note: migrationNote('error', false),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const statuses: InventoryStatus[] = [
    'repository-authority',
    'legacy-candidate',
    'clean',
    'incomplete',
    'di-self-metadata',
    'skipped',
    'error',
  ];
  const counts = Object.fromEntries(statuses.map(status => [
    status,
    items.filter(item => item.status === status).length,
  ]));
  const migrationRequired = items.filter(item => item.migrationRequired === true).length;
  const complete = offset === 0
    && page.length === selected.length
    && items.every(item => item.status !== 'error' && item.status !== 'incomplete' && item.status !== 'skipped' && item.coverageComplete === true);

  return {
    owners,
    discoveredRepositories: discovered.length,
    selectedRepositories: selected.length,
    offset,
    limit,
    processedRepositories: items.length,
    truncated: offset + page.length < selected.length,
    nextOffset: offset + page.length < selected.length ? offset + page.length : null,
    complete,
    migrationRequired,
    counts,
    items,
    policy: {
      providerAuthority: 'github-app-installation',
      revisionBinding: 'exact-default-branch-commit',
      readOnly: true,
      deletionAuthorized: false,
      absenceRequiresCompleteTree: true,
      diSelfMetadataSeparated: true,
      repositoryDocsAreNotSemanticAuthorityByNameAlone: true,
    },
  };
}
