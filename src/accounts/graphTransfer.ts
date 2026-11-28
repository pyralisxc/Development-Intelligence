import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { importLocalSourceGraph, localSourceGraphHistory, reconcileAccountGraphStages } from '../intelligence/localGraphStore.js';

type Entry = { generation: string; graphId: string; createdAt: string; sourceFingerprint: string | null };
export type GraphFile = { name: string; size: number; sha256: string };
export type GraphTransferManifest = { version: 1; project: string; graphId: string; entry: Entry; files: GraphFile[] };

function projectDirectory(root: string, project: string): string {
  return path.join(path.resolve(root), 'source-graphs', createHash('sha256').update(project).digest('hex'));
}
function filename(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) throw new Error('Invalid graph transfer file');
  return value;
}
async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
export function checkedGraphTransferManifest(value: unknown, project: string, graphId: string): GraphTransferManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid graph transfer manifest');
  const data = value as GraphTransferManifest;
  if (data.version !== 1 || data.project !== project || data.graphId !== graphId || data.entry?.graphId !== graphId || !/^[a-f0-9]{32}$/u.test(data.entry?.generation ?? '') || !Array.isArray(data.files)) throw new Error('Graph transfer identity does not match');
  const names = new Set<string>();
  for (const file of data.files) {
    const name = filename(file.name);
    if (names.has(name) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('Invalid graph transfer file metadata');
    names.add(name);
  }
  if (!names.has('manifest.json')) throw new Error('Graph transfer is missing its manifest');
  return data;
}

/** The transfer describes the existing generation; it creates no graph knowledge. */
export async function describeGraphTransfer(root: string, project: string, graphId: string): Promise<{ manifest: GraphTransferManifest; directory: string }> {
  const catalog = await localSourceGraphHistory(root, project);
  const entry = catalog?.entries.find(item => item.graphId === graphId);
  if (!entry || !/^[a-f0-9]{32}$/u.test(entry.generation)) throw new Error('The retained graph is unavailable');
  const directory = path.join(projectDirectory(root, project), entry.generation);
  const files: GraphFile[] = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (!item.isFile()) throw new Error('Unexpected item in retained graph generation');
    const name = filename(item.name), location = path.join(directory, name);
    const stat = await fs.stat(location);
    files.push({ name, size: stat.size, sha256: await digest(location) });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { manifest: checkedGraphTransferManifest({ version: 1, project, graphId, entry, files }, project, graphId), directory };
}

/** Stage exact files and publish through the same validating graph-store import. */
export async function receiveGraphTransfer(input: {
  manifest: unknown; project: string; graphId: string; target: string; destination: string; scratch: string; retain: number; stageOnly?: boolean; previousGraphId?: string; accountGraphId?: string; assertClaim?: () => Promise<void>;
  readFile: (file: GraphFile) => Promise<ReadableStream<Uint8Array>>;
  progress?: (completed: number, total: number) => void;
}): Promise<void> {
  const manifest = checkedGraphTransferManifest(input.manifest, input.project, input.graphId);
  await fs.mkdir(input.scratch, { recursive: true });
  const staging = await fs.mkdtemp(path.join(input.scratch, 'di-graph-transfer-'));
  try {
    const directory = projectDirectory(staging, input.project), generation = path.join(directory, manifest.entry.generation);
    await fs.mkdir(generation, { recursive: true });
    let completed = 0;
    for (const file of manifest.files) {
      const temporary = path.join(generation, `.${randomBytes(12).toString('hex')}.tmp`), target = path.join(generation, filename(file.name));
      const hash = createHash('sha256'); let size = 0;
      const reader = (await input.readFile(file)).getReader(), handle = await fs.open(temporary, 'wx', 0o600);
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > file.size) throw new Error(`Transferred graph file exceeded its recorded size: ${file.name}`); hash.update(value);
          let offset = 0; while (offset < value.byteLength) { const result = await handle.write(value, offset, value.byteLength - offset); if (!result.bytesWritten) throw new Error('Graph transfer write did not advance'); offset += result.bytesWritten; }
        }
      } finally { reader.releaseLock(); await handle.close(); }
      if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`Transferred graph file changed: ${file.name}`);
      await fs.rename(temporary, target);
      input.progress?.(++completed, manifest.files.length);
    }
    await fs.writeFile(path.join(directory, 'catalog.json'), JSON.stringify({ version: 1, project: input.project, active: manifest.entry.generation, entries: [manifest.entry], targets: { [input.target]: manifest.entry.generation } }), { mode: 0o600 });
    if (input.stageOnly && input.previousGraphId && input.accountGraphId) { if (!input.assertClaim) throw new Error('Account graph cleanup requires a verified claim'); await reconcileAccountGraphStages(input.destination, input.project, input.accountGraphId, input.previousGraphId, input.assertClaim); }
    await importLocalSourceGraph(staging, input.destination, input.project, input.graphId, input.target, input.retain, Boolean(input.stageOnly));
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

/** Send a retained generation over an authenticated streaming HTTP connection. */
export async function sendGraphTransfer(input: {
  root: string; project: string; graphId: string; endpoint: string; token: string;
  progress?: (completed: number, total: number, bytes: number, totalBytes: number) => void;
}): Promise<void> {
  const endpoint = new URL(input.endpoint);
  if (endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new Error('Graph transfer requires HTTPS or local loopback');
  const { manifest, directory } = await describeGraphTransfer(input.root, input.project, input.graphId);
  const headers = { authorization: `Bearer ${input.token}` };
  const request = async (pathname: string, options: any = {}) => {
    const response = await fetch(new URL(pathname, endpoint), { ...options, headers: { ...headers, ...(options.headers ?? {}) }, redirect: 'error' });
    const body = await response.text();
    if (!response.ok) { let message = body; try { message = JSON.parse(body).error ?? body; } catch { /* Provider may return a non-JSON error. */ } throw new Error(`Graph transfer failed (${response.status}): ${message.slice(0, 300)}`); }
    return body ? JSON.parse(body) : null;
  };
  await request('/manifest', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest) });
  let completed = 0, bytes = 0, lastProgress = 0;
  const totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  for (const file of manifest.files) {
    const stream = createReadStream(path.join(directory, file.name));
    stream.on('data', chunk => { bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length; if (Date.now() - lastProgress >= 3000) { lastProgress = Date.now(); input.progress?.(completed, manifest.files.length, bytes, totalBytes); } });
    await request(`/file/${encodeURIComponent(file.name)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.size) }, body: stream, duplex: 'half' });
    input.progress?.(++completed, manifest.files.length, bytes, totalBytes);
  }
  const result = await request('/commit', { method: 'POST' });
  if (!result?.imported || result.graphId !== input.graphId) throw new Error('Graph transfer did not confirm the selected generation');
}
