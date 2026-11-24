Failed to create stream fd: Operation not permitted
Failed to create stream fd: Operation not permitted
Failed to create stream fd: Operation not permitted
import { compareInteractionRevisions } from './intelligence/interactionParity.js';
import { comparisonSelection } from './intelligence/investigation.js';
import { repositoryAudit } from './intelligence/repositoryAudit.js';
import http from 'node:http';
import { computeOnly, previewRuntime } from './config/runtimeRole.js';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authMode, authorize, clearOwnerSession, normalizeReturnTo, ownerPasswordMatches, renderOwnerLogin, setOwnerSession, validateHost } from './auth.js';
import { callTool, listTools } from './mcp.js';
import { runtimeIdentity } from './runtimeIdentity.js';
import { currentGraph, graphSourceMetadata, machineGraphBuildStatus } from './intelligence/service.js';
import { localSourceGraphHistory } from './intelligence/localGraphStore.js';
import { localCapacity, localLifecycleStatus, startLocalOperation, updateLocalSettings } from './intelligence/localOperations.js';
import { compareRevisionSet, diffDefaultToSelected, diffRevisions, graphEvidence, pageGraphDiff, viewerProjection } from './intelligence/query.js';
import { exploreWorkbench, inspectEntity, projectOverview, queryWorkbenchRequest, scopeOrientation, workbenchProjects, workbenchSources } from './intelligence/workbench.js';
import { evaluateParityContract } from './intelligence/parityContract.js';
import { handleOAuthHttpRequest } from './oauthHttp.js';
import { renderCanonicalPortfolioResult, renderGraphViewer, renderProjectChooser, type WorkbenchProjectLink } from './viewer.js';
import { reconcileCanonicalPortfolio } from './intelligence/canonicalPortfolio.js';
import { reconcileCanonicalPortfolioIsolated } from './intelligence/canonicalReconcileWorker.js';
import type { TechnicalSourceCapability } from './types.js';
import { withVercelRequestContext } from './vercelRequestContext.js';
import { authenticateAccount } from './accounts/clerk.js';
import { WorkspaceStore } from './accounts/workspace.js';
import { renderAccountWorkbench } from './accounts/view.js';

const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const SUPPORTED_MODERN = [MODERN_VERSION];
const MAX_BODY = 4 * 1024 * 1024;
const SERVER_INFO = { name: 'Development Intelligence', version: '2.9.0' };
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
      instructions: 'Project-neutral technical intelligence. Development Intelligence builds one evidence-backed graph and exposes it through agent tools and a human Workbench. Overview, Inspector, Explore, Query, Sources, Change, Code, Architecture and Parity are projections over source/evidence truth. Caller-owned Parity Contracts are ephemeral expectation overlays and never replace Git/source authority.',
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
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
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

async function projectLinks(): Promise<{ projects: WorkbenchProjectLink[]; githubOwners: string[] }> {
  const data = await workbenchProjects() as any;
  return {
    projects: (data.projects ?? []).map((item: any) => ({ project: String(item.project), defaultRef: typeof item.defaultRef === 'string' ? item.defaultRef : undefined })),
    githubOwners: Array.isArray(data.githubOwners) ? data.githubOwners.filter((owner: unknown): owner is string => typeof owner === 'string') : [],
  };
}

function contextFromUrl(requestUrl: URL): { ref?: string; graphId?: string } {
  const ref = requestUrl.searchParams.get('ref') ?? undefined;
  const graphId = requestUrl.searchParams.get('graphId') ?? undefined;
  if (ref && graphId) throw Object.assign(new Error('Use either ref or graphId, not both'), { status: 400 });
  return { ...(ref ? { ref } : {}), ...(graphId ? { graphId } : {}) };
}

function changeCounts(diff: any): { added: number; removed: number; changed: number } {
  const semantic = diff?.semantic ?? diff;
  return {
    added: (semantic?.nodes?.added?.length ?? 0) + (semantic?.edges?.added?.length ?? 0),
    removed: (semantic?.nodes?.removed?.length ?? 0) + (semantic?.edges?.removed?.length ?? 0),
    changed: (semantic?.nodes?.changed?.length ?? 0) + (semantic?.edges?.changed?.length ?? 0),
  };
}

export function canonicalReconcileCronAuthorized(headers: Record<string, unknown>, secret = process.env.CRON_SECRET): boolean {
  const expected = typeof secret === 'string' ? secret.trim() : '';
  if (!expected) return false;
  const raw = headers.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw : '';
  return authorization === `Bearer ${expected}`;
}

export function createDevelopmentIntelligenceServer() {
  return http.createServer((req: any, res: any) => withVercelRequestContext(req.headers ?? {}, async () => {
    if (!validateHost(req, res)) return;
    const requestUrl = new URL(req.url ?? '/', 'http://development-intelligence.local');
    if (computeOnly() && (
      requestUrl.pathname === '/internal/reconcile-canonical'
      || requestUrl.pathname === '/workbench/reconcile-canonical'
    )) {
      json(res, 403, { error: 'This compute-only runtime cannot publish canonical source graphs', code: 'COMPUTE_ONLY_AUTHORITY_DENIED' });
      return;
    }
    if (requestUrl.pathname === '/health' && req.method === 'GET') {
      json(res, 200, { service: 'Development Intelligence', version: SERVER_INFO.version, status: 'ok', protocolVersions: SUPPORTED_MODERN, ...runtimeIdentity() });
      return;
    }
    if (requestUrl.pathname === '/account' && req.method === 'GET') {
      try { const page = renderAccountWorkbench(process.env.CLERK_PUBLISHABLE_KEY?.trim() ?? ''); res.writeHead(200, htmlHeaders()); res.end(page); }
      catch { json(res, 503, { error: 'Account sign-in is not configured' }); }
      return;
    }
    if (requestUrl.pathname === '/account/client-config' && req.method === 'GET') {
      const key = process.env.CLERK_PUBLISHABLE_KEY?.trim();
      const clientId = process.env.CLERK_DEVICE_CLIENT_ID?.trim();
      if (!key || !clientId) { json(res, 503, { error: 'Computer linking is not configured' }); return; }
      const encoded = key.split('_')[2];
      if (!encoded) { json(res, 503, { error: 'Account identity is not configured' }); return; }
      const host = Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/u, '');
      if (!/^[a-zA-Z0-9.-]+$/u.test(host)) { json(res, 503, { error: 'Invalid account identity configuration' }); return; }
      json(res, 200, { issuer: `https://${host}`, clientId }); return;
    }
    if (requestUrl.pathname === '/account/workspace') {
      try {
        const identity = await authenticateAccount(req, res);
        if (!identity) return;
        const store = new WorkspaceStore(identity.userId);
        if (req.method === 'GET') {
          const [projects, graphs, computers, layout, builds] = await Promise.all([store.projects(), store.graphs(), store.computers(), store.layout(), store.builds()]);
          json(res, 200, { projects, graphs, computers, layout, builds }); return;
        }
        if (req.method !== 'POST') { json(res, 405, { error: 'Use GET or POST' }); return; }
        if (identity.tokenType === 'session_token' && req.headers.origin !== new URL(process.env.DEVINT_PUBLIC_BASE_URL!).origin) {
          json(res, 403, { error: 'Account changes require the Workbench origin' }); return;
        }
        const body = await readJson(req);
        if (body.action === 'save-project' && identity.tokenType === 'session_token') { json(res, 200, await store.saveProject(body.project)); return; }
        if (body.action === 'save-graph' && identity.tokenType === 'session_token') { json(res, 200, await store.saveGraph(body.graph)); return; }
        if (body.action === 'save-layout' && identity.tokenType === 'session_token') { await store.saveLayout(body.layout); json(res, 200, { saved: true }); return; }
        if (body.action === 'build-graph' && identity.tokenType === 'session_token') { json(res, 200, await store.queueBuild(body.graphId)); return; }
        if (body.action === 'ask-graph' && identity.tokenType === 'session_token') { json(res, 200, await store.queueQuestion(body.graphId, body.question)); return; }
        if (body.action === 'link-computer' && identity.tokenType === 'oauth_token') { json(res, 200, await store.linkComputer(body.computer)); return; }
        if (body.action === 'computer-heartbeat' && identity.tokenType === 'oauth_token') { json(res, 200, await store.heartbeat(body.computerId, body.secret)); return; }
        if (body.action === 'computer-claim-build' && identity.tokenType === 'oauth_token') { json(res, 200, await store.claimBuild(body.computerId, body.secret)); return; }
        if (body.action === 'computer-update-build' && identity.tokenType === 'oauth_token') { await store.updateBuild(body.computerId, body.secret, body.jobId, body.update); json(res, 200, { saved: true }); return; }
        if (body.action === 'revoke-computer' && identity.tokenType === 'session_token') { await store.revokeComputer(body.computerId); json(res, 200, { revoked: true }); return; }
        json(res, 400, { error: 'Unsupported account operation' }); return;
      } catch (error) { json(res, (error as any)?.status ?? 500, { error: error instanceof Error ? error.message : String(error) }); return; }
    }
    if (requestUrl.pathname === '/workbench/graph-build') {
      if (!authorize(req, res)) return;
      try {
        if (req.method === 'GET') {
          const project = requestUrl.searchParams.get('project');
          if (!project) throw new Error('Missing project');
          json(res, 200, await machineGraphBuildStatus(project, requestUrl.searchParams.get('ref') ?? undefined, false, requestUrl.searchParams.get('revision') ?? undefined)); return;
        }
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (typeof body.project !== 'string' || !body.project.trim() || (body.ref !== undefined && typeof body.ref !== 'string')) throw new Error('Project and optional ref must be strings');
          json(res, 200, await machineGraphBuildStatus(body.project, body.ref, true)); return;
        }
        json(res, 405, { error: 'Use GET or POST' }); return;
      } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }); return; }
    }
    if (requestUrl.pathname === '/workbench/local' && process.env.DEVINT_LOCAL_SETTINGS) {
      if (!authorize(req, res)) return;
      try {
        if (req.method === 'GET') { json(res, 200, requestUrl.searchParams.get('action') === 'capacity' ? await localCapacity() : await localLifecycleStatus()); return; }
        if (req.method === 'POST') {
          const body = await readJson(req);
          const result = body.action === 'settings' ? await updateLocalSettings(body) : await startLocalOperation(body);
          json(res, 200, result); return;
        }
        json(res, 405, { error: 'Use GET or POST' }); return;
      } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }); return; }
    }
    if (requestUrl.pathname === '/internal/reconcile-canonical' && req.method === 'GET') {
      const cronSecret = process.env.CRON_SECRET?.trim();
      if (!cronSecret) {
        json(res, 503, { error: 'Canonical reconciliation cron is not configured' });
        return;
      }
      if (!canonicalReconcileCronAuthorized(req.headers ?? {}, cronSecret)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      try {
        const result = await reconcileCanonicalPortfolioIsolated({
          rotationEpochMs: Date.now(),
          rotationIntervalMs: 5 * 60_000,
        });
        json(res, 200, { trigger: 'vercel-cron', ...result });
      } catch (error) {
        json(res, (error as any)?.status ?? 500, {
          error: error instanceof Error ? error.message : String(error),
          trigger: 'vercel-cron',
        });
      }
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
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
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
        const links = await projectLinks();
        const project = requestUrl.searchParams.get('project');
        if (!project) {
          res.writeHead(200, htmlHeaders());
          res.end(renderProjectChooser(links.projects, links.githubOwners, !computeOnly() && !previewRuntime()));
          return;
        }
        const context = contextFromUrl(requestUrl);
        const machine = Boolean(process.env.DEVINT_MACHINE_GRAPH_DIR?.trim()) && previewRuntime() && !context.graphId;
        const build = machine ? await machineGraphBuildStatus(project, context.ref, true) : null;
        const graph = machine && build?.state !== 'complete'
          ? { project, repositoryRevision: String(build!.revision) }
          : await graphSourceMetadata(project, context.ref, context.graphId);
        res.writeHead(200, htmlHeaders());
        res.end(renderGraphViewer(graph, context.ref, context.graphId, links.projects, machine));
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
    if (requestUrl.pathname === '/workbench/reconcile-canonical' && req.method === 'POST') {
      if (!authorize(req, res, { interactive: true })) return;
      try {
        const form = await readForm(req);
        if (form.get('confirm') !== 'reconcile-current') {
          throw Object.assign(new Error('Canonical reconcile requires explicit owner confirmation'), { status: 400 });
        }
        const limitRaw = Number(form.get('limit') ?? '12');
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 25) : 12;
        const result = await reconcileCanonicalPortfolio({ limit });
        res.writeHead(200, htmlHeaders());
        res.end(renderCanonicalPortfolioResult(result));
      } catch (error) {
        res.writeHead((error as any)?.status ?? 500, htmlHeaders());
        res.end(renderCanonicalPortfolioResult({
          error: error instanceof Error ? error.message : String(error),
          counts: { error: 1 },
          items: [],
        }));
      }
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
        } else if (action === 'relationship') {
          const edge = requestUrl.searchParams.get('edge');
          if (!edge) throw Object.assign(new Error('Missing ?edge='), { status: 400 });
          result = await graphEvidence({ project, edge, ...context });
        } else if (action === 'explore') {
          result = await exploreWorkbench({ project, query: requestUrl.searchParams.get('query') ?? undefined, limit: numberParam(requestUrl, 'limit', 250), ...context });
        } else if (action === 'audit') result = await repositoryAudit({ project, ...context, offset: numberParam(requestUrl, 'offset', 0), limit: numberParam(requestUrl, 'limit', 20) });
        else if (action === 'sources') result = await workbenchSources(project, context.ref, context.graphId);
        else if (action === 'interaction-parity') {
          const baseRef = requestUrl.searchParams.get('baseRef') ?? 'main';
          const ref = requestUrl.searchParams.get('headRef') ?? 'preview';
          result = await compareInteractionRevisions({ project, baseRef, ref, scope: requestUrl.searchParams.get('scope') ?? undefined, offset: numberParam(requestUrl, 'offset', 0), limit: numberParam(requestUrl, 'limit', 20) });
        } else if (action === 'compare-graphs') {
          const refs = requestUrl.searchParams.getAll('refs');
          const offset = Number(requestUrl.searchParams.get('offset') ?? 0), limit = Number(requestUrl.searchParams.get('limit') ?? 50);
          result = await compareRevisionSet({ project, refs: refs.length ? refs : ['main', 'preview', 'working-tree'], offset, limit });
        } else if (action === 'changes') {
          if (context.graphId) throw Object.assign(new Error('Choose revision selectors to compare source states'), { status: 400 });
          let baseRef = requestUrl.searchParams.get('baseRef') ?? undefined;
          let headRef = requestUrl.searchParams.get('headRef') ?? context.ref;
          if (!baseRef && process.env.DEVINT_LOCAL_GRAPH_DIR) {
            const catalog = await localSourceGraphHistory(process.env.DEVINT_LOCAL_GRAPH_DIR, project);
            baseRef = catalog?.targets?.preview ? 'preview' : catalog?.targets?.main ? 'main' : undefined;
            if (baseRef && !headRef) headRef = 'working-tree';
          }
          const detail = baseRef
            ? await diffRevisions({ project, baseRef, ...(headRef ? { ref: headRef } : {}) })
            : await diffDefaultToSelected(project, headRef);
          const counts = changeCounts(detail);
          const historical = Boolean(baseRef);
          const offsetValue = Number(requestUrl.searchParams.get('offset') ?? 0);
          const limitValue = Number(requestUrl.searchParams.get('limit') ?? 50);
          const paged = process.env.DEVINT_LOCAL_GRAPH_DIR
            ? pageGraphDiff(detail, Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0,
              Number.isSafeInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 500) : 50) : null;
          const selectionDetail = paged?.detail ?? detail;
          const [baseGraph, headGraph] = await Promise.all([
            currentGraph(project, undefined, (detail as any).base.graphId),
            currentGraph(project, undefined, (detail as any).head.graphId),
          ]);
          result = {
            investigations: [comparisonSelection(baseGraph, selectionDetail, 'base', paged?.page), comparisonSelection(headGraph, selectionDetail, 'head', paged?.page)],
            project,
            mode: historical ? 'revision-to-revision' : 'default-to-selected',
            counts,
            summary: counts.added || counts.removed || counts.changed
              ? `${counts.added} added, ${counts.removed} removed, ${counts.changed} changed ${historical ? 'graph' : 'semantic'} records.`
              : historical ? 'The selected revisions have no graph changes.' : 'The default and selected source states have no semantic changes.',
            detail: paged?.detail ?? detail,
            ...(paged ? { page: paged.page } : {}),
          };
        } else if (action === 'semantics') {
          result = await scopeOrientation({ project, ...context, semanticDepth: 'expanded', limit: numberParam(requestUrl, 'limit', 25) });
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
        const text = typeof body.text === 'string' && body.text.trim() ? body.text : undefined;
        const questions = Array.isArray(body.questions) ? body.questions.filter((value: unknown) => typeof value === 'string') as string[] : undefined;
        if (!text && !questions?.length) throw Object.assign(new Error('text or questions must be non-empty'), { status: 400 });
        if (text && questions?.length) throw Object.assign(new Error('provide text or questions, not both'), { status: 400 });
        const result = await queryWorkbenchRequest({
          project: body.project,
          ...(text ? { text } : {}),
          ...(questions?.length ? { questions } : {}),
          ref: typeof body.ref === 'string' ? body.ref : undefined,
          graphId: typeof body.graphId === 'string' ? body.graphId : undefined,
          sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
          capability: typeof body.capability === 'string' ? body.capability as TechnicalSourceCapability : undefined,
          scope: typeof body.scope === 'string' ? body.scope : undefined,
          rankBy: typeof body.rankBy === 'string' ? body.rankBy as any : undefined,
          offset: typeof body.offset === 'number' ? body.offset : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
          nodeKinds: Array.isArray(body.nodeKinds) ? body.nodeKinds.filter((item: unknown) => typeof item === 'string') : undefined,
          relationshipKinds: Array.isArray(body.relationshipKinds) ? body.relationshipKinds.filter((item: unknown) => typeof item === 'string') : undefined,
          statuses: Array.isArray(body.statuses) ? body.statuses.filter((item: unknown) => typeof item === 'string') : undefined,
          direction: ['inbound', 'outbound', 'both'].includes(body.direction) ? body.direction : undefined,
          comparisonIds: Array.isArray(body.comparisonIds) ? body.comparisonIds.filter((item: unknown) => typeof item === 'string') : undefined,
          comparisonScope: typeof body.comparisonScope === 'string' ? body.comparisonScope : undefined,
          comparisonKinds: Array.isArray(body.comparisonKinds) ? body.comparisonKinds.filter((item: unknown) => typeof item === 'string') : undefined,
          conditionContains: typeof body.conditionContains === 'string' ? body.conditionContains : undefined,
          conditionTruth: typeof body.conditionTruth === 'boolean' ? body.conditionTruth : undefined,
          effectKinds: Array.isArray(body.effectKinds) ? body.effectKinds.filter((item: unknown) => typeof item === 'string') : undefined,
          depth: typeof body.depth === 'number' ? body.depth : undefined,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, (error as any)?.status ?? 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (requestUrl.pathname === '/workbench/parity' && req.method === 'POST') {
      if (!authorize(req, res)) return;
      try {
        const body = await readJson(req);
        if (typeof body.project !== 'string' || !body.project) throw Object.assign(new Error('project must be non-empty'), { status: 400 });
        const result = await evaluateParityContract({
          project: body.project,
          ref: typeof body.ref === 'string' ? body.ref : undefined,
          graphId: typeof body.graphId === 'string' ? body.graphId : undefined,
          contract: body.contract,
        });
        json(res, 200, result);
      } catch (error) {
        json(res, (error as any)?.status ?? 400, { error: error instanceof Error ? error.message : String(error) });
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
  }));
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
