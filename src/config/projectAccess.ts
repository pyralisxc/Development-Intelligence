import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ProjectConfig } from '../types.js';

/** Server-resolved association. Never construct this from HTTP/tool arguments. */
export interface ProjectAccessBinding {
  accountId: string;
  bindingId: string;
  bindingVersion: number;
  authorityId: string;
  internalProject: string;
  config: ProjectConfig;
  secretValues: Record<string, string>;
  canonical: null | { kind: 'file'; root: string } | {
    kind: 'vercel-private-blob'; storeId: string; token: string; apiUrl: string; baseUrl: string;
  };
}

interface OperationAccess { binding: ProjectAccessBinding; key: string; current: () => Promise<boolean>; }
const operations = new AsyncLocalStorage<OperationAccess>();

export function accessDenied(): Error {
  return Object.assign(new Error('Project binding is unavailable or not authorized'), { status: 403, code: 'PROJECT_ACCESS_DENIED' });
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function operation(project?: string): OperationAccess | undefined {
  const access = operations.getStore();
  if (access && project !== undefined && project !== access.binding.internalProject) throw accessDenied();
  return access;
}

export async function withProjectAccess<T>(binding: ProjectAccessBinding, current: () => Promise<boolean>, fn: () => Promise<T>): Promise<T> {
  if (operations.getStore()) throw accessDenied(); // no nested scope substitution
  if (![binding.accountId, binding.bindingId, binding.authorityId, binding.internalProject].every(value => typeof value === 'string' && value.length > 0 && value.length < 512)
      || !Number.isSafeInteger(binding.bindingVersion) || binding.bindingVersion < 1) throw accessDenied();
  if (!binding.config || typeof binding.config !== 'object' || !binding.secretValues || typeof binding.secretValues !== 'object'
      || Array.isArray(binding.secretValues) || Object.values(binding.secretValues).some(value => typeof value !== 'string')
      || !Object.hasOwn(binding, 'canonical') || binding.canonical === undefined) throw accessDenied();
  // Host SSH identity/config is not an account grant. Explicit SSH binding is
  // unsupported here; file URLs are retained for adopted/disposable fixtures.
  let repository: URL; try { repository = new URL(binding.config.repository); } catch { throw accessDenied(); }
  if (!['https:', 'file:'].includes(repository.protocol) || repository.username || repository.password) throw accessDenied();
  if (repository.protocol === 'file:') {
    let local: string; try { local = fileURLToPath(repository); } catch { throw accessDenied(); }
    if (repository.hostname || /^[/\\]{2}/u.test(local)) throw accessDenied();
  }
  if (binding.config.credential?.type === 'github-app-bound') throw accessDenied();
  if (binding.canonical !== null) {
    if (binding.canonical.kind === 'file') {
      if (typeof binding.canonical.root !== 'string' || !path.isAbsolute(binding.canonical.root) || /^[/\\]{2}/u.test(binding.canonical.root)) throw accessDenied();
    } else if (binding.canonical.kind === 'vercel-private-blob') {
      if (!binding.canonical.storeId || !binding.canonical.token) throw accessDenied();
      for (const raw of [binding.canonical.apiUrl, binding.canonical.baseUrl]) {
        let url: URL; try { url = new URL(raw); } catch { throw accessDenied(); }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw accessDenied();
      }
    } else throw accessDenied();
  }
  const snapshot = freeze(JSON.parse(JSON.stringify(binding)) as ProjectAccessBinding);
  const key = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return await operations.run({ binding: snapshot, key, current }, async () => {
    await assertProjectAccessCurrent(snapshot.internalProject);
    const result = await fn();
    // A revoked/replaced binding cannot return warm or in-flight results.
    await assertProjectAccessCurrent(snapshot.internalProject);
    return result;
  });
}

export async function assertProjectAccessCurrent(project?: string): Promise<void> {
  const access = operation(project);
  if (access && !await access.current()) throw accessDenied();
}

export function hasProjectAccess(): boolean { return Boolean(operation()); }
export function projectAccessScopeKey(): string { return operation()?.key ?? 'operator'; }
export function projectAccessConfig(project?: string): { project: string; config: ProjectConfig } | null {
  const binding = operation(project)?.binding;
  return binding ? { project: binding.internalProject, config: binding.config } : null;
}
export function assertProjectAccessConfiguration(config: ProjectConfig): void {
  const access = operation();
  if (!access) return;
  const identity = (value: ProjectConfig) => JSON.stringify([
    value.repository, value.defaultRef, value.allowedRefs?.length ? value.allowedRefs : [value.defaultRef], value.revisionPolicy ?? 'allowlisted',
    value.credential ?? { type: 'none' }, value.runtimeOrigins ?? [], value.runtimeHeaders ?? [], value.technicalSources ?? [],
  ]);
  if (identity(config) !== identity(access.binding.config)) throw accessDenied();
}
export function projectAccessCanonical(): ProjectAccessBinding['canonical'] | undefined {
  const access = operation();
  return access ? access.binding.canonical ?? null : undefined;
}
export function projectAccessSecret(name: string): string | undefined {
  const access = operation();
  return access ? (Object.hasOwn(access.binding.secretValues, name) ? access.binding.secretValues[name] : undefined) : process.env[name];
}
export function projectAccessScratchPrefix(operatorRoot: string, kind: 'checkout' | 'diff' | 'askpass'): string {
  return path.join(operatorRoot, hasProjectAccess() ? `binding-${projectAccessScopeKey()}-${kind}-` : `devint-${kind}-`);
}
export function projectAccessChildEnvironment(): NodeJS.ProcessEnv {
  if (!hasProjectAccess()) return process.env;
  const allowed = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive', 'PATH', 'TEMP', 'TMP'];
  const env: NodeJS.ProcessEnv = Object.fromEntries(allowed.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}
