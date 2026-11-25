import { getProjectConfig } from '../config/registry.js';
import { isMainThread } from 'node:worker_threads';
import { assertProjectAccessCurrent, hasProjectAccess, projectAccessScopeKey, projectAccessSecret } from '../config/projectAccess.js';
import { computeOnly, previewRuntime } from '../config/runtimeRole.js';
import type { EvidenceRecord, GraphCoverage, GraphEdge, GraphNode, IntelligenceGraph, SourceDescriptor } from '../types.js';
import { stableHash } from '../util/hash.js';
import { revisionIdentity, withResolvedProjectCheckoutObserved, resolveProjectRevision, type ProjectCheckoutTiming, type ProjectRevision } from '../source/git.js';
import { analyzeHtml, analyzeJson } from './analyzers/index.js';
import { proveRuntimeDeployment } from './runtimeDeploymentProof.js';
import { sanitizeExternalPayload } from './externalSanitization.js';
import { resolution } from './model.js';
import { AsyncGate, cacheEntryLimitSetting, graphRecordWeight, positiveIntegerSetting, retentionEvictions, type RetentionItem } from './capacity.js';
import { assertGraphIntegrity } from './integrity.js';
import { ANALYZER_VERSION, buildRepositoryGraph } from './repository.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from './resolver.js';
import { toolExecutionDiagnostics } from '../observability.js';
import { loadCanonicalGraph, loadPreviewReplayGraph, makeCanonicalGraphRecord, replacePreviewReplayQueryArtifacts, saveCanonicalGraph, savePreviewReplayGraph, type CanonicalPersistenceDiagnostics, type CanonicalQueryArtifactGenerationRef } from './canonicalStore.js';
import {
  loadCanonicalQueryArtifactPointer,
  loadCanonicalQueryArtifacts,
  loadCanonicalQueryArtifactsFromPointer,
  loadCanonicalQueryDetailShardsFromPointer,
  publishCanonicalQueryArtifactPointer,
  publishCanonicalQueryArtifacts,
  releaseCanonicalQueryArtifactSlot,
  withPreviewQueryArtifactScope,
  QUERY_ARTIFACT_FORMAT_VERSION,
  type CanonicalQueryArtifactLoadResult,
  type CanonicalQueryArtifactPointer,
  type CanonicalQueryArtifactPointerPublishResult,
} from './queryArtifactStore.js';
import { candidateQueryBuckets, exactEvidenceQueryBuckets } from './queryArtifacts.js';
import { localSourceGraphHistory, readLocalSourceGraph, withLocalSourceGraphEnvelope } from './localGraphStore.js';
import { hasLocalGraphIndex } from './localGraphIndex.js';
import { machineGraphStoreRoot } from './machineGraphStore.js';

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
  checkout: ProjectCheckoutTiming;
  totalMs: number;
  strategy?: 'full' | 'incremental';
  changedFiles?: number;
  affectedFiles?: number;
  fallbackReason?: string;
}

export interface GraphAccessTiming {
  cacheState: 'hit' | 'miss' | 'coalesced';
  revisionResolutionMs: number;
  graphLoadMs: number;
  totalMs: number;
  persistence: CanonicalPersistenceDiagnostics;
}

export interface QueryArtifactPublicationDiagnostics {
  state: 'referenced' | 'stored' | 'not-configured' | 'error' | 'none';
  saveMs: number;
  ref: CanonicalQueryArtifactGenerationRef | null;
  error?: string;
}

export interface QueryArtifactShadowLoad {
  state: 'hit' | 'unavailable' | 'miss' | 'invalid' | 'error' | 'not-configured';
  loadMs: number;
  bucketIds: string[];
  index: CanonicalQueryArtifactLoadResult['index'] | null;
  shards: NonNullable<CanonicalQueryArtifactLoadResult['shards']>;
  pointer?: CanonicalQueryArtifactPointer;
  reason?: string;
}

interface CachedRepositoryGraph {
  graph: IntelligenceGraph;
  accepted: IntelligenceGraph | null;
  currentness: GraphCurrentness;
  revision: ProjectRevision;
  touchedAt: number;
  buildTiming: GraphColdBuildTiming | null;
  persistence: CanonicalPersistenceDiagnostics;
  queryArtifacts: QueryArtifactPublicationDiagnostics;
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
const localGraphCache = new Map<string, IntelligenceGraph>();
interface MachineBuild {
  state: 'queued' | 'running' | 'complete' | 'failed';
  progress: import('./producerInputs.js').GraphBuildProgress;
  startedAt: string;
  finishedAt?: string;
  graphId?: string;
  error?: string;
  promise: Promise<Record<string, unknown>>;
}
const machineBuilds = new Map<string, MachineBuild>();
const snapshotCache = new Map<string, SnapshotGraph>();
const repositoryBuildGate = new AsyncGate(() => positiveIntegerSetting(process.env.DEVINT_GRAPH_BUILD_CONCURRENCY, 1, 'DEVINT_GRAPH_BUILD_CONCURRENCY'));

type RepositoryCacheScope = 'canonical' | 'replay';
function cacheKey(project: string, sha: string, scope: RepositoryCacheScope = 'canonical'): string {
  return `${projectAccessScopeKey()}:${project}:${scope}:${sha}`;
}
function snapshotKey(graphId: string): string { return `${projectAccessScopeKey()}:${graphId}`; }
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

async function buildCachedRepositoryGraph(project: string, ref?: string, resolvedRevision?: ProjectRevision): Promise<RepositoryGraphAccess> {
  const accessStarted = Date.now();
  const resolutionStarted = Date.now();
  const revision = resolvedRevision ?? await resolveProjectRevision(project, ref);
  const revisionResolutionMs = elapsedMs(resolutionStarted);
  const config = await getProjectConfig(project);
  const canonicalEligible = !computeOnly() && !previewRuntime() && (ref === undefined || ref === config.defaultRef);
  const cacheScope: RepositoryCacheScope = canonicalEligible ? 'canonical' : 'replay';
  const key = cacheKey(project, revision.sha, cacheScope);
  let entry = repositoryCache.get(key);
  const cacheState: GraphAccessTiming['cacheState'] = entry ? (entry.value ? 'hit' : 'coalesced') : 'miss';
  if (!entry) {
    const created = {} as RepositoryCacheEntry;
    const queuedAt = Date.now();
    created.promise = repositoryBuildGate.run(async () => {
      const gateStarted = Date.now();
      const queueWaitMs = Math.max(0, gateStarted - queuedAt);

      // A completed read may keep its oversized graph warm for reuse. Apply
      // the existing budget before allocating another graph on Preview.
      if (previewRuntime()) pruneGraphCaches();

      if (canonicalEligible) {
        const loaded = await loadCanonicalGraph({ project, repository: revision.repository, revision: revision.sha });
        if (loaded.record) {
          let persistence = loaded.diagnostics;
          let queryArtifacts: CachedRepositoryGraph['queryArtifacts'] = loaded.record.queryArtifacts
            ? { state: 'referenced', saveMs: 0, ref: loaded.record.queryArtifacts }
            : { state: 'none', saveMs: 0, ref: null };

          if (loaded.diagnostics.durable && loaded.record.queryArtifacts?.artifactFormatVersion === QUERY_ARTIFACT_FORMAT_VERSION) {
            queryArtifacts = await ensureSavedQueryArtifactPointer(loaded.record.working, revision, loaded.record.queryArtifacts, true);
          }

          // Canonical W may predate the derived query-plane format. Backfill the
          // disposable generation from the already-valid stored graph without
          // rebuilding/advancing source truth or touching Git checkout state.
          if ((!loaded.record.queryArtifacts || loaded.record.queryArtifacts.artifactFormatVersion !== QUERY_ARTIFACT_FORMAT_VERSION)
            && loaded.diagnostics.durable) {
            const queryArtifactPublication = await publishCanonicalQueryArtifacts(
              loaded.record.working,
              loaded.record.queryArtifacts ?? null,
              { repository: revision.repository },
            );
            let saved = null;
            let queryPointerPublication = null;
            if (queryArtifactPublication.state === 'stored' && queryArtifactPublication.ref) {
              const migratedRecord = makeCanonicalGraphRecord({
                project,
                repository: revision.repository,
                revision: revision.sha,
                working: loaded.record.working,
                accepted: loaded.record.accepted,
                ...(loaded.record.legacyAcceptedParts ? { legacyAcceptedParts: loaded.record.legacyAcceptedParts } : {}),
                currentness: loaded.record.currentness,
                queryArtifacts: queryArtifactPublication.ref,
              });
              saved = await saveCanonicalGraph(migratedRecord);
              if (saved.saveState === 'stored') {
                queryPointerPublication = await publishCurrentQueryArtifactPointer(
                  loaded.record.working,
                  revision.repository,
                  queryArtifactPublication.ref,
                  loaded.record.queryArtifacts ?? null,
                );
              } else if (saved.saveState !== 'error') {
                await releaseCanonicalQueryArtifactSlot(project, queryArtifactPublication.ref).catch(() => false);
              }
            }
            if (saved) {
              persistence = {
                ...loaded.diagnostics,
                saveState: saved.saveState,
                saveMs: saved.saveMs,
                ...(saved.error
                  ? { error: saved.error }
                  : loaded.diagnostics.error
                    ? { error: loaded.diagnostics.error }
                    : {}),
              };
            }
            const migrationError = queryPointerPublication?.error
              ?? saved?.error
              ?? queryArtifactPublication.error;
            queryArtifacts = {
              state: queryPointerPublication?.state === 'error' || saved?.saveState === 'error'
                ? 'error'
                : queryArtifactPublication.state,
              saveMs: queryArtifactPublication.saveMs + (saved?.saveMs ?? 0) + (queryPointerPublication?.saveMs ?? 0),
              ref: queryArtifactPublication.ref,
              ...(migrationError ? { error: migrationError } : {}),
            };
          }

          return {
            graph: loaded.record.working,
            accepted: loaded.record.accepted,
            currentness: loaded.record.currentness,
            revision,
            touchedAt: Date.now(),
            buildTiming: null,
            persistence,
            queryArtifacts,
          } satisfies CachedRepositoryGraph;
        }

        let graphBuildMs = 0;
        const observed = await withResolvedProjectCheckoutObserved(revision, async checkout => {
          const graphBuildStarted = Date.now();
          const graph = await buildRepositoryGraph({
            project,
            repository: checkout.repository,
            revision: checkout.sha,
            root: checkout.root,
            role: 'W',
            disposableCheckout: true,
          });
          assertGraphIntegrity(graph);
          graphBuildMs = elapsedMs(graphBuildStarted);

          // Preserve old accepted records only as historical stored data. They
          // do not supply current source understanding or a review gate.
          const accepted = loaded.staleRecord?.accepted ?? null;
          const currentness = emptyCurrentness();
          return { graph, accepted, currentness };
        });
        const previousQueryArtifacts = loaded.staleRecord?.queryArtifacts ?? null;
        const queryArtifactPublication = await publishCanonicalQueryArtifacts(
          observed.value.graph,
          previousQueryArtifacts,
          { repository: revision.repository },
        );
        const record = makeCanonicalGraphRecord({
          project,
          repository: revision.repository,
          revision: revision.sha,
          working: observed.value.graph,
          accepted: observed.value.accepted,
          ...(loaded.staleRecord?.legacyAcceptedParts ? { legacyAcceptedParts: loaded.staleRecord.legacyAcceptedParts } : {}),
          currentness: observed.value.currentness,
          queryArtifacts: queryArtifactPublication.state === 'stored' ? queryArtifactPublication.ref : null,
        });
        const saved = await saveCanonicalGraph(record);
        let queryPointerPublication = null;
        if (saved.saveState === 'stored' && queryArtifactPublication.state === 'stored' && queryArtifactPublication.ref) {
          queryPointerPublication = await publishCurrentQueryArtifactPointer(
            observed.value.graph,
            revision.repository,
            queryArtifactPublication.ref,
            previousQueryArtifacts,
          );
        } else if (saved.saveState !== 'error' && queryArtifactPublication.state === 'stored' && queryArtifactPublication.ref) {
          await releaseCanonicalQueryArtifactSlot(project, queryArtifactPublication.ref).catch(() => false);
        }
        return {
          ...observed.value,
          revision,
          touchedAt: Date.now(),
          buildTiming: {
            queueWaitMs,
            graphBuildMs,
            checkout: observed.timing,
            totalMs: elapsedMs(queuedAt),
            strategy: 'full',
          },
          persistence: {
            ...loaded.diagnostics,
            saveState: saved.saveState,
            saveMs: saved.saveMs,
            ...(saved.error ? { error: saved.error } : loaded.diagnostics.error ? { error: loaded.diagnostics.error } : {}),
          },
          queryArtifacts: {
            state: queryPointerPublication?.state === 'error' ? 'error' : queryArtifactPublication.state,
            saveMs: queryArtifactPublication.saveMs + (queryPointerPublication?.saveMs ?? 0),
            ref: queryArtifactPublication.ref,
            ...(queryPointerPublication?.error
              ? { error: queryPointerPublication.error }
              : queryArtifactPublication.error
                ? { error: queryArtifactPublication.error }
                : {}),
          },
        } satisfies CachedRepositoryGraph;
      }

      const replay = previewRuntime()
        ? await loadPreviewReplayGraph({ project, repository: revision.repository, revision: revision.sha })
        : null;
      if (replay?.record) {
        let queryArtifacts: CachedRepositoryGraph['queryArtifacts'] = replay.record.queryArtifacts
          ? { state: 'referenced', saveMs: 0, ref: replay.record.queryArtifacts }
          : { state: 'none', saveMs: 0, ref: null };
        if (replay.diagnostics.durable) {
          queryArtifacts = await withPreviewQueryArtifactScope({ project, repository: revision.repository, revision: revision.sha }, async () => {
            const previous = replay.record!.queryArtifacts ?? null;
            if (previous?.artifactFormatVersion === QUERY_ARTIFACT_FORMAT_VERSION) {
              return await ensureSavedQueryArtifactPointer(replay.record!.working, revision, previous, false);
            }
            if (!replay.previewManifestEtag) return { state: 'error', saveMs: 0, ref: previous,
              error: 'Preview graph manifest version is unavailable' };
            const built = await publishCanonicalQueryArtifacts(replay.record!.working, previous, { repository: revision.repository });
            if (built.state !== 'stored' || !built.ref) return { state: 'error', saveMs: built.saveMs, ref: previous,
              error: built.error ?? 'Preview query generation could not be built' };
            const replacement = await replacePreviewReplayQueryArtifacts({ project, repository: revision.repository,
              revision: revision.sha, graphId: replay.record!.working.graphId }, built.ref, replay.previewManifestEtag);
            if (replacement.state === 'conflict') {
              await releaseCanonicalQueryArtifactSlot(project, built.ref).catch(() => false);
              const winner = await loadPreviewReplayGraph({ project, repository: revision.repository, revision: revision.sha });
              const winnerRef = winner.record?.queryArtifacts;
              if (winner.record && winnerRef?.artifactFormatVersion === QUERY_ARTIFACT_FORMAT_VERSION) {
                // Return the exact graph that owns the winning reference; the
                // same source revision can have different producer coverage.
                replay.record = winner.record;
                const pointer = await ensureSavedQueryArtifactPointer(winner.record.working, revision, winnerRef, false);
                return { ...pointer, saveMs: built.saveMs + replacement.saveMs + pointer.saveMs };
              }
              return { state: 'error', saveMs: built.saveMs + replacement.saveMs, ref: previous,
                error: 'Preview graph changed while its query generation was being published' };
            }
            if (replacement.state !== 'stored') return { state: 'error', saveMs: built.saveMs + replacement.saveMs,
              ref: previous, error: replacement.error ?? 'Preview graph generation reference could not be saved' };
            const pointer = await ensureSavedQueryArtifactPointer(replay.record!.working, revision, built.ref, false);
            return { ...pointer, saveMs: built.saveMs + replacement.saveMs + pointer.saveMs };
          });
        }
        return {
          graph: replay.record.working,
          accepted: null,
          currentness: replay.record.currentness,
          revision,
          touchedAt: Date.now(),
          buildTiming: null,
          persistence: replay.diagnostics,
          queryArtifacts,
        } satisfies CachedRepositoryGraph;
      }
      // A failed storage read is not a cache miss. Rebuilding here could
      // repeatedly perform the most expensive operation during an outage and
      // conceal the reason the existing generation could not be loaded.
      if (replay?.diagnostics.loadState === 'error') {
        throw new Error(`Preview replay graph could not be read: ${replay.diagnostics.error ?? 'storage unavailable'}`);
      }
      if (replay?.diagnostics.durable && isMainThread) {
        // Build in the same worker entrypoint used by local work and canonical
        // reconciliation. The worker publishes once; the caller resumes from
        // the graph it actually published rather than transferring a full graph.
        const { runPreviewGraphWorker } = await import('./canonicalReconcileWorker.js');
        const result = await runPreviewGraphWorker({ project, revision: revision.sha, ...(ref ? { ref } : {}) });
        const saved = await loadPreviewReplayGraph({ project, repository: revision.repository, revision: revision.sha });
        if (!saved.record || saved.record.working.graphId !== result.graphId) {
          throw new Error('Preview graph worker did not publish the selected graph generation');
        }
        const savedRef = saved.record.queryArtifacts;
        const queryArtifacts = savedRef?.artifactFormatVersion === QUERY_ARTIFACT_FORMAT_VERSION
          ? await withPreviewQueryArtifactScope({ project, repository: revision.repository, revision: revision.sha },
            () => ensureSavedQueryArtifactPointer(saved.record!.working, revision, savedRef, false))
          : { state: 'error' as const, saveMs: 0, ref: savedRef ?? null, error: 'Preview graph needs a current query generation' };
        return { graph: saved.record.working, accepted: null, currentness: saved.record.currentness,
          revision, touchedAt: Date.now(), buildTiming: (result.coldBuild as GraphColdBuildTiming | null) ?? null,
          persistence: saved.diagnostics, queryArtifacts } satisfies CachedRepositoryGraph;
      }
      let graphBuildMs = 0;
      const observed = await withResolvedProjectCheckoutObserved(revision, async checkout => {
        const graphBuildStarted = Date.now();
        const graph = await buildRepositoryGraph({
          project,
          repository: checkout.repository,
          revision: checkout.sha,
          root: checkout.root,
          role: 'W',
          disposableCheckout: true,
        });
        assertGraphIntegrity(graph);
        graphBuildMs = elapsedMs(graphBuildStarted);

        const accepted = null;
        const currentness = emptyCurrentness();
        return { graph, accepted, currentness };
      });
      let artifactPublication: QueryArtifactPublicationDiagnostics = { state: 'not-configured', saveMs: 0, ref: null };
      let saved: CanonicalPersistenceDiagnostics | null = null;
      if (replay) {
        const publication = await withPreviewQueryArtifactScope({ project, repository: revision.repository, revision: revision.sha }, async () => {
          const artifacts = await publishCanonicalQueryArtifacts(observed.value.graph, null, { repository: revision.repository });
          const stored = await savePreviewReplayGraph(makeCanonicalGraphRecord({
            project, repository: revision.repository, revision: revision.sha,
            working: observed.value.graph, accepted: null, currentness: observed.value.currentness,
            queryArtifacts: artifacts.state === 'stored' ? artifacts.ref : null,
          }), { expectedEtag: null });
          if (stored.conflict) {
            if (artifacts.ref) await releaseCanonicalQueryArtifactSlot(project, artifacts.ref).catch(() => false);
            // The losing graph is no longer needed. Drop it before loading the
            // winner so a large repository does not require two full graphs.
            observed.value.graph = null as unknown as IntelligenceGraph;
            const winner = await loadPreviewReplayGraph({ project, repository: revision.repository, revision: revision.sha });
            const graph = winner.record?.working;
            if (!graph || !winner.record) throw new Error('Concurrent Preview graph generation could not be loaded');
            // Use the published winner, not this process's losing build. A
            // graph ID alone does not assert identical producer coverage.
            observed.value.graph = graph;
            observed.value.currentness = winner.record.currentness;
            const winnerRef = winner.record?.queryArtifacts;
            const diagnostics = winnerRef?.artifactFormatVersion === QUERY_ARTIFACT_FORMAT_VERSION
              ? await ensureSavedQueryArtifactPointer(graph, revision, winnerRef, false)
              : { state: 'error' as const, saveMs: 0, ref: winnerRef ?? null, error: 'Concurrent Preview graph needs a current query generation' };
            return { stored: winner.diagnostics, diagnostics };
          }
          let pointer = null;
          if (stored.saveState === 'stored' && artifacts.state === 'stored' && artifacts.ref) {
            pointer = await publishCanonicalQueryArtifactPointer(observed.value.graph, revision.repository, artifacts.ref);
          } else if (artifacts.ref && stored.saveState !== 'error') {
            await releaseCanonicalQueryArtifactSlot(project, artifacts.ref).catch(() => false);
          }
          const diagnostics: QueryArtifactPublicationDiagnostics = {
            state: pointer?.state === 'stored' ? 'stored' : artifacts.state === 'stored' ? 'error' : artifacts.state,
            saveMs: artifacts.saveMs + (pointer?.saveMs ?? 0),
            ref: pointer?.state === 'stored' ? artifacts.ref : null,
            ...(pointer?.error || artifacts.error ? { error: pointer?.error ?? artifacts.error } : {}),
          };
          return { stored, diagnostics };
        });
        saved = publication.stored;
        artifactPublication = publication.diagnostics;
      }
      return {
        ...observed.value,
        revision,
        touchedAt: Date.now(),
        buildTiming: {
          queueWaitMs,
          graphBuildMs,
          checkout: observed.timing,
          totalMs: elapsedMs(queuedAt),
        },
        persistence: replay && saved ? {
          ...replay.diagnostics,
          saveState: saved.saveState,
          saveMs: saved.saveMs,
          ...(saved.error ? { error: saved.error } : {}),
        } : {
          mode: 'process-only',
          durable: false,
          loadState: 'not-configured',
          saveState: 'not-configured',
          loadMs: 0,
          saveMs: 0,
        },
        queryArtifacts: artifactPublication,
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


async function loadCachedRepositoryGraphForRead(project: string, ref?: string): Promise<RepositoryGraphAccess> {
  const accessStarted = Date.now();
  const resolutionStarted = Date.now();
  const revision = await resolveProjectRevision(project, ref);
  const revisionResolutionMs = elapsedMs(resolutionStarted);
  const config = await getProjectConfig(project);
  const canonicalEligible = !previewRuntime() && (ref === undefined || ref === config.defaultRef);

  // Explicit historical/alternate selectors are allowed to use the replay/build
  // path. The no-surprise read/update separation applies to current canonical W.
  if (!canonicalEligible) return await buildCachedRepositoryGraph(project, ref, revision);

  const key = cacheKey(project, revision.sha, 'canonical');
  let entry = repositoryCache.get(key);
  const cacheState: GraphAccessTiming['cacheState'] = entry ? (entry.value ? 'hit' : 'coalesced') : 'miss';

  if (!entry) {
    const loadStarted = Date.now();
    const loaded = await loadCanonicalGraph({
      project,
      repository: revision.repository,
      revision: revision.sha,
    });
    const loadMs = elapsedMs(loadStarted);
    if (!loaded.record) {
      const state = loaded.diagnostics.loadState;
      const detail = loaded.diagnostics.error ? `: ${loaded.diagnostics.error}` : '';
      throw Object.assign(
        new Error(
          `Current canonical graph is not materialized for ${project} at ${revision.sha} (canonical ${state})${detail}. Run scan_graph for the current revision before retrying this read-only operation.`,
        ),
        { status: 409, code: 'CANONICAL_MATERIALIZATION_REQUIRED' },
      );
    }

    const value: CachedRepositoryGraph = {
      graph: loaded.record.working,
      accepted: loaded.record.accepted,
      currentness: loaded.record.currentness,
      revision,
      touchedAt: Date.now(),
      buildTiming: null,
      persistence: {
        ...loaded.diagnostics,
        loadMs,
        saveState: 'skipped',
        saveMs: 0,
      },
      queryArtifacts: loaded.record.queryArtifacts
        ? { state: 'referenced', saveMs: 0, ref: loaded.record.queryArtifacts }
        : { state: 'none', saveMs: 0, ref: null },
    };
    const created: RepositoryCacheEntry = {
      promise: Promise.resolve(value),
      value,
    };
    repositoryCache.set(key, created);
    entry = created;
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


async function publishCurrentQueryArtifactPointer(
  graph: IntelligenceGraph,
  repository: string,
  ref: CanonicalQueryArtifactGenerationRef,
  previousRef: CanonicalQueryArtifactGenerationRef | null = null,
): Promise<CanonicalQueryArtifactPointerPublishResult> {
  const observed = graph.repositoryRevision
    ? await loadCanonicalQueryArtifactPointer({ project: graph.project, repository, revision: graph.repositoryRevision })
    : null;
  const priorRef = observed?.pointer?.ref ?? previousRef;

  let result = await publishCanonicalQueryArtifactPointer(graph, repository, ref);
  for (let attempt = 0; result.state === 'conflict' && attempt < 2; attempt += 1) {
    if (!graph.repositoryRevision) break;
    const current = await resolveProjectRevision(graph.project);
    if (current.repository !== repository || current.sha !== graph.repositoryRevision) {
      result = {
        ...result,
        state: 'error',
        error: 'Canonical query pointer conflict was not retried because the candidate revision is no longer current',
      };
      break;
    }
    result = await publishCanonicalQueryArtifactPointer(graph, repository, ref);
  }
  if (result.state === 'conflict') {
    result = {
      ...result,
      state: 'error',
      error: 'Canonical query pointer remained contended after bounded optimistic retries',
    };
  }

  if (result.state === 'stored') {
    if (priorRef && priorRef.slot !== ref.slot) {
      await releaseCanonicalQueryArtifactSlot(graph.project, priorRef).catch(() => false);
    }
  }
  return result;
}

/** Recover the discovery pointer from the retained graph's own index reference. */
async function ensureSavedQueryArtifactPointer(
  graph: IntelligenceGraph, revision: ProjectRevision, ref: CanonicalQueryArtifactGenerationRef, verifyCurrent: boolean,
): Promise<QueryArtifactPublicationDiagnostics> {
  const expected = { project: graph.project, repository: revision.repository, revision: revision.sha };
  const pointer = await loadCanonicalQueryArtifactPointer(expected);
  const matches = (candidate: typeof pointer) => candidate.state === 'hit'
    && candidate.pointer?.graphId === graph.graphId
    && candidate.pointer.analyzerVersion === graph.analyzerVersion
    && candidate.pointer.sourceFingerprint === graph.sourceFingerprint
    && candidate.pointer.topologyFingerprint === graph.topologyFingerprint
    && candidate.pointer.evidenceFingerprint === graph.evidenceFingerprint
    && candidate.pointer.ref.generationId === ref.generationId
    && candidate.pointer.ref.slot === ref.slot
    && candidate.pointer.ref.manifestSha256 === ref.manifestSha256;
  if (matches(pointer)) return { state: 'referenced', saveMs: 0, ref };
  if (pointer.state === 'error') return { state: 'error', saveMs: 0, ref, error: pointer.error ?? 'Query generation pointer is unavailable' };
  const generation = await loadCanonicalQueryArtifacts(graph, ref, []);
  if (generation.state !== 'hit' || !generation.index) {
    return { state: 'error', saveMs: 0, ref, error: generation.error ?? 'Saved query generation is unavailable' };
  }
  if (verifyCurrent) {
    const current = await resolveProjectRevision(graph.project);
    if (current.repository !== revision.repository || current.sha !== revision.sha) {
      return { state: 'error', saveMs: 0, ref, error: 'Revision changed before restoring the query generation pointer' };
    }
  }
  const restored = await publishCanonicalQueryArtifactPointer(graph, revision.repository, ref);
  const concurrent = restored.state === 'conflict' ? await loadCanonicalQueryArtifactPointer(expected) : null;
  return restored.state === 'stored' || (concurrent && matches(concurrent))
    ? { state: 'referenced', saveMs: restored.saveMs, ref }
    : { state: 'error', saveMs: restored.saveMs, ref, error: restored.error ?? 'Query generation pointer could not be restored' };
}

function selectQueryArtifactBuckets(index: Parameters<typeof candidateQueryBuckets>[0], queries: string[]): string[] {
  return [...new Set(queries.map(value => value.trim()).filter(Boolean)
    .flatMap(value => candidateQueryBuckets(index, value)))].sort();
}

export async function loadCurrentQueryArtifacts(
  project: string,
  queries: string[],
  expectedGraphId?: string,
  ref?: string,
  evidenceIds?: string[],
): Promise<QueryArtifactShadowLoad> {
  const revision = await resolveProjectRevision(project, ref);
  const load = async (): Promise<QueryArtifactShadowLoad> => {
  const pointerLoad = await loadCanonicalQueryArtifactPointer({
    project,
    repository: revision.repository,
    revision: revision.sha,
  });
  if (pointerLoad.state !== 'hit' || !pointerLoad.pointer) {
    return {
      state: pointerLoad.state === 'stale' ? 'miss' : pointerLoad.state,
      loadMs: pointerLoad.loadMs,
      bucketIds: [],
      index: null,
      shards: {},
      ...(pointerLoad.error ? { reason: pointerLoad.error } : {}),
    };
  }
  const pointer = pointerLoad.pointer;
  if (expectedGraphId && pointer.graphId !== expectedGraphId) {
    return { state: 'miss', loadMs: pointerLoad.loadMs, bucketIds: [], index: null, shards: {}, reason: 'requested-graph-id-does-not-match-current-query-generation' };
  }
  if (pointer.analyzerVersion !== ANALYZER_VERSION || pointer.graphSchemaVersion !== 2) {
    return {
      state: 'invalid',
      loadMs: pointerLoad.loadMs,
      bucketIds: [],
      index: null,
      shards: {},
      reason: 'current-query-pointer-analyzer-or-schema-is-stale',
    };
  }

  const hasQueries = queries.some(query => query.trim());
  const loaded = await loadCanonicalQueryArtifactsFromPointer(pointer,
    hasQueries ? index => [...new Set([
      ...selectQueryArtifactBuckets(index, queries),
      ...(evidenceIds?.length ? exactEvidenceQueryBuckets(index, { evidenceIds }) ?? [] : []),
    ])].sort() : []);
  if (!loaded.index) {
    return {
      state: loaded.state,
      loadMs: pointerLoad.loadMs + loaded.loadMs,
      bucketIds: [],
      index: null,
      shards: loaded.shards ?? {},
      ...(loaded.error ? { reason: loaded.error } : {}),
    };
  }
  if (!hasQueries && evidenceIds?.length) {
    const buckets = exactEvidenceQueryBuckets(loaded.index, { evidenceIds });
    if (buckets?.length) {
      const detail = await loadCanonicalQueryDetailShardsFromPointer(pointer, loaded.index, buckets);
      return { state: detail.state, loadMs: pointerLoad.loadMs + loaded.loadMs + detail.loadMs,
        bucketIds: buckets, index: loaded.index, shards: detail.shards ?? {}, pointer,
        ...(detail.error ? { reason: detail.error } : {}) };
    }
  }
  return {
    state: loaded.state,
    loadMs: pointerLoad.loadMs + loaded.loadMs,
    bucketIds: loaded.bucketIds ?? [],
    index: loaded.index,
    shards: loaded.shards ?? {},
    pointer,
    ...(loaded.error ? { reason: loaded.error } : {}),
  };
  };
  return previewRuntime()
    ? await withPreviewQueryArtifactScope({ project, repository: revision.repository, revision: revision.sha }, load)
    : await load();
}

export async function loadCurrentQueryArtifactBuckets(
  established: QueryArtifactShadowLoad,
  bucketIds: string[],
): Promise<QueryArtifactShadowLoad> {
  if (established.state !== 'hit' || !established.pointer || !established.index) {
    return {
      state: 'unavailable',
      loadMs: 0,
      bucketIds: [],
      index: established.index,
      shards: {},
      reason: 'query-artifact-expansion-requires-an-established-current-generation',
    };
  }
  const selected = [...new Set(bucketIds)].sort();
  const pointer = established.pointer;
  const index = established.index;
  const load = () => loadCanonicalQueryDetailShardsFromPointer(pointer, index, selected);
  const detailLoad = previewRuntime()
    ? await withPreviewQueryArtifactScope({ project: pointer.project, repository: pointer.repository, revision: pointer.revision }, load)
    : await load();
  return {
    state: detailLoad.state,
    loadMs: detailLoad.loadMs,
    bucketIds: selected,
    index: established.index,
    shards: detailLoad.shards ?? {},
    pointer: established.pointer,
    ...(detailLoad.error ? { reason: detailLoad.error } : {}),
  };
}

export async function loadQueryArtifactShadow(
  project: string,
  graph: IntelligenceGraph,
  queries: string[],
): Promise<QueryArtifactShadowLoad> {
  const revision = graph.repositoryRevision;
  if (!revision) return { state: 'unavailable', loadMs: 0, bucketIds: [], index: null, shards: {}, reason: 'graph-has-no-exact-revision' };
  const entry = repositoryCache.get(cacheKey(project, revision, 'canonical'));
  if (!entry) return { state: 'unavailable', loadMs: 0, bucketIds: [], index: null, shards: {}, reason: 'canonical-cache-entry-unavailable' };
  const cached = await entry.promise;
  if (cached.graph.graphId !== graph.graphId || cached.graph.repositoryRevision !== revision) {
    return { state: 'unavailable', loadMs: 0, bucketIds: [], index: null, shards: {}, reason: 'canonical-cache-identity-mismatch' };
  }
  const ref = cached.queryArtifacts.ref;
  if (!ref) {
    return {
      state: cached.queryArtifacts.state === 'not-configured' ? 'not-configured' : 'miss',
      loadMs: 0,
      bucketIds: [],
      index: null,
      shards: {},
      reason: cached.queryArtifacts.error ?? 'canonical-query-artifact-generation-not-referenced',
    };
  }

  const loaded = await loadCanonicalQueryArtifacts(graph, ref, index => selectQueryArtifactBuckets(index, queries));
  if (!loaded.index) {
    return {
      state: loaded.state,
      loadMs: loaded.loadMs,
      bucketIds: [],
      index: null,
      shards: loaded.shards ?? {},
      ...(loaded.error ? { reason: loaded.error } : {}),
    };
  }
  return {
    state: loaded.state,
    loadMs: loaded.loadMs,
    bucketIds: loaded.bucketIds ?? [],
    index: loaded.index,
    shards: loaded.shards ?? {},
    ...(loaded.error ? { reason: loaded.error } : {}),
  };
}

function runtimeHeaders(projectHeaders: Array<{ name: string; valueEnv: string }> | undefined): HeadersInit {
  const headers: Record<string, string> = {};
  for (const item of projectHeaders ?? []) {
    const value = projectAccessSecret(item.valueEnv);
    if (!value) throw new Error(`Missing configured runtime credential environment variable: ${item.valueEnv}`);
    headers[item.name] = value;
  }
  return headers;
}

async function scanRuntimeUrl(project: string, urlText: string, repositoryRevision: string): Promise<{ source: SourceDescriptor; nodes: GraphNode[]; edges: GraphEdge[]; evidence: EvidenceRecord[] }> {
  const config = await getProjectConfig(project);
  const requested = new URL(urlText);
  const allowed = new Set((config.runtimeOrigins ?? []).map(value => new URL(value).origin));
  if (!allowed.has(requested.origin)) throw new Error(`Runtime origin is not allowlisted for ${project}: ${requested.origin}`);
  if (!['http:', 'https:'].includes(requested.protocol) || requested.username || requested.password || requested.search || requested.hash) throw new Error('Runtime URL must be credential-free HTTP(S) without query or fragment');
  // A source ref alone cannot authorize runtime facts. Require a provider-reported
  // ready deployment with the exact inspected SHA and matching runtime origin.
  const deployment = await proveRuntimeDeployment(project, repositoryRevision, requested);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DEVINT_RUNTIME_TIMEOUT_MS ?? 15_000));
  const observedAt = new Date().toISOString();
  try {
    let current = requested;
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (!allowed.has(current.origin) || current.origin !== requested.origin) throw new Error('Runtime redirect no longer matches the verified deployment origin');
      response = await fetch(current, { method: 'GET', headers: runtimeHeaders(config.runtimeHeaders), redirect: 'manual', signal: controller.signal });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) break;
      const next = new URL(location, current);
      if (next.username || next.password || next.search || next.hash) throw new Error('Runtime redirect URL must not contain credentials, query or fragment');
      if (next.origin !== requested.origin) throw new Error('Runtime redirect crosses the deployment-verified origin');
      if ((config.runtimeHeaders?.length ?? 0) > 0 && next.origin !== requested.origin) throw new Error('Authenticated runtime redirects must remain on the originally requested origin');
      current = next;
      if (redirects === 5) throw new Error('Runtime redirect limit exceeded');
    }
    if (!response) throw new Error('Runtime request produced no response');
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RUNTIME_BYTES) throw new Error(`Runtime response exceeds ${MAX_RUNTIME_BYTES} bytes`);
    const text = new TextDecoder().decode(body);
    const source: SourceDescriptor = {
      id: `runtime:${requested.href}`, kind: 'runtime-http', locator: requested.href,
      revision: deployment.revision, observedAt, available: true,
      warnings: [`HTTP observation on provider-reported ready deployment ${deployment.deploymentId} at exact source revision ${deployment.revision}; no execution path is inferred`],
    };
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
    // Do not expose HTML scripts, form values, embedded secrets or JSON row data
    // through runtime representation nodes. Runtime content is never canonical source.
    const safeHtml = (sanitizeExternalPayload(text
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '<script>[redacted]</script>')
      .replace(/\b(?:value|data-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*')/giu, 'value="[redacted]"')).value as string);
    let safeJson = '';
    if (/application\/(?:[^;]+\+)?json/iu.test(contentType)) {
      try { safeJson = JSON.stringify(sanitizeExternalPayload(JSON.parse(text)).value); }
      catch { safeJson = '{}'; }
    }
    const result = /text\/html/i.test(contentType)
      ? analyzeHtml({ source, text: safeHtml, locatorBase: requested.href })
      : /application\/(?:[^;]+\+)?json/i.test(contentType)
        ? analyzeJson({ source, text: safeJson, locatorBase: requested.href })
        : { observations: [], resolutions: [], evidence: [] };
    const deploymentNode: GraphNode = {
      id: stableHash([source.id, deployment.deploymentId, deployment.revision, 'deployment-observation']),
      sourceId: source.id,
      kind: 'deployment-observation',
      locator: 'deployment:' + deployment.deploymentId,
      field: 'deployment',
      name: deployment.deploymentId,
      value: {
        deploymentId: deployment.deploymentId,
        gitSha: deployment.revision,
        providerSourceId: deployment.deploymentSourceId,
        providerId: deployment.providerId,
        observedAt: deployment.observedAt,
        evidenceClass: deployment.evidenceClass,
      },
      raw: `deployment ${deployment.deploymentId} at source ${deployment.revision}`,
      layer: 'representation', checkpoint: false,
    };
    const provenance = resolution({
      from: statusNode.id, to: deploymentNode.id,
      kind: 'observed-on-deployment', strategy: 'provider-deployment-and-http-get',
      confidence: 1, status: 'resolved',
      evidence: [requested.origin, deployment.deploymentSourceId,
        deployment.deploymentId, deployment.revision, 'Provider-reported ready deployment and observed GET; not proven runtime execution of any specific code path'],
      layer: 'representation', checkpoint: false,
    });
    return {
      source,
      nodes: [statusNode, deploymentNode, ...result.observations.map(node => ({ ...node, layer: node.layer ?? 'representation', checkpoint: false }))],
      edges: [provenance, ...result.resolutions.map(edge => ({ ...edge, layer: edge.layer ?? 'representation', checkpoint: false }))],
      evidence: result.evidence ?? [],
    };
  } catch (error) {
    return {
      source: { id: `runtime:${requested.href}`, kind: 'runtime-http', locator: requested.href, revision: deployment.revision, observedAt, available: false, error: 'Runtime GET unavailable after deployment verification' },
      nodes: [],
      edges: [],
      evidence: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function scanGraph(project: string, options: { ref?: string | undefined; urls?: string[] } = {}): Promise<IntelligenceGraph> {
  const revision = await resolveProjectRevision(project, options.ref);
  const config = await getProjectConfig(project);
  const canonicalEligible = !computeOnly() && !previewRuntime() && (options.ref === undefined || options.ref === config.defaultRef);
  const key = cacheKey(project, revision.sha, canonicalEligible ? 'canonical' : 'replay');
  const cached = repositoryCache.get(key);
  if (canonicalEligible && cached?.value && (!cached.value.queryArtifacts.ref
    || cached.value.queryArtifacts.ref.artifactFormatVersion !== QUERY_ARTIFACT_FORMAT_VERSION)) {
    repositoryCache.delete(key);
  }
  const repository = machineGraphStoreRoot(project, revision.repository)
    ? await graphContext(project, options.ref ? { ref: options.ref } : {})
    : await buildCachedRepositoryGraph(project, options.ref, revision);
  const urls = options.urls ?? [];
  // Current semantic understanding is a pure reconstruction of repository.graph.
  // Canonical scans cannot write a second derived semantic history or promote
  // source interpretations into an out-of-band accepted ledger. Explicit
  // review/promotion controls remain separate from repository inspection.
  if (!urls.length) return repository.graph;

  const createdAt = new Date().toISOString();
  const sources = [...repository.graph.sources];
  const nodes = [...repository.graph.nodes];
  const evidence = [...repository.graph.evidence];
  let edges = [...repository.graph.edges];
  for (const url of urls) {
    const runtime = await scanRuntimeUrl(project, url, revision.sha);
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
  snapshotCache.set(snapshotKey(graph.graphId), { graph, revision: repository.revision, touchedAt: Date.now() });
  pruneGraphCaches(snapshotRetentionId(snapshotKey(graph.graphId)));
  return graph;
}

function retainedLocalEntry(
  catalog: Awaited<ReturnType<typeof localSourceGraphHistory>>,
  options: { ref?: string | undefined; graphId?: string | undefined },
) {
  if (!catalog) return undefined;
  if (options.graphId) return catalog.entries.find(item => item.graphId === options.graphId);
  const commit = /^commit:([0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)$/u.exec(options.ref ?? '');
  if (commit) return catalog.entries.find(item => item.graphId.startsWith(`repo-${commit[1]!.toLowerCase()}-`));
  if (options.ref === 'working-tree') return catalog.entries.find(item => item.graphId.startsWith('worktree-'));
  const name = options.ref?.replace(/^branch:/u, '');
  const generation = name ? (catalog.targets && Object.hasOwn(catalog.targets, name) ? catalog.targets[name] : undefined) : catalog.active;
  return catalog.entries.find(item => item.generation === generation);
}

function queueMachineBuild(project: string, revision: ProjectRevision, root: string, ref?: string, retry = false): MachineBuild {
  const key = `${root}\0${project}\0${revision.sha}`;
  let job = machineBuilds.get(key);
  if (job && !(retry && job.state === 'failed')) return job;
  job = { state: 'queued', progress: { stage: 'queued' }, startedAt: new Date().toISOString(), promise: undefined as unknown as Promise<Record<string, unknown>> };
  const current = job;
  machineBuilds.set(key, current);
  current.promise = repositoryBuildGate.run(async () => {
    current.state = 'running';
    const { runPreviewGraphWorker } = await import('./canonicalReconcileWorker.js');
    return await runPreviewGraphWorker({ project, revision: revision.sha, ...(ref ? { ref } : {}) }, progress => { current.progress = progress; });
  }).then(result => {
    current.state = 'complete'; current.finishedAt = new Date().toISOString();
    if (typeof result.graphId === 'string') current.graphId = result.graphId;
    return result;
  }, error => {
    current.state = 'failed'; current.finishedAt = new Date().toISOString();
    current.error = error instanceof Error ? error.message : String(error);
    throw error;
  });
  // A caller may start a graph and move elsewhere without awaiting the job.
  void current.promise.catch(() => {});
  return current;
}

/** Request or inspect the machine's exact-revision build without loading a
 * graph. State is scoped to the authorized project and the running server. */
export async function machineGraphBuildStatus(project: string, ref?: string, start = false, revisionHint?: string): Promise<Record<string, unknown>> {
  await assertProjectAccessCurrent(project);
  if (!process.env.DEVINT_MACHINE_GRAPH_DIR?.trim() || !previewRuntime()) throw new Error('Persistent-machine Preview graph builds are not configured');
  if (!start && revisionHint) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revisionHint)) throw new Error('Revision must be an exact Git identity');
    const config = await getProjectConfig(project);
    const knownRoot = machineGraphStoreRoot(project, config.repository);
    const known = knownRoot ? machineBuilds.get(`${knownRoot}\0${project}\0${revisionHint}`) : undefined;
    if (known) {
      await assertProjectAccessCurrent(project);
      return { project, revision: revisionHint, state: known.state, progress: known.progress, startedAt: known.startedAt,
        ...(known.graphId ? { graphId: known.graphId } : {}), ...(known.finishedAt ? { finishedAt: known.finishedAt } : {}), ...(known.error ? { error: known.error } : {}) };
    }
  }
  const revision = await resolveProjectRevision(project, ref);
  if (revisionHint && revision.sha !== revisionHint) throw new Error('The requested revision is no longer selected by this ref');
  const root = machineGraphStoreRoot(project, revision.repository);
  if (!root) throw new Error('Persistent-machine Preview graph storage is unavailable');
  const catalog = await localSourceGraphHistory(root, project);
  const entry = catalog?.entries.find(item => item.graphId.startsWith(`repo-${revision.sha}-`));
  const key = `${root}\0${project}\0${revision.sha}`;
  const job = start && !entry ? queueMachineBuild(project, revision, root, ref, true) : machineBuilds.get(key);
  await assertProjectAccessCurrent(project);
  return { project, revision: revision.sha, ...(entry ? { graphId: entry.graphId } : {}),
    state: entry ? 'complete' : job?.state ?? 'not-built',
    ...(job ? { progress: job.progress, startedAt: job.startedAt, ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}), ...(job.error ? { error: job.error } : {}) } : {}) };
}

async function machineGraphSelection(project: string, options: { ref?: string | undefined; graphId?: string | undefined }, allowBuild = true) {
  if (!process.env.DEVINT_MACHINE_GRAPH_DIR?.trim() || !previewRuntime()) return null;
  const match = options.graphId && /^repo-([0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{10}$/u.exec(options.graphId);
  if (options.graphId && !match) return null;
  const ref = match ? `commit:${match[1]}` : options.ref;
  const revision = await resolveProjectRevision(project, ref);
  const root = machineGraphStoreRoot(project, revision.repository);
  if (!root) return null;
  const find = async () => {
    const catalog = await localSourceGraphHistory(root, project);
    return catalog?.entries.find(item => options.graphId ? item.graphId === options.graphId
      : item.graphId.startsWith(`repo-${revision.sha}-`));
  };
  let entry = await find();
  if (!entry && options.graphId) throw new Error(`Graph generation is not retained: ${options.graphId}`);
  if (!entry && !allowBuild) return null;
  if (!entry) {
    const result = await queueMachineBuild(project, revision, root, ref).promise;
    await assertProjectAccessCurrent(project);
    const catalog = await localSourceGraphHistory(root, project);
    entry = catalog?.entries.find(item => item.graphId === result.graphId);
    if (!entry) throw new Error('Graph worker did not publish the selected machine generation');
  }
  await assertProjectAccessCurrent(project);
  return { root, entry, revision };
}

export async function graphContext(project: string, options: { ref?: string; graphId?: string } = {}): Promise<{ graph: IntelligenceGraph; revision: ProjectRevision; access?: RepositoryGraphAccess }> {
  const started = Date.now();
  await assertProjectAccessCurrent(project);
  if (options.ref && options.graphId) throw new Error('Use either ref or graphId, not both');
  const machine = await machineGraphSelection(project, options);
  if (machine) {
    const graph = await readLocalSourceGraph(machine.root, project, machine.entry.graphId, machine.entry.generation);
    await assertProjectAccessCurrent(project);
    return { graph, revision: machine.revision };
  }
  const localDir = process.env.DEVINT_LOCAL_GRAPH_DIR?.trim();
  if (localDir) {
    const catalog = await localSourceGraphHistory(localDir, project);
    const entry = retainedLocalEntry(catalog, options);
    if (entry) {
      if (options.ref?.startsWith('commit:')) await resolveProjectRevision(project, options.ref);
      const config = await getProjectConfig(project);
      const prefix = `${localDir}\0${project}\0`;
      const key = `${prefix}${entry.generation}`;
      let graph = localGraphCache.get(key);
      if (!graph) {
        graph = await readLocalSourceGraph(localDir, project, entry.graphId, entry.generation);
        localGraphCache.set(key, graph);
        const configured = Number(process.env.DEVINT_LOCAL_GRAPH_CACHE_SIZE ?? '3');
        const maximum = Number.isSafeInteger(configured) && configured >= 0 ? configured : 3;
        const keys = [...localGraphCache.keys()].filter(candidate => candidate.startsWith(prefix));
        while (keys.length > maximum) localGraphCache.delete(keys.shift()!);
      } else {
        localGraphCache.delete(key);
        localGraphCache.set(key, graph);
      }
      const sha = graph.sourceState?.headRevision ?? graph.repositoryRevision;
      if (!sha) throw new Error('Local graph is missing its source identity');
      return { graph, revision: { project, repository: config.repository, ref: graph.sourceState ? 'working-tree' : options.ref ?? `commit:${graph.repositoryRevision!}`, selectorKind: graph.sourceState ? 'working-tree' : 'commit', resolvedRef: graph.sourceState ? 'working-tree' : graph.repositoryRevision!, sha } };
    }
    if (!options.ref && !options.graphId || options.ref === 'working-tree' || options.ref === 'main' || options.ref === 'preview' || options.graphId?.startsWith('worktree-')) throw new Error(`No retained local graph for ${project}${options.ref ? ` target ${options.ref}` : ''}; build it first`);
  }
  if (options.graphId) {
    const snapshot = snapshotCache.get(snapshotKey(options.graphId));
    if (snapshot?.graph.project === project) {
      snapshot.touchedAt = Date.now();
      return { graph: snapshot.graph, revision: snapshot.revision };
    }
    const canonical = /^repo-([0-9a-f]{40}|[0-9a-f]{64})-([0-9a-f]{10})$/u.exec(options.graphId);
    if (canonical) {
      const sha = canonical[1]!;
      const cachedCanonical = repositoryCache.get(cacheKey(project, sha, 'canonical'));
      if (cachedCanonical) {
        const cacheState = cachedCanonical.value ? 'hit' : 'coalesced';
        const loadStarted = Date.now();
        const value = await cachedCanonical.promise;
        if (value.graph.graphId === options.graphId && value.revision.sha === sha) {
          value.touchedAt = Date.now();
          pruneGraphCaches(repositoryRetentionId(cacheKey(project, sha, 'canonical')));
          return { graph: value.graph, revision: value.revision, access: { ...value, accessTiming: {
            cacheState, revisionResolutionMs: 0, graphLoadMs: elapsedMs(loadStarted), totalMs: elapsedMs(started), persistence: value.persistence } } };
        }
      }

      const cachedReplay = repositoryCache.get(cacheKey(project, sha, 'replay'));
      if (cachedReplay) {
        const cacheState = cachedReplay.value ? 'hit' : 'coalesced';
        const loadStarted = Date.now();
        const value = await cachedReplay.promise;
        if (value.graph.graphId === options.graphId && value.revision.sha === sha) {
          value.touchedAt = Date.now();
          pruneGraphCaches(repositoryRetentionId(cacheKey(project, sha, 'replay')));
          return { graph: value.graph, revision: value.revision, access: { ...value, accessTiming: {
            cacheState, revisionResolutionMs: 0, graphLoadMs: elapsedMs(loadStarted), totalMs: elapsedMs(started), persistence: value.persistence } } };
        }
      }

      let repository: RepositoryGraphAccess;
      if (previewRuntime()) {
        // Preview only has process-local replays. A cold exact-ID read
        // should never build the configured default revision first.
        repository = await buildCachedRepositoryGraph(project, `commit:${sha}`);
        if (repository.graph.graphId !== options.graphId) throw new Error(`Graph identifier does not match the Preview replay: ${options.graphId}`);
        return { graph: repository.graph, revision: repository.revision, access: repository };
      }
      if (hasProjectAccess()) {
        // Reconstruct against the adopted authority before considering source
        // replay. Never use another binding's snapshot or ambient operator W.
        try {
          const current = await loadCachedRepositoryGraphForRead(project);
          if (current.revision.sha === sha && current.graph.graphId === options.graphId) return { graph: current.graph, revision: current.revision, access: current };
        } catch (error) {
          await assertProjectAccessCurrent(project);
          if ((error as any)?.status === 403) throw error;
        }
        repository = await buildCachedRepositoryGraph(project, `commit:${sha}`);
        if (repository.graph.graphId !== options.graphId) throw new Error(`Graph identifier does not match the selected binding replay: ${options.graphId}`);
        return { graph: repository.graph, revision: repository.revision, access: repository };
      }
      try {
        // An explicit graph-id lookup is a read. Loading a current saved graph
        // must not trigger artifact migration or publication as a side effect.
        const current = await loadCachedRepositoryGraphForRead(project);
        if (current.revision.sha === sha && current.graph.graphId === options.graphId) {
          return { graph: current.graph, revision: current.revision, access: current };
        }
        repository = await buildCachedRepositoryGraph(project, `commit:${sha}`);
      } catch (error) {
        repository = await buildCachedRepositoryGraph(project, `commit:${sha}`);
        if (repository.revision.sha !== sha) throw error;
      }
      if (repository.graph.graphId !== options.graphId) throw new Error(`Canonical graph identifier does not match the current analyzer result: ${options.graphId}`);
      return { graph: repository.graph, revision: repository.revision, access: repository };
    }
    throw new Error(`Runtime graph snapshot is unavailable or expired: ${options.graphId}`);
  }
  const repository = await loadCachedRepositoryGraphForRead(project, options.ref);
  return { graph: repository.graph, revision: repository.revision, access: repository };
}

export async function currentGraph(project: string, ref?: string, graphId?: string): Promise<IntelligenceGraph> {
  return (await graphContext(project, { ...(ref ? { ref } : {}), ...(graphId ? { graphId } : {}) })).graph;
}

/** Keep the selected local generation pinned while its indexed records are in use. */
export async function withIndexedLocalGraph<T>(project: string, options: { ref?: string | undefined; graphId?: string | undefined }, use: (graph: IntelligenceGraph) => Promise<T | null>, useLoaded?: (graph: IntelligenceGraph) => Promise<T>): Promise<T | null> {
  if (options.ref && options.graphId) throw new Error('Use either ref or graphId, not both');
  const machine = await machineGraphSelection(project, options);
  if (machine) {
    const result = await withLocalSourceGraphEnvelope(machine.root, project, use, machine.entry.graphId, machine.entry.generation, true);
    await assertProjectAccessCurrent(project);
    return result;
  }
  const localDir = process.env.DEVINT_LOCAL_GRAPH_DIR?.trim();
  if (!localDir) return null;
  await assertProjectAccessCurrent(project);
  if (options.ref && options.graphId) throw new Error('Use either ref or graphId, not both');
  const catalog = await localSourceGraphHistory(localDir, project);
  const entry = retainedLocalEntry(catalog, options);
  if (!entry) return null;
  if (options.ref?.startsWith('commit:')) await resolveProjectRevision(project, options.ref);
  await getProjectConfig(project);
  const key = `${localDir}\0${project}\0${entry.generation}`;
  const loaded = localGraphCache.get(key);
  if (loaded && useLoaded && hasLocalGraphIndex(loaded)) {
    localGraphCache.delete(key); localGraphCache.set(key, loaded);
    return await withLocalSourceGraphEnvelope(localDir, project, () => useLoaded(loaded), entry.graphId, entry.generation, true);
  }
  try { return await withLocalSourceGraphEnvelope(localDir, project, use, entry.graphId, entry.generation, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as Error).message === 'This retained graph needs a current retrieval index') return null;
    throw error;
  }
}

/** Read graph-owned source and coverage metadata from the selected generation. */
export async function graphSourceMetadata(project: string, ref?: string, graphId?: string): Promise<Pick<IntelligenceGraph,
  'project' | 'graphId' | 'repositoryRevision' | 'sourceState' | 'sources' | 'unavailableSourceIds' | 'coverage' | 'producerCoverage' | 'relationshipCoverage'>> {
  if (ref && graphId) throw new Error('Use either ref or graphId, not both');
  const select = (graph: IntelligenceGraph) => ({ project: graph.project, graphId: graph.graphId,
    repositoryRevision: graph.repositoryRevision, ...(graph.sourceState ? { sourceState: graph.sourceState } : {}), sources: graph.sources, unavailableSourceIds: graph.unavailableSourceIds,
    ...(graph.coverage ? { coverage: graph.coverage } : {}),
    ...(graph.producerCoverage ? { producerCoverage: graph.producerCoverage } : {}),
    ...(graph.relationshipCoverage ? { relationshipCoverage: graph.relationshipCoverage } : {}) });
  const local = await withIndexedLocalGraph(project, { ref, graphId }, async graph => select(graph));
  if (local) return local;
  const match = graphId && /^repo-([0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{10}$/u.exec(graphId);
  if (!process.env.DEVINT_LOCAL_GRAPH_DIR?.trim() && (!graphId || match)) {
    const saved = await loadCurrentQueryArtifacts(project, [], graphId, ref ?? (match ? `commit:${match[1]}` : undefined));
    if (saved.state === 'hit' && saved.index) {
      const metadata = saved.index.sourceMetadata;
      return { project, graphId: saved.index.graphId, repositoryRevision: saved.index.revision,
        sources: metadata.sources, unavailableSourceIds: metadata.unavailableSourceIds,
        ...(metadata.coverage ? { coverage: metadata.coverage } : {}), producerCoverage: saved.index.producerCoverage,
        ...(metadata.relationshipCoverage ? { relationshipCoverage: metadata.relationshipCoverage } : {}) };
    }
  }
  return select(await currentGraph(project, ref, graphId));
}

export function clearGraphCache(project?: string): void {
  for (const key of localGraphCache.keys()) if (!project || key.split('\0')[1] === project) localGraphCache.delete(key);
  if (hasProjectAccess()) {
    const prefix = `${projectAccessScopeKey()}:`;
    for (const key of repositoryCache.keys()) if (key.startsWith(prefix) && (!project || key.startsWith(`${prefix}${project}:`))) repositoryCache.delete(key);
    for (const [key, value] of snapshotCache.entries()) if (key.startsWith(prefix) && (!project || value.graph.project === project)) snapshotCache.delete(key);
    return;
  }
  if (!project) {
    repositoryCache.clear();
    snapshotCache.clear();
    return;
  }
  for (const key of [...repositoryCache.keys()]) if (key.startsWith(`operator:${project}:`)) repositoryCache.delete(key);
  for (const [key, snapshot] of [...snapshotCache.entries()]) if (snapshot.graph.project === project) snapshotCache.delete(key);
}

export function graphCacheDiagnostics(): Record<string, unknown> {
  const prefix = `${projectAccessScopeKey()}:`;
  const repository = repositoryRetentionItems().filter(item => !hasProjectAccess() || item.id.startsWith(`repository:${prefix}`));
  const snapshots = snapshotRetentionItems().filter(item => !hasProjectAccess() || item.id.startsWith(`snapshot:${prefix}`));
  return {
    scope: hasProjectAccess() ? 'project-binding' : 'process',
    maxRetainedRecords: positiveIntegerSetting(process.env.DEVINT_GRAPH_CACHE_MAX_RECORDS, 150_000, 'DEVINT_GRAPH_CACHE_MAX_RECORDS'),
    retainedRecords: [...repository, ...snapshots].reduce((total, item) => total + item.records, 0),
    repository: {
      entries: hasProjectAccess() ? repository.length : repositoryCache.size,
      building: [...repositoryCache.entries()].filter(([key, entry]) => !entry.value && (!hasProjectAccess() || key.startsWith(prefix))).length,
      retainedRecords: repository.reduce((total, item) => total + item.records, 0),
      maxEntries: cacheEntryLimitSetting(process.env.DEVINT_GRAPH_CACHE_SIZE, 6, 'DEVINT_GRAPH_CACHE_SIZE'),
    },
    snapshots: {
      entries: hasProjectAccess() ? snapshots.length : snapshotCache.size,
      retainedRecords: snapshots.reduce((total, item) => total + item.records, 0),
      maxEntries: cacheEntryLimitSetting(process.env.DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE, 12, 'DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE'),
    },
    coldBuilds: hasProjectAccess() ? null : repositoryBuildGate.status(),
  };
}

export async function graphStatus(project: string, ref?: string, materialize = true): Promise<Record<string, unknown>> {
  const machineActive = Boolean(process.env.DEVINT_MACHINE_GRAPH_DIR?.trim()) && previewRuntime();
  const machine = machineActive ? await machineGraphSelection(project, { ref }, materialize) : null;
  if (machineActive && !machine) throw new Error(`No retained Preview graph for ${project}`);
  const repository = machine ? {
    graph: await readLocalSourceGraph(machine.root, project, machine.entry.graphId, machine.entry.generation),
    revision: machine.revision, accessTiming: { cacheState: 'hit', persistence: { mode: 'machine-file', scope: 'preview-replay', durable: true, loadState: 'hit', saveState: 'skipped' } },
    buildTiming: null, queryArtifacts: { state: 'referenced', storage: 'sqlite', ref: null },
  } : materialize
    ? await buildCachedRepositoryGraph(project, ref)
    : await loadCachedRepositoryGraphForRead(project, ref);
  const graphs = { working: repository.graph };
  const semanticNodes = graphs.working.nodes.filter(node => node.layer === 'semantic').length;
  const semanticEdges = graphs.working.edges.filter(edge => edge.layer === 'semantic').length;
  return {
    project,
    repository: repository.revision.repository,
    ref: repository.revision.ref,
    revision: repository.revision.sha,
    revisionIdentity: revisionIdentity(repository.revision),
    analyzerVersion: graphs.working.analyzerVersion,
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
      queryArtifacts: repository.queryArtifacts,
    },
  };
}
