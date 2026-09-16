import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'devint_session';

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function sessionSecret(): string | null {
  const value = process.env.DEVINT_SESSION_SECRET?.trim();
  return value || null;
}

function sessionTtlSeconds(): number {
  const requested = Number(process.env.DEVINT_SESSION_TTL_SECONDS ?? 43_200);
  return Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 300), 604_800) : 43_200;
}

function sessionSignature(expires: number, secret: string): string {
  return createHmac('sha256', secret).update(`owner:${expires}`).digest('base64url');
}

function validOwnerSession(req: IncomingMessage): boolean {
  const secret = sessionSecret();
  const token = cookieValue(req, SESSION_COOKIE);
  if (!secret || !token) return false;
  const [expiresText, suppliedSignature] = token.split('.');
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || expires <= Math.floor(Date.now() / 1000) || !suppliedSignature) return false;
  const expected = sessionSignature(expires, secret);
  return equalSecret(expected, suppliedSignature);
}

function cookieSecure(): boolean {
  return process.env.DEVINT_COOKIE_SECURE !== '0';
}

function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

export function authMode(): string {
  return process.env.DEVINT_AUTH_MODE ?? 'bearer';
}

export function privateAccessConfigured(): boolean {
  return Boolean(process.env.DEVINT_OWNER_PASSWORD?.trim() && process.env.DEVINT_AGENT_TOKEN?.trim() && sessionSecret());
}

export function ownerPasswordMatches(password: string): boolean {
  const expected = process.env.DEVINT_OWNER_PASSWORD?.trim() ?? '';
  return Boolean(expected && password && equalSecret(expected, password));
}

export function setOwnerSession(res: ServerResponse): void {
  const secret = sessionSecret();
  if (!secret) throw new Error('DEVINT_SESSION_SECRET is required for private auth mode');
  const expires = Math.floor(Date.now() / 1000) + sessionTtlSeconds();
  const token = `${expires}.${sessionSignature(expires, secret)}`;
  const flags = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${sessionTtlSeconds()}`];
  if (cookieSecure()) flags.push('Secure');
  res.setHeader('set-cookie', flags.join('; '));
}

export function clearOwnerSession(res: ServerResponse): void {
  const flags = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (cookieSecure()) flags.push('Secure');
  res.setHeader('set-cookie', flags.join('; '));
}

export function renderOwnerLogin(returnTo?: string, error?: string): string {
  const target = safeReturnTo(returnTo);
  const message = error ? `<div class="error">${escapeHtml(error)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — Development Intelligence</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#070a10;color:#edf4ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 15%,#13233a 0,#070a10 46%)}.card{width:min(420px,calc(100vw - 28px));border:1px solid #293a54;background:#0b121ddf;box-shadow:0 26px 70px #0008;border-radius:18px;padding:26px}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#142943;border:1px solid #365579;color:#a4e4fa;font-weight:800}.eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8093aa;margin-top:20px}h1{font-size:24px;margin:7px 0 7px}p{color:#91a2b8;font-size:12px;line-height:1.55;margin:0 0 18px}label{display:block;font-size:11px;color:#aab8c9;margin-bottom:6px}input{width:100%;border:1px solid #344761;background:#0d1725;color:#fff;border-radius:10px;padding:11px 12px;outline:none}input:focus{border-color:#6093c0;box-shadow:0 0 0 3px #2d639633}button{width:100%;margin-top:12px;border:1px solid #3d6488;background:#173451;color:#ecf8ff;border-radius:10px;padding:11px 12px;font-weight:700;cursor:pointer}.error{border:1px solid #713b43;background:#30181d;color:#ffb9c0;border-radius:9px;padding:9px 10px;font-size:11px;margin-bottom:13px}.note{margin-top:16px;padding-top:14px;border-top:1px solid #213047;color:#74869d;font-size:10px;line-height:1.45}</style></head><body><main class="card"><div class="mark">DI</div><div class="eyebrow">Private workspace</div><h1>Development Intelligence</h1><p>Sign in to inspect the human Viewer. Agent access uses a separate deployment credential and does not share this browser session.</p>${message}<form method="post" action="/login"><input type="hidden" name="returnTo" value="${escapeHtml(target)}"><label for="password">Owner password</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required><button type="submit">Sign in</button></form><div class="note">The source repository may be public. This sign-in protects only the running Development Intelligence service and its project data.</div></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function normalizeReturnTo(value: string | null | undefined): string {
  return safeReturnTo(value);
}

export function authorize(req: IncomingMessage, res: ServerResponse, options: { interactive?: boolean } = {}): boolean {
  const mode = authMode();
  if (mode === 'none') {
    if (process.env.DEVINT_ALLOW_UNAUTHENTICATED !== '1') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthenticated mode is disabled unless DEVINT_ALLOW_UNAUTHENTICATED=1' }));
      return false;
    }
    return true;
  }
  if (mode === 'bearer') {
    const expected = process.env.DEVINT_BEARER_TOKEN ?? '';
    const supplied = bearerToken(req);
    if (!expected || !supplied || !equalSecret(expected, supplied)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="Development Intelligence"' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return false;
    }
    return true;
  }
  if (mode === 'proxy') {
    const expected = process.env.DEVINT_PROXY_SHARED_SECRET ?? '';
    const supplied = String(req.headers['x-devint-proxy-secret'] ?? '');
    if (!expected || !supplied || !equalSecret(expected, supplied)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized proxy request' }));
      return false;
    }
    return true;
  }
  if (mode === 'private') {
    if (!privateAccessConfigured()) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Private auth requires DEVINT_OWNER_PASSWORD, DEVINT_AGENT_TOKEN, and DEVINT_SESSION_SECRET' }));
      return false;
    }
    const agentToken = process.env.DEVINT_AGENT_TOKEN!.trim();
    const supplied = bearerToken(req);
    if ((supplied && equalSecret(agentToken, supplied)) || validOwnerSession(req)) return true;
    if (options.interactive) {
      const returnTo = encodeURIComponent(req.url ?? '/');
      res.writeHead(303, { location: `/login?returnTo=${returnTo}`, 'cache-control': 'no-store' });
      res.end();
      return false;
    }
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="Development Intelligence"', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: `Unsupported DEVINT_AUTH_MODE: ${mode}` }));
  return false;
}

export function validateHost(req: IncomingMessage, res: ServerResponse): boolean {
  const configured = (process.env.DEVINT_ALLOWED_HOSTS ?? '').split(',').map((value: string) => value.trim().toLowerCase()).filter(Boolean);
  if (!configured.length) return true;
  const host = String(req.headers.host ?? '').split(':')[0]!.toLowerCase();
  if (!configured.includes(host)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Host not allowed' }));
    return false;
  }
  return true;
}
