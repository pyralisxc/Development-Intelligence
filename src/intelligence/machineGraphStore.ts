import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectAccessScopeKey } from '../config/projectAccess.js';
import { previewRuntime } from '../config/runtimeRole.js';
import { ANALYZER_VERSION } from './repository.js';

/** The persistent machine uses the same graph/index store as local DI. Each
 * engine, project grant and repository gets its own retained generations. */
export function machineGraphStoreRoot(project: string, repository: string): string | null {
  const root = process.env.DEVINT_MACHINE_GRAPH_DIR?.trim();
  if (!root || !previewRuntime()) return null;
  const engine = process.env.DEVINT_BUILD_SHA || process.env.DEVINT_PREVIEW_ENGINE_REVISION || ANALYZER_VERSION;
  const identity = JSON.stringify([projectAccessScopeKey(), project, repository, ANALYZER_VERSION, engine,
    process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? process.env.DEVINT_PARITY_MAX_FILE_BYTES ?? null,
    process.env.DEVINT_GRAPH_MAX_FILES ?? process.env.DEVINT_PARITY_MAX_FILES ?? null]);
  return path.join(path.resolve(root), createHash('sha256').update(identity).digest('hex'));
}
