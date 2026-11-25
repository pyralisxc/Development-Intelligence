import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { AnalyzeResult } from './model.js';

// This is a disposable handoff from source analysis, never a graph or a
// substitute for producer reconciliation. Bind it to the actual engine files
// and dependency lock so an updated analyzer cannot reuse old observations.
async function engineIdentity(): Promise<string> {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hash = createHash('sha256').update(`source-stage-v1\0${process.version}\0${process.platform}\0${process.arch}\0`);
  async function visit(dir: string, prefix: string, allFiles = false): Promise<void> {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(name, prefix, allFiles);
      else if (entry.isFile() && (allFiles || entry.name.endsWith('.js'))) hash.update(prefix).update(path.relative(dirRoot, name)).update('\0').update(await fs.readFile(name));
    }
  }
  let dirRoot = src;
  await visit(src, 'engine:');
  // Runtime distributions without a lock cannot establish this identity and
  // simply perform source analysis normally.
  hash.update(await fs.readFile(path.resolve(src, '../../package-lock.json')));
  // Bind the handoff to the actual installed parsers as well as the lockfile.
  // A locally modified native grammar must not reuse facts from another one.
  const require = createRequire(import.meta.url);
  const typescript = await fs.realpath(require.resolve('typescript'));
  dirRoot = path.dirname(path.dirname(path.dirname(typescript)));
  for (const name of ['typescript', '@ast-grep', 'tree-sitter', 'tree-sitter-bash', 'tree-sitter-powershell', 'node-addon-api', 'node-gyp-build']) {
    const directory = path.join(dirRoot, name);
    try { if ((await fs.stat(directory)).isDirectory()) await visit(directory, `dependency:${name}:`, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return hash.digest('hex');
}

export class SourceStageCache {
  private constructor(private readonly directory: string, private readonly engine: string) {}

  static async open(root: string | undefined, project: string, repository: string): Promise<SourceStageCache | null> {
    if (!root) return null;
    try {
      const engine = await engineIdentity();
      const scope = createHash('sha256').update(JSON.stringify([project, repository])).digest('hex');
      const directory = path.join(root, '.source-stage', scope);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      return new SourceStageCache(directory, engine);
    } catch { return null; }
  }

  private file(sourcePath: string): string {
    return path.join(this.directory, createHash('sha256').update(sourcePath).digest('hex') + '.json');
  }

  async read(sourcePath: string, content: string): Promise<AnalyzeResult | null> {
    try {
      const entry = JSON.parse(await fs.readFile(this.file(sourcePath), 'utf8')) as { engine: string; path: string; content: string; payload: string; digest: string };
      if (entry.engine !== this.engine || entry.path !== sourcePath || entry.content !== content ||
          createHash('sha256').update(entry.payload).digest('hex') !== entry.digest) return null;
      const result = JSON.parse(entry.payload) as AnalyzeResult;
      return Array.isArray(result.observations) && Array.isArray(result.resolutions) ? result : null;
    } catch { return null; }
  }

  async write(sourcePath: string, content: string, result: AnalyzeResult): Promise<void> {
    const target = this.file(sourcePath);
    const temporary = `${target}.${randomBytes(16).toString('hex')}.tmp`;
    try {
      const payload = JSON.stringify(result);
      const entry = JSON.stringify({ engine: this.engine, path: sourcePath, content, payload, digest: createHash('sha256').update(payload).digest('hex') });
      await fs.writeFile(temporary, entry, { mode: 0o600 });
      await fs.rename(temporary, target);
    } catch { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async prune(paths: Iterable<string>): Promise<void> {
    const keep = new Set([...paths].map(sourcePath => path.basename(this.file(sourcePath))));
    try {
      for (const entry of await fs.readdir(this.directory) as string[]) {
        if (/^[a-f0-9]{64}\.json$/u.test(entry) && !keep.has(entry)) {
          await fs.rm(path.join(this.directory, entry), { force: true });
        }
      }
    } catch { /* Cache maintenance must not change the graph result. */ }
  }
}
