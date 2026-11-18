import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const home = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(home, 'local-settings.json'), 'utf8'));
const [command = 'help', ...args] = process.argv.slice(2);
const commands = { build: 'working-build', 'build-revision': 'revision-build', history: 'working-history', activate: 'working-activate', unpin: 'working-unpin', backup: 'working-backup', restore: 'working-restore', compare: 'working-compare', parity: 'working-parity', query: 'working-query', serve: 'working-serve', mcp: 'working-mcp', open: 'working-serve' };
if (!commands[command]) {
  console.log('DI local: build | build-revision --ref REF [--target NAME] | history | activate --graph-id ID | compare [--base NAME --target NAME] | parity --base NAME [--target NAME] | query --question TEXT [--text | --details] | serve | open | mcp');
  console.log('Options: --repo-path PATH --project NAME --data-dir PATH --retain COUNT --port PORT');
  process.exit(command === 'help' ? 0 : 2);
}
const executable = process.execPath;
const defaults = ['--repo-path', config.repoPath, '--project', config.project, '--data-dir', config.dataDir, '--retain', String(config.retain), '--port', String(config.port)];
const argv = [path.join(home, 'dist', 'src', 'graphCli.js'), commands[command], ...args, ...defaults];
const env = { ...process.env, DEVINT_SCRATCH_DIR: config.scratchDir, DEVINT_LOCAL_GRAPH_CACHE_SIZE: String(config.cacheSize ?? 3), DEVINT_LOCAL_SETTINGS: path.join(home, 'local-settings.json') };
if (command === 'open') {
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
