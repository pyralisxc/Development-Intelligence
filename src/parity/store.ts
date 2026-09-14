import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDataDir } from '../config/paths.js';
import type { ParityScan } from '../types.js';
import { atomicWriteJson, ensureDir, readJson } from '../util/fs.js';

function parityDir(project: string): string { return path.join(projectDataDir(project), 'parity'); }
function latestFile(project: string): string { return path.join(parityDir(project), 'latest.json'); }
function scanFile(project: string, scanId: string): string { return path.join(parityDir(project), 'scans', `${scanId}.json`); }

export async function saveScan(scan: ParityScan): Promise<void> {
  await ensureDir(path.dirname(scanFile(scan.project, scan.scanId)));
  await atomicWriteJson(scanFile(scan.project, scan.scanId), scan);
  await atomicWriteJson(latestFile(scan.project), { scanId: scan.scanId, createdAt: scan.createdAt });
}

export async function loadScan(project: string, scanId: string): Promise<ParityScan> {
  const value = await readJson<ParityScan | null>(scanFile(project, scanId), null);
  if (!value) throw new Error(`Parity scan not found: ${project}/${scanId}`);
  return value;
}

export async function latestScan(project: string): Promise<ParityScan | null> {
  const latest = await readJson<{ scanId: string } | null>(latestFile(project), null);
  return latest ? await loadScan(project, latest.scanId) : null;
}

export async function listScans(project: string): Promise<Array<{ scanId: string; createdAt: string }>> {
  const dir = path.join(parityDir(project), 'scans');
  try {
    const files = (await fs.readdir(dir)).filter((file: string) => file.endsWith('.json')).sort().reverse();
    const scans = [];
    for (const file of files.slice(0, 100)) {
      const scan = await readJson<ParityScan | null>(path.join(dir, file), null);
      if (scan) scans.push({ scanId: scan.scanId, createdAt: scan.createdAt });
    }
    return scans;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
