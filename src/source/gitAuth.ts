import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from '../types.js';
import { resolveRepositoryCredential } from './repositoryCredential.js';

export interface GitAuthContext {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export async function gitAuth(config: ProjectConfig): Promise<GitAuthContext> {
  const resolved = await resolveRepositoryCredential(config);
  if (!resolved) return { env: {}, cleanup: async () => {} };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-git-'));
  const askpass = path.join(dir, 'askpass.sh');
  const username = resolved.username;
  await fs.writeFile(
    askpass,
    '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$DEVINT_GIT_USERNAME" ;;\n  *) printf "%s\\n" "$DEVINT_GIT_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  );
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
