import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import type { Observation } from '../../types.js';
import { observation } from '../model.js';

const SENSITIVE_FIELD = /(^|[._-])(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|access[-_]?token|refresh[-_]?token)($|[._-])/i;
const NPM_LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

function fileName(locatorBase: string): string {
  return locatorBase.split(/[\\/]/u).at(-1)?.toLowerCase() ?? locatorBase.toLowerCase();
}

function structuredObservation(
  context: AnalyzeContext,
  path: string,
  current: string | number | boolean | null,
): Observation {
  const name = path.split('.').at(-1) ?? '$';
  const sensitive = SENSITIVE_FIELD.test(path);
  const base = {
    sourceId: context.source.id,
    kind: 'structured-value',
    locator: `${context.locatorBase}:${path || '$'}`,
    field: path || '$',
    name,
    value: sensitive ? '<redacted>' : current,
  };
  return observation(sensitive ? { ...base, raw: '<redacted>' } : base);
}

function npmLockfileObservations(context: AnalyzeContext, value: unknown): Observation[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const root = value as Record<string, unknown>;
  const observations: Observation[] = [];
  const emit = (path: string, current: unknown): void => {
    if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) {
      observations.push(structuredObservation(context, path, current as string | number | boolean | null));
    }
  };

  for (const key of ['name', 'version', 'lockfileVersion']) emit(key, root[key]);

  const packages = root.packages;
  if (packages && typeof packages === 'object' && !Array.isArray(packages)) {
    for (const [packagePath, metadata] of Object.entries(packages as Record<string, unknown>)) {
      if (!packagePath || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
      emit(`packages.${packagePath}.version`, (metadata as Record<string, unknown>).version);
    }
  }

  const visitLegacyDependencies = (dependencies: unknown, path: string, depth: number): void => {
    if (depth > 12 || !dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return;
    for (const [dependency, metadata] of Object.entries(dependencies as Record<string, unknown>)) {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
      const record = metadata as Record<string, unknown>;
      const dependencyPath = `${path}.${dependency}`;
      emit(`${dependencyPath}.version`, record.version);
      visitLegacyDependencies(record.dependencies, `${dependencyPath}.dependencies`, depth + 1);
    }
  };
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    visitLegacyDependencies(root.dependencies, 'dependencies', 0);
  }

  return observations;
}

export function analyzeJson(context: AnalyzeContext): AnalyzeResult {
  const value = JSON.parse(context.text) as unknown;
  if (NPM_LOCKFILES.has(fileName(context.locatorBase))) {
    return { observations: npmLockfileObservations(context, value), resolutions: [] };
  }

  const observations: Observation[] = [];
  const walk = (current: unknown, path: string, depth: number) => {
    if (depth > 8) return;
    if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) {
      observations.push(structuredObservation(context, path, current as string | number | boolean | null));
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
