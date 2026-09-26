import { getProjectConfig } from '../config/registry.js';
import type { EvidenceRecord, GraphCoverage, GraphEdge, GraphNode, IntelligenceGraph, SourceDescriptor } from '../types.js';
import { stableHash } from '../util/hash.js';
import { revisionIdentity, withResolvedProjectCheckoutObserved, resolveProjectRevision, type ProjectCheckoutTiming, type ProjectRevision } from '../source/git.js';
import { analyzeHtml, analyzeJson } from './analyzers/index.js';
import { AsyncGate, cacheEntryLimitSetting, graphRecordWeight, positiveIntegerSetting, retentionEvictions, type RetentionItem } from './capacity.js';
import { checkpointAnalyzerCurrent, checkpointToGraph, readCheckpoint } from './checkpoint.js';
import { assertGraphIntegrity } from './integrity.js';
import { buildRepositoryGraph } from './repository.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from './resolver.js';
import { toolExecutionDiagnostics } from '../observability.js';
import { loadCanonicalGraph, makeCanonicalGraphRecord, saveCanonicalGraph, type CanonicalPersistenceDiagnostics } from './canonicalStore.js';

const MAX_RUNTIME_BYTES = Number(process.env.DEVINT_GRAPH_MAX_RUNTIME_BYTES ?? process.env.DEVINT_PARITY_MAX_RUNTIME_BYTES ?? 2_000_000);

export interface GraphCurrentness {
  acceptedSemanticCurrent: boolean;
  sourceCurrent: boolean;
  topologyCurrent: boolean;
  evidenceCurrent: boolean;
  analyzerCurrent: boolean;
  schemaSupported: boolean;
  integrityCurrent: boolean;
  checkpointError: string | null;
}

export interface GraphColdBuildTiming {
  queueWaitMs: number;
  graphBuildMs: number;
  checkpointReadMs: number;
  acceptedProjectionMs: number;
  checkout: ProjectCheckoutTiming;
  totalMs: number;
}

export interface GraphAccessTiming {
  cacheState: 'hit' | 'miss' | 'coalesced';
  revisionResolutionMs: number;
  graphLoadMs: number;
  totalMs: number;
  persistence: CanonicalPersistenceDiagnostics;
}

interface CachedRepositoryGraph {
  graph: IntelligenceGraph;
  accepted: IntelligenceGraph | null;
  currentness: GraphCurrentness;
  revision: ProjectRevision;
  touchedAt: number;
  buildTiming: GraphColdBuildTiming | null;
  persistence: CanonicalPersistenceDiagnostics;
}

interface RepositoryGraphAccess extends CachedRepositoryGraph {
  accessTiming: GraphAccessTiming;
}

interface SnapshotGraph {
  graph: IntelligenceGraph;
  revision: ProjectRevision;
  touchedAt: number;
}

interface RepositoryCacheEntry {
  promise: Promise<CachedRepositoryGraph>;
  value?: CachedRepositoryGraph;
}

const repositoryCache = new Map<string, RepositoryCacheEntry>();
const snapshotCache = new Map<string, SnapshotGraph>();
const repositoryBuildGate = new AsyncGate(() => positiveIntegerSetting(process.env.DEVINT_GRAPH_BUILD_CONCURRENCY, 1, 'DEVINT_GRAPH_BUILD_CONCURRENCY'));

function cacheKey(project: string, sha: string): string { return `${project}:${sha}`; }
function repositoryRetentionId(key: string): string { return `repository:${key}`; }
function snapshotRetentionId(key: string): string { return `snapshot:${key}`; }

function repositoryRetentionItems(protectedId?: string): RetentionItem[] {
  return [...repositoryCache.entries()].flatMap(([key, entry]) => entry.value ? [{
    id: repositoryRetentionId(key),
    records: graphRecordWeight(entry.value.graph) + graphRecordWeight(entry.value.accepted),
    touchedAt: entry.value.touchedAt,
    protected: repositoryRetentionId(key) === protectedId,
  }] : []);
}

function snapshotRetentionItems(protectedId?: string): RetentionItem[] {
  return [...snapshotCache.entries()].map(([key, entry]) => ({
    id: snapshotRetentionId(key),
    records: graphRecordWeight(entry.graph),
    touchedAt: entry.touchedAt,
    protected: snapshotRetentionId(key) === protectedId,
  }));
}

function deleteRetentionItem(id: string): void {
  if (id.startsWith('repository:')) repositoryCache.delete(id.slice('repository:'.length));
  if (id.startsWith('snapshot:')) snapshotCache.delete(id.slice('snapshot:'.length));
}

function pruneGraphCaches(protectedId?: string): void {
  const repositoryMax = cacheEntryLimitSetting(process.env.DEVINT_GRAPH_CACHE_SIZE, 6, 'DEVINT_GRAPH_CACHE_SIZE');
  const snapshotMax = cacheEntryLimitSetting(process.env.DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE, 12, 'DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE');
  const maxRecords = positiveIntegerSetting(process.env.DEVINT_GRAPH_CACHE_MAX_RECORDS, 150_000, 'DEVINT_GRAPH_CACHE_MAX_RECORDS');

  for (const id of retentionEvictions(repositoryRetentionItems(protectedId), { maxEntries: repositoryMax, maxRecords: Number.MAX_SAFE_INTEGER })) deleteRetentionItem(id);
  for (const id of retentionEvictions(snapshotRetentionItems(protectedId), { maxEntries: snapshotMax, maxRecords: Number.MAX_SAFE_INTEGER })) deleteRetentionItem(id);
  const combined = [...repositoryRetentionItems(protectedId), ...snapshotRetentionItems(protectedId)];
  for (const id of retentionEvictions(combined, { maxEntries: Number.MAX_SAFE_INTEGER, maxRecords })) deleteRetentionItem(id);
}

function emptyCurrentness(checkpointError: string | null = null): GraphCurrentness {
  return {
    acceptedSemanticCurrent: false,
    sourceCurrent: false,
    topologyCurrent: false,
    evidenceCurrent: false,
    analyzerCurrent: false,
    schemaSupported: false,
    integrityCurrent: false,
    checkpointError,
  };
}

function compactCoverage(coverage: GraphCoverage | undefined): Omit<GraphCoverage, 'files'> | null {
  if (!coverage) return null;
  const { files: _files, ...summary } = coverage;
  return summary;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

async function buildCachedRepositoryGraph(project: string, ref?: string): Promise<RepositoryGraphAccess> {
  const accessStarted = Date.now();
  const resolutionStarted = Date.now();
  const revision = await resolveProjectRevision(project, ref);
  const revisionResolutionMs = elapsedMs(resolutionStarted);
  const config = await getProjectConfig(project);
  const canonicalEligible = ref === undefined || ref === config.defaultRef;
  const key = cacheKey(project, revision.sha);
  let entry = repositoryCache.get(key);
  const cacheState: GraphAccessTiming['cacheState'] = entry ? (entry.value ? 'hit' : 'coalesced') : 'miss';
  if (!entry) {
    const created = {} as RepositoryCacheEntry;
    const queuedAt = Date.now();
    created.promise = repositoryBuildGate.run(async () => {
      const gateStarted = Date.now();
      const queueWaitMs = Math.max(0, gateStarted - queuedAt);

      if (canonicalEligible) {
        const loaded = await loadCanonicalGraph({ project, repository: revision.repository, revision: revision.sha });
        if (loaded.record) {
          return {
            graph: loaded.record.working,
            accepted: loaded.record.accepted,
            currentness: loaded.record.currentness,
            revision,
            touchedAt: Date.now(),
            buildTiming: null,
            persistence: loaded.diagnostics,
          } satisfies CachedRepositoryGraph;
        }

        let graphBuildMs = 0;
        let checkpointReadMs = 0;
        let acceptedProjectionMs = 0;
        const observed = await withResolvedProjectCheckoutObserved(revision, async checkout => {
          const graphBuildStarted = Date.now();
          const graph = await buildRepositoryGraph({
            project,
            repository: checkout.repository,
            revision: checkout.sha,
            root: checkout.root,
            role: 'W',
          });
          assertGraphIntegrity(graph);
          graphBuildMs = elapsedMs(graphBuildStarted);

          let checkpoint = null;
          let checkpointError: string | null = null;
          const checkpointReadStarted = Date.now();
          try {
            checkpoint = await readCheckpoint(checkout.root);
          } catch (error) {
            checkpointError = error instanceof Error ? error.message : String(error);
          }
          checkpointReadMs = elapsedMs(checkpointReadStarted);

          const acceptedProjectionStarted = Date.now();
          const accepted = checkpoint ? checkpointToGraph({ project, repository: checkout.repository, revision: checkout.sha, checkpoint }) : null;
          if (accepted) assertGraphIntegrity(accepted);
          let currentness = emptyCurrentness(checkpointError);
          if (checkpoint) {
            const sourceCurrent = checkpoint.meta.sourceFingerprint === graph.sourceFingerprint;
            const analyzerCurrent = checkpointAnalyzerCurrent(checkpoint.meta);
            const topologyCurrent = checkpoint.meta.schemaVersion === 2 && checkpoint.meta.topologyFingerprint === graph.topologyFingerprint;
            const evidenceCurrent = checkpoint.meta.schemaVersion === 2 && checkpoint.meta.evidenceFingerprint === graph.evidenceFingerprint;
            const schemaSupported = checkpoint.meta.schemaVersion === 2;
            const integrityCurrent = checkpoint.integrity.countsValid && checkpoint.integrity.topologyValid !== false;
            currentness = {
              acceptedSemanticCurrent: sourceCurrent && topologyCurrent && schemaSupported && integrityCurrent,
              sourceCurrent,
              topologyCurrent,
              evidenceCurrent,
              analyzerCurrent,
              schemaSupported,
              integrityCurrent,
              checkpointError,
            };
          }
          acceptedProjectionMs = elapsedMs(acceptedProjectionStarted);
          return { graph, accepted, currentness };
        });
        const record = makeCanonicalGraphRecord({
          project,
          repository: revision.repository,
          revision: revision.sha,
          working: observed.value.graph,
          accepted: observed.value.accepted,
          currentness: observed.value.currentness,
        });
        const saved = await saveCanonicalGraph(record);
        return {
          ...observed.value,
          revision,
          touchedAt: Date.now(),
          buildTiming: {
            queueWaitMs,
            graphBuildMs,
            checkpointReadMs,
            acceptedProjectionMs,
            checkout: observed.timing,
            totalMs: elapsedMs(queuedAt),
          },
          persistence: {
            ...loaded.diagnostics,
            saveState: saved.saveState,
            saveMs: saved.saveMs,
            ...(saved.error ? { error: saved.error } : loaded.diagnostics.error ? { error: loaded.diagnostics.error } : {}),
          },
        } satisfies CachedRepositoryGraph;
      }

      let graphBuildMs = 0;
      let checkpointReadMs = 0;
      let acceptedProjectionMs = 0;
      const observed = await withResolvedProjectCheckoutObserved(revision, async checkout => {
        const graphBuildStarted = Date.now();
        const graph = await buildRepositoryGraph({
          project,
          repository: checkout.repository,
          revision: checkout.sha,
          root: checkout.root,
          role: 'W',
        });
        assertGraphIntegrity(graph);
        graphBuildMs = elapsedMs(graphBuildStarted);

        let checkpoint = null;
        let checkpointError: string | null = null;
        const checkpointReadStarted = Date.now();
        try {
          checkpoint = await readCheckpoint(checkout.root);
        } catch (error) {
          checkpointError = error instanceof Error ? error.message : String(error);
        }
        checkpointReadMs = elapsedMs(checkpointReadStarted);

        const acceptedProjectionStarted = Date.now();
        const accepted = checkpoint ? checkpointToGraph({ project, repository: checkout.repository, revision: checkout.sha, checkpoint }) : null;
        if (accepted) assertGraphIntegrity(accepted);
        let currentness = emptyCurrentness(checkpointError);
        if (checkpoint) {
          const sourceCurrent = checkpoint.meta.sourceFingerprint === graph.sourceFingerprint;
          const analyzerCurrent = checkpointAnalyzerCurrent(checkpoint.meta);
          const topologyCurrent = checkpoint.meta.schemaVersion === 2 && checkpoint.meta.topologyFingerprint === graph.topologyFingerprint;
          const evidenceCurrent = checkpoint.meta.schemaVersion === 2 && checkpoint.meta.evidenceFingerprint === graph.evidenceFingerprint;
          const schemaSupported = checkpoint.meta.schemaVersion === 2;
          const integrityCurrent = checkpoint.integrity.countsValid && checkpoint.integrity.topologyValid !== false;
          currentness = {
            acceptedSemanticCurrent: sourceCurrent && topologyCurrent && schemaSupported && integrityCurrent,
            sourceCurrent,
            topologyCurrent,
            evidenceCurrent,
            analyzerCurrent,
            schemaSupported,
            integrityCurrent,
            checkpointError,
          };
        }
        acceptedProjectionMs = elapsedMs(acceptedProjectionStarted);
        return { graph, accepted, currentness };
      });
      return {
        ...observed.value,
        revision,
        touchedAt: Date.now(),
        buildTiming: {
          queueWaitMs,
          graphBuildMs,
          checkpointReadMs,
          acceptedProjectionMs,
          checkout: observed.timing,
          totalMs: elapsedMs(queuedAt),
        },
        persistence: {
          mode: 'process-only',
          durable: false,
          loadState: 'not-configured',
          saveState: 'not-configured',
          loadMs: 0,
          saveMs: 0,
        },
      } satisfies CachedRepositoryGraph;
    }).then(value => {
      created.value = value;
      return value;
    });
    entry = created;
    repositoryCache.set(key, entry);
    entry.promise.catch(() => { if (repositoryCache.get(key) === created) repositoryCache.delete(key); });
  }
  const graphLoadStarted = Date.now();
  const value = await entry.promise;
  const graphLoadMs = elapsedMs(graphLoadStarted);
  value.touchedAt = Date.now();
  pruneGraphCaches(repositoryRetentionId(key));
  return {
    ...value,
    revision,
    accessTiming: {
      cacheState,
      revisionResolutionMs,
      graphLoadMs,
      totalMs: elapsedMs(accessStarted),
      persistence: value.persistence,
    },
  };
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
  const urls = options.urls ?? [];
  if (!urls.length) return repository.graph;

  const createdAt = new Date().toISOString();
  const sources = [...repository.graph.sources];
  const nodes = [...repository.graph.nodes];
  const evidence = [...repository.graph.evidence];
  let edges = [...repository.graph.edges];
  for (const url of urls) {
    const runtime = await scanRuntimeUrl(project, url);
    sources.push(runtime.source);
    nodes.push(...runtime.nodes);
    edges.push(...runtime.edges);
    evidence.push(...runtime.evidence);
  }
  edges = resolveCrossSource(nodes, edges);
  const graph: IntelligenceGraph = {
    ...repository.graph,
    graphId: `snapshot-${repository.graph.repositoryRevision?.slice(0, 12) ?? 'unknown'}-${stableHash([createdAt, ...urls, nodes.length, edges.length]).slice(0, 10)}`,
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
  assertGraphIntegrity(graph);
  snapshotCache.set(graph.graphId, { graph, revision: repository.revision, touchedAt: Date.now() });
  pruneGraphCaches(snapshotRetentionId(graph.graphId));
  return graph;
}

export async function repositoryGraphs(project: string, ref?: string): Promise<{ accepted: IntelligenceGraph | null; working: IntelligenceGraph; acceptedCurrent: boolean; currentness: GraphCurrentness }> {
  const value = await buildCachedRepositoryGraph(project, ref);
  return { accepted: value.accepted, working: value.graph, acceptedCurrent: value.currentness.acceptedSemanticCurrent, currentness: value.currentness };
}

export async function graphContext(project: string, options: { ref?: string; graphId?: string } = {}): Promise<{ graph: IntelligenceGraph; revision: ProjectRevision }> {
  if (options.ref && options.graphId) throw new Error('Use either ref or graphId, not both');
  if (options.graphId) {
    const snapshot = snapshotCache.get(options.graphId);
    if (snapshot?.graph.project === project) {
      snapshot.touchedAt = Date.now();
      return { graph: snapshot.graph, revision: snapshot.revision };
    }
    const canonical = /^repo-([0-9a-f]{40}|[0-9a-f]{64})-([0-9a-f]{10})$/u.exec(options.graphId);
    if (canonical) {
      const sha = canonical[1]!;
      let repository: CachedRepositoryGraph;
      try {
        repository = await buildCachedRepositoryGraph(project, `commit:${sha}`);
      } catch (error) {
        repository = await buildCachedRepositoryGraph(project);
        if (repository.revision.sha !== sha) throw error;
      }
      if (repository.graph.graphId !== options.graphId) throw new Error(`Canonical graph identifier does not match the current analyzer result: ${options.graphId}`);
      return { graph: repository.graph, revision: repository.revision };
    }
    throw new Error(`Runtime graph snapshot is unavailable or expired: ${options.graphId}`);
  }
  const repository = await buildCachedRepositoryGraph(project, options.ref);
  return { graph: repository.graph, revision: repository.revision };
}

export async function currentGraph(project: string, ref?: string, graphId?: string): Promise<IntelligenceGraph> {
  return (await graphContext(project, { ...(ref ? { ref } : {}), ...(graphId ? { graphId } : {}) })).graph;
}

export function clearGraphCache(project?: string): void {
  if (!project) {
    repositoryCache.clear();
    snapshotCache.clear();
    return;
  }
  for (const key of [...repositoryCache.keys()]) if (key.startsWith(`${project}:`)) repositoryCache.delete(key);
  for (const [key, snapshot] of [...snapshotCache.entries()]) if (snapshot.graph.project === project) snapshotCache.delete(key);
}

export function graphCacheDiagnostics(): Record<string, unknown> {
  const repository = repositoryRetentionItems();
  const snapshots = snapshotRetentionItems();
  return {
    scope: 'process',
    maxRetainedRecords: positiveIntegerSetting(process.env.DEVINT_GRAPH_CACHE_MAX_RECORDS, 150_000, 'DEVINT_GRAPH_CACHE_MAX_RECORDS'),
    retainedRecords: [...repository, ...snapshots].reduce((total, item) => total + item.records, 0),
    repository: {
      entries: repositoryCache.size,
      building: [...repositoryCache.values()].filter(entry => !entry.value).length,
      retainedRecords: repository.reduce((total, item) => total + item.records, 0),
      maxEntries: cacheEntryLimitSetting(process.env.DEVINT_GRAPH_CACHE_SIZE, 6, 'DEVINT_GRAPH_CACHE_SIZE'),
    },
    snapshots: {
      entries: snapshotCache.size,
      retainedRecords: snapshots.reduce((total, item) => total + item.records, 0),
      maxEntries: cacheEntryLimitSetting(process.env.DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE, 12, 'DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE'),
    },
    coldBuilds: repositoryBuildGate.status(),
  };
}

export async function graphStatus(project: string, ref?: string): Promise<Record<string, unknown>> {
  const repository = await buildCachedRepositoryGraph(project, ref);
  const graphs = { accepted: repository.accepted, working: repository.graph };
  const semanticNodes = graphs.working.nodes.filter(node => node.layer === 'semantic').length;
  const semanticEdges = graphs.working.edges.filter(edge => edge.layer === 'semantic').length;
  return {
    project,
    repository: repository.revision.repository,
    ref: repository.revision.ref,
    revision: repository.revision.sha,
    revisionIdentity: revisionIdentity(repository.revision),
    analyzerVersion: graphs.working.analyzerVersion,
    currentness: repository.currentness,
    accepted: graphs.accepted ? {
      graphId: graphs.accepted.graphId,
      sourceFingerprint: graphs.accepted.sourceFingerprint,
      topologyFingerprint: graphs.accepted.topologyFingerprint,
      evidenceFingerprint: graphs.accepted.evidenceFingerprint,
      analyzerVersion: graphs.accepted.analyzerVersion,
      current: repository.currentness.acceptedSemanticCurrent,
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
      explicitValueConflicts: graphs.working.explicitValueConflicts.length,
      coverage: compactCoverage(graphs.working.coverage),
    },
    cache: graphCacheDiagnostics(),
    observability: {
      graphAccess: repository.accessTiming,
      coldBuild: repository.buildTiming,
      lastToolCall: toolExecutionDiagnostics(project),
      persistence: repository.accessTiming.persistence,
    },
  };
}
