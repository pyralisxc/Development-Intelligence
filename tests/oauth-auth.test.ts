import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import test from 'node:test';

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function startServer(): Promise<{ server: Server; origin: string }> {
  const { createDevelopmentIntelligenceServer } = await import('../src/http.js');
  const server = createDevelopmentIntelligenceServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value || !value.includes('devint_session=')) throw new Error('Expected Development Intelligence session cookie');
  return value.split(';')[0]!;
}

test('OAuth mode supports ChatGPT-style DCR, PKCE, refresh, and MCP bearer access', async () => {
  const previous = {
    mode: process.env.DEVINT_AUTH_MODE,
    owner: process.env.DEVINT_OWNER_PASSWORD,
    agent: process.env.DEVINT_AGENT_TOKEN,
    session: process.env.DEVINT_SESSION_SECRET,
    publicBase: process.env.DEVINT_PUBLIC_BASE_URL,
    redirects: process.env.DEVINT_OAUTH_ALLOWED_REDIRECT_ORIGINS,
    loopback: process.env.DEVINT_OAUTH_ALLOW_LOOPBACK,
    cookie: process.env.DEVINT_COOKIE_SECURE,
  };
  process.env.DEVINT_AUTH_MODE = 'oauth';
  process.env.DEVINT_OWNER_PASSWORD = 'owner-test-password';
  process.env.DEVINT_SESSION_SECRET = 'oauth-session-secret-long-enough-for-tests';
  process.env.DEVINT_COOKIE_SECURE = '0';
  delete process.env.DEVINT_AGENT_TOKEN;
  delete process.env.DEVINT_OAUTH_ALLOWED_REDIRECT_ORIGINS;
  delete process.env.DEVINT_OAUTH_ALLOW_LOOPBACK;

  const { server, origin } = await startServer();
  process.env.DEVINT_PUBLIC_BASE_URL = origin;
  const redirectUri = 'https://chatgpt.com/connector/oauth/devint-test';
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  try {
    const resourceMetadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(resourceMetadata.status, 200);
    const resource = await resourceMetadata.json() as any;
    assert.equal(resource.resource, `${origin}/mcp`);
    assert.deepEqual(resource.authorization_servers, [origin]);
    assert.ok(resource.scopes_supported.includes('development-intelligence.read'));

    const serverMetadata = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    assert.equal(serverMetadata.status, 200);
    const metadata = await serverMetadata.json() as any;
    assert.equal(metadata.issuer, origin);
    assert.equal(metadata.registration_endpoint, `${origin}/oauth/register`);
    assert.ok(metadata.grant_types_supported.includes('refresh_token'));
    assert.ok(metadata.scopes_supported.includes('offline_access'));

    const badRegistration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://attacker.example/callback'], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(badRegistration.status, 400);

    const loopbackRegistrationDenied = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:49152/callback'], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(loopbackRegistrationDenied.status, 400);

    process.env.DEVINT_OAUTH_ALLOW_LOOPBACK = '1';
    const loopbackRegistration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Codex CLI',
        application_type: 'native',
        redirect_uris: ['http://127.0.0.1:49152/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(loopbackRegistration.status, 201);

    const registration = await fetch(`${origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        application_type: 'web',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json() as any;
    assert.equal(registered.client_name, 'ChatGPT');
    assert.ok(typeof registered.client_id === 'string' && registered.client_id.startsWith('dic.'));

    const authorizeUrl = new URL(`${origin}/oauth/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', registered.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'development-intelligence.read offline_access');
    authorizeUrl.searchParams.set('state', 'test-state');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const authorizeDenied = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(authorizeDenied.status, 303);
    assert.match(authorizeDenied.headers.get('location') ?? '', /^\/login\?returnTo=/u);

    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'owner-test-password', returnTo: `${authorizeUrl.pathname}${authorizeUrl.search}` }),
    });
    assert.equal(login.status, 303);
    const cookie = cookieFrom(login);

    const consent = await fetch(authorizeUrl, { headers: { cookie } });
    assert.equal(consent.status, 200);
    assert.match(await consent.text(), /Authorize Development Intelligence/u);

    const approval = await fetch(`${origin}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        scope: 'development-intelligence.read offline_access',
        state: 'test-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    });
    assert.equal(approval.status, 303);
    const callback = new URL(approval.headers.get('location')!);
    assert.equal(callback.origin + callback.pathname, redirectUri);
    assert.equal(callback.searchParams.get('state'), 'test-state');
    assert.equal(callback.searchParams.get('iss'), origin);
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const token = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    assert.equal(token.status, 200);
    const tokens = await token.json() as any;
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.access_token.startsWith('dia.'));
    assert.ok(tokens.refresh_token.startsWith('dir.'));

    const replay = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    assert.equal(replay.status, 400);

    const deniedMcp = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(deniedMcp.status, 401);
    assert.match(deniedMcp.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp/u);

    const allowedMcp = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
    });
    assert.equal(allowedMcp.status, 200);
    const mcpBody = await allowedMcp.json() as any;
    assert.equal(mcpBody.result.serverInfo.name, 'Development Intelligence');

    const refresh = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registered.client_id, refresh_token: tokens.refresh_token }),
    });
    assert.equal(refresh.status, 200);
    const refreshed = await refresh.json() as any;
    assert.ok(refreshed.access_token.startsWith('dia.'));
    assert.ok(refreshed.refresh_token.startsWith('dir.'));
  } finally {
    await close(server);
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('DEVINT_AUTH_MODE', previous.mode);
    restore('DEVINT_OWNER_PASSWORD', previous.owner);
    restore('DEVINT_AGENT_TOKEN', previous.agent);
    restore('DEVINT_SESSION_SECRET', previous.session);
    restore('DEVINT_PUBLIC_BASE_URL', previous.publicBase);
    restore('DEVINT_OAUTH_ALLOWED_REDIRECT_ORIGINS', previous.redirects);
    restore('DEVINT_OAUTH_ALLOW_LOOPBACK', previous.loopback);
    restore('DEVINT_COOKIE_SECURE', previous.cookie);
  }
});
