import { getProjectConfig } from './config/registry.js';
import { graphStatus } from './intelligence/service.js';
import { upstreamStatus } from './source/git.js';

export async function projectStatus(project: string, checkUpstream = true): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(project);
  const upstream = checkUpstream ? await upstreamStatus(project, config.defaultRef) : null;
  let graph: Record<string, unknown> | null = null;
  let graphError: string | null = null;
  try { graph = await graphStatus(project, config.defaultRef); }
  catch (error) { graphError = error instanceof Error ? error.message : String(error); }
  return {
    project,
    repository: config.repository,
    ref: config.defaultRef,
    upstreamSha: upstream?.upstreamSha ?? null,
    upstreamError: upstream?.error ?? null,
    graph,
    graphError,
  };
}
