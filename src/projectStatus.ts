import { getProjectConfig } from './config/registry.js';
import { graphStatus } from './intelligence/service.js';
import { upstreamStatus } from './source/git.js';

export async function projectStatus(project: string, checkUpstream = true): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(project);
  let graph: Record<string, unknown> | null = null;
  let graphError: string | null = null;
  let upstreamSha: string | null = null;
  let upstreamError: string | null = null;
  try {
    graph = await graphStatus(project, config.defaultRef);
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
