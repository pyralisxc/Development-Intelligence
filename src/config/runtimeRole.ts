/** Execution placement never grants durable-authority mutation rights. */
import { hasProjectAccess } from './projectAccess.js';
export function computeOnly(): boolean {
  return hasProjectAccess() || process.env.DEVINT_COMPUTE_ONLY === '1';
}

export function previewRuntime(): boolean {
  return process.env.VERCEL_ENV === 'preview' || process.env.VERCEL_TARGET_ENV === 'preview';
}

export function assertAuthorityWritesAllowed(): void {
  if (computeOnly() || previewRuntime()) {
    throw Object.assign(new Error('This runtime cannot publish canonical source graphs'), {
      status: 403,
      code: 'COMPUTE_ONLY_AUTHORITY_DENIED',
    });
  }
}
