import { Storage } from '@google-cloud/storage';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { localArtifactDir, safeSegment } from '../config/paths.js';
import { ensureDir, pathExists } from '../util/fs.js';

let storage: Storage | null = null;

function gcsBucketName(): string | null {
  return process.env.DEVINT_GCS_BUCKET?.trim() || null;
}

function requireBackend(): void {
  if (process.env.NODE_ENV === 'production' && !gcsBucketName()) {
    throw new Error('DEVINT_GCS_BUCKET is required in production; local artifact storage is development/test only');
  }
}

function gcs() {
  if (!storage) storage = new Storage();
  return storage;
}

function assertKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) throw new Error(`Invalid artifact key: ${key}`);
}

function localPath(key: string): string {
  assertKey(key);
  const root = localArtifactDir();
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Artifact key escapes storage root: ${key}`);
  return resolved;
}

export function projectArtifactPrefix(project: string): string {
  return `projects/${safeSegment(project)}`;
}

export async function uploadArtifact(key: string, sourceFile: string): Promise<void> {
  assertKey(key);
  requireBackend();
  const bucketName = gcsBucketName();
  if (bucketName) {
    await gcs().bucket(bucketName).upload(sourceFile, { destination: key, resumable: false, validation: 'crc32c' });
    return;
  }
  const destination = localPath(key);
  await ensureDir(path.dirname(destination));
  await fs.copyFile(sourceFile, destination);
}

export async function downloadArtifact(key: string, destination: string): Promise<void> {
  assertKey(key);
  requireBackend();
  await ensureDir(path.dirname(destination));
  const bucketName = gcsBucketName();
  if (bucketName) {
    await gcs().bucket(bucketName).file(key).download({ destination });
    return;
  }
  await fs.copyFile(localPath(key), destination);
}

export async function writeArtifactJson(key: string, value: unknown): Promise<void> {
  assertKey(key);
  requireBackend();
  const content = JSON.stringify(value, null, 2) + '\n';
  const bucketName = gcsBucketName();
  if (bucketName) {
    await gcs().bucket(bucketName).file(key).save(content, { contentType: 'application/json', resumable: false, validation: 'crc32c' });
    return;
  }
  const destination = localPath(key);
  await ensureDir(path.dirname(destination));
  await fs.writeFile(destination, content, { mode: 0o600 });
}

export async function readArtifactJson<T>(key: string): Promise<T> {
  assertKey(key);
  requireBackend();
  const bucketName = gcsBucketName();
  if (bucketName) {
    const [buffer] = await gcs().bucket(bucketName).file(key).download();
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  }
  return JSON.parse(await fs.readFile(localPath(key), 'utf8')) as T;
}

export async function artifactExists(key: string): Promise<boolean> {
  assertKey(key);
  requireBackend();
  const bucketName = gcsBucketName();
  if (bucketName) {
    const [exists] = await gcs().bucket(bucketName).file(key).exists();
    return exists;
  }
  return await pathExists(localPath(key));
}

export async function deleteArtifactPrefix(prefix: string): Promise<void> {
  assertKey(prefix);
  requireBackend();
  const bucketName = gcsBucketName();
  if (bucketName) {
    await gcs().bucket(bucketName).deleteFiles({ prefix, force: true });
    return;
  }
  await fs.rm(localPath(prefix), { recursive: true, force: true });
}
