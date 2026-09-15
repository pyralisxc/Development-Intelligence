import { runChecked } from '../util/process.js';

export interface CbmCallOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function cbmCall(tool: string, args: Record<string, unknown> = {}, options: CbmCallOptions = {}): Promise<unknown> {
  const binary = process.env.DEVINT_CBM_BINARY ?? 'codebase-memory-mcp';
  const cliArgs = ['cli', '--raw', tool];
  if (Object.keys(args).length > 0) cliArgs.push(JSON.stringify(args));
  const env: NodeJS.ProcessEnv = {
    CBM_WORKERS: process.env.CBM_WORKERS ?? '1',
    ...(process.env.CBM_MEM_BUDGET_MB ? { CBM_MEM_BUDGET_MB: process.env.CBM_MEM_BUDGET_MB } : {}),
    ...(process.env.CBM_CACHE_DIR ? { CBM_CACHE_DIR: process.env.CBM_CACHE_DIR } : {}),
    ...options.env,
  };
  const result = await runChecked(binary, cliArgs, { env, timeoutMs: options.timeoutMs ?? 10 * 60_000 });
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

export function isHealthyIndexResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  if (status && ['error', 'failed', 'degraded', 'cancelled'].includes(status)) return false;
  const nodes = numeric(record.nodes ?? record.node_count ?? record.total_nodes);
  if (nodes !== null && nodes <= 0) return false;
  return true;
}

export function codebaseSummary(value: unknown): { status: string; nodes: number | null; edges: number | null } {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    status: typeof record.status === 'string' ? record.status : 'unknown',
    nodes: numeric(record.nodes ?? record.node_count ?? record.total_nodes),
    edges: numeric(record.edges ?? record.edge_count ?? record.total_edges),
  };
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}
