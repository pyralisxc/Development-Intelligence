import type { GraphNode, Observation, Resolution, SourceDescriptor } from '../types.js';
import { stableHash } from '../util/hash.js';

export interface AnalyzeContext {
  source: SourceDescriptor;
  text: string;
  locatorBase: string;
}

export interface AnalyzeResult {
  observations: Observation[];
  resolutions: Resolution[];
}

type ObservationInput = Omit<Observation, 'id' | 'raw'> & {
  id?: string;
  raw?: string;
  identity?: unknown[];
};

type ResolutionInput = Omit<Resolution, 'id'> & {
  id?: string;
  identity?: unknown[];
};

export function observation(input: ObservationInput): Observation {
  const { id, identity, raw: suppliedRaw, ...rest } = input;
  const raw = suppliedRaw ?? stringifyValue(rest.value);
  const defaultIdentity = [rest.sourceId, rest.kind, rest.locator, rest.field ?? null];
  return { ...rest, raw, id: id ?? stableHash(identity ?? defaultIdentity) };
}

export function semanticEntity(input: {
  id: string;
  sourceId: string;
  kind: string;
  locator: string;
  name?: string;
  value?: unknown;
  tags?: string[];
}): GraphNode {
  return observation({
    id: input.id,
    sourceId: input.sourceId,
    kind: input.kind,
    locator: input.locator,
    ...(input.name === undefined ? {} : { name: input.name }),
    value: input.value ?? input.name ?? input.id,
    tags: [...new Set(['semantic', ...(input.tags ?? [])])],
    layer: 'semantic',
    checkpoint: true,
  });
}

export function resolution(input: ResolutionInput): Resolution {
  const { id, identity, ...rest } = input;
  return { ...rest, id: id ?? stableHash(identity ?? [rest.from, rest.to, rest.kind, rest.strategy, rest.status]) };
}

export function semanticRelationship(input: {
  from: string;
  to: string;
  kind: string;
  evidence: string[];
  strategy?: string;
  confidence?: number;
  status?: 'resolved' | 'candidate' | 'unresolved';
}): Resolution {
  return resolution({
    from: input.from,
    to: input.to,
    kind: input.kind,
    strategy: input.strategy ?? 'declared',
    confidence: input.confidence ?? 1,
    status: input.status ?? 'resolved',
    evidence: input.evidence,
    layer: 'semantic',
    checkpoint: true,
  });
}

export function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function normalizeName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ')
    .toLowerCase()
    .replace(/\b(handle|on|use|create|get|set|run|do)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const SENSITIVE_FIELD = /(^|[._-])(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|access[-_]?token|refresh[-_]?token)($|[._-])/i;

export function redactSensitiveValue(field: string, value: unknown): { value: unknown; raw?: string } {
  if (!SENSITIVE_FIELD.test(field)) return { value };
  return { value: '<redacted>', raw: '<redacted>' };
}
