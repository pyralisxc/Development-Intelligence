import { getProjectConfig } from '../config/registry.js';
import type { TechnicalSourceCapability, TechnicalSourceConfig } from '../types.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function envHeaders(source: TechnicalSourceConfig): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.8' };
  for (const item of source.headers ?? []) {
    const value = process.env[item.valueEnv];
    if (!value) throw new Error(`Missing technical source credential environment variable: ${item.valueEnv}`);
    headers[item.name] = value;
  }
  return headers;
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error(`Technical source response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export async function listTechnicalSources(project: string): Promise<Array<Record<string, unknown>>> {
  const config = await getProjectConfig(project);
  const configured = (config.technicalSources ?? []).map(source => ({
    id: source.id,
    label: source.label ?? source.id,
    type: source.type,
    capabilities: source.capabilities,
    endpoint: source.endpoint,
    configured: true,
    access: 'read-only',
  }));
  return [
    {
      id: 'git',
      label: 'Git repository',
      type: 'git',
      capabilities: ['source', 'history', 'diff'],
      endpoint: config.repository,
      configured: true,
      access: 'read-only',
    },
    ...(config.runtimeOrigins ?? []).map((origin, index) => ({
      id: `runtime-${index + 1}`,
      label: `Runtime ${new URL(origin).hostname}`,
      type: 'runtime-http',
      capabilities: ['runtime-observation'],
      endpoint: origin,
      configured: true,
      access: 'read-only',
    })),
    ...configured,
  ];
}

export async function queryTechnicalSource(input: {
  project: string;
  sourceId: string;
  capability?: TechnicalSourceCapability | undefined;
  query: string;
  limit?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): Promise<Record<string, unknown>> {
  const config = await getProjectConfig(input.project);
  const source = (config.technicalSources ?? []).find(item => item.id === input.sourceId);
  if (!source) throw new Error(`Unknown technical source: ${input.sourceId}`);
  const capability = input.capability ?? source.capabilities[0];
  if (!capability || !source.capabilities.includes(capability)) throw new Error(`Technical source ${source.id} does not support capability ${String(capability)}`);
  const query = input.query.trim();
  if (!query) throw new Error('query must be non-empty');
  if (query.length > 8_000) throw new Error('query exceeds 8000 characters');
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const endpoint = new URL(source.endpoint);
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('capability', capability);
  endpoint.searchParams.set('limit', String(limit));
  if (input.from) endpoint.searchParams.set('from', input.from);
  if (input.to) endpoint.searchParams.set('to', input.to);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), source.timeoutMs ?? 15_000);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: envHeaders(source),
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await readBounded(response);
    const contentType = response.headers.get('content-type') ?? '';
    let data: unknown = body;
    if (contentType.includes('application/json')) {
      try { data = body ? JSON.parse(body) : null; } catch { data = body; }
    }
    return {
      project: input.project,
      source: { id: source.id, label: source.label ?? source.id, type: source.type, capability },
      observedAt: new Date().toISOString(),
      status: response.status,
      ok: response.ok,
      contentType,
      data,
    };
  } finally {
    clearTimeout(timeout);
  }
}
