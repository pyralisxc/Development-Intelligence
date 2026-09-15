import { cbmCall } from './cbm.js';
import { withHydratedBundle } from './hydration.js';

const PRIVATE_PATH_KEYS = new Set([
  'root_path', 'repo_path', 'worktree', 'shadow_path', 'shadow_root', 'database_path', 'cache_path', 'logfile', 'log_path',
]);

function sanitize(value: unknown, internalProject: string, publicProject: string, sourceDir: string): unknown {
  if (typeof value === 'string') {
    let text = value.split(internalProject).join(publicProject);
    text = text.split(`${sourceDir}/`).join('');
    text = text.split(sourceDir).join(publicProject);
    return text;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, internalProject, publicProject, sourceDir));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_PATH_KEYS.has(key)) continue;
    output[key] = sanitize(child, internalProject, publicProject, sourceDir);
  }
  return output;
}

export async function callCurrentCodebase(project: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return await withHydratedBundle(project, async hydrated => {
    const result = await cbmCall(tool, { ...args, project: hydrated.cbmProject }, { env: hydrated.cbmEnv });
    return sanitize(result, hydrated.cbmProject, project, hydrated.sourceDir);
  });
}
