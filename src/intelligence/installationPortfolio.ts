import { listAuthorizedGithubOwners } from '../config/registry.js';
import { listGithubInstallationRepositories, type GithubInstallationRepository } from '../source/repositoryCredential.js';

export interface InstallationPortfolioSelection {
  owners?: string[];
  repositories?: string[];
}

export interface AuthorizedInstallationPortfolio {
  owners: string[];
  discovered: GithubInstallationRepository[];
  selected: GithubInstallationRepository[];
}

export function selectedAuthorizedGithubOwners(requested: string[] | undefined): string[] {
  const allowed = listAuthorizedGithubOwners();
  if (!requested?.length) return allowed;
  const lookup = new Map(allowed.map(owner => [owner.toLowerCase(), owner]));
  return [...new Set(requested.map(owner => {
    const resolved = lookup.get(owner.trim().toLowerCase());
    if (!resolved) throw new Error(`GitHub owner is not authorized for portfolio inspection: ${owner}`);
    return resolved;
  }))].sort((a, b) => a.localeCompare(b));
}

function selectedRepository(repository: GithubInstallationRepository, requested: Set<string> | null): boolean {
  if (!requested) return true;
  return requested.has(repository.name.toLowerCase()) || requested.has(repository.fullName.toLowerCase());
}

export async function authorizedInstallationPortfolio(
  options: InstallationPortfolioSelection = {},
): Promise<AuthorizedInstallationPortfolio> {
  const owners = selectedAuthorizedGithubOwners(options.owners);
  const requested = options.repositories?.length
    ? new Set(options.repositories.map(value => value.trim().toLowerCase()).filter(Boolean))
    : null;
  const discovered: GithubInstallationRepository[] = [];
  for (const owner of owners) discovered.push(...await listGithubInstallationRepositories(owner));
  const selected = discovered
    .filter(repository => selectedRepository(repository, requested))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { owners, discovered, selected };
}
