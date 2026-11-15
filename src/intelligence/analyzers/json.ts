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

  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    const pending: Array<{ dependencies: unknown; path: string }> = [{ dependencies: root.dependencies, path: 'dependencies' }];
    while (pending.length) {
      const { dependencies, path } = pending.pop()!;
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
      for (const [dependency, metadata] of Object.entries(dependencies as Record<string, unknown>)) {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
        const record = metadata as Record<string, unknown>;
        const dependencyPath = `${path}.${dependency}`;
        emit(`${dependencyPath}.version`, record.version);
        pending.push({ dependencies: record.dependencies, path: `${dependencyPath}.dependencies` });
      }
    }
  }

  return observations;
}

export function analyzeJson(context: AnalyzeContext): AnalyzeResult {
  const value = JSON.parse(context.text) as unknown;
  if (NPM_LOCKFILES.has(fileName(context.locatorBase))) {
    return { observations: npmLockfileObservations(context, value), resolutions: [],
      coverage: { status: 'partial', reason: 'Lockfile analysis retains package versions rather than every structured value.' } };
  }

  const observations: Observation[] = [];
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: '' }];
  while (pending.length) {
    const { value: current, path } = pending.pop()!;
    if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) {
      observations.push(structuredObservation(context, path, current as string | number | boolean | null));
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push({ value: current[index], path: `${path}[${index}]` });
      continue;
    }
    if (typeof current === 'object') {
      const entries = Object.entries(current as Record<string, unknown>);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index]!;
        pending.push({ value: child, path: path ? `${path}.${key}` : key });
      }
    }
  }
  return { observations, resolutions: [] };
}
