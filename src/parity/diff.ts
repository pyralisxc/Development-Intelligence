import type { Observation, ParityScan, Resolution } from '../types.js';
import { loadScan } from './store.js';

function diffById<T extends { id: string }>(left: T[], right: T[]): { added: T[]; removed: T[]; changed: Array<{ before: T; after: T }> } {
  const a = new Map(left.map(item => [item.id, item]));
  const b = new Map(right.map(item => [item.id, item]));
  const added: T[] = [];
  const removed: T[] = [];
  const changed: Array<{ before: T; after: T }> = [];
  for (const [id, item] of b) {
    const previous = a.get(id);
    if (!previous) added.push(item);
    else if (JSON.stringify(previous) !== JSON.stringify(item)) changed.push({ before: previous, after: item });
  }
  for (const [id, item] of a) if (!b.has(id)) removed.push(item);
  return { added, removed, changed };
}

function sourceSummary(scan: ParityScan) {
  return scan.sources.map(source => ({ id: source.id, kind: source.kind, locator: source.locator, revision: source.revision, observedAt: source.observedAt, available: source.available }));
}

export async function diffParity(project: string, baseScanId: string, headScanId: string): Promise<Record<string, unknown>> {
  const base = await loadScan(project, baseScanId);
  const head = await loadScan(project, headScanId);
  const observationDiff = diffById<Observation>(base.observations, head.observations);
  const resolutionDiff = diffById<Resolution>(base.resolutions, head.resolutions);
  const baseUnmatched = new Set(base.unmatchedObservationIds);
  const headUnmatched = new Set(head.unmatchedObservationIds);
  return {
    project,
    base: { scanId: base.scanId, createdAt: base.createdAt, repositoryRevision: base.repositoryRevision, sources: sourceSummary(base) },
    head: { scanId: head.scanId, createdAt: head.createdAt, repositoryRevision: head.repositoryRevision, sources: sourceSummary(head) },
    observations: observationDiff,
    resolutions: resolutionDiff,
    newlyUnmatchedObservationIds: head.unmatchedObservationIds.filter(id => !baseUnmatched.has(id)),
    resolvedUnmatchedObservationIds: base.unmatchedObservationIds.filter(id => !headUnmatched.has(id)),
    namingDivergences: {
      added: head.namingDivergences.filter(item => !base.namingDivergences.some(previous => JSON.stringify(previous) === JSON.stringify(item))),
      removed: base.namingDivergences.filter(item => !head.namingDivergences.some(next => JSON.stringify(next) === JSON.stringify(item))),
    },
    explicitValueConflicts: {
      added: head.explicitValueConflicts.filter(item => !base.explicitValueConflicts.some(previous => JSON.stringify(previous) === JSON.stringify(item))),
      removed: base.explicitValueConflicts.filter(item => !head.explicitValueConflicts.some(next => JSON.stringify(next) === JSON.stringify(item))),
    },
    unavailableSources: {
      base: base.unavailableSourceIds,
      head: head.unavailableSourceIds,
    },
  };
}
