import type { ParityScan } from '../types.js';
import { safeSegment } from '../config/paths.js';
import { projectArtifactPrefix, readArtifactJson, writeArtifactJson } from '../storage/artifacts.js';
import { readStoredProjectState, recordParityScan } from '../storage/control.js';

function scanKey(project: string, scanId: string): string {
  const safe = safeSegment(scanId);
  if (safe !== scanId) throw new Error(`Invalid parity scan identity: ${scanId}`);
  return `${projectArtifactPrefix(project)}/parity/scans/${safe}.json`;
}

export async function saveScan(scan: ParityScan, recordLatest = true): Promise<void> {
  await writeArtifactJson(scanKey(scan.project, scan.scanId), scan);
  if (recordLatest) await recordParityScan(scan.project, { scanId: scan.scanId, createdAt: scan.createdAt }, scan.repositoryRevision);
}

export async function loadScan(project: string, scanId: string): Promise<ParityScan> {
  try {
    return await readArtifactJson<ParityScan>(scanKey(project, scanId));
  } catch (error) {
    throw new Error(`Parity scan not found: ${project}/${scanId}`, { cause: error });
  }
}

export async function latestScan(project: string): Promise<ParityScan | null> {
  const state = await readStoredProjectState(project);
  if (!state?.latestParityScanId) return null;
  return await loadScan(project, state.latestParityScanId);
}

export async function listScans(project: string): Promise<Array<{ scanId: string; createdAt: string }>> {
  const state = await readStoredProjectState(project);
  return Array.isArray(state?.recentParityScans) ? state.recentParityScans.slice(0, 100) : [];
}
