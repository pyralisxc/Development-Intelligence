import path from 'node:path';

export function dataDir(): string {
  return path.resolve(process.env.DEVINT_DATA_DIR ?? '.data');
}

export function projectsFile(): string {
  return path.resolve(process.env.DEVINT_PROJECTS_FILE ?? 'config/projects.json');
}

export function projectDataDir(project: string): string {
  return path.join(dataDir(), 'projects', safeSegment(project));
}

export function safeSegment(value: string): string {
  const result = value.normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!result) throw new Error('Project identity is not filesystem-safe');
  return result.slice(0, 96);
}
