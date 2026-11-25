import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { getHeapStatistics } from 'node:v8';
import { reconcileCanonicalPortfolio, reconcileCanonicalProject, type CanonicalPortfolioReconcileItem, type CanonicalPortfolioReconcileOptions } from './canonicalPortfolio.js';
import type { GithubInstallationRepository } from '../source/repositoryCredential.js';
import { currentVercelOidcToken, withVercelRequestContext } from '../vercelRequestContext.js';
import { assertAuthorityWritesAllowed } from '../config/runtimeRole.js';
import { assertProjectAccessCurrent, projectAccessWorkerBinding, withProjectAccess, type ProjectAccessBinding } from '../config/projectAccess.js';
import type { GraphBuildProgress } from './producerInputs.js';

interface WorkerInput {
  kind?: 'canonical';
  project: string;
  defaultBranch: string;
  oidcToken: string | null;
}

export interface LocalGraphWorkerInput {
  kind: 'local';
  project: string;
  root: string;
  dataDir: string;
  scratchDir: string;
  retain: number;
  ref?: string;
  target?: string;
  joern?: { bytes: Uint8Array; version: string; projectPrefix?: string };
}

interface PreviewGraphWorkerInput {
  kind: 'preview'; project: string; ref?: string; revision: string;
  oidcToken: string | null; binding: ProjectAccessBinding | null;
}

interface WorkerEnvelope {
  ok: true;
  item: CanonicalPortfolioReconcileItem;
}

interface LocalWorkerEnvelope { ok: boolean; result?: Record<string, unknown>; error?: string }

function graphWorkerResources(): { maxOldGenerationSizeMb: number } | undefined {
  const configured = process.env.DEVINT_GRAPH_WORKER_HEAP_MB?.trim();
  return configured ? { maxOldGenerationSizeMb: positiveSetting(configured, 0, 128) } : undefined;
}

/** Hosted graph builds use the same worker entrypoint and return an identity,
 * not a second copy of the graph. Bound access remains live in the caller. */
export async function runPreviewGraphWorker(input: { project: string; ref?: string; revision: string }, progress?: (value: GraphBuildProgress) => void): Promise<Record<string, unknown>> {
  const binding = projectAccessWorkerBinding(input.project);
  const task: PreviewGraphWorkerInput = { kind: 'preview', ...input, binding,
    oidcToken: currentVercelOidcToken() ?? process.env.VERCEL_OIDC_TOKEN?.trim() ?? null };
  await assertProjectAccessCurrent(input.project);
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const resources = graphWorkerResources();
    const worker = new Worker(new URL('./canonicalReconcileWorker.js', import.meta.url), {
      workerData: task, ...(resources ? { resourceLimits: resources } : {}),
    });
    let settled = false;
    let response: Record<string, unknown> | undefined;
    const fail = (reason: string) => { if (!settled) { settled = true; reject(new Error(reason)); } };
    worker.on('message', (message: any) => {
      if (message?.type === 'progress' && message.progress && typeof message.progress.stage === 'string') { progress?.(message.progress); return; }
      if (message?.type === 'access-check' && typeof message.id === 'number') {
        void (async () => {
          let current = true;
          try { await assertProjectAccessCurrent(input.project); } catch { current = false; }
          if (!settled) worker.postMessage({ type: 'access-result', id: message.id, current });
        })();
        return;
      }
      if (!message?.ok || !message.result) return fail(message?.error ?? 'Preview graph worker returned an invalid result');
      response = message.result;
    });
    worker.once('error', error => fail(error.message));
    worker.once('exit', code => {
      if (settled) return;
      if (code !== 0 || !response) return fail(`Preview graph worker exited with code ${code} before returning a result`);
      settled = true; resolve(response);
    });
  });
  await assertProjectAccessCurrent(input.project);
  return result;
}

/** The installed Workbench and canonical reconciliation use the same worker
 * entrypoint. Local generations are written before the compact result returns. */
export async function runLocalGraphWorker(input: LocalGraphWorkerInput, progress?: (value: GraphBuildProgress) => void): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const resources = graphWorkerResources();
    const worker = new Worker(new URL('./canonicalReconcileWorker.js', import.meta.url), {
      workerData: input, env: { ...process.env, DEVINT_SCRATCH_DIR: input.scratchDir },
      ...(resources ? { resourceLimits: resources } : {}),
    });
    let settled = false;
    const fail = (reason: string) => { if (!settled) { settled = true; reject(new Error(reason)); } };
    worker.on('message', (message: LocalWorkerEnvelope & { type?: string; progress?: GraphBuildProgress }) => {
      if (message?.type === 'progress' && message.progress) { progress?.(message.progress); return; }
      if (settled) return;
      if (!message?.ok || !message.result) return fail(message?.error ?? 'Graph worker returned an invalid result');
      settled = true; resolve(message.result);
    });
    worker.once('error', error => fail(error.message));
    worker.once('exit', code => fail(`Graph worker exited with code ${code} before returning a result`));
  });
}

function positiveSetting(raw: string | undefined, fallback: number, min: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`Worker setting must be an integer of at least ${min}`);
  return parsed;
}

export function canonicalReconcileWorkerLimits(): { timeoutMs: number | null; maxOldGenerationSizeMb: number | null } {
  const rawTimeout = process.env.DEVINT_CANONICAL_RECONCILE_WORKER_TIMEOUT_MS?.trim();
  const rawHeap = process.env.DEVINT_CANONICAL_RECONCILE_WORKER_HEAP_MB?.trim();
  const timeoutMs = rawTimeout ? positiveSetting(rawTimeout, 0, 1) : null;
  if (timeoutMs !== null && timeoutMs > 2_147_483_647) throw new Error('Worker timeout exceeds the Node.js timer maximum');
  return {
    timeoutMs,
    maxOldGenerationSizeMb: rawHeap ? positiveSetting(rawHeap, 0, 128) : null,
  };
}

function errorItem(input: Pick<WorkerInput, 'project' | 'defaultBranch'>, startedAt: number, reason: string): CanonicalPortfolioReconcileItem {
  return {
    project: input.project,
    defaultBranch: input.defaultBranch,
    outcome: 'error',
    durationMs: Math.max(0, Date.now() - startedAt),
    reason: reason.slice(0, 1000),
  };
}

export async function runCanonicalReconcileWorker(
  input: Pick<WorkerInput, 'project' | 'defaultBranch'>,
  overrides: Partial<ReturnType<typeof canonicalReconcileWorkerLimits>> = {},
): Promise<CanonicalPortfolioReconcileItem> {
  assertAuthorityWritesAllowed();
  const startedAt = Date.now();
  const defaults = canonicalReconcileWorkerLimits();
  const timeoutMs = overrides.timeoutMs ?? defaults.timeoutMs;
  const maxOldGenerationSizeMb = overrides.maxOldGenerationSizeMb ?? defaults.maxOldGenerationSizeMb;
  const oidcToken = currentVercelOidcToken() ?? process.env.VERCEL_OIDC_TOKEN?.trim() ?? null;

  return await new Promise<CanonicalPortfolioReconcileItem>(resolve => {
    let settled = false;
    const worker = new Worker(new URL('./canonicalReconcileWorker.js', import.meta.url), {
      workerData: { ...input, oidcToken } satisfies WorkerInput,
      ...(maxOldGenerationSizeMb === null ? {} : { resourceLimits: { maxOldGenerationSizeMb } }),
    });
    const finish = (item: CanonicalPortfolioReconcileItem) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(item);
    };
    const timer = timeoutMs === null ? null : setTimeout(() => {
      void worker.terminate().finally(() => finish(errorItem(input, startedAt, `isolated reconcile worker exceeded ${timeoutMs} ms`)));
    }, timeoutMs);
    worker.once('message', (message: WorkerEnvelope) => {
      if (message?.ok && message.item) finish(message.item);
      else finish(errorItem(input, startedAt, 'isolated reconcile worker returned an invalid response'));
    });
    worker.once('error', (error: Error) => finish(errorItem(input, startedAt, `isolated reconcile worker failed: ${error.message}`)));
    worker.once('exit', (code: number) => {
      if (!settled) finish(errorItem(input, startedAt, `isolated reconcile worker exited with code ${code} before returning a result`));
    });
  });
}

export async function reconcileCanonicalPortfolioIsolated(options: CanonicalPortfolioReconcileOptions = {}): Promise<Record<string, unknown>> {
  const result = await reconcileCanonicalPortfolio(options, async (repository: GithubInstallationRepository) => {
    return await runCanonicalReconcileWorker({
      project: repository.fullName,
      defaultBranch: repository.defaultBranch,
    });
  }) as any;
  return {
    ...result,
    policy: {
      ...(result.policy ?? {}),
      executionIsolation: 'worker-thread',
      ...canonicalReconcileWorkerLimits(),
    },
  };
}

async function workerMain(input: WorkerInput | LocalGraphWorkerInput | PreviewGraphWorkerInput): Promise<void> {
  if (input.kind === 'local') {
    const { buildLocalRevisionGraph, buildLocalWorkingGraph } = await import('./local.js');
    const { saveLocalSourceGraph } = await import('./localGraphStore.js');
    const progress = (value: GraphBuildProgress) => parentPort?.postMessage({ type: 'progress', progress: value });
    progress({ stage: 'resolving-revision' });
    const graph = input.ref
      ? await buildLocalRevisionGraph(input.root, input.ref, input.project, input.joern, progress)
      : await buildLocalWorkingGraph(input.root, input.project, input.joern, progress);
    progress({ stage: 'publishing-graph-and-index' });
    const retained = await saveLocalSourceGraph(input.dataDir, graph, input.retain, input.target ?? 'working', !input.ref);
    const { files: _files, ...coverage } = graph.coverage ?? {};
    parentPort?.postMessage({ ok: true, result: { project: graph.project, target: input.target ?? (input.ref ?? 'working'), graphId: graph.graphId,
      revision: graph.repositoryRevision, sourceState: graph.sourceState, sourceFingerprint: graph.sourceFingerprint,
      nodes: graph.nodes.length, edges: graph.edges.length, coverage, producerCoverage: graph.producerCoverage, retained } } satisfies LocalWorkerEnvelope);
    return;
  }
  if (input.kind === 'preview') {
    const port = parentPort;
    if (!port) throw new Error('Preview graph worker requires a parent');
    let sequence = 0;
    const pending = new Map<number, (current: boolean) => void>();
    if (input.binding) port.on('message', message => {
      if (message?.type !== 'access-result' || typeof message.id !== 'number') return;
      const done = pending.get(message.id); pending.delete(message.id); done?.(message.current === true);
    });
    const current = async () => await new Promise<boolean>(resolve => {
      const id = ++sequence; pending.set(id, resolve); port.postMessage({ type: 'access-check', id });
    });
    try {
      const progress = (value: GraphBuildProgress) => port.postMessage({ type: 'progress', progress: value });
      const execute = async () => {
        progress({ stage: 'resolving-revision' });
        const { resolveProjectRevision, withResolvedProjectCheckoutObserved } = await import('../source/git.js');
        const { machineGraphStoreRoot } = await import('./machineGraphStore.js');
        const revision = await resolveProjectRevision(input.project, input.ref);
        if (revision.sha !== input.revision) throw new Error('Selected revision changed while starting the graph build');
        const machineRoot = machineGraphStoreRoot(input.project, revision.repository);
        if (machineRoot) {
          const { buildRepositoryGraph } = await import('./repository.js');
          const { assertGraphIntegrity } = await import('./integrity.js');
          const { saveLocalSourceGraph } = await import('./localGraphStore.js');
          progress({ stage: 'checking-out-source' });
          const observed = await withResolvedProjectCheckoutObserved(revision, async checkout => {
            const graph = await buildRepositoryGraph({ project: input.project, repository: checkout.repository,
              revision: checkout.sha, root: checkout.root, role: 'W', disposableCheckout: true, progress });
            assertGraphIntegrity(graph);
            await assertProjectAccessCurrent(input.project);
            const retain = positiveSetting(process.env.DEVINT_MACHINE_GRAPH_RETAIN, 3, 1);
            progress({ stage: 'publishing-graph-and-index' });
            await saveLocalSourceGraph(machineRoot, graph, retain);
            return graph;
          });
          await assertProjectAccessCurrent(input.project);
          return { project: input.project, revision: observed.value.repositoryRevision, graphId: observed.value.graphId,
            checkout: observed.timing, workerHeapLimitMb: Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024)) };
        }
        const { scanGraph, graphStatus } = await import('./service.js');
        progress({ stage: 'building-and-publishing-graph' });
        const graph = await scanGraph(input.project, input.ref ? { ref: input.ref } : {});
        if (graph.repositoryRevision !== input.revision) throw new Error('Selected revision changed while starting the graph build');
        const status = await graphStatus(input.project, input.ref) as any;
        if (status?.working?.graphId !== graph.graphId || status?.observability?.persistence?.saveState === 'error'
          || status?.observability?.queryArtifacts?.state === 'error') throw new Error('Preview graph publication did not complete');
        return { project: input.project, revision: graph.repositoryRevision, graphId: graph.graphId,
          coldBuild: status?.observability?.coldBuild ?? null,
          workerHeapLimitMb: Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024)) };
      };
      const headers = input.oidcToken ? { 'x-vercel-oidc-token': input.oidcToken } : {};
      const result = await withVercelRequestContext(headers, async () => input.binding
        ? await withProjectAccess(input.binding, current, execute) : await execute());
      port.postMessage({ ok: true, result } satisfies LocalWorkerEnvelope);
    } catch (error) {
      port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies LocalWorkerEnvelope);
    } finally {
      if (input.binding) port.removeAllListeners('message');
      port.close();
    }
    return;
  }
  const headers = input.oidcToken ? { 'x-vercel-oidc-token': input.oidcToken } : {};
  const [owner = '', name = input.project] = input.project.split('/');
  const repository: GithubInstallationRepository = {
    owner,
    name,
    fullName: input.project,
    defaultBranch: input.defaultBranch,
    private: false,
    fork: false,
    archived: false,
    disabled: false,
    pushedAt: null,
  };
  const item = await withVercelRequestContext(headers, async () => await reconcileCanonicalProject(repository));
  parentPort?.postMessage({ ok: true, item: { ...item, workerHeapLimitMb: Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024)) } } satisfies WorkerEnvelope);
}

if (!isMainThread) {
  void workerMain(workerData as WorkerInput | LocalGraphWorkerInput | PreviewGraphWorkerInput).catch(error => {
    const input = workerData as WorkerInput | LocalGraphWorkerInput | PreviewGraphWorkerInput;
    if (input.kind === 'local' || input.kind === 'preview') {
      parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies LocalWorkerEnvelope);
      return;
    }
    parentPort?.postMessage({
      ok: true,
      item: errorItem(input, Date.now(), error instanceof Error ? error.message : String(error)),
    } satisfies WorkerEnvelope);
  });
}
