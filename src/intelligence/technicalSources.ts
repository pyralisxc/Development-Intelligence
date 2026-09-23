import { getProjectConfig } from '../config/registry.js';
import { stableHash } from '../util/hash.js';
import { graphContext } from './service.js';
import type {
  GraphNode,
  TechnicalEvidenceCorrelation,
  TechnicalEvidenceEnvelope,
  TechnicalEvidenceObservation,
  TechnicalEvidenceRelationship,
  TechnicalSourceAdapterKind,
  TechnicalSourceCapability,
  TechnicalSourceConfig,
} from '../types.js';

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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textField(value: unknown, ...keys: string[]): string | null {
  const current = record(value);
  if (!current) return null;
  for (const key of keys) {
    const candidate = current[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function nestedText(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    const row = record(current);
    if (!row) return null;
    current = row[key];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

function sourceTimestamp(data: unknown): string | null {
  return textField(data, 'observedAt', 'updatedAt', 'createdAt', 'timestamp')
    ?? nestedText(data, ['meta', 'observedAt'])
    ?? nestedText(data, ['meta', 'updatedAt']);
}

function sourceRevision(data: unknown): string | null {
  return textField(data, 'revision', 'version', 'sha', 'commitSha', 'gitSha')
    ?? nestedText(data, ['gitSource', 'sha'])
    ?? nestedText(data, ['git', 'sha'])
    ?? nestedText(data, ['meta', 'githubCommitSha']);
}

function observation(input: {
  source: TechnicalSourceConfig;
  adapter: TechnicalSourceAdapterKind;
  kind: string;
  locator: string;
  name?: string;
  value: unknown;
  observedAt: string;
  revision?: string | null;
}): TechnicalEvidenceObservation {
  return {
    id: `external:${stableHash([input.source.id, input.adapter, input.kind, input.locator, input.name ?? null, input.revision ?? null])}`,
    kind: input.kind,
    locator: input.locator,
    ...(input.name ? { name: input.name } : {}),
    value: input.value,
    observedAt: input.observedAt,
    ...(input.revision ? { sourceRevision: input.revision } : {}),
  };
}

function relationship(input: {
  sourceId: string;
  from: string;
  to: string;
  kind: string;
  evidence: string[];
  status?: 'resolved' | 'candidate';
  confidence?: number;
}): TechnicalEvidenceRelationship {
  const status = input.status ?? 'resolved';
  return {
    id: `external-edge:${stableHash([input.sourceId, input.from, input.to, input.kind, status])}`,
    from: input.from,
    to: input.to,
    kind: input.kind,
    status,
    confidence: input.confidence ?? (status === 'resolved' ? 1 : 0.65),
    evidence: input.evidence,
  };
}

function deploymentItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const row = record(data);
  return Array.isArray(row?.deployments) ? row.deployments : row ? [row] : [];
}

function deploymentEvidence(source: TechnicalSourceConfig, data: unknown, observedAt: string): {
  observations: TechnicalEvidenceObservation[];
  relationships: TechnicalEvidenceRelationship[];
  recognized: boolean;
} {
  const observations: TechnicalEvidenceObservation[] = [];
  const relationships: TechnicalEvidenceRelationship[] = [];

  for (const item of deploymentItems(data)) {
    const row = record(item);
    if (!row) continue;
    const deploymentId = textField(row, 'id', 'uid', 'deploymentId', 'name');
    if (!deploymentId) continue;
    const revision = sourceRevision(row);
    const status = textField(row, 'state', 'status', 'readyState');
    const url = textField(row, 'url', 'targetUrl', 'deploymentUrl');
    const gitRef = nestedText(row, ['gitSource', 'ref']) ?? nestedText(row, ['git', 'ref']) ?? textField(row, 'gitRef', 'branch');
    const id = `deployment:${deploymentId}`;
    const value = {
      deploymentId,
      status,
      url,
      gitSha: revision,
      gitRef,
    };
    observations.push(observation({
      source,
      adapter: 'deployment-state',
      kind: 'deployment-state',
      locator: id,
      name: deploymentId,
      value,
      observedAt,
      revision,
    }));
    if (revision) relationships.push(relationship({
      sourceId: source.id,
      from: id,
      to: `git-revision:${revision}`,
      kind: 'deployed-from',
      evidence: [`deployment ${deploymentId} reports git revision ${revision}`],
    }));
    if (url) relationships.push(relationship({
      sourceId: source.id,
      from: id,
      to: `url:${url}`,
      kind: 'available-at',
      evidence: [`deployment ${deploymentId} reports URL ${url}`],
    }));
  }

  return { observations, relationships, recognized: observations.length > 0 };
}

function schemaItems(data: unknown): { tables: Array<{ schema: string; name: string; raw: unknown }>; routines: Array<{ schema: string; name: string; raw: unknown }> } {
  const tables: Array<{ schema: string; name: string; raw: unknown }> = [];
  const routines: Array<{ schema: string; name: string; raw: unknown }> = [];
  const row = record(data);
  if (!row) return { tables, routines };

  const add = (target: typeof tables, value: unknown, fallbackSchema = 'public') => {
    if (typeof value === 'string') {
      const parts = value.split('.');
      target.push({ schema: parts.length > 1 ? parts.slice(0, -1).join('.') : fallbackSchema, name: parts.at(-1)!, raw: value });
      return;
    }
    const item = record(value);
    if (!item) return;
    const name = textField(item, 'name', 'table', 'function', 'routine');
    if (!name) return;
    target.push({ schema: textField(item, 'schema', 'namespace') ?? fallbackSchema, name, raw: value });
  };

  if (Array.isArray(row.tables)) for (const item of row.tables) add(tables, item);
  if (Array.isArray(row.functions)) for (const item of row.functions) add(routines, item);
  if (Array.isArray(row.routines)) for (const item of row.routines) add(routines, item);

  if (Array.isArray(row.schemas)) for (const schemaValue of row.schemas) {
    const schema = record(schemaValue);
    if (!schema) continue;
    const schemaName = textField(schema, 'name', 'schema') ?? 'public';
    if (Array.isArray(schema.tables)) for (const item of schema.tables) add(tables, item, schemaName);
    if (Array.isArray(schema.functions)) for (const item of schema.functions) add(routines, item, schemaName);
    if (Array.isArray(schema.routines)) for (const item of schema.routines) add(routines, item, schemaName);
  }

  return { tables, routines };
}

function databaseEvidence(source: TechnicalSourceConfig, data: unknown, observedAt: string): {
  observations: TechnicalEvidenceObservation[];
  relationships: TechnicalEvidenceRelationship[];
  recognized: boolean;
} {
  const observations: TechnicalEvidenceObservation[] = [];
  const relationships: TechnicalEvidenceRelationship[] = [];
  const revision = sourceRevision(data);
  const items = schemaItems(data);

  for (const table of items.tables) {
    const qualified = `${table.schema}.${table.name}`;
    const id = `database-table:${qualified.toLowerCase()}`;
    observations.push(observation({
      source,
      adapter: 'database-schema',
      kind: 'database-table',
      locator: id,
      name: qualified,
      value: { schema: table.schema, name: table.name, qualifiedName: qualified, raw: table.raw },
      observedAt,
      revision,
    }));
    relationships.push(relationship({
      sourceId: source.id,
      from: `database-schema:${table.schema.toLowerCase()}`,
      to: id,
      kind: 'contains',
      evidence: [`schema ${table.schema} contains table ${table.name}`],
    }));
  }

  for (const routine of items.routines) {
    const qualified = `${routine.schema}.${routine.name}`;
    const id = `database-function:${qualified.toLowerCase()}`;
    observations.push(observation({
      source,
      adapter: 'database-schema',
      kind: 'database-function',
      locator: id,
      name: qualified,
      value: { schema: routine.schema, name: routine.name, qualifiedName: qualified, raw: routine.raw },
      observedAt,
      revision,
    }));
    relationships.push(relationship({
      sourceId: source.id,
      from: `database-schema:${routine.schema.toLowerCase()}`,
      to: id,
      kind: 'contains',
      evidence: [`schema ${routine.schema} contains routine ${routine.name}`],
    }));
  }

  return { observations, relationships, recognized: observations.length > 0 };
}

function genericEvidence(source: TechnicalSourceConfig, data: unknown, observedAt: string): {
  observations: TechnicalEvidenceObservation[];
  relationships: TechnicalEvidenceRelationship[];
  recognized: boolean;
} {
  if (data === null || data === undefined) return { observations: [], relationships: [], recognized: false };
  const revision = sourceRevision(data);
  return {
    observations: [observation({
      source,
      adapter: 'generic-json',
      kind: 'technical-payload',
      locator: `technical-source:${source.id}`,
      name: source.label ?? source.id,
      value: data,
      observedAt,
      revision,
    })],
    relationships: [],
    recognized: true,
  };
}

function graphText(node: GraphNode, key: string): string | null {
  if (!node.value || typeof node.value !== 'object') return null;
  const value = node.value as Record<string, unknown>;
  return typeof value[key] === 'string' ? String(value[key]) : null;
}

async function correlate(project: string, source: TechnicalSourceConfig, observations: TechnicalEvidenceObservation[]): Promise<{
  correlations: TechnicalEvidenceCorrelation[];
  status: TechnicalEvidenceEnvelope['correlationStatus'];
}> {
  try {
    const { graph } = await graphContext(project);
    const correlations: TechnicalEvidenceCorrelation[] = [];

    if (source.providerId) {
      const provider = graph.nodes.find(node => node.id === `provider:${source.providerId}`);
      if (provider) correlations.push({
        externalId: `technical-source:${source.id}`,
        repositoryTarget: provider.id,
        kind: 'matches-provider',
        status: 'resolved',
        evidence: [`technical source providerId ${source.providerId} matches exact repository provider node`],
      });
    }

    for (const item of observations) {
      const value = record(item.value);
      const gitSha = typeof value?.gitSha === 'string' ? value.gitSha : null;
      if (gitSha && graph.repositoryRevision === gitSha) correlations.push({
        externalId: item.id,
        repositoryTarget: graph.graphId,
        kind: 'matches-revision',
        status: 'resolved',
        evidence: [`external git revision ${gitSha} equals inspected repository revision`],
      });

      if (item.kind === 'database-table') {
        const qualified = typeof value?.qualifiedName === 'string' ? value.qualifiedName.toLowerCase() : null;
        const short = typeof value?.name === 'string' ? value.name.toLowerCase() : null;
        const candidates = graph.nodes.filter(node => {
          if (node.kind !== 'sql-table') return false;
          const candidateQualified = graphText(node, 'qualifiedName')?.toLowerCase();
          const candidateName = node.name?.toLowerCase();
          return Boolean((qualified && candidateQualified === qualified) || (short && candidateName === short));
        });
        if (candidates.length === 1) correlations.push({
          externalId: item.id,
          repositoryTarget: candidates[0]!.id,
          kind: 'matches-entity',
          status: 'resolved',
          evidence: [`external table ${item.name ?? item.locator} uniquely matches repository SQL table`],
        });
      }
    }

    return { correlations, status: { attempted: true, available: true } };
  } catch (error) {
    return {
      correlations: [],
      status: {
        attempted: true,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function snapshotState(source: TechnicalSourceConfig, response: Response, data: unknown, observedAt: string): TechnicalEvidenceEnvelope['snapshot'] {
  const sourceObservedAt = sourceTimestamp(data);
  const parsedObserved = sourceObservedAt ? Date.parse(sourceObservedAt) : Number.NaN;
  const ageMs = Number.isFinite(parsedObserved) ? Math.max(0, Date.parse(observedAt) - parsedObserved) : null;
  const freshness = source.freshnessMs === undefined || ageMs === null
    ? 'unknown'
    : ageMs <= source.freshnessMs ? 'fresh' : 'stale';
  const revision = sourceRevision(data);
  const snapshotId = response.headers.get('etag')
    ?? revision
    ?? textField(data, 'snapshotId', 'snapshot', 'id')
    ?? null;
  return {
    id: snapshotId,
    sourceRevision: revision,
    observedAt,
    sourceObservedAt,
    freshness,
    ageMs,
  };
}

export async function listTechnicalSources(project: string): Promise<Array<Record<string, unknown>>> {
  const config = await getProjectConfig(project);
  const configured = (config.technicalSources ?? []).map(source => ({
    id: source.id,
    label: source.label ?? source.id,
    type: source.type,
    adapter: source.adapter ?? 'generic-json',
    capabilities: source.capabilities,
    endpoint: source.endpoint,
    providerId: source.providerId ?? null,
    freshnessMs: source.freshnessMs ?? null,
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

    const observedAt = new Date().toISOString();
    const adapter = source.adapter ?? 'generic-json';
    const normalized = adapter === 'deployment-state'
      ? deploymentEvidence(source, data, observedAt)
      : adapter === 'database-schema'
        ? databaseEvidence(source, data, observedAt)
        : genericEvidence(source, data, observedAt);
    const correlation = await correlate(input.project, source, normalized.observations);
    const envelope: TechnicalEvidenceEnvelope = {
      source: {
        id: source.id,
        label: source.label ?? source.id,
        type: source.type,
        adapter,
        capability,
        endpoint: source.endpoint,
        ...(source.providerId ? { providerId: source.providerId } : {}),
      },
      snapshot: snapshotState(source, response, data, observedAt),
      availability: { available: response.ok, httpStatus: response.status },
      coverage: response.ok
        ? {
            status: normalized.recognized ? 'complete' : 'partial',
            observed: normalized.observations.length,
            expected: null,
            ...(!normalized.recognized ? { reason: `adapter ${adapter} did not recognize structured evidence in the response` } : {}),
          }
        : {
            status: 'unavailable',
            observed: 0,
            expected: null,
            reason: `technical source returned HTTP ${response.status}`,
          },
      observations: normalized.observations,
      relationships: normalized.relationships,
      correlations: correlation.correlations,
      correlationStatus: correlation.status,
      raw: data,
    };

    return {
      project: input.project,
      source: envelope.source,
      observedAt,
      status: response.status,
      ok: response.ok,
      contentType,
      data,
      evidence: envelope,
      policy: {
        readOnly: true,
        providerStateAuthoritative: true,
        persisted: false,
        acceptedCheckpointAffected: false,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
