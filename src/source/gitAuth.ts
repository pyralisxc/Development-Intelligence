import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from '../types.js';
import { resolveRepositoryCredential } from './repositoryCredential.js';
import { hasProjectAccess, projectAccessScratchPrefix } from '../config/projectAccess.js';

export interface GitAuthContext {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export async function gitAuth(config: ProjectConfig): Promise<GitAuthContext> {
  const resolved = await resolveRepositoryCredential(config);
  if (!resolved) return { env: {}, cleanup: async () => {} };

  const scratch = hasProjectAccess() ? path.resolve(process.env.DEVINT_SCRATCH_DIR ?? os.tmpdir()) : os.tmpdir();
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.mkdtemp(projectAccessScratchPrefix(scratch, 'askpass'));
  const askpass = path.join(dir, 'askpass.sh');
  const username = resolved.username;
  try { await fs.writeFile(
    askpass,
    '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$DEVINT_GIT_USERNAME" ;;\n  *) printf "%s\\n" "$DEVINT_GIT_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  ); } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
  return {
    env: {
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: '0',
      DEVINT_GIT_USERNAME: username,
      DEVINT_GIT_TOKEN: resolved.token,
    },
    cleanup: async () => { await fs.rm(dir, { recursive: true, force: true }); },
  };
}
