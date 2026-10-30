/** Execution placement never grants durable-authority mutation rights. */
export function computeOnly(): boolean {
  return process.env.DEVINT_COMPUTE_ONLY === '1';
}

export function assertAuthorityWritesAllowed(): void {
  if (computeOnly()) {
    throw Object.assign(new Error('This compute-only runtime cannot publish canonical or accepted authority'), {
      status: 403,
      code: 'COMPUTE_ONLY_AUTHORITY_DENIED',
    });
  }
}
