import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
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

test('private auth separates owner browser sessions from agent bearer access', async () => {
  const previous = {
    mode: process.env.DEVINT_AUTH_MODE,
    owner: process.env.DEVINT_OWNER_PASSWORD,
    agent: process.env.DEVINT_AGENT_TOKEN,
    session: process.env.DEVINT_SESSION_SECRET,
    cookie: process.env.DEVINT_COOKIE_SECURE,
  };
  process.env.DEVINT_AUTH_MODE = 'private';
  process.env.DEVINT_OWNER_PASSWORD = 'owner-test-password';
  process.env.DEVINT_AGENT_TOKEN = 'agent-test-token';
  process.env.DEVINT_SESSION_SECRET = 'session-test-secret-that-is-long-enough';
  process.env.DEVINT_COOKIE_SECURE = '0';
  const { server, origin } = await startServer();
  try {
    const browserDenied = await fetch(`${origin}/graph`, { redirect: 'manual' });
    assert.equal(browserDenied.status, 303);
    assert.match(browserDenied.headers.get('location') ?? '', /^\/login\?returnTo=/u);

    const badLogin = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'wrong', returnTo: '/graph' }),
    });
    assert.equal(badLogin.status, 401);

    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'owner-test-password', returnTo: '/graph' }),
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/graph');
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie?.includes('devint_session='));
    assert.ok(cookie?.includes('HttpOnly'));
    assert.ok(cookie?.includes('SameSite=Strict'));

    const ownerSession = await fetch(`${origin}/graph`, { redirect: 'manual', headers: { cookie: cookie!.split(';')[0]! } });
    assert.equal(ownerSession.status, 400, 'valid owner session should pass auth before the route validates project input');

    const agentDenied = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(agentDenied.status, 401);
    assert.match(agentDenied.headers.get('www-authenticate') ?? '', /Bearer/u);

    const agentAllowed = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer agent-test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
    });
    assert.equal(agentAllowed.status, 200);
    const body = await agentAllowed.json() as any;
    assert.equal(body.result.serverInfo.name, 'Development Intelligence');

    const logout = await fetch(`${origin}/logout`, { redirect: 'manual', headers: { cookie: cookie!.split(';')[0]! } });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.get('location'), '/login');
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/u);
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
    restore('DEVINT_COOKIE_SECURE', previous.cookie);
  }
});
