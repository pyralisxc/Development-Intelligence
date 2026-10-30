import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const SERVICE_NAME = 'DevelopmentIntelligenceTrial';
export function validateConfiguration(config) {
  if (config?.formatVersion !== 1 || config.authMode !== 'bearer' || typeof config.agentToken !== 'string' || config.agentToken.trim().length < 32 || config.agentToken !== config.agentToken.trim()) {
    throw new Error('Explicit formatVersion=1 bearer configuration with a token of at least 32 characters is required');
  }
  if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) throw new Error('An explicit project access registry is required');
  if (Object.keys(config).some(key => !['formatVersion', 'authMode', 'agentToken', 'projects', 'remoteStorage'].includes(key))) throw new Error('Unknown managed configuration field');
  if (config.remoteStorage && (typeof config.remoteStorage.storeId !== 'string' || typeof config.remoteStorage.token !== 'string')) throw new Error('Remote storage requires explicit storeId and token');
  return config;
}

// Never follow junctions/symlinks or accept a caller-selected cleanup root.
export async function scratchInventory(root, transient = false) {
  const items = [];
  async function visit(directory) {
    let names;
    try { names = await fs.readdir(directory); } catch (error) { if (transient && error.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      const target = path.join(directory, name);
      let stat;
      try { stat = await fs.lstat(target); } catch (error) { if (transient && error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) throw new Error('Scratch contains a reparse link; operator inspection is required');
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) items.push({ path: target, bytes: stat.size });
      else throw new Error('Scratch contains an unsupported file type');
    }
  }
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Scratch root is not a regular directory');
  await visit(root);
  return items;
}

async function regularAncestors(root) {
  for (let current = path.resolve(root); ; current = path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Reparse package ancestor refused');
    if (path.dirname(current) === current) break;
  }
}

export async function verifyPayload(root) {
  await regularAncestors(root);
  const manifestStat = await fs.lstat(path.join(root, 'manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16 * 1024 ** 2) throw new Error('Invalid package manifest file');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.formatVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.engineSha) || manifest.packagingSha !== manifest.engineSha || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid package identity');
  const actual = new Set((await scratchInventory(root)).map(item => path.relative(root, item.path).replaceAll('\\', '/').toLowerCase()));
  actual.delete('manifest.json');
  const declared = new Set();
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || path.isAbsolute(item.path) || /[\\:]/.test(item.path) || item.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid manifest path');
    const key = item.path.toLowerCase();
    if (declared.has(key) || !actual.has(key)) throw new Error('Package inventory mismatch');
    declared.add(key);
    const target = path.join(root, item.path);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Package contains a non-regular file');
    const hash = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    if (hash !== item.sha256) throw new Error(`Package integrity failure: ${item.path}`);
  }
  if (actual.size !== declared.size) throw new Error('Package contains undeclared files');
  return manifest;
}

async function main() {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const dataRoot = path.join(process.env.ProgramData || 'C:\\ProgramData', SERVICE_NAME);
  if (process.argv[2] === '--cleanup') {
    const scratch = path.join(dataRoot, 'scratch');
    try { await fs.access(scratch); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await regularAncestors(scratch);
    await scratchInventory(scratch);
    for (const name of await fs.readdir(scratch)) await fs.rm(path.join(scratch, name), { recursive: true, force: true });
    return;
  }
  const manifest = await verifyPayload(root);
  await regularAncestors(path.join(dataRoot, 'config', 'service.json'));
  const config = validateConfiguration(JSON.parse(await fs.readFile(path.join(dataRoot, 'config', 'service.json'), 'utf8')));
  const scratch = path.join(dataRoot, 'scratch');
  // Only inherited OS essentials survive. In particular PORT, NODE_OPTIONS,
  // VERCEL/OIDC and filesystem-canonical settings cannot change managed policy.
  const osEnvironment = Object.fromEntries(['SystemRoot','WINDIR','COMSPEC','ProgramData','SystemDrive'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, osEnvironment, {
    PATH: `${path.join(root, 'git', 'cmd')};${path.join(root, 'git', 'usr', 'bin')};${osEnvironment.SystemRoot}\\System32`,
    TEMP: scratch, TMP: scratch, HOME: scratch, USERPROFILE: scratch,
    NODE_ENV: 'production', DEVINT_BUILD_SHA: manifest.engineSha,
    DEVINT_AUTH_MODE: 'bearer', DEVINT_BEARER_TOKEN: config.agentToken,
    DEVINT_HOST: '127.0.0.1', DEVINT_PORT: '8788', DEVINT_ALLOWED_HOSTS: '127.0.0.1,localhost',
    DEVINT_PROJECTS_JSON: JSON.stringify(config.projects), DEVINT_SCRATCH_DIR: scratch,
    DEVINT_GRAPH_BUILD_CONCURRENCY: '1', DEVINT_GRAPH_CACHE_SIZE: '2', DEVINT_GRAPH_SNAPSHOT_CACHE_SIZE: '1', DEVINT_GRAPH_CACHE_MAX_RECORDS: '50000',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0',
    ...(config.remoteStorage ? { DEVINT_CANONICAL_BLOB_STORE_ID: config.remoteStorage.storeId, DEVINT_CANONICAL_BLOB_TOKEN: config.remoteStorage.token } : {}),
  });
  // Start is exclusive (SCM owns this one service). Anything left here is abandoned.
  await scratchInventory(scratch);
  for (const name of await fs.readdir(scratch)) await fs.rm(path.join(scratch, name), { recursive: true, force: true });
  const { createDevelopmentIntelligenceServer } = await import('./app/dist/src/http.js');
  const server = createDevelopmentIntelligenceServer();
  const handlers = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url === '/managed-health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true, engineSha: manifest.engineSha, packagingSha: manifest.packagingSha, msiVersion: manifest.msiVersion, pid: process.pid, node: process.version, scheduler: 'disabled', authority: 'remote' }));
    } else for (const handler of handlers) handler.call(server, req, res);
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(quotaTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15000).unref();
  };
  const quotaTimer = setInterval(async () => {
    try {
      const files = await scratchInventory(scratch, true);
      if (files.reduce((sum, item) => sum + item.bytes, 0) > 2 * 1024 ** 3) throw new Error('Scratch budget exceeded');
    } catch { console.error('Managed scratch budget/integrity failure; stopping'); shutdown(); }
  }, 5000);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.listen(8788, '127.0.0.1');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Managed activation failed: check protected configuration, package integrity and owned directory permissions'); process.exitCode = 1; });
}
