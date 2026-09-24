import { toolContract } from './mcp.js';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;
const SAFE_REF = /^[A-Za-z0-9._\/-]{1,200}$/;
const DEPLOYMENT_ENVIRONMENTS = new Set(['production', 'preview', 'development']);

function exactGitSha(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && FULL_GIT_SHA.test(candidate) ? candidate.toLowerCase() : null;
}

function safeRef(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && SAFE_REF.test(candidate) ? candidate : null;
}

function deploymentEnvironment(value: string | undefined): string | null {
  const candidate = value?.trim().toLowerCase();
  return candidate && DEPLOYMENT_ENVIRONMENTS.has(candidate) ? candidate : null;
}

export function runtimeIdentity(env: NodeJS.ProcessEnv = process.env) {
  const revision = exactGitSha(env.DEVINT_BUILD_SHA) ?? exactGitSha(env.VERCEL_GIT_COMMIT_SHA);
  return {
    deployment: {
      revision,
      gitRef: safeRef(env.VERCEL_GIT_COMMIT_REF),
      environment: deploymentEnvironment(env.VERCEL_TARGET_ENV),
    },
    mcp: toolContract(),
  };
}
