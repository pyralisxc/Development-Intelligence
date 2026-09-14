import type { Observation, Resolution } from '../types.js';
import { loadScan, latestScan, listScans } from './store.js';

export interface QueryParityInput {
  project: string;
  scanId?: string;
  query?: string;
  kinds?: string[];
  sourceIds?: string[];
  status?: Array<'resolved' | 'candidate' | 'unresolved'>;
  limit?: number;
  offset?: number;
}

export async function queryParity(input: QueryParityInput): Promise<Record<string, unknown>> {
  const scan = input.scanId ? await loadScan(input.project, input.scanId) : await latestScan(input.project);
  if (!scan) throw new Error(`No parity scan exists for ${input.project}`);
  const query = input.query?.trim().toLowerCase();
  const kinds = new Set(input.kinds ?? []);
  const sourceIds = new Set(input.sourceIds ?? []);
  const statuses = new Set(input.status ?? []);
  const matchesObservation = (obs: Observation) => {
    if (kinds.size && !kinds.has(obs.kind)) return false;
    if (sourceIds.size && !sourceIds.has(obs.sourceId)) return false;
    if (!query) return true;
    return [obs.kind, obs.locator, obs.field, obs.name, obs.raw, JSON.stringify(obs.value)].filter(Boolean).join(' ').toLowerCase().includes(query);
  };
  const matchesResolution = (rel: Resolution) => {
    if (statuses.size && !statuses.has(rel.status)) return false;
    if (!query) return true;
    return [rel.kind, rel.strategy, rel.status, ...rel.evidence].join(' ').toLowerCase().includes(query);
  };
  const observations = scan.observations.filter(matchesObservation);
  const resolutions = scan.resolutions.filter(matchesResolution);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const offset = Math.max(input.offset ?? 0, 0);
  return {
    project: input.project,
    scanId: scan.scanId,
    observationTotal: observations.length,
    resolutionTotal: resolutions.length,
    observations: observations.slice(offset, offset + limit),
    resolutions: resolutions.slice(offset, offset + limit),
    namingDivergences: scan.namingDivergences.filter(item => {
      if (!query) return true;
      return `${item.fromName} ${item.toName}`.toLowerCase().includes(query);
    }).slice(offset, offset + limit),
    unmatchedObservationIds: scan.unmatchedObservationIds.slice(offset, offset + limit),
    unavailableSourceIds: scan.unavailableSourceIds,
  };
}

export async function parityStatus(project: string): Promise<Record<string, unknown>> {
  const scan = await latestScan(project);
  const scans = await listScans(project);
  if (!scan) return { project, available: false, scans: 0 };
  const counts = { resolved: 0, candidate: 0, unresolved: 0 };
  for (const rel of scan.resolutions) counts[rel.status] += 1;
  return {
    project,
    available: true,
    latestScanId: scan.scanId,
    createdAt: scan.createdAt,
    repositoryRevision: scan.repositoryRevision,
    sources: scan.sources,
    observationCount: scan.observations.length,
    resolutionCounts: counts,
    namingDivergenceCount: scan.namingDivergences.length,
    explicitValueConflictCount: scan.explicitValueConflicts.length,
    unmatchedObservationCount: scan.unmatchedObservationIds.length,
    unavailableSourceIds: scan.unavailableSourceIds,
    recentScans: scans.slice(0, 20),
  };
}
