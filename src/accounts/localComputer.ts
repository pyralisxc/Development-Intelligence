import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runChecked } from '../util/process.js';
import { runLocalGraphWorker } from '../intelligence/canonicalReconcileWorker.js';
import type { BuildJob, BrowseJob } from './workspace.js';
import { gitAuth } from '../source/gitAuth.js';

type Discovery = { device_authorization_endpoint: string; token_endpoint: string };
type DeviceCredentials = { origin: string; clientId: string; tokenEndpoint: string; refreshToken: string; computerId: string; secret: string };

function trustedUrl(raw: string, allowLocal = false): URL {
  const url = new URL(raw);
  if (url.username || url.password || (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS Workbench or a local loopback address');
  return url;
}
function file(home: string): string { return path.join(home, 'linked-account.json'); }
function protect(text: string, decrypt = false): string {
  if (process.platform !== 'win32') return text;
  const script = decrypt
    ? '$v=[Convert]::FromBase64String([Console]::In.ReadToEnd());[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'
    : '$v=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Security;${script}`], { input: text, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) throw new Error('Could not access this Windows user’s protected credential store');
  return result.stdout;
}
async function save(home: string, data: DeviceCredentials): Promise<void> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const target = file(home), temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, protect(JSON.stringify(data)), { mode: 0o600 });
  await fs.rename(temporary, target);
  if (process.platform !== 'win32') await fs.chmod(target, 0o600);
}
async function read(home: string): Promise<DeviceCredentials> { return JSON.parse(protect(await fs.readFile(file(home), 'utf8'), true)) as DeviceCredentials; }
async function postForm(url: string, form: Record<string, string>): Promise<any> {
  const response = await fetch(trustedUrl(url), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), redirect: 'error' });
  const result = await response.json() as any;
  if (!response.ok && !result.error) throw new Error(`Authorization request failed (${response.status})`);
  return result;
}
async function workspace(origin: string, token: string, data: unknown): Promise<any> {
  const response = await fetch(new URL('/account/workspace', trustedUrl(origin, true)), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(data), redirect: 'error' });
  const text = await response.text();
  let result: any;
  try { result = JSON.parse(text); } catch { throw new Error(`Workbench returned ${response.status}: ${text.slice(0, 200)}`); }
  if (!response.ok) throw new Error(result.error || `Workbench returned ${response.status}`);
  return result;
}

/** Link this installation using Clerk's device grant; a secret is never embedded in the installer. */
export async function linkComputer(home: string, workbench: string, pairingCode: string): Promise<void> {
  const origin = trustedUrl(workbench, true).origin;
  const configResponse = await fetch(new URL('/account/client-config', origin), { redirect: 'error' });
  if (!configResponse.ok) throw new Error('This Workbench does not yet offer computer linking');
  const config = await configResponse.json() as { issuer: string; clientId: string };
  const issuer = trustedUrl(config.issuer);
  const discoveryResponse = await fetch(new URL('/.well-known/openid-configuration', issuer), { redirect: 'error' });
  if (!discoveryResponse.ok) throw new Error('Clerk authorization discovery failed');
  const discovery = await discoveryResponse.json() as Discovery;
  for (const endpoint of [discovery.device_authorization_endpoint, discovery.token_endpoint]) {
    if (trustedUrl(endpoint).origin !== issuer.origin) throw new Error('Unexpected Clerk authorization endpoint');
  }
  const request = await postForm(discovery.device_authorization_endpoint, { client_id: config.clientId, scope: 'openid profile offline_access' });
  if (request.error || !request.device_code || !request.user_code || !request.verification_uri || !Number.isFinite(request.expires_in) || !Number.isFinite(request.interval)) throw new Error('Clerk did not start computer authorization');
  console.log(`Open ${request.verification_uri} and enter ${request.user_code} to link this computer.`);
  if (request.verification_uri_complete) console.log(`Or open ${request.verification_uri_complete}`);
  const until = Date.now() + request.expires_in * 1000;
  let interval = request.interval * 1000;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, interval));
    const tokens = await postForm(discovery.token_endpoint, { client_id: config.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: request.device_code });
    if (tokens.error === 'authorization_pending') continue;
    if (tokens.error === 'slow_down') { interval += 5000; continue; }
    if (tokens.error || !tokens.access_token || !tokens.refresh_token) throw new Error(`Computer authorization did not complete: ${tokens.error || 'missing credentials'}`);
    const linked = await workspace(origin, tokens.access_token, { action: 'link-computer', pairingCode, computer: { name: os.hostname(), platform: `${os.platform()} ${os.arch()}` } });
    await save(home, { origin, clientId: config.clientId, tokenEndpoint: discovery.token_endpoint, refreshToken: tokens.refresh_token, computerId: linked.computer.id, secret: linked.secret });
    console.log(`Linked ${linked.computer.name} to ${origin}.`); return;
  }
  throw new Error('Computer authorization expired; start the link again');
}

/** The linked desktop opens the same account Workbench used by the browser. */
export async function accountWorkbenchOrigin(home: string): Promise<string> {
  return trustedUrl((await read(home)).origin, true).origin;
}

export async function computerHeartbeat(home: string): Promise<void> {
  const credentials = await read(home);
  const tokens = await postForm(credentials.tokenEndpoint, { client_id: credentials.clientId, grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
  if (tokens.error || !tokens.access_token) throw new Error('Computer authorization expired; link this computer again');
  if (tokens.refresh_token) { credentials.refreshToken = tokens.refresh_token; await save(home, credentials); }
  const computer = await workspace(credentials.origin, tokens.access_token, { action: 'computer-heartbeat', computerId: credentials.computerId, secret: credentials.secret });
  console.log(`Connected ${computer.name} to ${credentials.origin}.`);
}

/** Execute the same account graph job on a linked computer or hosted runtime. */
export async function executeAccountGraphJob(
  job: BuildJob,
  scratchDir: string,
  retain: number,
  githubToken: () => Promise<string | null>,
  report: (progress: unknown) => Promise<unknown>,
): Promise<unknown> {
  let temporary: string | null = null;
  let renewal: ReturnType<typeof setInterval> | undefined;
  try {
    let root = job.graph.source.location;
    let ref = job.graph.source.revision;
    if (job.graph.source.kind === 'git' && job.kind !== 'question' && job.kind !== 'investigation') {
      const source = trustedUrl(root);
      await fs.mkdir(scratchDir, { recursive: true });
      temporary = await fs.mkdtemp(path.join(scratchDir, 'di-linked-'));
      root = path.join(temporary, 'repository');
      const token = source.hostname === 'github.com' ? await githubToken() : null;
      const auth = await gitAuth({ repository: source.href, defaultRef: 'HEAD' }, token ? { token, username: 'x-access-token', kind: 'token-env' } : undefined);
      try { await runChecked('git', ['clone', '--', source.href, root], { env: { GIT_TERMINAL_PROMPT: '0', ...auth.env } }); }
      finally { await auth.cleanup(); }
      ref ||= 'HEAD';
    }
    let activeProgress: unknown = { stage: job.kind === 'question' || job.kind === 'investigation' ? 'querying-snapshot' : 'building' };
    renewal = setInterval(() => { void report(activeProgress).catch(() => {}); }, 60_000);
    let lastProgress = 0;
    let result: unknown;
    if (job.kind === 'question' || job.kind === 'investigation') {
      if (!job.graphId) throw new Error('Investigation has no retained graph');
      const graphDirectory = path.resolve(job.graph.query?.location ?? job.graph.storage.location);
      process.env.DEVINT_LOCAL_GRAPH_DIR = graphDirectory;
      const { localSourceGraphHistory } = await import('../intelligence/localGraphStore.js');
      const catalog = await localSourceGraphHistory(graphDirectory, job.project.id);
      if (!catalog?.entries.some(entry => entry.graphId === job.graphId)) throw new Error('The selected graph is not available at the query service location');
      activeProgress = { stage: 'querying-snapshot', graphId: job.graphId, location: graphDirectory };
      await report(activeProgress);
      const repository = job.graph.source.kind === 'git' ? trustedUrl(root).href : pathToFileURL(path.resolve(root)).href;
      process.env.DEVINT_PROJECTS_JSON = JSON.stringify({ [job.project.id]: { repository, defaultRef: 'HEAD', revisionPolicy: 'repository-history' } });
      if (job.kind === 'question') {
        if (!job.question) throw new Error('Missing question');
        const { queryWorkbenchRequest } = await import('../intelligence/workbench.js');
        result = await queryWorkbenchRequest({ project: job.project.id, graphId: job.graphId, text: job.question });
      } else {
        if (!job.request) throw new Error('Missing investigation');
        const { createDevelopmentIntelligenceServer } = await import('../http.js');
        process.env.DEVINT_AUTH_MODE = 'none'; process.env.DEVINT_ALLOW_UNAUTHENTICATED = '1';
        const server = createDevelopmentIntelligenceServer();
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        try {
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Local investigation service is unavailable');
          const url = new URL(job.request.path, `http://127.0.0.1:${address.port}`);
          const query = new URLSearchParams(job.request.query ?? '');
          const action = query.get('action');
          if (action === 'changes' || action === 'interaction-parity') {
            const names = [query.get('baseRef'), query.get('headRef')];
            if (names.some(name => !name || !catalog.targets || !Object.hasOwn(catalog.targets, name))) throw new Error('Choose two saved graph targets available to this query service');
            query.delete('graphId'); query.set('ref', names[1]!);
          }
          query.set('project', job.project.id);
          if (!query.has('ref') && !query.has('graphId')) query.set('graphId', job.graphId);
          url.search = query.toString();
          const body = job.request.body && typeof job.request.body === 'object' && !Array.isArray(job.request.body) ? job.request.body as Record<string, unknown> : {};
          const response = await fetch(url, job.request.method === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, project: job.project.id, ...(!body.ref && !body.graphId ? { graphId: job.graphId } : {}) }) } : undefined);
          result = await response.json();
          if (!response.ok) throw new Error((result as { error?: string })?.error ?? `Investigation failed (${response.status})`);
        } finally { server.close(); }
      }
    } else {
      const dataDir = job.graph.buildComputer === job.graph.storage.computer ? job.graph.storage.location : job.graph.transfer && path.join(job.graph.transfer.buildLocation, '.di-transfers', job.id);
      if (!dataDir) throw new Error('A transfer method is required for this graph');
      result = await runLocalGraphWorker({ kind: 'local', project: job.project.id, root, dataDir,
        scratchDir, retain, target: job.graph.name, ...(ref ? { ref } : {}) }, progress => {
        activeProgress = progress;
        if (Date.now() - lastProgress >= 5000) { lastProgress = Date.now(); void report(progress).catch(() => {}); }
      });
    }
    return result;
  } finally {
    if (renewal) clearInterval(renewal);
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** Polling uses the same local graph worker as the CLI and Workbench. */
export async function runComputer(home: string, scratchDir: string, retain: number): Promise<void> {
  const credentials = await read(home);
  let accessToken = '', expiresAt = 0;
  let refreshing: Promise<void> | null = null;
  const send = async (payload: Record<string, unknown>) => {
    if (Date.now() >= expiresAt) {
      refreshing ??= (async () => {
        const tokens = await postForm(credentials.tokenEndpoint, { client_id: credentials.clientId, grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
        if (tokens.error || !tokens.access_token) throw new Error('Computer authorization expired; link this computer again');
        if (tokens.refresh_token) { credentials.refreshToken = tokens.refresh_token; await save(home, credentials); }
        accessToken = tokens.access_token; expiresAt = Date.now() + Math.max(1, Number(tokens.expires_in ?? 60) - 15) * 1000;
      })().finally(() => { refreshing = null; });
      await refreshing;
    }
    return await workspace(credentials.origin, accessToken, { ...payload, computerId: credentials.computerId, secret: credentials.secret });
  };
  console.log(`Waiting for DI account work from ${credentials.origin}.`);
  for (;;) {
    let job: BuildJob | BrowseJob | null;
    try { job = await send({ action: 'computer-claim-build' }) as BuildJob | BrowseJob | null; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/authorization expired|not linked to this account/i.test(message)) throw error;
      console.error(`Account connection interrupted: ${message}`);
      await new Promise(resolve => setTimeout(resolve, 5000)); continue;
    }
    if (!job) { await new Promise(resolve => setTimeout(resolve, 5000)); continue; }
    const update = (data: Record<string, unknown>) => send({ action: 'computer-update-build', jobId: job.id, update: { ...data, claimId: job.claimId } });
    let renewal: ReturnType<typeof setInterval> | undefined;
    try {
      if (job.kind === 'browse') {
        const directory = path.resolve(job.path ?? os.homedir());
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const candidates = await Promise.all(entries.map(async (entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }) => ({ name: entry.name, path: path.join(directory, entry.name), directory: entry.isDirectory() || (entry.isSymbolicLink() && await fs.stat(path.join(directory, entry.name)).then((stat: { isDirectory(): boolean }) => stat.isDirectory()).catch(() => false)) })));
        const folders = candidates.filter((entry: { directory: boolean }) => entry.directory).map((entry: { name: string; path: string }) => ({ name: entry.name, path: entry.path })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
        const roots = process.platform === 'win32' ? (await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async letter => { const root = `${letter}:\\`; return await fs.access(root).then(() => root).catch(() => null); }))).filter(Boolean) : ['/'];
        await update({ state: 'complete', result: { path: directory, parent: path.dirname(directory) === directory ? null : path.dirname(directory), roots, folders } });
        continue;
      }
      if (job.kind === 'build' && job.stage === 'transfer') {
        const built = job.result as { graphId?: unknown } | undefined;
        if (typeof built?.graphId !== 'string' || !job.graph.transfer) throw new Error('The graph transfer has no built generation');
        const staging = path.join(job.graph.transfer.storageLocation, '.di-transfers', job.id);
        renewal = setInterval(() => { void update({ progress: { stage: 'transferring-to-storage' } }).catch(() => {}); }, 60_000);
        const { importLocalSourceGraph } = await import('../intelligence/localGraphStore.js');
        await importLocalSourceGraph(staging, job.graph.storage.location, job.project.id, built.graphId, job.graph.name, retain);
        if (renewal) clearInterval(renewal);
        await update({ state: 'complete', result: built });
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const result = await executeAccountGraphJob(job, scratchDir, retain, async () => (await send({ action: 'computer-github-token', jobId: job.id, claimId: job.claimId })).token as string | null, progress => update({ progress }));
      if (renewal) clearInterval(renewal);
      if (job.kind === 'investigation') {
        const bytes = Buffer.from(JSON.stringify(result), 'utf8'), size = 192 * 1024;
        const parts = Math.ceil(bytes.length / size);
        renewal = setInterval(() => { void update({ progress: { stage: 'transferring-investigation' } }).catch(() => {}); }, 60_000);
        for (let index = 0; index < parts; index++) await send({ action: 'computer-investigation-part', jobId: job.id, claimId: job.claimId, index, part: bytes.subarray(index * size, (index + 1) * size).toString('base64') });
        if (renewal) clearInterval(renewal);
        await update({ state: 'complete', resultParts: parts });
      } else await update({ state: 'complete', result });
    } catch (error) {
      if (renewal) clearInterval(renewal);
      await update({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
}
