import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localSourceGraphHistory } from './localGraphStore.js';

type Settings = { installDir: string; dataDir: string; scratchDir: string; repoPath: string; project: string; retain: number; cacheSize?: number; port: number; backupDir?: string };
type Job = { action: string; state: 'running' | 'complete' | 'failed'; output: string; startedAt: string; finishedAt?: string };
let job: Job | null = null;
// Reserve the handoff before reading settings: both requests and settings reads
// are asynchronous, so checking only the running child permits overlap.
let transitionPending = false;
function reserveTransition(): void {
  if (transitionPending || job?.state === 'running') throw new Error('Wait for the current local operation or settings change to finish');
  transitionPending = true;
}
const settingsPath = () => {
  const value = process.env.DEVINT_LOCAL_SETTINGS;
  if (!value) throw new Error('Local setup is available from an installed DI launcher');
  return path.resolve(value);
};
export async function localSettings(): Promise<Settings> {
  return JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as Settings;
}
export async function localLifecycleStatus(): Promise<Record<string, unknown>> {
  const settings = await localSettings();
  return { settings, history: await localSourceGraphHistory(settings.dataDir, settings.project), job };
}
export async function updateLocalSettings(input: Record<string, unknown>): Promise<Settings> {
  reserveTransition();
  try {
  const previous = await localSettings();
  const str = (name: string, fallback: string): string => {
    const value = input[name] ?? fallback;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a path`);
    return path.resolve(value.trim());
  };
  const retain = Number(input.retain ?? previous.retain), cacheSize = Number(input.cacheSize ?? previous.cacheSize ?? 3), port = Number(input.port ?? previous.port);
  if (!Number.isSafeInteger(retain) || retain < 1 || !Number.isSafeInteger(cacheSize) || cacheSize < 0 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Retention must be positive, cache size non-negative and port between 1 and 65535');
  const { backupDir: _previousBackup, ...base } = previous;
  const settings: Settings = { ...base, repoPath: str('repoPath', previous.repoPath), dataDir: str('dataDir', previous.dataDir), scratchDir: str('scratchDir', previous.scratchDir), retain, cacheSize, port,
    ...(typeof input.backupDir === 'string' && input.backupDir.trim() ? { backupDir: path.resolve(input.backupDir.trim()) } : {}) };
  await fs.access(settings.repoPath);
  await fs.mkdir(settings.dataDir, { recursive: true });
  await fs.mkdir(settings.scratchDir, { recursive: true });
  const temporary = `${settingsPath()}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(settings, null, 2));
  await fs.rename(temporary, settingsPath());
  process.env.DEVINT_LOCAL_GRAPH_DIR = settings.dataDir;
  process.env.DEVINT_SCRATCH_DIR = settings.scratchDir;
  process.env.DEVINT_LOCAL_GRAPH_CACHE_SIZE = String(settings.cacheSize);
  process.env.DEVINT_PROJECTS_JSON = JSON.stringify({ [settings.project]: { repository: pathToFileURL(settings.repoPath).href, defaultRef: 'HEAD', revisionPolicy: 'repository-history' } });
  const { clearGraphCache } = await import('./service.js');
  clearGraphCache(settings.project);
  return settings;
  } finally {
    transitionPending = false;
  }
}
export async function startLocalOperation(input: Record<string, unknown>): Promise<Job> {
  reserveTransition();
  try {
  const settings = await localSettings();
  const action = input.action;
  if (typeof action !== 'string' || !['build', 'build-revision', 'backup', 'restore', 'unpin'].includes(action)) throw new Error('Unsupported local operation');
  const commands: Record<string, string> = { build: 'working-build', 'build-revision': 'revision-build', backup: 'working-backup', restore: 'working-restore', unpin: 'working-unpin' };
  const args = [fileURLToPath(new URL('../graphCli.js', import.meta.url)), commands[action]!, '--repo-path', settings.repoPath, '--project', settings.project, '--data-dir', settings.dataDir, '--retain', String(settings.retain)];
  if (action === 'build-revision') {
    if (typeof input.ref !== 'string' || !input.ref.trim()) throw new Error('Enter a revision');
    if (typeof input.target !== 'string' || !input.target.trim()) throw new Error('Enter a target name');
    args.push('--ref', input.ref.trim(), '--target', input.target.trim());
  }
  if (action === 'backup' || action === 'restore') {
    const backup = typeof input.backupDir === 'string' && input.backupDir.trim() ? input.backupDir : settings.backupDir;
    if (!backup) throw new Error('Choose a backup directory');
    args.push('--backup-dir', path.resolve(backup));
  }
  if (action === 'unpin') {
    if (typeof input.target !== 'string' || !input.target.trim()) throw new Error('Enter a target name');
    args.push('--target', input.target.trim());
  }
  const current: Job = { action, state: 'running', output: '', startedAt: new Date().toISOString() };
  job = current;
  const child = spawn(process.execPath, args, { env: { ...process.env, DEVINT_SCRATCH_DIR: settings.scratchDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (chunk: unknown) => { current.output = (current.output + String(chunk)).slice(-24000); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.on('error', (error: Error) => { append(error.message); current.state = 'failed'; current.finishedAt = new Date().toISOString(); });
  child.on('close', (code: number | null) => { if (current.state === 'running') current.state = code === 0 ? 'complete' : 'failed'; current.finishedAt = new Date().toISOString(); });
  return current;
  } finally {
    transitionPending = false;
  }
}
