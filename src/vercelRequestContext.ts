import { AsyncLocalStorage } from 'node:async_hooks';

export interface VercelRequestContext {
  oidcToken: string | null;
}

type HeaderValue = string | string[] | undefined;

const context = new AsyncLocalStorage<VercelRequestContext>();

function normalizedHeader(value: HeaderValue): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  const token = candidate?.trim();
  return token ? token : null;
}

export function withVercelRequestContext<T>(
  headers: Record<string, HeaderValue>,
  operation: () => T,
): T {
  return context.run({
    oidcToken: normalizedHeader(headers['x-vercel-oidc-token']),
  }, operation);
}

export function currentVercelOidcToken(): string | null {
  return context.getStore()?.oidcToken ?? null;
}

export interface VercelOidcProjectIdentity {
  projectId: string;
  teamId: string;
}

export function vercelOidcProjectIdentity(token: string): VercelOidcProjectIdentity | null {
  const compact = token.trim();
  const parts = compact.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const projectId = typeof payload.project_id === 'string' ? payload.project_id.trim() : '';
    const ownerId = typeof payload.owner_id === 'string' ? payload.owner_id.trim() : '';
    if (!/^prj_[A-Za-z0-9]+$/u.test(projectId)) return null;
    if (!/^team_[A-Za-z0-9]+$/u.test(ownerId)) return null;
    return { projectId, teamId: ownerId };
  } catch {
    return null;
  }
}
