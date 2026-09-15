import { Firestore } from '@google-cloud/firestore';
import path from 'node:path';
import { localControlDir, safeSegment } from '../config/paths.js';
import type { ParityScanSummary, ProjectState } from '../types.js';
import { atomicWriteJson, readJson } from '../util/fs.js';

let firestore: Firestore | null = null;

function cloudEnabled(): boolean {
  return process.env.DEVINT_FIRESTORE_ENABLED === '1' || process.env.NODE_ENV === 'production';
}

function db(): Firestore {
  if (!firestore) {
    const databaseId = process.env.DEVINT_FIRESTORE_DATABASE?.trim();
    firestore = new Firestore(databaseId ? { databaseId } : {});
  }
  return firestore;
}

function collectionName(): string {
  return process.env.DEVINT_FIRESTORE_COLLECTION?.trim() || 'development-intelligence-projects';
}

function localStateFile(project: string): string {
  return path.join(localControlDir(), 'projects', `${safeSegment(project)}.json`);
}

function document(project: string) {
  return db().collection(collectionName()).doc(safeSegment(project));
}

export async function readStoredProjectState(project: string): Promise<Partial<ProjectState> | null> {
  if (cloudEnabled()) {
    const snapshot = await document(project).get();
    return snapshot.exists ? snapshot.data() as Partial<ProjectState> : null;
  }
  return await readJson<Partial<ProjectState> | null>(localStateFile(project), null);
}

export async function writeStoredProjectState(project: string, state: ProjectState): Promise<void> {
  if (cloudEnabled()) {
    await document(project).set(state);
    return;
  }
  await atomicWriteJson(localStateFile(project), state);
}

export async function patchStoredProjectState(project: string, patch: Partial<ProjectState>): Promise<void> {
  if (cloudEnabled()) {
    await document(project).set(patch, { merge: true });
    return;
  }
  const current = await readStoredProjectState(project) ?? {};
  await atomicWriteJson(localStateFile(project), { ...current, ...patch });
}

export async function deleteStoredProjectState(project: string): Promise<void> {
  if (cloudEnabled()) {
    await document(project).delete();
    return;
  }
  const fs = await import('node:fs');
  await fs.promises.rm(localStateFile(project), { force: true });
}

export async function recordParityScan(project: string, summary: ParityScanSummary): Promise<void> {
  if (cloudEnabled()) {
    const ref = document(project);
    await db().runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() as Partial<ProjectState> : {};
      const recent = Array.isArray(current.recentParityScans) ? current.recentParityScans : [];
      const deduped = [summary, ...recent.filter(item => item.scanId !== summary.scanId)].slice(0, 100);
      transaction.set(ref, { latestParityScanId: summary.scanId, recentParityScans: deduped }, { merge: true });
    });
    return;
  }
  const current = await readStoredProjectState(project) ?? {};
  const recent = Array.isArray(current.recentParityScans) ? current.recentParityScans : [];
  const deduped = [summary, ...recent.filter(item => item.scanId !== summary.scanId)].slice(0, 100);
  await atomicWriteJson(localStateFile(project), { ...current, latestParityScanId: summary.scanId, recentParityScans: deduped });
}
