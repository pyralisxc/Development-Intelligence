import { promises as fs } from 'node:fs';
import { projectsFile, safeSegment } from './paths.js';
import type { ProjectConfig, ProjectRegistry, RuntimeHeaderConfig } from '../types.js';

const GITHUB_PROJECT_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)$/;

export function listAuthorizedGithubOwners(): string[] {
  const raw = process.env.DEVINT_GITHUB_ALLOWED_OWNERS?.trim();
  if (!raw) return [];
  const owners = raw.split(',').map(value => value.trim()).filter(Boolean);
  const unique = new Map<string, string>();
  for (const owner of owners) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new Error(`Invalid GitHub owner in DEVINT_GITHUB_ALLOWED_OWNERS: ${owner}`);
    const key = owner.toLowerCase();
    if (!unique.has(key)) unique.set(key, owner);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}

function assertRepositoryUrl(value: string): void {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    const url = new URL(value);
    if (!['https:', 'ssh:', 'file:'].includes(url.protocol)) throw new Error(`Unsupported repository protocol: ${url.protocol}`);
    if (url.username || url.password) throw new Error('Repository URLs must not embed credentials');
    return;
  }
  if (!/^[^\s@]+@[^\s:]+:[^\s]+$/.test(value)) {
    throw new Error('Repository must be an HTTPS/SSH URL or scp-style SSH URL');
  }
}

function validateHeaders(name: string, headers: RuntimeHeaderConfig[] | undefined, label: string): void {
  if (!headers) return;
  const forbiddenHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
  for (const header of headers) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)) throw new Error(`${name}: invalid ${label} header name`);
    if (forbiddenHeaders.has(header.name.toLowerCase())) throw new Error(`${name}: ${label} header is transport-owned and cannot be configured: ${header.name}`);
    if (!header.valueEnv?.trim()) throw new Error(`${name}: ${label} header valueEnv is required`);
  }
}

function validateProject(name: string, config: ProjectConfig): ProjectConfig {
  if (!name.trim()) throw new Error('Project names must be non-empty');
  assertRepositoryUrl(config.repository);
  if (config.credential && config.credential.type !== 'none' && !config.repository.startsWith('https://')) {
    throw new Error(`${name}: configured repository credentials require an HTTPS repository URL; use host SSH credentials with credential.type=none for SSH repositories`);
  }
  if (config.credential?.type === 'github-app-env') {
    for (const [label, value] of [['appIdEnv', config.credential.appIdEnv], ['privateKeyEnv', config.credential.privateKeyEnv]] as const) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${name}: github-app-env ${label} must name an environment variable`);
    }
  }
  if (!config.defaultRef?.trim()) throw new Error(`${name}: defaultRef is required`);
  const revisionPolicy = config.revisionPolicy ?? 'allowlisted';
  if (!['allowlisted', 'repository-history'].includes(revisionPolicy)) throw new Error(`${name}: unsupported revisionPolicy: ${String(config.revisionPolicy)}`);
  const allowedRefs = config.allowedRefs?.length ? config.allowedRefs : [config.defaultRef];
  if (!allowedRefs.includes(config.defaultRef)) throw new Error(`${name}: defaultRef must be allowlisted`);
  validateHeaders(name, config.runtimeHeaders, 'runtime');
  if (config.runtimeOrigins) {
    for (const origin of config.runtimeOrigins) {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name}: runtime origin must be HTTP(S)`);
      if (parsed.origin !== origin.replace(/\/$/, '')) throw new Error(`${name}: runtimeOrigins must contain origins only`);
    }
  }
  if (config.technicalSources) {
    const ids = new Set<string>();
    for (const source of config.technicalSources) {
      if (!source.id?.trim() || !/^[A-Za-z0-9._-]+$/.test(source.id)) throw new Error(`${name}: technical source id must use letters, numbers, dot, underscore, or dash`);
      if (ids.has(source.id)) throw new Error(`${name}: duplicate technical source id: ${source.id}`);
      ids.add(source.id);
      if (source.type !== 'read-only-http') throw new Error(`${name}: unsupported technical source type: ${String((source as any).type)}`);
      const endpoint = new URL(source.endpoint);
      if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error(`${name}: technical source endpoint must be HTTP(S)`);
      if (endpoint.username || endpoint.password) throw new Error(`${name}: technical source endpoint must not embed credentials`);
      if (!Array.isArray(source.capabilities) || !source.capabilities.length) throw new Error(`${name}: technical source ${source.id} must declare at least one capability`);
      for (const capability of source.capabilities) if (!['query', 'logs', 'metrics'].includes(capability)) throw new Error(`${name}: unsupported technical source capability: ${capability}`);
      validateHeaders(name, source.headers, `technical source ${source.id}`);
      if (source.timeoutMs !== undefined && (!Number.isFinite(source.timeoutMs) || source.timeoutMs < 250 || source.timeoutMs > 60_000)) {
        throw new Error(`${name}: technical source ${source.id} timeoutMs must be between 250 and 60000`);
      }
    }
  }
  return { ...config, allowedRefs, revisionPolicy };
}

function githubProjectConfig(project: string): ProjectConfig | null {
  const match = GITHUB_PROJECT_PATTERN.exec(project);
  if (!match) return null;
  const [, requestedOwner, repository] = match;
  if (!requestedOwner || !repository || repository === '.' || repository === '..' || repository.toLowerCase().endsWith('.git')) return null;
  const owner = listAuthorizedGithubOwners().find(value => value.toLowerCase() === requestedOwner.toLowerCase());
  if (!owner) return null;
  const appId = process.env.DEVINT_GITHUB_APP_ID?.trim();
  const privateKey = process.env.DEVINT_GITHUB_APP_PRIVATE_KEY?.trim();
  if (Boolean(appId) !== Boolean(privateKey)) {
    throw new Error('DEVINT_GITHUB_APP_ID and DEVINT_GITHUB_APP_PRIVATE_KEY must be configured together');
  }
  const tokenEnv = process.env.DEVINT_GITHUB_TOKEN_ENV?.trim() || 'DEVINT_GITHUB_TOKEN';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('DEVINT_GITHUB_TOKEN_ENV must name an environment variable');
  return validateProject(project, {
    repository: `https://github.com/${owner}/${repository}.git`,
    defaultRef: 'HEAD',
    allowedRefs: ['HEAD'],
    revisionPolicy: 'repository-history',
    credential: appId && privateKey
      ? {
          type: 'github-app-env',
          appIdEnv: 'DEVINT_GITHUB_APP_ID',
          privateKeyEnv: 'DEVINT_GITHUB_APP_PRIVATE_KEY',
          username: 'x-access-token',
        }
      : { type: 'token-env', tokenEnv, username: 'x-access-token' },
  });
}

function parseRegistry(raw: string, source: string): ProjectRegistry {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('registry root must be an object');
    return parsed as ProjectRegistry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Development Intelligence project registry from ${source}: ${message}`);
  }
}

async function registrySource(): Promise<{ parsed: ProjectRegistry; source: string }> {
  const inline = process.env.DEVINT_PROJECTS_JSON?.trim();
  if (inline) return { parsed: parseRegistry(inline, 'DEVINT_PROJECTS_JSON'), source: 'DEVINT_PROJECTS_JSON' };
  const file = projectsFile();
  const raw = await fs.readFile(file, 'utf8');
  return { parsed: parseRegistry(raw, file), source: file };
}

export async function loadRegistry(): Promise<ProjectRegistry> {
  const { parsed } = await registrySource();
  const validated: ProjectRegistry = {};
  const storageKeys = new Map<string, string>();
  for (const [name, config] of Object.entries(parsed)) {
    const storageKey = safeSegment(name);
    const existing = storageKeys.get(storageKey);
    if (existing && existing !== name) throw new Error(`Project identities ${existing} and ${name} collide on derived storage key ${storageKey}`);
    storageKeys.set(storageKey, name);
    validated[name] = validateProject(name, config);
  }
  return validated;
}

export async function getProjectConfig(project: string): Promise<ProjectConfig> {
  const registry = await loadRegistry();
  const config = registry[project];
  if (config) return config;
  const github = githubProjectConfig(project);
  if (github) return github;
  const owners = listAuthorizedGithubOwners();
  const hint = owners.length ? ` Use owner/repository under an authorized GitHub owner: ${owners.join(', ')}.` : '';
  throw new Error(`Unknown project: ${project}.${hint}`);
}
