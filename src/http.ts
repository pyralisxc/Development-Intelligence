import http from 'node:http';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authMode, authorize, clearOwnerSession, normalizeReturnTo, ownerPasswordMatches, renderOwnerLogin, setOwnerSession, validateHost } from './auth.js';
import { callTool, listTools } from './mcp.js';
import { currentGraph } from './intelligence/service.js';
import { diffAcceptedToWorking, viewerProjection } from './intelligence/query.js';
import { exploreWorkbench, inspectEntity, projectOverview, queryWorkbench, workbenchProjects, workbenchSources } from './intelligence/workbench.js';
import { handleOAuthHttpRequest } from './oauthHttp.js';
import { renderGraphViewer, renderProjectChooser, type WorkbenchProjectLink } from './viewer.js';
import type { TechnicalSourceCapability } from './types.js';

const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const SUPPORTED_MODERN = [MODERN_VERSION];
const MAX_BODY = 4 * 1024 * 1024;
const SERVER_INFO = { name: 'Development Intelligence', version: '2.1.0' };
const VIEWER_BUNDLE = fileURLToPath(new URL('../public/viewer.js', import.meta.url));

async function readBody(req: any, maxBytes = MAX_BODY): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJson(req: any): Promise<any> {
  const content = await readBody(req);
  if (!content.length) return {};
  try { return JSON.parse(content.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400, rpcCode: -32700 }); }
}

async function readForm(req: any): Promise<URLSearchParams> {
  const content = await readBody(req, 64 * 1024);
  return new URLSearchParams(content.toString('utf8'));
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
      instructions: 'Project-neutral technical intelligence. Development Intelligence builds one evidence-backed graph and exposes it through agent tools and a human Workbench. Overview, Inspector, Explore, Query, Sources, Change, Code, Architecture and Parity are projections over source/evidence truth; Git/source remains implementation authority.',
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

function htmlHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  };
}

function json(res: any, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function projectLinks(): Promise<WorkbenchProjectLink[]> {
  const data = await workbenchProjects() as any;
  return (data.projects ?? []).map((item: any) => ({ project: String(item.project), defaultRef: typeof item.defaultRef === 'string' ? item.defaultRef : undefined }));
}

function contextFromUrl(requestUrl: URL): { ref?: string; graphId?: string } {
  const ref = requestUrl.searchParams.get('ref') ?? undefined;
  const graphId = requestUrl.searchParams.get('graphId') ?? undefined;
  if (ref && graphId) throw Object.assign(new Error('Use either ref or graphId, not both'), { status: 400 });
  return { ...(ref ? { ref } : {}), ...(graphId ? { graphId } : {}) };
}

function changeCounts(diff: any): { added: number; removed: number; changed: number } {
  const semantic = diff?.semantic;
  return {
    added: (semantic?.nodes?.added?.length ?? 0) + (semantic?.edges?.added?.length ?? 0),
    removed: (semantic?.nodes?.removed?.length ?? 0) + (semantic?.edges?.removed?.length ?? 0),
    changed: (semantic?.nodes?.changed?.length ?? 0) + (semantic?.edges?.changed?.length ?? 0),
  };
}

export function createDevelopmentIntelligenceServer() {
  return http.createServer(async (req: any, res: any) => {
    if (!validateHost(req, res)) return;
    const requestUrl = new URL(req.url ?? '/', 'http://development-intelligence.local');
    if (requestUrl.pathname === '/health' && req.method === 'GET') {
      json(res, 200, { service: 'Development Intelligence', version: SERVER_INFO.version, status: 'ok', protocolVersions: SUPPORTED_MODERN });
      return;
    }
    if (await handleOAuthHttpRequest(req, res, requestUrl)) return;
    if (requestUrl.pathname === '/login' && (authMode() === 'private' || authMode() === 'oauth')) {
      const returnTo = normalizeReturnTo(requestUrl.searchParams.get('returnTo'));
      if (req.method === 'GET') {
        res.writeHead(200, htmlHeaders());
        res.end(renderOwnerLogin(returnTo));
        return;
      }
      if (req.method === 'POST') {
        try {
          const form = await readForm(req);
          const formReturnTo = normalizeReturnTo(form.get('returnTo'));
          const password = form.get('password') ?? '';
          if (!ownerPasswordMatches(password)) {
            res.writeHead(401, htmlHeaders());
            res.end(renderOwnerLogin(formReturnTo, 'That password was not accepted.'));
            return;
          }
          setOwnerSession(res);
          res.writeHead(303, { location: formReturnTo, 'cache-control': 'no-store' });
          res.end();
        } catch (error) {
          res.writeHead((error as any)?.status ?? 400, htmlHeaders());
          res.end(renderOwnerLogin(returnTo, error instanceof Error ? error.message : String(error)));
        }
        return;
      }
      res.writeHead(405, { allow: 'GET, POST' });
      res.end();
      return;
    }
    if (requestUrl.pathname === '/logout' && (authMode() === 'private' || authMode() === 'oauth')) {
      clearOwnerSession(res);
      res.writeHead(303, { location: '/login', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (requestUrl.pathname === '/viewer.js' && req.method === 'GET') {
      try {
        const script = await fs.readFile(VIEWER_BUNDLE, 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' });
        res.end(script);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if ((requestUrl.pathname === '/' || requestUrl.pathname === '/workbench') && req.method === 'GET') {
      if (!authorize(req, res, { interactive: true })) return;
      try {
        const projects = await projectLinks();
        const project = requestUrl.searchParams.get('project');
        if (!project) {
          res.writeHead(200, htmlHeaders());
          res.end(renderProjectChooser(projects));
          return;
        }
        const context = contextFromUrl(requestUrl);
        const graph = await currentGraph(project, context.ref, context.graphId);
        res.writeHead(200, htmlHeaders());
        res.end(renderGraphViewer(graph, context.ref, context.graphId, projects));
      } catch (error) {
        res.writeHead((error as any)?.status ?? 500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (requestUrl.pathname === '/graph' && req.method === 'GET') {
      if (!authorize(req, res, { interactive: true })) return;
      const project = requestUrl.searchParams.get('project');
      if (!project) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Missing ?project=');
        return;
      }
      const query = new URLSearchParams(requestUrl.searchParams);
      query.set('surface', 'explore');
      query.set('display', 'graph');
      res.writeHead(303, { location: `/workbench?${query.toString()}`, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (requestUrl.pathname === '/workbench/data' && req.method === 'GET') {
      if (!authorize(req, res)) return;
      const project = requestUrl.searchParams.get('project');
      if (!project) { json(res, 400, { error: 'Missing ?project=' }); return; }
      try {
        const context = contextFromUrl(requestUrl);
        const action = requestUrl.searchParams.get('action') ?? 'overview';
        let result: unknown;
        if (action === 'overview') result = await projectOverview(project, context.ref, context.graphId);
        else if (action === 'inspect') {
          const node = requestUrl.searchParams.get('node');
          if (!node) throw Object.assign(new Error('Missing ?node='), { status: 400 });
          result = await inspectEntity({ project, node, ...context });
        } else if (action === 'explore') {
          result = await exploreWorkbench({ project, query: requestUrl.searchParams.get('query') ?? undefined, limit: numberParam(requestUrl, 'limit', 250), ...context });
        } else if (action === 'sources') result = await workbenchSources(project, context.ref, context.graphId);
        else if (action === 'changes') {
          if (context.graphId) throw Object.assign(new Error('Accepted-to-working change is only available for canonical source graphs'), { status: 400 });
          const detail = await diffAcceptedToWorking(project, context.ref);
          const counts = changeCounts(detail);
          result = { project, counts, summary: counts.added || counts.removed || counts.changed ? `${counts.added} added, ${counts.removed} removed, ${counts.changed} changed semantic records.` : 'Accepted and working semantic topology agree.', detail };
        } else if (action === 'projects') result = await workbenchProjects();
        else throw Object.assign(new Error(`Unsupported workbench action: ${action}`), { status: 400 });
        json(res, 200, result);
      } catch (error) {
        json(res, (error as any)?.status ?? 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (requestUrl.pathname === '/workbench/query' && req.method === 'POST') {
      if (!authorize(req, res)) return;
      try {
        const body = await readJson(req);
        if (typeof body.project !== 'string' || !body.project) throw Object.assign(new Error('project must be non-empty'), { status: 400 });
        if (typeof body.text !== 'string' || !body.text.trim()) throw Object.assign(new Error('text must be non-empty'), { status: 400 });
        const result = await queryWorkbench({
          project: body.project,
          text: body.text,
          ref: typeof body.ref === 'string' ? body.ref : undefined,
          graphId: typeof body.graphId === 'string' ? body.graphId : undefined,
          sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
          capability: typeof body.capability === 'string' ? body.capability as TechnicalSourceCapability : undefined,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, (error as any)?.status ?? 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (requestUrl.pathname === '/graph/data' && req.method === 'GET') {
      if (!authorize(req, res)) return;
      const project = requestUrl.searchParams.get('project');
      if (!project) { json(res, 400, { error: 'Missing ?project=' }); return; }
      const viewName = requestUrl.searchParams.get('view');
      if (viewName && !['architecture', 'parity', 'code', 'change'].includes(viewName)) { json(res, 400, { error: 'Unsupported graph view' }); return; }
      try {
        const context = contextFromUrl(requestUrl);
        const query = requestUrl.searchParams.get('query') ?? undefined;
        const node = requestUrl.searchParams.get('node') ?? undefined;
        const projection = await viewerProjection({
          project,
          ...context,
          view: (viewName ?? 'architecture') as 'architecture' | 'parity' | 'code' | 'change',
          ...(query ? { query } : {}),
          ...(node ? { node } : {}),
          depth: numberParam(requestUrl, 'depth', 2),
          limit: numberParam(requestUrl, 'limit', 700),
        });
        json(res, 200, projection);
      } catch (error) {
        json(res, (error as any)?.status ?? 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (requestUrl.pathname !== '/mcp') { json(res, 404, { error: 'Not found' }); return; }
    if (!authorize(req, res)) return;
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { json(res, 415, { error: 'Content-Type must be application/json' }); return; }
    try {
      const body = await readJson(req);
      const classification = modernHeaders(req, body);
      if (classification.error) {
        json(res, 400, rpcError(body?.id ?? null, classification.error.code, classification.error.message, classification.error.data));
        return;
      }
      const result = await handleRpc(body, { modern: classification.modern });
      if (result.body === undefined) { res.writeHead(result.status); res.end(); return; }
      json(res, result.status, result.body);
    } catch (error) {
      const statusCode = (error as any)?.status ?? 500;
      const code = (error as any)?.rpcCode ?? -32603;
      json(res, statusCode, rpcError(null, code, error instanceof Error ? error.message : String(error)));
    }
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const platformPort = process.env.PORT;
  const host = process.env.DEVINT_HOST ?? (platformPort ? '0.0.0.0' : '127.0.0.1');
  const port = Number(platformPort ?? process.env.DEVINT_PORT ?? '8787');
  const server = createDevelopmentIntelligenceServer();
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(port, host, () => console.error(`Development Intelligence listening on http://${host}:${port}`));
}
