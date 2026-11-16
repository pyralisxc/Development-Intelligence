import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] ?? (() => { throw new Error(`${name} needs a value`); })(); };
if (args.includes('--help')) {
  console.log('node scripts/install-local.mjs --repo-path PATH [--project NAME] [--install-dir PATH] [--data-dir PATH] [--scratch-dir PATH] [--retain COUNT] [--port PORT]');
  process.exit(0);
}
if (!['linux', 'win32'].includes(process.platform)) throw new Error('Local installation currently supports Linux and Windows');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required to install');
const appData = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const installDir = path.resolve(option('--install-dir', path.join(appData, 'development-intelligence-local')));
let prior = {};
try { prior = JSON.parse(await fs.readFile(path.join(installDir, 'local-settings.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const dataDir = path.resolve(option('--data-dir', prior.dataDir || path.join(appData, 'development-intelligence-data')));
const scratchDir = path.resolve(option('--scratch-dir', prior.scratchDir || path.join(dataDir, 'scratch')));
const repoPath = path.resolve(option('--repo-path', prior.repoPath || process.cwd()));
const project = option('--project', prior.project || path.basename(repoPath));
const retain = Number(option('--retain', prior.retain ?? '3'));
const port = Number(option('--port', prior.port ?? '8787'));
const desktopDir = path.resolve(option('--desktop-dir', prior.desktopDir || (process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs') : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications'))));
if (!project || !Number.isSafeInteger(retain) || retain < 1 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Specify a project, a positive retention count and a port from 1 to 65535');
if (installDir === source || installDir === dataDir || source.startsWith(`${installDir}${path.sep}`)) throw new Error('Choose an install directory separate from the source and data directories');
await fs.access(path.join(source, 'dist', 'src', 'graphCli.js'));
await fs.access(path.join(source, 'node_modules'));
await fs.access(repoPath);
await fs.mkdir(installDir, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(scratchDir, { recursive: true });
await fs.cp(path.join(source, 'dist'), path.join(installDir, 'dist'), { recursive: true });
await fs.cp(path.join(source, 'node_modules'), path.join(installDir, 'node_modules'), { recursive: true });
await fs.copyFile(path.join(source, 'package.json'), path.join(installDir, 'package.json'));
await fs.copyFile(path.join(source, 'scripts', 'local-launcher.mjs'), path.join(installDir, 'local-launcher.mjs'));
await fs.mkdir(path.join(installDir, 'runtime'), { recursive: true });
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
await fs.copyFile(process.execPath, path.join(installDir, 'runtime', nodeName));
await fs.writeFile(path.join(installDir, 'local-settings.json'), JSON.stringify({ ...prior, installDir, dataDir, scratchDir, desktopDir, repoPath, project, retain, port }, null, 2));
await fs.mkdir(desktopDir, { recursive: true });
let desktop;
if (process.platform === 'win32') {
  await fs.writeFile(path.join(installDir, 'di-local.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0local-launcher.mjs" %*\r\n');
  desktop = path.join(desktopDir, 'Development Intelligence Local.lnk');
  const psString = value => `'${value.replace(/'/g, "''")}'`;
  const script = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psString(desktop)});$s.TargetPath=${psString(path.join(installDir, 'runtime', 'node.exe'))};$s.Arguments=${psString(`"${path.join(installDir, 'local-launcher.mjs')}" open`)};$s.WorkingDirectory=${psString(installDir)};$s.Save()`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not create Start Menu shortcut: ${result.stderr || result.error?.message || result.status}`);
} else {
  const launcher = path.join(installDir, 'di-local');
  await fs.writeFile(launcher, '#!/bin/sh\napp_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$app_dir/runtime/node" "$app_dir/local-launcher.mjs" "$@"\n', { mode: 0o755 });
  await fs.chmod(launcher, 0o755);
  desktop = path.join(desktopDir, 'development-intelligence-local.desktop');
  const desktopExec = launcher.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&');
  await fs.writeFile(desktop, `[Desktop Entry]\nType=Application\nName=Development Intelligence Local\nExec="${desktopExec}" open\nTerminal=false\nCategories=Development;\n`);
}
console.log(JSON.stringify({ installed: installDir, launcher: path.join(installDir, process.platform === 'win32' ? 'di-local.cmd' : 'di-local'), desktop, dataDir, scratchDir, project, repoPath, retain, port }, null, 2));
