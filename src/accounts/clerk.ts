Failed to create stream fd: Operation not permitted
Failed to create stream fd: Operation not permitted
Failed to create stream fd: Operation not permitted
import { createClerkClient } from '@clerk/backend';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AccountIdentity { userId: string; tokenType: 'session_token' | 'oauth_token'; }

/** Authenticate with Clerk before resolving any account-owned data. */
export async function authenticateAccount(req: IncomingMessage, res: ServerResponse): Promise<AccountIdentity | null> {
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY?.trim();
  const origin = process.env.DEVINT_PUBLIC_BASE_URL?.trim();
  if (!secretKey || !publishableKey || !origin) {
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'Account sign-in is not configured' }));
    return null;
  }
  const base = new URL(origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (typeof value === 'string') headers.set(key, value);
  }
  const url = new URL(req.url ?? '/', base);
  // The configured origin, not the incoming Host or forwarding headers, establishes the frontend authority.
  if (url.origin !== base.origin) throw new Error('Invalid account request URL');
  const client = createClerkClient({ secretKey, publishableKey });
  const state = await client.authenticateRequest(new Request(url, { method: req.method ?? 'GET', headers }), {
    acceptsToken: ['session_token', 'oauth_token'], authorizedParties: [base.origin],
  });
  if (state.status === 'handshake') {
    const location = state.headers.get('location');
    if (!location) throw new Error('Clerk handshake did not provide a destination');
    state.headers.forEach((value, key) => res.setHeader(key, value));
    res.writeHead(307); res.end(); return null;
  }
  if (!state.isAuthenticated) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'Sign in to continue' })); return null;
  }
  const auth = state.toAuth();
  if (!auth || !('userId' in auth) || !auth.userId || (state.tokenType !== 'session_token' && state.tokenType !== 'oauth_token')) {
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'This account token cannot access the workspace' })); return null;
  }
  if (state.tokenType === 'oauth_token') {
    const clientId = process.env.CLERK_DEVICE_CLIENT_ID?.trim();
    if (!clientId || !('clientId' in auth) || auth.clientId !== clientId || !('scopes' in auth) || !auth.scopes?.includes('profile')) {
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'This OAuth client cannot access DI computers' })); return null;
    }
  }
  return { userId: auth.userId, tokenType: state.tokenType };
}
