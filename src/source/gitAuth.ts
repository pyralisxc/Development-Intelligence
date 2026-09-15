import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from '../types.js';

export interface GitAuthContext {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export async function gitAuth(config: ProjectConfig): Promise<GitAuthContext> {
  const credential = config.credential ?? { type: 'none' as const };
  if (credential.type === 'none') return { env: {}, cleanup: async () => {} };

  const token = process.env[credential.tokenEnv];
  if (!token) throw new Error(`Missing configured repository credential environment variable: ${credential.tokenEnv}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-git-'));
  const askpass = path.join(dir, 'askpass.sh');
  const username = credential.username ?? 'oauth2';
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
      DEVINT_GIT_TOKEN: token,
    },
    cleanup: async () => { await fs.rm(dir, { recursive: true, force: true }); },
  };
}
