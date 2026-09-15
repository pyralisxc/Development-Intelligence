import path from 'node:path';
import { runChecked } from '../util/process.js';
import type { IntelligenceGraph } from '../types.js';
import { buildRepositoryGraph } from './repository.js';
import { readCheckpoint, writeCheckpoint } from './checkpoint.js';

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
  return {
    current: checkpoint.meta.sourceFingerprint === graph.sourceFingerprint,
    expectedSourceFingerprint: graph.sourceFingerprint,
    checkpointSourceFingerprint: checkpoint.meta.sourceFingerprint,
    checkpointSummary: checkpoint.meta.summary,
  };
}
