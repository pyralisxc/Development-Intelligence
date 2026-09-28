import { createPrivateKey, sign } from 'node:crypto';
import type { ProjectConfig } from '../types.js';

export interface ResolvedRepositoryCredential {
  token: string;
  username: string;
  kind: 'token-env' | 'github-app-installation';
  expiresAt?: string;
}

interface CachedAppToken {
  token: string;
  expiresAt: string;
  expiresAtMs: number;
}

const appTokenCache = new Map<string, CachedAppToken>();
const ownerAppTokenCache = new Map<string, CachedAppToken>();

export interface GithubInstallationRepository {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  archived: boolean;
  disabled: boolean;
  private: boolean;
  fork: boolean;
}

function githubRepository(repository: string): { owner: string; name: string } {
  const url = new URL(repository);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('github-app-env credentials require a github.com HTTPS repository');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error('github-app-env credentials require an owner/repository GitHub URL');
  }
  const rawName = segments[1];
  const name = rawName.toLowerCase().endsWith('.git') ? rawName.slice(0, -4) : rawName;
  if (!name) throw new Error('github-app-env credentials require a repository name');
  return { owner: segments[0], name };
}

function normalizePrivateKey(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function appJwt(appId: string, privateKey: string, now = new Date()): string {
  const numericAppId = Number(appId);
  if (!Number.isSafeInteger(numericAppId) || numericAppId < 1 || String(numericAppId) !== appId) {
    throw new Error('DEVINT_GITHUB_APP_ID must be a positive integer');
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: appId,
  }));
  const input = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), createPrivateKey(normalizePrivateKey(privateKey)));
  return `${input}.${signature.toString('base64url')}`;
}

async function githubJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'development-intelligence',
      ...(init.headers ?? {}),
    },
    redirect: 'error',
  });
  if (!response.ok) {
    const requestId = response.headers.get('x-github-request-id');
    throw new Error(`GitHub App credential request failed: HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}`);
  }
  return await response.json() as T;
}

async function githubAppCredential(config: ProjectConfig): Promise<ResolvedRepositoryCredential> {
  const credential = config.credential;
  if (!credential || credential.type !== 'github-app-env') throw new Error('Expected github-app-env credential');
  const appId = process.env[credential.appIdEnv]?.trim();
  const privateKey = process.env[credential.privateKeyEnv]?.trim();
  if (!appId) throw new Error(`Missing configured GitHub App ID environment variable: ${credential.appIdEnv}`);
  if (!privateKey) throw new Error(`Missing configured GitHub App private-key environment variable: ${credential.privateKeyEnv}`);

  const repository = githubRepository(config.repository);
  const cacheKey = `${appId}:${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`;
  const cached = appTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60_000) {
    return {
      token: cached.token,
      username: credential.username ?? 'x-access-token',
      kind: 'github-app-installation',
      expiresAt: cached.expiresAt,
    };
  }

  const jwt = appJwt(appId, privateKey);
  const installation = await githubJson<{ id: number; account?: { login?: string } }>(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/installation`,
    { headers: { authorization: `Bearer ${jwt}` } },
  );
  if (!Number.isSafeInteger(installation.id) || installation.id < 1) {
    throw new Error(`GitHub returned an invalid installation for ${repository.owner}/${repository.name}`);
  }
  const account = installation.account?.login;
  if (account && account.toLowerCase() !== repository.owner.toLowerCase()) {
    throw new Error(`GitHub App installation account ${account} does not match repository owner ${repository.owner}`);
  }

  const tokenResponse = await githubJson<{
    token: string;
    expires_at: string;
    permissions?: Record<string, string>;
  }>(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repositories: [repository.name],
        permissions: {
          contents: 'read',
          pull_requests: 'read',
        },
      }),
    },
  );
  if (!tokenResponse.token || !tokenResponse.expires_at) {
    throw new Error('GitHub returned an invalid installation access token');
  }
  for (const [permission, level] of Object.entries(tokenResponse.permissions ?? {})) {
    if (level !== 'read') {
      throw new Error(`Development Intelligence GitHub App token unexpectedly received non-read permission: ${permission}=${level}`);
    }
  }

  const expiresAtMs = Date.parse(tokenResponse.expires_at);
  if (!Number.isFinite(expiresAtMs)) throw new Error('GitHub returned an invalid installation token expiry');
  appTokenCache.set(cacheKey, {
    token: tokenResponse.token,
    expiresAt: tokenResponse.expires_at,
    expiresAtMs,
  });
  return {
    token: tokenResponse.token,
    username: credential.username ?? 'x-access-token',
    kind: 'github-app-installation',
    expiresAt: tokenResponse.expires_at,
  };
}


async function ownerInstallation(owner: string, jwt: string): Promise<{ id: number; account?: { login?: string } }> {
  for (const kind of ['users', 'orgs'] as const) {
    const response = await fetch(`https://api.github.com/${kind}/${encodeURIComponent(owner)}/installation`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'development-intelligence',
        authorization: `Bearer ${jwt}`,
      },
      redirect: 'error',
    });
    if (response.status === 404) continue;
    if (!response.ok) {
      const requestId = response.headers.get('x-github-request-id');
      throw new Error(`GitHub App owner installation request failed: HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}`);
    }
    return await response.json() as { id: number; account?: { login?: string } };
  }
  throw new Error(`GitHub App is not installed for authorized owner: ${owner}`);
}

async function githubOwnerCredential(owner: string): Promise<ResolvedRepositoryCredential> {
  const appId = process.env.DEVINT_GITHUB_APP_ID?.trim();
  const privateKey = process.env.DEVINT_GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) throw new Error('Portfolio repository discovery requires DEVINT_GITHUB_APP_ID and DEVINT_GITHUB_APP_PRIVATE_KEY');

  const cacheKey = `${appId}:owner:${owner.toLowerCase()}`;
  const cached = ownerAppTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60_000) {
    return { token: cached.token, username: 'x-access-token', kind: 'github-app-installation', expiresAt: cached.expiresAt };
  }

  const jwt = appJwt(appId, privateKey);
  const installation = await ownerInstallation(owner, jwt);
  if (!Number.isSafeInteger(installation.id) || installation.id < 1) throw new Error(`GitHub returned an invalid installation for owner ${owner}`);
  const account = installation.account?.login;
  if (account && account.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`GitHub App installation account ${account} does not match authorized owner ${owner}`);
  }

  const tokenResponse = await githubJson<{
    token: string;
    expires_at: string;
    permissions?: Record<string, string>;
  }>(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: { contents: 'read', pull_requests: 'read' } }),
    },
  );
  if (!tokenResponse.token || !tokenResponse.expires_at) throw new Error('GitHub returned an invalid owner installation access token');
  for (const [permission, level] of Object.entries(tokenResponse.permissions ?? {})) {
    if (level !== 'read') throw new Error(`Development Intelligence GitHub App token unexpectedly received non-read permission: ${permission}=${level}`);
  }
  const expiresAtMs = Date.parse(tokenResponse.expires_at);
  if (!Number.isFinite(expiresAtMs)) throw new Error('GitHub returned an invalid owner installation token expiry');
  ownerAppTokenCache.set(cacheKey, { token: tokenResponse.token, expiresAt: tokenResponse.expires_at, expiresAtMs });
  return { token: tokenResponse.token, username: 'x-access-token', kind: 'github-app-installation', expiresAt: tokenResponse.expires_at };
}

export async function listGithubInstallationRepositories(owner: string): Promise<GithubInstallationRepository[]> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)) throw new Error(`Invalid GitHub owner: ${owner}`);
  const credential = await githubOwnerCredential(owner);
  const repositories: GithubInstallationRepository[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await githubJson<{
      total_count?: number;
      repositories?: Array<{
        name?: string;
        full_name?: string;
        default_branch?: string;
        archived?: boolean;
        disabled?: boolean;
        private?: boolean;
        fork?: boolean;
        owner?: { login?: string };
      }>;
    }>(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${credential.token}` } },
    );
    const batch = Array.isArray(result.repositories) ? result.repositories : [];
    for (const repository of batch) {
      const repositoryOwner = repository.owner?.login;
      if (!repositoryOwner || repositoryOwner.toLowerCase() !== owner.toLowerCase()) continue;
      if (!repository.name || !repository.full_name || !repository.default_branch) continue;
      repositories.push({
        owner: repositoryOwner,
        name: repository.name,
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        archived: repository.archived === true,
        disabled: repository.disabled === true,
        private: repository.private === true,
        fork: repository.fork === true,
      });
    }
    if (batch.length < 100) break;
  }
  return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export interface GithubInstallationRepositoryTree {
  repository: string;
  defaultBranch: string;
  revision: string;
  treeSha: string;
  truncated: boolean;
  entries: Array<{ path: string; type: string; size?: number }>;
}

export async function inspectGithubInstallationRepositoryTree(
  repository: GithubInstallationRepository,
): Promise<GithubInstallationRepositoryTree> {
  const credential = await githubOwnerCredential(repository.owner);
  const owner = encodeURIComponent(repository.owner);
  const name = encodeURIComponent(repository.name);
  const ref = encodeURIComponent(repository.defaultBranch);
  const commit = await githubJson<{
    sha?: string;
    commit?: { tree?: { sha?: string } };
  }>(
    `https://api.github.com/repos/${owner}/${name}/commits/${ref}`,
    { headers: { authorization: `Bearer ${credential.token}` } },
  );
  const revision = commit.sha?.toLowerCase();
  const treeSha = commit.commit?.tree?.sha?.toLowerCase();
  if (!revision || !/^[0-9a-f]{40}$/u.test(revision) || !treeSha || !/^[0-9a-f]{40}$/u.test(treeSha)) {
    throw new Error(`GitHub returned an invalid default-branch commit/tree for ${repository.fullName}`);
  }

  const tree = await githubJson<{
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; size?: number }>;
  }>(
    `https://api.github.com/repos/${owner}/${name}/git/trees/${treeSha}?recursive=1`,
    { headers: { authorization: `Bearer ${credential.token}` } },
  );
  const entries = (Array.isArray(tree.tree) ? tree.tree : [])
    .filter(entry => typeof entry.path === 'string' && entry.path.length > 0 && typeof entry.type === 'string' && entry.type.length > 0)
    .map(entry => ({
      path: entry.path!,
      type: entry.type!,
      ...(typeof entry.size === 'number' && Number.isFinite(entry.size) ? { size: entry.size } : {}),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    repository: repository.fullName,
    defaultBranch: repository.defaultBranch,
    revision,
    treeSha,
    truncated: tree.truncated === true,
    entries,
  };
}

export async function resolveRepositoryCredential(config: ProjectConfig): Promise<ResolvedRepositoryCredential | null> {
  const credential = config.credential ?? { type: 'none' as const };
  if (credential.type === 'none') return null;
  if (credential.type === 'github-app-env') return await githubAppCredential(config);

  const token = process.env[credential.tokenEnv];
  if (!token) throw new Error(`Missing configured repository credential environment variable: ${credential.tokenEnv}`);
  return {
    token,
    username: credential.username ?? 'oauth2',
    kind: 'token-env',
  };
}

export function clearRepositoryCredentialCacheForTests(): void {
  appTokenCache.clear();
  ownerAppTokenCache.clear();
}
