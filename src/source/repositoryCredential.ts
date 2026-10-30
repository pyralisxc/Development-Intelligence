import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
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
const boundApps = new Map<string, { appId: string; privateKey: KeyObject; repositories: Set<string> }>();

/** Host adapters bind protected material in memory, never through graph/config output or child environment. */
export function bindGithubAppCredential(binding: string, appId: string, privateKey: KeyObject, repositories: string[]): () => void {
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(binding) || !/^[1-9][0-9]*$/u.test(appId) || !Number.isSafeInteger(Number(appId)) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !repositories.length) throw new Error('Invalid in-memory GitHub App binding');
  const material = { appId, privateKey, repositories: new Set(repositories.map(repository => {
    const selected = githubRepository(repository);
    return `${selected.owner}/${selected.name}`.toLowerCase();
  })) };
  boundApps.set(binding, material);
  appTokenCache.clear();
  return () => { if (boundApps.get(binding) === material) { boundApps.delete(binding); appTokenCache.clear(); } };
}

export interface GithubInstallationRepository {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  archived: boolean;
  disabled: boolean;
  private: boolean;
  fork: boolean;
  pushedAt: string | null;
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

function appJwt(appId: string, privateKey: string | KeyObject, now = new Date()): string {
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
  const signature = sign('RSA-SHA256', Buffer.from(input), typeof privateKey === 'string' ? createPrivateKey(normalizePrivateKey(privateKey)) : privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

async function githubJson<T>(url: string, init: RequestInit, bounded = false): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'development-intelligence',
      ...(init.headers ?? {}),
    },
    redirect: 'error',
    ...(bounded ? { signal: AbortSignal.timeout(10_000) } : {}),
  }).catch(error => { if (bounded) throw new Error('GitHub App credential request unavailable'); throw error; });
  if (!response.ok) {
    const requestId = bounded ? null : response.headers.get('x-github-request-id');
    throw new Error(`GitHub App credential request failed: HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}`);
  }
  if (!bounded) return await response.json() as T;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub App credential response unavailable');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > 64 * 1024) throw new Error('bounded'); chunks.push(item.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch { throw new Error('GitHub App credential response invalid or exceeds bounds'); }
  finally { await reader.cancel().catch(() => {}); }
}

async function githubAppCredential(config: ProjectConfig): Promise<ResolvedRepositoryCredential> {
  const credential = config.credential;
  if (!credential || (credential.type !== 'github-app-env' && credential.type !== 'github-app-bound')) throw new Error('Expected GitHub App credential');
  const bound = credential.type === 'github-app-bound' ? boundApps.get(credential.binding) : undefined;
  const appId = credential.type === 'github-app-env' ? process.env[credential.appIdEnv]?.trim() : bound?.appId;
  const privateKey = credential.type === 'github-app-env' ? process.env[credential.privateKeyEnv]?.trim() : bound?.privateKey;
  if (!appId || !privateKey) throw new Error('Configured GitHub App material is unavailable');

  const repository = githubRepository(config.repository);
  const repositoryKey = `${repository.owner}/${repository.name}`.toLowerCase();
  if (credential.type === 'github-app-bound' && !bound?.repositories.has(repositoryKey)) throw new Error('Repository is outside the in-memory GitHub App binding');
  const cacheKey = `${credential.type === 'github-app-bound' ? `bound:${credential.binding}:` : ''}${appId}:${repositoryKey}`;
  const username = credential.type === 'github-app-bound' ? 'x-access-token' : credential.username ?? 'x-access-token';
  const cached = appTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60_000) {
    return {
      token: cached.token,
      username,
      kind: 'github-app-installation',
      expiresAt: cached.expiresAt,
    };
  }

  const jwt = appJwt(appId, privateKey);
  const installation = await githubJson<{ id: number; account?: { login?: string } }>(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/installation`,
    { headers: { authorization: `Bearer ${jwt}` } },
    credential.type === 'github-app-bound',
  );
  if (!Number.isSafeInteger(installation.id) || installation.id < 1) {
    throw new Error(`GitHub returned an invalid installation for ${repository.owner}/${repository.name}`);
  }
  const account = installation.account?.login;
  if (account && account.toLowerCase() !== repository.owner.toLowerCase()) {
    if (credential.type === 'github-app-bound') throw new Error('GitHub App installation account does not match repository owner');
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
    credential.type === 'github-app-bound',
  );
  if (!tokenResponse.token || !tokenResponse.expires_at) {
    throw new Error('GitHub returned an invalid installation access token');
  }
  for (const [permission, level] of Object.entries(tokenResponse.permissions ?? {})) {
    if (level !== 'read') {
      if (credential.type === 'github-app-bound') throw new Error('GitHub App token received non-read permission');
      throw new Error(`Development Intelligence GitHub App token unexpectedly received non-read permission: ${permission}=${level}`);
    }
    if (credential.type === 'github-app-bound' && !['contents','metadata','pull_requests'].includes(permission)) throw new Error('GitHub App token received unexpected read permission');
  }

  const expiresAtMs = Date.parse(tokenResponse.expires_at);
  if (!Number.isFinite(expiresAtMs)) throw new Error('GitHub returned an invalid installation token expiry');
  if (credential.type === 'github-app-bound' && (typeof tokenResponse.token !== 'string' || typeof tokenResponse.expires_at !== 'string' || expiresAtMs <= Date.now() || expiresAtMs > Date.now()+65*60_000 || tokenResponse.permissions?.contents !== 'read' || tokenResponse.permissions?.pull_requests !== 'read')) throw new Error('Invalid bounded GitHub App installation token');
  if (credential.type === 'github-app-bound' && boundApps.get(credential.binding) !== bound) throw new Error('GitHub App binding changed during credential request');
  appTokenCache.set(cacheKey, {
    token: tokenResponse.token,
    expiresAt: tokenResponse.expires_at,
    expiresAtMs,
  });
  return {
    token: tokenResponse.token,
    username,
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
        pushed_at?: string | null;
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
      const pushedAtMs = typeof repository.pushed_at === 'string' ? Date.parse(repository.pushed_at) : Number.NaN;
      repositories.push({
        owner: repositoryOwner,
        name: repository.name,
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        archived: repository.archived === true,
        disabled: repository.disabled === true,
        private: repository.private === true,
        fork: repository.fork === true,
        pushedAt: Number.isFinite(pushedAtMs) ? new Date(pushedAtMs).toISOString() : null,
      });
    }
    if (batch.length < 100) break;
  }
  return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export interface GithubRepositoryPathEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule' | 'unknown';
  size: number | null;
  sha: string | null;
}

function safeRepositoryPath(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/gu, '');
  if (!normalized || normalized.split('/').some(segment => segment === '.' || segment === '..' || !segment)) {
    throw new Error('GitHub repository path must be a normalized repository-relative path');
  }
  return normalized;
}

export async function inspectGithubRepositoryPathAtRevision(
  repository: GithubInstallationRepository,
  relativePath: string,
  revision: string,
): Promise<{ revision: string; entries: GithubRepositoryPathEntry[] }> {
  const exactRevision = revision.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(exactRevision)) throw new Error('GitHub repository path inspection requires an exact 40-character Git revision');
  const credential = await githubOwnerCredential(repository.owner);
  const path = safeRepositoryPath(relativePath);
  const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/');
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${encodedPath}?ref=${encodeURIComponent(exactRevision)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'development-intelligence',
        authorization: `Bearer ${credential.token}`,
      },
      redirect: 'error',
    },
  );
  if (response.status === 404) return { revision: exactRevision, entries: [] };
  if (!response.ok) {
    const requestId = response.headers.get('x-github-request-id');
    throw new Error(`GitHub repository path inspection failed: HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}`);
  }
  const raw = await response.json() as unknown;
  const records = Array.isArray(raw) ? raw : [raw];
  const entries = records.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    if (typeof value.name !== 'string' || typeof value.path !== 'string') return [];
    const rawType = typeof value.type === 'string' ? value.type : 'unknown';
    const type: GithubRepositoryPathEntry['type'] =
      rawType === 'file' || rawType === 'dir' || rawType === 'symlink' || rawType === 'submodule'
        ? rawType
        : 'unknown';
    return [{
      name: value.name,
      path: value.path,
      type,
      size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : null,
      sha: typeof value.sha === 'string' ? value.sha : null,
    }];
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { revision: exactRevision, entries };
}

export async function inspectGithubRepositoryPathAtDefaultBranch(
  repository: GithubInstallationRepository,
  relativePath: string,
): Promise<{ revision: string; entries: GithubRepositoryPathEntry[] }> {
  const credential = await githubOwnerCredential(repository.owner);
  const branch = await githubJson<{ commit?: { sha?: string } }>(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/branches/${encodeURIComponent(repository.defaultBranch)}`,
    { headers: { authorization: `Bearer ${credential.token}` } },
  );
  const revision = branch.commit?.sha?.toLowerCase();
  if (!revision || !/^[0-9a-f]{40}$/u.test(revision)) throw new Error(`GitHub returned an invalid default-branch revision for ${repository.fullName}`);
  return await inspectGithubRepositoryPathAtRevision(repository, relativePath, revision);
}

export async function resolveRepositoryCredential(config: ProjectConfig): Promise<ResolvedRepositoryCredential | null> {
  const credential = config.credential ?? { type: 'none' as const };
  if (credential.type === 'none') return null;
  if (credential.type === 'github-app-env' || credential.type === 'github-app-bound') return await githubAppCredential(config);

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
