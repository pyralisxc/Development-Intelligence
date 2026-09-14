import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}

async function acquireDirectoryLock(lockPath: string, staleMs: number): Promise<void> {
  try {
    await fs.mkdir(lockPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= staleMs) throw new Error(`Operation already in progress for ${path.basename(lockPath)}`);
    await fs.rm(lockPath, { recursive: true, force: true });
    await fs.mkdir(lockPath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Operation already in progress')) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(lockPath);
      return;
    }
    throw error;
  }
}

export async function withDirectoryLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await ensureDir(path.dirname(lockPath));
  const staleMs = Math.max(60_000, Number(process.env.DEVINT_LOCK_STALE_MS ?? 10 * 60_000));
  await acquireDirectoryLock(lockPath, staleMs);
  const heartbeatMs = Math.min(30_000, Math.max(5_000, Math.floor(staleMs / 4)));
  const heartbeat: any = setInterval(() => { void fs.utimes(lockPath, new Date(), new Date()).catch(() => {}); }, heartbeatMs);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}
