import { promises as fs } from 'node:fs';
import { projectsFile, safeSegment } from './paths.js';
import type { ProjectConfig, ProjectRegistry } from '../types.js';

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

function validateProject(name: string, config: ProjectConfig): ProjectConfig {
  if (!name.trim()) throw new Error('Project names must be non-empty');
  assertRepositoryUrl(config.repository);
  if (config.credential?.type === 'token-env' && !config.repository.startsWith('https://')) {
    throw new Error(`${name}: token-env repository credentials require an HTTPS repository URL; use host SSH credentials with credential.type=none for SSH repositories`);
  }
  if (!config.defaultRef?.trim()) throw new Error(`${name}: defaultRef is required`);
  const allowedRefs = config.allowedRefs?.length ? config.allowedRefs : [config.defaultRef];
  if (!allowedRefs.includes(config.defaultRef)) throw new Error(`${name}: defaultRef must be allowlisted`);
  if (config.runtimeHeaders) {
    const forbiddenHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
    for (const header of config.runtimeHeaders) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)) throw new Error(`${name}: invalid runtime header name`);
      if (forbiddenHeaders.has(header.name.toLowerCase())) throw new Error(`${name}: runtime header is transport-owned and cannot be configured: ${header.name}`);
      if (!header.valueEnv?.trim()) throw new Error(`${name}: runtime header valueEnv is required`);
    }
  }
  if (config.runtimeOrigins) {
    for (const origin of config.runtimeOrigins) {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name}: runtime origin must be HTTP(S)`);
      if (parsed.origin !== origin.replace(/\/$/, '')) throw new Error(`${name}: runtimeOrigins must contain origins only`);
    }
  }
  return { ...config, allowedRefs };
}

export async function loadRegistry(): Promise<ProjectRegistry> {
  const raw = await fs.readFile(projectsFile(), 'utf8');
  const parsed = JSON.parse(raw) as ProjectRegistry;
  const validated: ProjectRegistry = {};
  const storageKeys = new Map<string, string>();
  for (const [name, config] of Object.entries(parsed)) {
    const storageKey = safeSegment(name);
    const existing = storageKeys.get(storageKey);
    if (existing && existing !== name) {
      throw new Error(`Project identities ${existing} and ${name} collide on derived storage key ${storageKey}`);
    }
    storageKeys.set(storageKey, name);
    validated[name] = validateProject(name, config);
  }
  return validated;
}

export async function getProjectConfig(project: string): Promise<ProjectConfig> {
  const registry = await loadRegistry();
  const config = registry[project];
  if (!config) throw new Error(`Unknown project: ${project}`);
  return config;
}
