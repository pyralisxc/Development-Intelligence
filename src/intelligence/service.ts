import { getProjectConfig } from '../config/registry.js';
import type { EvidenceRecord, GraphEdge, GraphNode, IntelligenceGraph, SourceDescriptor } from '../types.js';
import { stableHash } from '../util/hash.js';
import { withProjectCheckout, resolveProjectRevision } from '../source/git.js';
import { analyzeHtml, analyzeJson } from './analyzers/index.js';
import { checkpointAnalyzerCurrent, checkpointToGraph, readCheckpoint } from './checkpoint.js';
import { buildRepositoryGraph } from './repository.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from './resolver.js';

const MAX_RUNTIME_BYTES = Number(process.env.DEVINT_GRAPH_MAX_RUNTIME_BYTES ?? process.env.DEVINT_PARITY_MAX_RUNTIME_BYTES ?? 2_000_000);

interface CachedRepositoryGraph {
  graph: IntelligenceGraph;
  accepted: IntelligenceGraph | null;
  acceptedCurrent: boolean;
  touchedAt: number;
}

const repositoryCache = new Map<string, Promise<CachedRepositoryGraph>>();
const latestGraphByProject = new Map<string, IntelligenceGraph>();

function cacheKey(project: string, sha: string): string { return `${project}:${sha}`; }

async function pruneCache(): Promise<void> {
  const max = Math.max(1, Number(process.env.DEVINT_GRAPH_CACHE_SIZE ?? 6));
  if (repositoryCache.size <= max) return;
  const entries = [...repositoryCache.entries()];
  const hydrated = await Promise.all(entries.map(async ([key, promise]) => [key, await promise] as const));
  hydrated.sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  while (repositoryCache.size > max && hydrated.length) repositoryCache.delete(hydrated.shift()![0]);
}

async function buildCachedRepositoryGraph(project: string, ref?: string): Promise<CachedRepositoryGraph> {
  const revision = await resolveProjectRevision(project, ref);
  const key = cacheKey(project, revision.sha);
  let promise = repositoryCache.get(key);
  if (!promise) {
    promise = withProjectCheckout(project, revision.ref, async checkout => {
      const graph = await buildRepositoryGraph({
        project,
        repository: checkout.repository,
        revision: checkout.sha,
        root: checkout.root,
        role: 'W',
      });
      const checkpoint = await readCheckpoint(checkout.root);
      const accepted = checkpoint ? checkpointToGraph({ project, repository: checkout.repository, revision: checkout.sha, checkpoint }) : null;
      const sourceCurrent = Boolean(accepted?.sourceFingerprint && accepted.sourceFingerprint === graph.sourceFingerprint);
      const analyzerCurrent = Boolean(checkpoint && checkpointAnalyzerCurrent(checkpoint.meta));
      const topologyCurrent = Boolean(checkpoint?.meta.schemaVersion === 2 && checkpoint.meta.topologyFingerprint === graph.topologyFingerprint);
      return {
        graph,
        accepted,
        acceptedCurrent: sourceCurrent && analyzerCurrent && topologyCurrent,
        touchedAt: Date.now(),
      };
    });
    repositoryCache.set(key, promise);
    promise.catch(() => { if (repositoryCache.get(key) === promise) repositoryCache.delete(key); });
  }
  const value = await promise;
  value.touchedAt = Date.now();
  await pruneCache();
  return value;
}

function runtimeHeaders(projectHeaders: Array<{ name: string; valueEnv: string }> | undefined): HeadersInit {
  const headers: Record<string, string> = {};
  for (const item of projectHeaders ?? []) {
    const value = process.env[item.valueEnv];
    if (!value) throw new Error(`Missing configured runtime credential environment variable: ${item.valueEnv}`);
    headers[item.name] = value;
  }
  return headers;
}

async function scanRuntimeUrl(project: string, urlText: string): Promise<{ source: SourceDescriptor; nodes: GraphNode[]; edges: GraphEdge[]; evidence: EvidenceRecord[] }> {
  const config = await getProjectConfig(project);
  const requested = new URL(urlText);
  const allowed = new Set((config.runtimeOrigins ?? []).map(value => new URL(value).origin));
  if (!allowed.has(requested.origin)) throw new Error(`Runtime origin is not allowlisted for ${project}: ${requested.origin}`);
  if (!['http:', 'https:'].includes(requested.protocol) || requested.username || requested.password) throw new Error('Runtime URL must be credential-free HTTP(S)');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DEVINT_RUNTIME_TIMEOUT_MS ?? 15_000));
  const observedAt = new Date().toISOString();
  try {
    let current = requested;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!allowed.has(current.origin)) throw new Error(`Runtime redirect origin is not allowlisted for ${project}: ${current.origin}`);
      response = await fetch(current, { method: 'GET', headers: runtimeHeaders(config.runtimeHeaders), redirect: 'manual', signal: controller.signal });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) break;
      const next = new URL(location, current);
      if (next.username || next.password) throw new Error('Runtime redirect URL must not contain credentials');
      if ((config.runtimeHeaders?.length ?? 0) > 0 && next.origin !== requested.origin) throw new Error('Authenticated runtime redirects must remain on the originally requested origin');
      current = next;
      if (redirects === 5) throw new Error('Runtime redirect limit exceeded');
    }
    if (!response) throw new Error('Runtime request produced no response');
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RUNTIME_BYTES) throw new Error(`Runtime response exceeds ${MAX_RUNTIME_BYTES} bytes`);
    const text = new TextDecoder().decode(body);
    const revision = response.headers.get('etag') ?? response.headers.get('last-modified');
    const source: SourceDescriptor = { id: `runtime:${requested.href}`, kind: 'runtime-http', locator: requested.href, revision, observedAt, available: true };
    const statusNode: GraphNode = {
      id: stableHash([source.id, 'http-status']),
      sourceId: source.id,
      kind: 'http-status',
      locator: `${requested.href}:status`,
      field: 'status',
      name: String(response.status),
      value: response.status,
      raw: String(response.status),
      layer: 'representation',
      checkpoint: false,
    };
    const contentType = response.headers.get('content-type') ?? '';
    const result = /text\/html/i.test(contentType)
      ? analyzeHtml({ source, text, locatorBase: requested.href })
      : /application\/(?:[^;]+\+)?json/i.test(contentType)
        ? analyzeJson({ source, text, locatorBase: requested.href })
        : { observations: [], resolutions: [], evidence: [] };
    return { source, nodes: [statusNode, ...result.observations.map(node => ({ ...node, layer: node.layer ?? 'representation', checkpoint: false }))], edges: result.resolutions.map(edge => ({ ...edge, layer: edge.layer ?? 'representation', checkpoint: false })), evidence: result.evidence ?? [] };
  } catch (error) {
    return {
      source: { id: `runtime:${requested.href}`, kind: 'runtime-http', locator: requested.href, revision: null, observedAt, available: false, error: error instanceof Error ? error.message : String(error) },
      nodes: [],
      edges: [],
      evidence: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function scanGraph(project: string, options: { ref?: string | undefined; urls?: string[] } = {}): Promise<IntelligenceGraph> {
  const repository = await buildCachedRepositoryGraph(project, options.ref);
  const createdAt = new Date().toISOString();
  const sources = [...repository.graph.sources];
  const nodes = [...repository.graph.nodes];
  const evidence = [...repository.graph.evidence];
  let edges = [...repository.graph.edges];
  for (const url of options.urls ?? []) {
    const runtime = await scanRuntimeUrl(project, url);
    sources.push(runtime.source);
    nodes.push(...runtime.nodes);
    edges.push(...runtime.edges);
    evidence.push(...runtime.evidence);
  }
  edges = resolveCrossSource(nodes, edges);
  const graph: IntelligenceGraph = {
    ...repository.graph,
    graphId: `working-${repository.graph.repositoryRevision?.slice(0, 12) ?? 'unknown'}-${stableHash([createdAt, nodes.length, edges.length]).slice(0, 8)}`,
    role: 'W',
    createdAt,
    sources,
    evidence,
    nodes,
    edges,
    namingDivergences: deriveNamingDivergences(nodes, edges),
    unmatchedNodeIds: deriveUnmatched(nodes, edges),
    unavailableSourceIds: sources.filter(source => !source.available).map(source => source.id),
  };
  latestGraphByProject.set(project, graph);
  return graph;
}

export async function repositoryGraphs(project: string, ref?: string): Promise<{ accepted: IntelligenceGraph | null; working: IntelligenceGraph; acceptedCurrent: boolean }> {
  const value = await buildCachedRepositoryGraph(project, ref);
  latestGraphByProject.set(project, value.graph);
  return { accepted: value.accepted, working: value.graph, acceptedCurrent: value.acceptedCurrent };
}

export async function currentGraph(project: string, ref?: string): Promise<IntelligenceGraph> {
  const revision = await resolveProjectRevision(project, ref);
  const cached = latestGraphByProject.get(project);
  if (cached?.repositoryRevision === revision.sha) return cached;
  return (await repositoryGraphs(project, revision.ref)).working;
}

export function clearGraphCache(project?: string): void {
  if (!project) {
    repositoryCache.clear();
    latestGraphByProject.clear();
    return;
  }
  for (const key of [...repositoryCache.keys()]) if (key.startsWith(`${project}:`)) repositoryCache.delete(key);
  latestGraphByProject.delete(project);
}

export async function graphStatus(project: string, ref?: string): Promise<Record<string, unknown>> {
  const revision = await resolveProjectRevision(project, ref);
  const graphs = await repositoryGraphs(project, revision.ref);
  const semanticNodes = graphs.working.nodes.filter(node => node.layer === 'semantic').length;
  const semanticEdges = graphs.working.edges.filter(edge => edge.layer === 'semantic').length;
  return {
    project,
    repository: revision.repository,
    ref: revision.ref,
    revision: revision.sha,
    analyzerVersion: graphs.working.analyzerVersion,
    accepted: graphs.accepted ? {
      graphId: graphs.accepted.graphId,
      sourceFingerprint: graphs.accepted.sourceFingerprint,
      topologyFingerprint: graphs.accepted.topologyFingerprint,
      analyzerVersion: graphs.accepted.analyzerVersion,
      current: graphs.acceptedCurrent,
      nodes: graphs.accepted.nodes.length,
      edges: graphs.accepted.edges.length,
    } : null,
    working: {
      graphId: graphs.working.graphId,
      sourceFingerprint: graphs.working.sourceFingerprint,
      topologyFingerprint: graphs.working.topologyFingerprint,
      evidenceFingerprint: graphs.working.evidenceFingerprint,
      nodes: graphs.working.nodes.length,
      edges: graphs.working.edges.length,
      semanticNodes,
      semanticEdges,
      evidenceRecords: graphs.working.evidence.length,
      coverage: graphs.working.coverage,
    },
  };
}
