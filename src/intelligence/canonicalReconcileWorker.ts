import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { reconcileCanonicalPortfolio, reconcileCanonicalProject, type CanonicalPortfolioReconcileItem, type CanonicalPortfolioReconcileOptions } from './canonicalPortfolio.js';
import type { GithubInstallationRepository } from '../source/repositoryCredential.js';
import { currentVercelOidcToken, withVercelRequestContext } from '../vercelRequestContext.js';

interface WorkerInput {
  project: string;
  defaultBranch: string;
  oidcToken: string | null;
}

interface WorkerEnvelope {
  ok: true;
  item: CanonicalPortfolioReconcileItem;
}

function positiveSetting(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function canonicalReconcileWorkerLimits(): { timeoutMs: number; maxOldGenerationSizeMb: number } {
  return {
    timeoutMs: positiveSetting(process.env.DEVINT_CANONICAL_RECONCILE_WORKER_TIMEOUT_MS, 45_000, 5_000, 55_000),
    maxOldGenerationSizeMb: positiveSetting(process.env.DEVINT_CANONICAL_RECONCILE_WORKER_HEAP_MB, 768, 128, 896),
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
  const startedAt = Date.now();
  const defaults = canonicalReconcileWorkerLimits();
  const timeoutMs = overrides.timeoutMs ?? defaults.timeoutMs;
  const maxOldGenerationSizeMb = overrides.maxOldGenerationSizeMb ?? defaults.maxOldGenerationSizeMb;
  const oidcToken = currentVercelOidcToken() ?? process.env.VERCEL_OIDC_TOKEN?.trim() ?? null;

  return await new Promise<CanonicalPortfolioReconcileItem>(resolve => {
    let settled = false;
    const worker = new Worker(new URL('./canonicalReconcileWorker.js', import.meta.url), {
      workerData: { ...input, oidcToken } satisfies WorkerInput,
      resourceLimits: { maxOldGenerationSizeMb },
    });
    const finish = (item: CanonicalPortfolioReconcileItem) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(item);
    };
    const timer = setTimeout(() => {
      void worker.terminate().finally(() => finish(errorItem(input, startedAt, `isolated reconcile worker exceeded ${timeoutMs} ms`)));
    }, timeoutMs);
    worker.once('message', (message: WorkerEnvelope) => {
      if (message?.ok && message.item) finish(message.item);
      else finish(errorItem(input, startedAt, 'isolated reconcile worker returned an invalid response'));
    });
    worker.once('error', (error: Error) => finish(errorItem(input, startedAt, `isolated reconcile worker failed: ${error.message}`)));
    worker.once('exit', (code: number) => {
      if (!settled && code !== 0) finish(errorItem(input, startedAt, `isolated reconcile worker exited with code ${code}`));
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

async function workerMain(input: WorkerInput): Promise<void> {
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
  parentPort?.postMessage({ ok: true, item } satisfies WorkerEnvelope);
}

if (!isMainThread) {
  void workerMain(workerData as WorkerInput).catch(error => {
    const input = workerData as WorkerInput;
    parentPort?.postMessage({
      ok: true,
      item: errorItem(input, Date.now(), error instanceof Error ? error.message : String(error)),
    } satisfies WorkerEnvelope);
  });
}
