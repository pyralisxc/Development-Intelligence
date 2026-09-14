import { cbmCall } from './cbm.js';
import { readProjectState } from './sourceManager.js';

const PRIVATE_PATH_KEYS = new Set([
  'root_path', 'repo_path', 'worktree', 'shadow_path', 'shadow_root', 'database_path', 'cache_path', 'logfile', 'log_path',
]);

function sanitize(value: unknown, internalProject: string, publicProject: string, worktree: string | null): unknown {
  if (typeof value === 'string') {
    let text = value.split(internalProject).join(publicProject);
    if (worktree) {
      text = text.split(`${worktree}/`).join('');
      text = text.split(worktree).join(publicProject);
    }
    return text;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, internalProject, publicProject, worktree));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_PATH_KEYS.has(key)) continue;
    output[key] = sanitize(child, internalProject, publicProject, worktree);
  }
  return output;
}

export async function callCurrentCodebase(project: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const state = await readProjectState(project);
  if (!state.selectedCbmProject || !state.selectedSha) {
    throw new Error(`${project} has no selected Codebase Memory generation. Run refresh_codebase first.`);
  }
  const result = await cbmCall(tool, { ...args, project: state.selectedCbmProject });
  return sanitize(result, state.selectedCbmProject, project, state.selectedWorktree);
}
