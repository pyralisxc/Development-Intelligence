import { getProjectConfig } from './config/registry.js';
import { callCurrentCodebase } from './codebase/proxy.js';
import { readProjectState, upstreamStatus } from './codebase/sourceManager.js';
import { parityStatus } from './parity/query.js';

export async function projectStatus(project: string, checkUpstream = true): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(project);
  const state = await readProjectState(project);
  let upstream: Awaited<ReturnType<typeof upstreamStatus>> | null = null;
  if (checkUpstream) upstream = await upstreamStatus(project, state.ref || config.defaultRef);
  let codebaseStatus: unknown = null;
  let codebaseError: string | null = null;
  if (state.selectedCbmProject) {
    try { codebaseStatus = await callCurrentCodebase(project, 'index_status', {}); }
    catch (error) { codebaseError = error instanceof Error ? error.message : String(error); }
  }
  const parity = await parityStatus(project);
  return {
    project,
    repository: config.repository,
    ref: state.ref || config.defaultRef,
    upstreamSha: upstream?.upstreamSha ?? null,
    upstreamError: upstream?.error ?? null,
    checkoutSha: state.selectedSha,
    indexedSha: state.selectedSha && state.selectedCbmProject ? state.selectedSha : null,
    sourceCurrent: upstream?.upstreamSha ? upstream.upstreamSha === state.selectedSha : null,
    indexedAt: state.indexedAt,
    refreshedAt: state.refreshedAt,
    lastFetchAt: state.lastFetchAt,
    codebaseStatus,
    codebaseError,
    parity,
  };
}
