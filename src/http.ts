import http from 'node:http';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authorize, validateHost } from './auth.js';
import { callTool, listTools } from './mcp.js';
import { scanGraph } from './intelligence/service.js';
import { viewerProjection } from './intelligence/query.js';
import { renderGraphViewer } from './viewer.js';

const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const SUPPORTED_MODERN = [MODERN_VERSION];
const MAX_BODY = 4 * 1024 * 1024;
const SERVER_INFO = { name: 'Development Intelligence', version: '2.1.0' };
const VIEWER_BUNDLE = fileURLToPath(new URL('../public/viewer.js', import.meta.url));

async function readJson(req: any): Promise<any> {
  let size = 0;
  const chunks: any[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400, rpcCode: -32700 }); }
}

function rpcResult(id: unknown, result: unknown) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id: unknown, code: number, message: string, data?: unknown) { return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function complete(result: Record<string, unknown>, modern: boolean): Record<string, unknown> {
  return modern ? { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }, ...result } : result;
}

function protocolMeta(body: any): string | null {
  const value = body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  return typeof value === 'string' ? value : null;
}

function modernHeaders(req: any, body: any): { modern: boolean; error?: { code: number; message: string; data?: unknown } } {
  const headerVersion = typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : null;
  const metaVersion = protocolMeta(body);
  const modern = headerVersion === MODERN_VERSION || metaVersion === MODERN_VERSION || body?.method === 'server/discover';
  if (!modern) return { modern: false };
  const requested = headerVersion ?? metaVersion;
  if (requested !== MODERN_VERSION) return { modern: true, error: { code: -32022, message: 'Unsupported protocol version', data: { requested, supported: SUPPORTED_MODERN } } };
  if (!headerVersion) return { modern: true, error: { code: -32020, message: 'Missing MCP-Protocol-Version header' } };
  if (metaVersion && metaVersion !== headerVersion) return { modern: true, error: { code: -32020, message: 'Protocol version header does not match request metadata' } };
  const methodHeader = typeof req.headers['mcp-method'] === 'string' ? req.headers['mcp-method'] : null;
  if (!methodHeader || methodHeader !== body.method) return { modern: true, error: { code: -32020, message: 'Mcp-Method header does not match JSON-RPC method' } };
  if (body.method === 'tools/call') {
    const name = body?.params?.name;
    const nameHeader = typeof req.headers['mcp-name'] === 'string' ? req.headers['mcp-name'] : null;
    if (typeof name !== 'string' || !nameHeader || nameHeader !== name) return { modern: true, error: { code: -32020, message: 'Mcp-Name header does not match tools/call name' } };
  }
  return { modern: true };
}

export async function handleRpc(body: any, requestInfo: { modern: boolean }): Promise<{ status: number; body?: unknown }> {
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return { status: 400, body: rpcError(body?.id ?? null, -32600, 'Invalid Request') };
  const id = body.id;
  const modern = requestInfo.modern;
  if (modern) {
    const meta = body?.params?._meta;
    if (!meta || meta['io.modelcontextprotocol/protocolVersion'] !== MODERN_VERSION || !meta['io.modelcontextprotocol/clientCapabilities'] || typeof meta['io.modelcontextprotocol/clientCapabilities'] !== 'object') {
      return { status: 400, body: rpcError(id ?? null, -32602, 'Modern MCP requests require protocolVersion and clientCapabilities in params._meta') };
    }
  }
  if (!modern && (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled')) return { status: 202 };
  if (!modern && body.method === 'initialize') return { status: 200, body: rpcResult(id, { protocolVersion: LEGACY_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO }) };
  if (modern && body.method === 'server/discover') {
    return { status: 200, body: rpcResult(id, complete({
      supportedVersions: SUPPORTED_MODERN,
      capabilities: { tools: {} },
      instructions: 'Project-neutral technical intelligence. Development Intelligence builds one evidence-backed graph of stable semantic entities, structural code, representations, relationships, and provenance. Code, Architecture, Parity, Change, and human visualization are lenses over that graph; Git/source remains implementation authority.',
      ttlMs: 60_000,
      cacheScope: 'private',
    }, true)) };
  }
  if (body.method === 'ping') return { status: 200, body: rpcResult(id, complete({}, modern)) };
  if (body.method === 'tools/list') {
    const result: Record<string, unknown> = { tools: listTools() };
    if (modern) { result.ttlMs = 60_000; result.cacheScope = 'private'; }
    return { status: 200, body: rpcResult(id, complete(result, modern)) };
  }
  if (body.method === 'tools/call') {
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return { status: 200, body: rpcError(id, -32602, 'Invalid tools/call parameters') };
    try {
      const value = await callTool(name, args);
      const structuredContent = Array.isArray(value) ? { items: value } : value && typeof value === 'object' ? value : { value };
      return { status: 200, body: rpcResult(id, complete({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent }, modern)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 200, body: rpcResult(id, complete({ content: [{ type: 'text', text: message }], isError: true }, modern)) };
    }
  }
  return { status: 200, body: rpcError(id ?? null, -32601, `Method not found: ${body.method}`) };
}

function numberParam(url: URL, key: string, fallback: number): number {
  const value = Number(url.searchParams.get(key));
  return Number.isFinite(value) ? value : fallback;
}

export function createDevelopmentIntelligenceServer() {
  return http.createServer(async (req: any, res: any) => {
    if (!validateHost(req, res)) return;
    const requestUrl = new URL(req.url ?? '/', 'http://development-intelligence.local');
    if (requestUrl.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'Development Intelligence', version: SERVER_INFO.version, status: 'ok', protocolVersions: SUPPORTED_MODERN }));
      return;
    }
    if (requestUrl.pathname === '/viewer.js' && req.method === 'GET') {
      try {
        const script = await fs.readFile(VIEWER_BUNDLE, 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=300' });
        res.end(script);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (requestUrl.pathname === '/graph' && req.method === 'GET') {
      if (!authorize(req, res)) return;
      const project = requestUrl.searchParams.get('project');
      if (!project) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Missing ?project='); return; }
      const requestedRef = requestUrl.searchParams.get('ref') ?? undefined;
      try {
        const graph = await scanGraph(project, { ref: requestedRef });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' });
        res.end(renderGraphViewer(graph, requestedRef));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (requestUrl.pathname === '/graph/data' && req.method === 'GET') {
      if (!authorize(req, res)) return;
      const project = requestUrl.searchParams.get('project');
      if (!project) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing ?project=' })); return; }
      const view = requestUrl.searchParams.get('view');
      if (view && !['architecture', 'parity', 'code', 'change'].includes(view)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Unsupported graph view' })); return; }
      try {
        const ref = requestUrl.searchParams.get('ref') ?? undefined;
        const query = requestUrl.searchParams.get('query') ?? undefined;
        const node = requestUrl.searchParams.get('node') ?? undefined;
        const projection = await viewerProjection({
          project,
          ...(ref ? { ref } : {}),
          view: (view ?? 'architecture') as 'architecture' | 'parity' | 'code' | 'change',
          ...(query ? { query } : {}),
          ...(node ? { node } : {}),
          depth: numberParam(requestUrl, 'depth', 2),
          limit: numberParam(requestUrl, 'limit', 700),
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' });
        res.end(JSON.stringify(projection));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (requestUrl.pathname !== '/mcp') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!authorize(req, res)) return;
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { res.writeHead(415, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Content-Type must be application/json' })); return; }
    try {
      const body = await readJson(req);
      const classification = modernHeaders(req, body);
      if (classification.error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rpcError(body?.id ?? null, classification.error.code, classification.error.message, classification.error.data)));
        return;
      }
      const result = await handleRpc(body, { modern: classification.modern });
      if (result.body === undefined) { res.writeHead(result.status); res.end(); return; }
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (error) {
      const status = (error as any)?.status ?? 500;
      const code = (error as any)?.rpcCode ?? -32603;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, code, error instanceof Error ? error.message : String(error))));
    }
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const host = process.env.DEVINT_HOST ?? '127.0.0.1';
  const port = Number(process.env.DEVINT_PORT ?? 8787);
  const server = createDevelopmentIntelligenceServer();
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(port, host, () => console.error(`Development Intelligence listening on http://${host}:${port}`));
}
