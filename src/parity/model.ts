import type { Observation, Resolution, SourceDescriptor } from '../types.js';
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

export function observation(input: Omit<Observation, 'id' | 'raw'> & { raw?: string }): Observation {
  const raw = input.raw ?? stringifyValue(input.value);
  const identity = [input.sourceId, input.kind, input.locator, input.field ?? null];
  return { ...input, raw, id: stableHash(identity) };
}

export function resolution(input: Omit<Resolution, 'id'>): Resolution {
  return { ...input, id: stableHash([input.from, input.to, input.kind, input.strategy, input.status]) };
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
