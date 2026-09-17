import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const listenPort = Number(process.env.DEVINT_PREVIEW_PROXY_PORT ?? 8790);
const target = new URL(process.env.DEVINT_PREVIEW_TARGET ?? 'http://127.0.0.1:8787');
const expectedUser = process.env.DEVINT_PREVIEW_USER ?? 'review';
const expectedPassword = process.env.DEVINT_PREVIEW_PASSWORD;
const proxySecret = process.env.DEVINT_PROXY_SHARED_SECRET;

if (!expectedPassword || !proxySecret) {
  throw new Error('DEVINT_PREVIEW_PASSWORD and DEVINT_PROXY_SHARED_SECRET are required');
}

function equal(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(header) {
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    return equal(decoded.slice(0, separator), expectedUser) && equal(decoded.slice(separator + 1), expectedPassword);
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': 'Basic realm="Development Intelligence Preview"',
      'cache-control': 'no-store',
    });
    res.end('Development Intelligence Preview authentication required');
    return;
  }

  const headers = { ...req.headers };
  delete headers.authorization;
  headers.host = target.host;
  headers['x-devint-proxy-secret'] = proxySecret;
  headers['x-forwarded-proto'] = 'https';

  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers,
  }, upstreamResponse => {
    res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });

  upstream.on('error', error => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Preview upstream error: ${error.message}`);
  });
  req.pipe(upstream);
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
server.listen(listenPort, '127.0.0.1', () => {
  console.error(`Development Intelligence preview proxy listening on http://127.0.0.1:${listenPort}`);
});
