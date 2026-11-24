import { spawn } from 'node:child_process';
import { projectAccessChildEnvironment } from '../config/projectAccess.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
}

/** Long source operations have no implicit deadline. Operators can opt into a
 * deadline for their environment without changing what the graph may contain. */
export function optionalProcessTimeout(name: string): { timeoutMs?: number } {
  const value = process.env[name]?.trim();
  if (!value) return {};
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error(`${name} must be a positive number of milliseconds within the Node timer range`);
  }
  return { timeoutMs };
}

export async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; killTree?: boolean } = {},
): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...projectAccessChildEnvironment(), ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: options.killTree && process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        if (options.killTree && child.pid) {
          if (process.platform === 'win32') {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            killer.on('error', () => child.kill('SIGKILL'));
          } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        } else child.kill('SIGKILL');
      }, options.timeoutMs)
      : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1, ...(timedOut ? { timedOut: true } : {}) });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function runChecked(
  command: string,
  args: string[],
  options: Parameters<typeof run>[2] = {},
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return result;
}
