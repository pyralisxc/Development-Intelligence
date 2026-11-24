import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const home = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(home, 'local-settings.json'), 'utf8'));
const [command = 'help', ...args] = process.argv.slice(2);
async function startAccountAgent() {
  const stateDir = path.join(config.dataDir, 'account');
  try { await fs.access(path.join(stateDir, 'linked-account.json')); } catch { return; }
  const log = await fs.open(path.join(stateDir, 'computer.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'account-run'], { detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
    child.unref();
  } finally { await log.close(); }
}
if (command === 'link' || command === 'account-status' || command === 'account-run') {
  const account = await import(path.join(home, 'dist', 'src', 'accounts', 'localComputer.js'));
  const stateDir = path.join(config.dataDir, 'account');
  if (command === 'link') {
    const at = args.indexOf('--workbench');
    const pairAt = args.indexOf('--pair-code');
    if (at < 0 || !args[at + 1] || pairAt < 0 || !args[pairAt + 1]) throw new Error('Start linking in your Workbench and run the displayed command on this computer');
    await account.linkComputer(stateDir, args[at + 1], args[pairAt + 1]);
    await startAccountAgent();
  } else if (command === 'account-status') await account.computerHeartbeat(stateDir);
  else {
    const lockPath = path.join(stateDir, 'computer.lock');
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(lockPath, 'utf8').catch(() => '0'));
      try { if (pid > 0) { process.kill(pid, 0); process.exit(0); } } catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await fs.rm(lockPath, { force: true }); lock = await fs.open(lockPath, 'wx', 0o600);
    }
    try { await lock.writeFile(String(process.pid)); await lock.close(); await account.runComputer(stateDir, config.scratchDir, config.retain); }
    finally { await fs.rm(lockPath, { force: true }); }
  }
  process.exit(0);
}
const commands = { capacity: 'working-capacity', build: 'working-build', 'build-revision': 'revision-build', history: 'working-history', activate: 'working-activate', unpin: 'working-unpin', backup: 'working-backup', restore: 'working-restore', compare: 'working-compare', parity: 'working-parity', query: 'working-query', serve: 'working-serve', mcp: 'working-mcp', open: 'working-serve', 'oss-evidence': 'oss-evidence', 'joern-build': 'joern-build' };
if (!commands[command]) {
  console.log('DI local: link --workbench URL | account-status | account-run | capacity | build [--target NAME] | joern-build [producer options] | build-revision --ref REF [--target NAME] | history | activate --graph-id ID | compare [--base NAME --target NAME] | parity --base NAME [--target NAME] | query --question TEXT [--target NAME] [--text | --details] | oss-evidence [producer options] | serve | open | mcp');
  console.log('Options: --repo-path PATH --project NAME --data-dir PATH --retain COUNT --port PORT');
  process.exit(command === 'help' ? 0 : 2);
}
const executable = process.execPath;
const defaults = ['--repo-path', config.repoPath, '--project', config.project, '--data-dir', config.dataDir, '--retain', String(config.retain), '--port', String(config.port)];
const argv = command === 'oss-evidence' || command === 'joern-build'
  ? [path.join(home, 'scripts', 'run-oss-understanding.mjs'), ...args, '--repo-path', config.repoPath, '--project', config.project,
    ...(command === 'joern-build' ? ['--activate-working-data-dir', config.dataDir, '--retain', String(config.retain)] : [])]
  : [path.join(home, 'dist', 'src', 'graphCli.js'), commands[command], ...args, ...defaults];
const env = { ...process.env, DEVINT_SCRATCH_DIR: config.scratchDir, DEVINT_LOCAL_GRAPH_CACHE_SIZE: String(config.cacheSize ?? 3), DEVINT_LOCAL_SETTINGS: path.join(home, 'local-settings.json'),
  ...(config.graphWorkerHeapMB ? { DEVINT_GRAPH_WORKER_HEAP_MB: String(config.graphWorkerHeapMB) } : {}),
  ...(config.scipHeapMB ? { DEVINT_SCIP_HEAP_MB: String(config.scipHeapMB) } : {}) };
if (command === 'open') {
  await startAccountAgent();
  const server = spawn(executable, argv, { env, detached: true, stdio: 'ignore' });
  server.unref();
  const portAt = args.indexOf('--port');
  const port = portAt >= 0 ? args[portAt + 1] : config.port;
  const url = `http://127.0.0.1:${port}/workbench`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch(url); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Workbench did not start at ${url}. Run 'di-local serve' for details.`);
  const browser = process.platform === 'win32' ? spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }) : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  browser.unref();
} else {
  const child = spawn(executable, argv, { env, stdio: 'inherit' });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
