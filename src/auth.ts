import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorize(req: IncomingMessage, res: ServerResponse): boolean {
  const mode = process.env.DEVINT_AUTH_MODE ?? 'bearer';
  if (mode === 'none') {
    if (process.env.DEVINT_ALLOW_UNAUTHENTICATED !== '1') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthenticated mode is disabled unless DEVINT_ALLOW_UNAUTHENTICATED=1' }));
      return false;
    }
    return true;
  }
  if (mode === 'bearer') {
    const expected = process.env.DEVINT_BEARER_TOKEN;
    const header = req.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!expected || !supplied || !equalSecret(expected, supplied)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return false;
    }
    return true;
  }
  if (mode === 'proxy') {
    const expected = process.env.DEVINT_PROXY_SHARED_SECRET;
    const supplied = String(req.headers['x-devint-proxy-secret'] ?? '');
    if (!expected || !supplied || !equalSecret(expected, supplied)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized proxy request' }));
      return false;
    }
    return true;
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
