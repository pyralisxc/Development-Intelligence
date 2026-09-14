import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import type { Observation } from '../../types.js';
import { observation } from '../model.js';

const SENSITIVE_FIELD = /(^|[._-])(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|access[-_]?token|refresh[-_]?token)($|[._-])/i;

export function analyzeJson(context: AnalyzeContext): AnalyzeResult {
  const observations: Observation[] = [];
  const value = JSON.parse(context.text) as unknown;
  const walk = (current: unknown, path: string, depth: number) => {
    if (depth > 8) return;
    if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) {
      const name = path.split('.').at(-1) ?? '$';
      const sensitive = SENSITIVE_FIELD.test(path);
      const base = { sourceId: context.source.id, kind: 'structured-value', locator: `${context.locatorBase}:${path || '$'}`, field: path || '$', name, value: sensitive ? '<redacted>' : current };
      observations.push(observation(sensitive ? { ...base, raw: '<redacted>' } : base));
      return;
    }
    if (Array.isArray(current)) {
      current.slice(0, 200).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof current === 'object') {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(value, '', 0);
  return { observations, resolutions: [] };
}
