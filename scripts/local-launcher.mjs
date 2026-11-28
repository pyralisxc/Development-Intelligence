import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const home = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(home, 'local-settings.json'), 'utf8'));
const [command = 'help', ...args] = process.argv.slice(2);
async function removeAccountAutostart() {
  const startupDir = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
  const target = path.join(startupDir, process.platform === 'win32' ? 'Development Intelligence Linked Computer.vbs' : 'development-intelligence-linked-computer.desktop');
  await fs.rm(target, { force: true });
}

async function startAccountAgent() {
  const stateDir = path.join(config.dataDir, 'account');
  try { await fs.access(path.join(stateDir, 'linked-account.json')); } catch { throw new Error('This installation is not linked. Choose Link a computer in the Workbench first.'); }
  const log = await fs.open(path.join(stateDir, 'computer.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'account-run'], { detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
    child.unref();
  } finally { await log.close(); }
}
if (command === 'protocol-link' || command === 'link' || command === 'account-status' || command === 'account-run' || command === 'account-autostart' || command === 'unlink-local') {
  const account = await import(path.join(home, 'dist', 'src', 'accounts', 'localComputer.js'));
  const stateDir = path.join(config.dataDir, 'account');
  if (command === 'protocol-link') {
    const link = new URL(args[0] || '');
    const workbench = link.searchParams.get('workbench');
    if (link.protocol !== 'devint:' || !['link', 'connect'].includes(link.hostname) || link.pathname || link.hash || [...link.searchParams.keys()].some(key => !['workbench', 'computer'].includes(key)) || link.searchParams.getAll('workbench').length !== 1 || !workbench) throw new Error('Invalid computer link. Start again in the Workbench.');
    const destination = new URL(workbench);
    if (destination.origin !== workbench || destination.username || destination.password || (destination.protocol !== 'https:' && !(destination.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)))) throw new Error('Invalid Workbench address. Start again in the Workbench.');
    if (link.hostname === 'connect') {
      if (link.searchParams.getAll('computer').length !== 1) throw new Error('Choose a linked computer in the Workbench.');
      const identity = await account.accountComputerIdentity(stateDir);
      if (identity.origin !== destination.origin || identity.computerId !== link.searchParams.get('computer')) throw new Error('This is a different linked computer. Start DI on the selected computer.');
      await startAccountAgent();
      console.log('Connecting this computer.');
      process.exit(0);
    }
    if (link.searchParams.has('computer')) throw new Error('Invalid computer link. Start again in the Workbench.');
    if (await account.prepareComputerLink(stateDir, workbench) === 'linked') { console.log('This computer is already linked. Connect it from the Workbench when needed.'); process.exit(0); }
    await account.linkComputer(stateDir, workbench, url => {
      const opener = process.platform === 'win32' ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }) : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      opener.on('error', () => console.error('Could not open the browser for sign-in.')); opener.unref();
    });
    console.log('The computer is linked. Connect it when you are ready to use it.');
  } else if (command === 'link') {
    const at = args.indexOf('--workbench');
    if (at < 0 || !args[at + 1]) throw new Error('Start linking in your Workbench and run the displayed command on this computer');
    if (await account.prepareComputerLink(stateDir, args[at + 1]) === 'linked') { console.log('This computer is already linked. Connect it from the Workbench when needed.'); process.exit(0); }
    await account.linkComputer(stateDir, args[at + 1], url => { const opener = process.platform === 'win32' ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }) : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }); opener.on('error', () => console.error('Could not open the browser for sign-in.')); opener.unref(); });
  } else if (command === 'unlink-local') { await account.forgetLocalComputer(stateDir); console.log('Removed this installation’s local link. Its account association must be unlinked in the Workbench.'); }
  else if (command === 'account-status') await account.computerHeartbeat(stateDir);
  else if (command === 'account-autostart') {
    if (args[0] !== 'off') throw new Error('Automatic computer startup is no longer supported. Start the connection when needed.');
    await removeAccountAutostart();
    console.log('Removed the previous automatic startup entry.');
  }
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
const commands = { capacity: 'working-capacity', build: 'working-build', 'build-revision': 'revision-build', history: 'working-history', storage: 'working-storage', reindex: 'working-reindex', activate: 'working-activate', unpin: 'working-unpin', backup: 'working-backup', restore: 'working-restore', compare: 'working-compare', parity: 'working-parity', query: 'working-query', serve: 'working-serve', mcp: 'working-mcp', open: 'working-serve', 'oss-evidence': 'oss-evidence', 'joern-build': 'joern-build' };
if (!commands[command]) {
  console.log('DI local: link --workbench URL | unlink-local | account-status | account-run | account-autostart off | capacity | build [--target NAME] | build-revision --ref REF [--target NAME] | history | storage | reindex [--target NAME] | activate --graph-id ID | compare [--base NAME --target NAME] | parity --base NAME [--target NAME] | query --question TEXT [--target NAME] [--text | --details] | oss-evidence [producer options] | serve | open [--local] | mcp');
  console.log('Options: --repo-path PATH --project NAME --data-dir PATH --retain COUNT --port PORT; query: --max-passes COUNT');
  process.exit(command === 'help' ? 0 : 2);
}
const executable = process.execPath;
const forwardedArgs = command === 'open' ? args.filter(arg => arg !== '--local') : args;
const defaults = ['--repo-path', config.repoPath, '--project', config.project, '--data-dir', config.dataDir, '--retain', String(config.retain), '--port', String(config.port)];
const argv = command === 'oss-evidence' || command === 'joern-build'
  ? [path.join(home, 'scripts', 'run-oss-understanding.mjs'), ...args, '--repo-path', config.repoPath, '--project', config.project,
    ...(command === 'joern-build' ? ['--activate-working-data-dir', config.dataDir, '--retain', String(config.retain)] : [])]
  : [path.join(home, 'dist', 'src', 'graphCli.js'), commands[command], ...forwardedArgs, ...defaults];
const env = { ...process.env, DEVINT_SCRATCH_DIR: config.scratchDir, DEVINT_LOCAL_GRAPH_CACHE_SIZE: String(config.cacheSize ?? 3), DEVINT_LOCAL_SETTINGS: path.join(home, 'local-settings.json'),
  ...(config.graphWorkerHeapMB ? { DEVINT_GRAPH_WORKER_HEAP_MB: String(config.graphWorkerHeapMB) } : {}),
  ...(config.scipHeapMB ? { DEVINT_SCIP_HEAP_MB: String(config.scipHeapMB) } : {}) };
if (command === 'open') {
  if (!args.includes('--local')) {
    try {
      const account = await import(path.join(home, 'dist', 'src', 'accounts', 'localComputer.js'));
      const origin = await account.accountWorkbenchOrigin(path.join(config.dataDir, 'account'));
      const response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const url = new URL('/account', origin).href;
        const browser = process.platform === 'win32' ? spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }) : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        browser.unref(); process.exit(0);
      }
    } catch { /* A local workbench remains available without the hosted connection. */ }
  }
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
