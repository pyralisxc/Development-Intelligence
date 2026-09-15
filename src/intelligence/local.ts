import path from 'node:path';
import { runChecked } from '../util/process.js';
import type { IntelligenceGraph } from '../types.js';
import { buildRepositoryGraph } from './repository.js';
import { checkpointAnalyzerCurrent, readCheckpoint, writeCheckpoint } from './checkpoint.js';

async function gitValue(root: string, args: string[]): Promise<string> {
  return (await runChecked('git', ['-C', root, ...args])).stdout.trim();
}

export async function buildLocalGraph(rootInput: string, project?: string, role: 'W' | 'B' = 'W'): Promise<IntelligenceGraph> {
  const root = path.resolve(rootInput);
  const revision = await gitValue(root, ['rev-parse', 'HEAD']);
  let repository = '';
  try { repository = await gitValue(root, ['remote', 'get-url', 'origin']); } catch { repository = root; }
  const name = project?.trim() || path.basename(root);
  return await buildRepositoryGraph({ project: name, repository, revision, root, role });
}

export async function sealLocalGraph(root: string, project?: string): Promise<{ graph: IntelligenceGraph; path: string }> {
  const graph = await buildLocalGraph(root, project, 'B');
  const target = await writeCheckpoint(path.resolve(root), graph);
  return { graph, path: target };
}

export async function checkLocalGraph(root: string, project?: string): Promise<Record<string, unknown>> {
  const graph = await buildLocalGraph(root, project, 'W');
  const checkpoint = await readCheckpoint(path.resolve(root));
  if (!checkpoint) return { current: false, reason: 'missing-checkpoint', sourceFingerprint: graph.sourceFingerprint };
  const sourceCurrent = checkpoint.meta.sourceFingerprint === graph.sourceFingerprint;
  const analyzerCurrent = checkpointAnalyzerCurrent(checkpoint.meta);
  const topologyCurrent = checkpoint.meta.schemaVersion === 2 && checkpoint.meta.topologyFingerprint === graph.topologyFingerprint;
  return {
    current: sourceCurrent && analyzerCurrent && topologyCurrent,
    sourceCurrent,
    analyzerCurrent,
    topologyCurrent,
    expectedSourceFingerprint: graph.sourceFingerprint,
    checkpointSourceFingerprint: checkpoint.meta.sourceFingerprint,
    expectedTopologyFingerprint: graph.topologyFingerprint,
    checkpointTopologyFingerprint: checkpoint.meta.schemaVersion === 2 ? checkpoint.meta.topologyFingerprint : null,
    expectedAnalyzerVersion: graph.analyzerVersion,
    checkpointAnalyzerVersion: checkpoint.meta.schemaVersion === 2 ? checkpoint.meta.analyzerVersion : 'legacy-1',
    checkpointSummary: checkpoint.meta.summary,
  };
}
