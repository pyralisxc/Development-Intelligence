import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Observation, Resolution, SourceDescriptor } from '../types.js';
import { runChecked } from '../util/process.js';
import { analyzeByTechnology } from './analyzers/index.js';

const MAX_FILE_BYTES = Number(process.env.DEVINT_PARITY_MAX_FILE_BYTES ?? 1_000_000);
const MAX_FILES = Number(process.env.DEVINT_PARITY_MAX_FILES ?? 5000);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.html', '.htm']);

export async function scanRepositoryPath(input: { project: string; repository: string; revision: string; sourceDir: string; observedAt?: string }): Promise<{ source: SourceDescriptor; observations: Observation[]; resolutions: Resolution[] }> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const result = await runChecked('git', ['-C', input.sourceDir, 'ls-files', '-z']);
  const eligible = result.stdout.split('\0').filter(Boolean).filter(file => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()));
  const files = eligible.slice(0, MAX_FILES);
  const warnings: string[] = [];
  if (eligible.length > files.length) warnings.push(`Parity scan file limit reached: analyzed ${files.length} of ${eligible.length} eligible tracked files.`);
  let oversizedFiles = 0;
  const source: SourceDescriptor = { id: 'repository', kind: 'repository', locator: input.repository, revision: input.revision, observedAt, available: true };
  const observations: Observation[] = [];
  const resolutions: Resolution[] = [];
  const root = path.resolve(input.sourceDir);
  for (const relative of files) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) { warnings.push(`Skipped tracked path outside source root: ${relative}`); continue; }
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) { warnings.push(`Skipped non-regular tracked file: ${relative}`); continue; }
    if (stat.size > MAX_FILE_BYTES) { oversizedFiles += 1; continue; }
    const text = await fs.readFile(absolute, 'utf8');
    const fileSource: SourceDescriptor = { id: `repo:${relative}`, kind: 'repository-file', locator: relative, revision: input.revision, observedAt, available: true };
    const analyzed = analyzeByTechnology({ source: fileSource, text, locatorBase: relative });
    observations.push(...analyzed.observations);
    resolutions.push(...analyzed.resolutions);
  }
  if (oversizedFiles > 0) warnings.push(`Skipped ${oversizedFiles} tracked files larger than ${MAX_FILE_BYTES} bytes.`);
  if (warnings.length > 0) source.warnings = warnings;
  return { source, observations, resolutions };
}
