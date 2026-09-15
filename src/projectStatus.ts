import { getProjectConfig } from './config/registry.js';
import { indexStatus, readProjectState, upstreamStatus } from './codebase/sourceManager.js';
import { parityStatus } from './parity/query.js';

export async function projectStatus(project: string, checkUpstream = true): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(project);
  const state = await readProjectState(project);
  const upstream = checkUpstream ? await upstreamStatus(project, state.ref || config.defaultRef) : null;
  const index = await indexStatus(project);
  const parity = await parityStatus(project);
  return {
    project,
    repository: config.repository,
    ref: state.ref || config.defaultRef,
    upstreamSha: upstream?.upstreamSha ?? null,
    upstreamError: upstream?.error ?? null,
    selectedSha: state.selectedSha,
    selectedBundleId: state.selectedBundleId,
    sourceCurrent: upstream?.upstreamSha ? upstream.upstreamSha === state.selectedSha : null,
    indexedAt: state.indexedAt,
    refreshedAt: state.refreshedAt,
    lastFetchAt: state.lastFetchAt,
    index,
    parity,
  };
}
