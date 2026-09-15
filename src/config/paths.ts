import path from 'node:path';

export function dataDir(): string {
  return path.resolve(process.env.DEVINT_DATA_DIR ?? '.data');
}

export function localArtifactDir(): string {
  return path.resolve(process.env.DEVINT_ARTIFACT_DIR ?? path.join(dataDir(), 'artifacts'));
}

export function localControlDir(): string {
  return path.resolve(process.env.DEVINT_CONTROL_DIR ?? path.join(dataDir(), 'control'));
}

export function ephemeralDir(): string {
  return path.resolve(process.env.DEVINT_EPHEMERAL_DIR ?? path.join(dataDir(), 'ephemeral'));
}

export function projectsFile(): string {
  return path.resolve(process.env.DEVINT_PROJECTS_FILE ?? 'config/projects.json');
}

export function safeSegment(value: string): string {
  const result = value.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!result) throw new Error('Project identity is not storage-safe');
  return result.slice(0, 96);
}
