import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { optionalProcessTimeout, runChecked } from '../util/process.js';
import { projectAccessScopeKey, projectAccessScratchPrefix } from '../config/projectAccess.js';

export interface PreparedProducerInputs {
  root: string;
  dependencyProducer: {
    producer: string;
    state: 'complete' | 'partial';
    version?: string;
    indexSha256?: string;
    reason?: string;
  } | null;
}
export type GraphBuildProgress = { stage: string; completed?: number; total?: number; reused?: number };

/** Build producers from a disposable snapshot rather than an ambient checkout.
 * Both local working files and immutable revisions use this sequence. */
export async function withPreparedProducerInputs<T>(input: {
  root: string; revision: string; workingTree?: boolean; disposableCheckout?: boolean; progress?: (value: GraphBuildProgress) => void;
}, isIgnored: (path: string) => boolean, use: (prepared: PreparedProducerInputs) => Promise<T>): Promise<T> {
  const scratch = path.resolve(process.env.DEVINT_SCRATCH_DIR ?? os.tmpdir());
  await fs.mkdir(scratch, { recursive: true });
  if (input.workingTree && input.disposableCheckout) throw new Error('Working files require their own source snapshot');
  const temporary = input.disposableCheckout ? null : await fs.mkdtemp(projectAccessScratchPrefix(scratch, 'checkout'));
  const root = temporary ? path.join(temporary, 'source') : input.root;
  try {
    input.progress?.({ stage: 'preparing-source' });
    if (temporary) {
      await runChecked('git', ['clone', '--no-checkout', '--shared', '--', input.root, root]);
      await runChecked('git', ['-C', root, 'checkout', '--detach', input.revision]);
    }
    if (input.workingTree) {
      const listed = await runChecked('git', ['-C', input.root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']);
      const staged = await runChecked('git', ['-C', input.root, 'ls-files', '-s', '-z']);
      const gitlinks = new Set(staged.stdout.split('\0').filter(record => record.startsWith('160000 '))
        .map(record => record.slice(record.indexOf('\t') + 1)));
      const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(file => !isIgnored(file));
      const present = new Set<string>();
      for (const file of paths) {
        const source = path.join(input.root, file);
        const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!stat || (!stat.isFile() && !stat.isSymbolicLink() && !(stat.isDirectory() && gitlinks.has(file)))) continue;
        present.add(file);
        const target = path.join(root, file);
        if (stat.isDirectory()) { await fs.mkdir(target, { recursive: true }); continue; }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rm(target, { force: true, recursive: true });
        if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(source), target);
        else { await fs.copyFile(source, target); await fs.chmod(target, stat.mode); }
      }
      const original = await runChecked('git', ['-C', root, 'ls-files', '-z']);
      for (const file of original.stdout.split('\0').filter(Boolean)) {
        if (!present.has(file) && !isIgnored(file)) await fs.rm(path.join(root, file), { force: true, recursive: true });
      }
    }

    const lockFile = await fs.readFile(path.join(root, 'npm-shrinkwrap.json')).then(() => 'npm-shrinkwrap.json')
      .catch(async () => await fs.access(path.join(root, 'package-lock.json')).then(() => 'package-lock.json').catch(() => null));
    let dependencyProducer: PreparedProducerInputs['dependencyProducer'] = null;
    if (lockFile) {
      input.progress?.({ stage: 'preparing-dependencies' });
      const digest = createHash('sha256').update(await fs.readFile(path.join(root, lockFile))).digest('hex');
      const npmPackage = createRequire(import.meta.url).resolve('npm/package.json');
      const npmRoot = path.dirname(npmPackage);
      const npm = JSON.parse(await fs.readFile(npmPackage, 'utf8')) as { version: string };
      const installTimeout = optionalProcessTimeout('DEVINT_DEPENDENCY_INSTALL_TIMEOUT_MS');
      try {
        await runChecked(process.execPath, [path.join(npmRoot, 'bin', 'npm-cli.js'), 'ci', '--include=dev', '--include=optional', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error'], {
          cwd: root, ...installTimeout, killTree: true,
          env: { npm_config_cache: path.join(scratch, 'di-npm-cache', projectAccessScopeKey()), npm_config_os: 'linux', npm_config_cpu: 'x64' },
        });
        dependencyProducer = { producer: 'npm-lockfile', state: 'complete', version: npm.version, indexSha256: digest,
          reason: `${lockFile}; npm ci without install scripts; dependency target linux/x64` };
      } catch {
        // Source parsing remains useful when a registry or dependency is not
        // available. Do not retain partially installed modules as complete.
        await fs.rm(path.join(root, 'node_modules'), { recursive: true, force: true });
        dependencyProducer = { producer: 'npm-lockfile', state: 'partial', version: npm.version, indexSha256: digest,
          reason: `${lockFile}; dependency installation was unavailable; analysis continued without installed dependencies` };
      }
    } else if (await fs.access(path.join(root, 'package.json')).then(() => true).catch(() => false)) {
      dependencyProducer = { producer: 'npm-lockfile', state: 'partial', reason: 'No npm lockfile was present; dependencies were not installed for analysis' };
    }
    return await use({ root, dependencyProducer });
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}
