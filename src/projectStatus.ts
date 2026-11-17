import { getProjectConfig } from './config/registry.js';
import { currentGraph, graphStatus } from './intelligence/service.js';
import { upstreamStatus } from './source/git.js';

export async function projectStatus(project: string, checkUpstream = true): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(project);
  if (process.env.DEVINT_LOCAL_GRAPH_DIR) {
    const graph = await currentGraph(project);
    return { project, repository: config.repository, ref: graph.sourceState ? 'working-tree' : graph.repositoryRevision,
      upstreamSha: null, upstreamError: null, graph: { graphId: graph.graphId, revision: graph.repositoryRevision,
        sourceState: graph.sourceState ?? null, sourceFingerprint: graph.sourceFingerprint, coverage: graph.coverage ?? null }, graphError: null };
  }
  let graph: Record<string, unknown> | null = null;
  let graphError: string | null = null;
  let upstreamSha: string | null = null;
  let upstreamError: string | null = null;
  try {
    graph = await graphStatus(project, config.defaultRef, false);
    upstreamSha = checkUpstream && typeof graph.revision === 'string' ? graph.revision : null;
  } catch (error) {
    graphError = error instanceof Error ? error.message : String(error);
    if (checkUpstream) {
      const upstream = await upstreamStatus(project, config.defaultRef);
      upstreamSha = upstream.upstreamSha;
      upstreamError = upstream.error ?? null;
    }
  }
  return {
    project,
    repository: config.repository,
    ref: config.defaultRef,
    upstreamSha,
    upstreamError,
    graph,
    graphError,
  };
}
