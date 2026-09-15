import type { NamingDivergence, Observation, Resolution } from '../types.js';
import { normalizeName, resolution } from './model.js';

const GENERIC_VALUES = new Set(['true', 'false', 'null', 'undefined', 'open', 'close', 'save', 'delete', 'edit', 'cancel', 'ok', 'yes', 'no']);

export function resolveCrossSource(observations: Observation[], existing: Resolution[]): Resolution[] {
  const output = [...existing];
  const seen = new Set(existing.map(item => item.id));
  const exactValues = new Map<string, Observation[]>();
  const names = new Map<string, Observation[]>();

  for (const obs of observations) {
    if (typeof obs.value === 'string') {
      const value = obs.value.trim();
      if (value.length >= 4 && value.length <= 300 && !GENERIC_VALUES.has(value.toLowerCase())) {
        const list = exactValues.get(value) ?? [];
        list.push(obs);
        exactValues.set(value, list);
      }
    }
    if (obs.name) {
      const normalized = normalizeName(obs.name);
      if (normalized.length >= 4 && !GENERIC_VALUES.has(normalized)) {
        const list = names.get(normalized) ?? [];
        list.push(obs);
        names.set(normalized, list);
      }
    }
  }

  for (const group of exactValues.values()) {
    if (group.length < 2 || group.length > 10) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const left = group[i]!;
        const right = group[j]!;
        if (left.sourceId === right.sourceId) continue;
        const candidate = resolution({
          from: left.id,
          to: right.id,
          kind: 'same_observed_value',
          strategy: 'exact-value',
          confidence: 0.75,
          status: 'candidate',
          evidence: [`Both sources observed the exact value ${JSON.stringify(left.value)}`],
        });
        if (!seen.has(candidate.id)) { seen.add(candidate.id); output.push(candidate); }
      }
    }
  }

  for (const group of names.values()) {
    if (group.length < 2 || group.length > 10) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const left = group[i]!;
        const right = group[j]!;
        if (left.sourceId === right.sourceId) continue;
        const sameExactName = left.name === right.name;
        const candidate = resolution({
          from: left.id,
          to: right.id,
          kind: sameExactName ? 'same_observed_name' : 'similar_identifier',
          strategy: sameExactName ? 'exact-name' : 'identifier-match',
          confidence: sameExactName ? 0.8 : 0.65,
          status: 'candidate',
          evidence: [sameExactName
            ? `Both sources observed the exact name ${JSON.stringify(left.name)}`
            : `Normalized names both resolve to ${JSON.stringify(normalizeName(left.name!))}`],
        });
        if (!seen.has(candidate.id)) { seen.add(candidate.id); output.push(candidate); }
      }
    }
  }
  return output;
}

export function deriveNamingDivergences(observations: Observation[], resolutions: Resolution[]): NamingDivergence[] {
  const byId = new Map(observations.map(obs => [obs.id, obs]));
  const output: NamingDivergence[] = [];
  for (const rel of resolutions) {
    if (rel.status !== 'resolved' || !rel.from || !rel.to) continue;
    const left = byId.get(rel.from);
    const right = byId.get(rel.to);
    if (!left?.name || !right?.name) continue;
    const leftName = normalizeName(left.name);
    const rightName = normalizeName(right.name);
    if (!leftName || !rightName || leftName === rightName) continue;
    output.push({
      resolutionId: rel.id,
      fromObservationId: left.id,
      toObservationId: right.id,
      fromName: left.name,
      toName: right.name,
    });
  }
  return output;
}

export function deriveUnmatched(observations: Observation[], resolutions: Resolution[]): string[] {
  const linked = new Set<string>();
  for (const rel of resolutions) {
    if (rel.status !== 'resolved') continue;
    if (rel.from) linked.add(rel.from);
    if (rel.to) linked.add(rel.to);
  }
  const interesting = new Set(['ui-element', 'http-call', 'route-reference', 'navigation-call', 'mcp-tool', 'heading']);
  return observations.filter(obs => interesting.has(obs.kind) && !linked.has(obs.id)).map(obs => obs.id);
}
