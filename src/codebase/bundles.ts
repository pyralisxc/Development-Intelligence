import type { RevisionBundleManifest } from '../types.js';
import { safeSegment } from '../config/paths.js';
import { artifactExists, readArtifactJson } from '../storage/artifacts.js';
import { readStoredProjectState } from '../storage/control.js';

export const BUNDLE_SCHEMA_VERSION = 1 as const;
export const PARITY_SCHEMA_VERSION = '1';
export const DEFAULT_CBM_VERSION = '0.10.8';

export function bundlePrefix(project: string, bundleId: string): string {
  return `projects/${safeSegment(project)}/bundles/${safeSegment(bundleId)}`;
}

export function bundleManifestKey(project: string, bundleId: string): string {
  return `${bundlePrefix(project, bundleId)}/manifest.json`;
}

export async function loadBundleManifest(project: string, bundleId: string): Promise<RevisionBundleManifest> {
  const key = bundleManifestKey(project, bundleId);
  if (!await artifactExists(key)) throw new Error(`Revision bundle manifest not found: ${project}/${bundleId}`);
  const manifest = await readArtifactJson<RevisionBundleManifest>(key);
  if (manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION) throw new Error(`Unsupported revision bundle schema: ${manifest.schemaVersion}`);
  if (manifest.project !== project || manifest.bundleId !== bundleId) throw new Error('Revision bundle identity mismatch');
  return manifest;
}

export async function loadSelectedBundleManifest(project: string): Promise<RevisionBundleManifest | null> {
  const state = await readStoredProjectState(project);
  if (!state?.selectedBundleId) return null;
  return await loadBundleManifest(project, state.selectedBundleId);
}
