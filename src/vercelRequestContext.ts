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
