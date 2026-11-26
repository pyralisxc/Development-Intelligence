import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] ?? (() => { throw new Error(`${name} needs a value`); })(); };
if (args.includes('--help')) {
  console.log('node scripts/install-local.mjs --repo-path PATH [--project NAME] [--install-dir PATH] [--data-dir PATH] [--scratch-dir PATH] [--retain COUNT] [--cache-size COUNT] [--graph-worker-heap-mb MB] [--scip-heap-mb MB] [--port PORT]');
  process.exit(0);
}
if (!['linux', 'win32'].includes(process.platform)) throw new Error('Local installation currently supports Linux and Windows');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13) || (nodeMajor === 23 && nodeMinor < 4)) throw new Error('Node.js 22.13 or 23.4 (or a later supported version) is required to install');
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
const cacheSize = Number(option('--cache-size', prior.cacheSize ?? '3'));
const port = Number(option('--port', prior.port ?? '8787'));
const optionalHeap = (flag, previous, minimum) => {
  const raw = option(flag, previous);
  if (raw === undefined || raw === null || raw === '' || raw === 'default') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${flag} must be at least ${minimum} MiB or default`);
  return value;
};
const graphWorkerHeapMB = optionalHeap('--graph-worker-heap-mb', prior.graphWorkerHeapMB, 128);
const scipHeapMB = optionalHeap('--scip-heap-mb', prior.scipHeapMB, 1);
const desktopDir = path.resolve(option('--desktop-dir', prior.desktopDir || (process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs') : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications'))));
if (!project || !Number.isSafeInteger(retain) || retain < 1 || !Number.isSafeInteger(cacheSize) || cacheSize < 0 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Specify a project, positive retention, a non-negative cache size and a port from 1 to 65535');
if (installDir === source || installDir === dataDir || source.startsWith(`${installDir}${path.sep}`)) throw new Error('Choose an install directory separate from the source and data directories');
await fs.access(path.join(source, 'dist', 'src', 'graphCli.js'));
await fs.access(path.join(source, 'node_modules'));
await fs.access(repoPath);
await fs.mkdir(installDir, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(scratchDir, { recursive: true });
await fs.cp(path.join(source, 'dist'), path.join(installDir, 'dist'), { recursive: true });
// Stage dependencies separately: copying over an existing installation can
// follow old absolute links back into the source checkout, and can leave stale
// packages behind. Keep relative package links relative to the installation.
const dependencies = path.join(installDir, 'node_modules');
const sourceDependencies = await fs.realpath(path.join(source, 'node_modules'));
const dependencyStage = path.join(installDir, `.node-modules-${randomUUID()}`);
const dependencyBackup = path.join(installDir, `.node-modules-${randomUUID()}`);
let backedUpDependencies = false;
try {
  await fs.cp(sourceDependencies, dependencyStage, { recursive: true, verbatimSymlinks: true });
  try { await fs.rename(dependencies, dependencyBackup); backedUpDependencies = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await fs.rename(dependencyStage, dependencies); }
  catch (error) {
    if (backedUpDependencies) await fs.rename(dependencyBackup, dependencies);
    throw error;
  }
  if (backedUpDependencies) await fs.rm(dependencyBackup, { recursive: true, force: true });
} finally {
  await fs.rm(dependencyStage, { recursive: true, force: true });
}
await fs.copyFile(path.join(source, 'package.json'), path.join(installDir, 'package.json'));
// Source-stage reuse verifies its parser dependencies against this installation's
// lockfile as well as the installed engine and grammar files.
await fs.copyFile(path.join(source, 'package-lock.json'), path.join(installDir, 'package-lock.json'));
await fs.copyFile(path.join(source, 'scripts', 'local-launcher.mjs'), path.join(installDir, 'local-launcher.mjs'));
await fs.mkdir(path.join(installDir, 'scripts'), { recursive: true });
for (const script of ['run-oss-understanding.mjs', 'node-test-events-reporter.mjs']) {
  await fs.copyFile(path.join(source, 'scripts', script), path.join(installDir, 'scripts', script));
}
await fs.mkdir(path.join(installDir, 'runtime'), { recursive: true });
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const installedRuntime = path.join(installDir, 'runtime', nodeName);
let sameRuntime = false;
try { sameRuntime = (await fs.readFile(process.execPath)).equals(await fs.readFile(installedRuntime)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!sameRuntime) {
  const stagedRuntime = path.join(installDir, 'runtime', `.node-${randomUUID()}${process.platform === 'win32' ? '.exe' : ''}`);
  try {
    await fs.copyFile(process.execPath, stagedRuntime);
    await fs.rename(stagedRuntime, installedRuntime);
  } finally { await fs.rm(stagedRuntime, { force: true }); }
}
await fs.writeFile(path.join(installDir, 'local-settings.json'), JSON.stringify({ ...prior, installDir, dataDir, scratchDir, desktopDir, repoPath, project, retain, cacheSize, port, graphWorkerHeapMB, scipHeapMB }, null, 2));
await fs.mkdir(desktopDir, { recursive: true });
let desktop;
if (process.platform === 'win32') {
  await fs.writeFile(path.join(installDir, 'di-local.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0local-launcher.mjs" %*\r\n');
  desktop = path.join(desktopDir, 'Development Intelligence Local.lnk');
  const psString = value => `'${value.replace(/'/g, "''")}'`;
  const script = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psString(desktop)});$s.TargetPath=${psString(path.join(installDir, 'runtime', 'node.exe'))};$s.Arguments=${psString(`"${path.join(installDir, 'local-launcher.mjs')}" open`)};$s.WorkingDirectory=${psString(installDir)};$s.Save()`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not create Start Menu shortcut: ${result.stderr || result.error?.message || result.status}`);
  const protocolScript = path.join(installDir, 'protocol-link.ps1');
  await fs.writeFile(protocolScript, 'param([string]$Link)\r\n& (Join-Path $PSScriptRoot "runtime\\node.exe") (Join-Path $PSScriptRoot "local-launcher.mjs") protocol-link $Link\r\nRead-Host "Press Enter to close"\r\n');
  const command = `"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')}" -NoProfile -ExecutionPolicy Bypass -File "${protocolScript}" "%1"`;
  const register = `$p='HKCU:\\Software\\Classes\\devint';New-Item -Path $p -Force | Out-Null;Set-Item -LiteralPath $p -Value 'URL:Development Intelligence';New-ItemProperty -LiteralPath $p -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null;New-Item -Path "$p\\shell\\open\\command" -Force | Out-Null;Set-Item -LiteralPath "$p\\shell\\open\\command" -Value ${psString(command)}`;
  const registered = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(register, 'utf16le').toString('base64')], { encoding: 'utf8' });
  if (registered.status !== 0) throw new Error(`Could not register the computer link: ${registered.stderr || registered.error?.message || registered.status}`);
} else {
  const launcher = path.join(installDir, 'di-local');
  await fs.writeFile(launcher, '#!/bin/sh\napp_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$app_dir/runtime/node" "$app_dir/local-launcher.mjs" "$@"\n', { mode: 0o755 });
  await fs.chmod(launcher, 0o755);
  desktop = path.join(desktopDir, 'development-intelligence-local.desktop');
  const desktopExec = launcher.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&');
  await fs.writeFile(desktop, `[Desktop Entry]\nType=Application\nName=Development Intelligence Local\nExec="${desktopExec}" open\nTerminal=false\nCategories=Development;\n`);
  const protocolScript = path.join(installDir, 'protocol-link.sh');
  await fs.writeFile(protocolScript, '#!/bin/sh\napp_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n"$app_dir/runtime/node" "$app_dir/local-launcher.mjs" protocol-link "$1"\nprintf "Press Enter to close: "\nread -r unused\n', { mode: 0o755 });
  await fs.chmod(protocolScript, 0o755);
  const applications = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications');
  await fs.mkdir(applications, { recursive: true });
  const protocolExec = protocolScript.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&');
  const handler = path.join(applications, 'development-intelligence-link.desktop');
  await fs.writeFile(handler, `[Desktop Entry]\nType=Application\nName=Link Development Intelligence\nExec="${protocolExec}" %u\nTerminal=true\nNoDisplay=true\nMimeType=x-scheme-handler/devint;\n`);
  const registered = spawnSync('xdg-mime', ['default', 'development-intelligence-link.desktop', 'x-scheme-handler/devint'], { encoding: 'utf8' });
  if (registered.status !== 0) console.warn('Direct computer linking could not be registered. The command shown in the Workbench remains available.');
}
console.log(JSON.stringify({ installed: installDir, launcher: path.join(installDir, process.platform === 'win32' ? 'di-local.cmd' : 'di-local'), desktop, dataDir, scratchDir, project, repoPath, retain, cacheSize, port, graphWorkerHeapMB, scipHeapMB }, null, 2));
