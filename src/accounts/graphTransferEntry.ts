import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { checkedGraphTransferManifest, receiveGraphTransfer, type GraphFile, type GraphTransferManifest } from './graphTransfer.js';

type TransferInput = { token: string; project: string; graphId: string; target: string; retain: number; stageOnly?: boolean; previousGraphId?: string; accountGraphId?: string; lease?: { origin: string; userId: string; jobId: string; claimId: string } };
type Arrival = { stream: ReadableStream<Uint8Array>; response: any };

/** One short-lived, claim-scoped transfer endpoint inside the destination Sandbox. */
async function main(): Promise<void> {
  const [inputFile, destination, scratch, portText] = process.argv.slice(2);
  if (!inputFile || !destination || !scratch || !portText) throw new Error('Graph transfer arguments are incomplete');
  const input = JSON.parse(await fs.readFile(inputFile, 'utf8')) as TransferInput;
  if (!input.token || !input.project || !input.graphId || !input.target || !Number.isSafeInteger(input.retain) || input.retain < 1) throw new Error('Graph transfer identity is incomplete');
  let manifest: GraphTransferManifest | null = null, receiving: Promise<void> | null = null, failure: Error | null = null;
  const waiting = new Map<string, (arrival: Arrival) => void>(), arrivals = new Map<string, Arrival>(), complete = new Set<string>(), responses = new Map<string, any>();
  let currentFile = '';
  const reply = (res: any, status: number, value: unknown) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); } };
  const authorized = (req: any) => { const actual = String(req.headers.authorization ?? ''), expected = `Bearer ${input.token}`; return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); };
  const assertClaim = async (requirePublished = false) => {
    if (!input.lease) throw new Error('Graph transfer claim is unavailable');
    const response = await fetch(new URL('/account/hosted-transfer-lease', input.lease.origin), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: input.lease.userId, jobId: input.lease.jobId, claimId: input.lease.claimId, graphId: input.graphId, token: input.token, requirePublished }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Graph transfer claim is no longer active');
  };
  const server = http.createServer(async (req: any, res: any) => {
    try {
      if (!authorized(req)) { reply(res, 403, { error: 'Invalid transfer authorization' }); return; }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/ready') { reply(res, 200, { ready: true }); return; }
      if (req.method === 'PUT' && url.pathname === '/manifest') {
        const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(Buffer.from(chunk));
        const next = checkedGraphTransferManifest(JSON.parse(Buffer.concat(buffers).toString('utf8')), input.project, input.graphId);
        if (manifest && JSON.stringify(next) !== JSON.stringify(manifest)) throw new Error('Transfer manifest changed');
        if (!manifest) {
          manifest = next;
          receiving = receiveGraphTransfer({ manifest, project: input.project, graphId: input.graphId, target: input.target, destination, scratch, retain: input.retain, stageOnly: Boolean(input.stageOnly), ...(input.previousGraphId && input.accountGraphId ? { previousGraphId: input.previousGraphId, accountGraphId: input.accountGraphId } : {}),
            assertClaim,
            readFile: async (file: GraphFile) => {
              currentFile = file.name;
              const existing = arrivals.get(file.name); if (existing) { arrivals.delete(file.name); responses.set(file.name, existing.response); return existing.stream; }
              return await new Promise<ReadableStream<Uint8Array>>((resolve) => waiting.set(file.name, arrival => { responses.set(file.name, arrival.response); resolve(arrival.stream); }));
            },
            progress: () => { complete.add(currentFile); const response = responses.get(currentFile); responses.delete(currentFile); if (response) reply(response, 200, { received: true }); },
          }).catch(error => { failure = error instanceof Error ? error : new Error(String(error)); for (const response of responses.values()) reply(response, 500, { error: failure.message }); throw failure; });
          void receiving.catch(() => {});
        }
        reply(res, 200, { accepted: true }); return;
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/file/')) {
        const name = decodeURIComponent(url.pathname.slice('/file/'.length));
        if (!manifest?.files.some(file => file.name === name)) throw new Error('File is not in the selected graph');
        if (failure) throw failure;
        if (complete.has(name)) { req.resume(); reply(res, 200, { received: true }); return; }
        if (arrivals.has(name) || responses.has(name)) throw new Error('This graph file is already being transferred');
        const arrival = { stream: Readable.toWeb(req) as ReadableStream<Uint8Array>, response: res };
        const waiter = waiting.get(name); if (waiter) { waiting.delete(name); waiter(arrival); } else arrivals.set(name, arrival);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/retire') {
        if (!input.stageOnly || !input.accountGraphId) throw new Error('Graph retirement is unavailable for this transfer');
        if (receiving) await receiving;
        const { reconcileAccountGraphStages } = await import('../intelligence/localGraphStore.js');
        await reconcileAccountGraphStages(destination, input.project, input.accountGraphId, input.graphId, () => assertClaim(true));
        reply(res, 200, { retired: true, graphId: input.graphId }); return;
      }
      if (req.method === 'POST' && url.pathname === '/commit') {
        if (!receiving) throw new Error('Graph transfer has not started');
        if (manifest && complete.size !== manifest.files.length) throw new Error('Graph transfer is incomplete');
        await receiving; reply(res, 200, { imported: true, graphId: input.graphId }); return;
      }
      reply(res, 404, { error: 'Unknown transfer operation' });
    } catch (error) { reply(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  if (input.lease) {
    const lease = input.lease;
    let checking = false;
    const check = async () => {
      if (checking) return; checking = true;
      try {
        const response = await fetch(new URL('/account/hosted-transfer-lease', lease.origin), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: lease.userId, jobId: lease.jobId, claimId: lease.claimId, graphId: input.graphId, token: input.token }), signal: AbortSignal.timeout(10_000) });
        if (response.status === 403) { if (server.listening) { server.closeAllConnections(); server.close(); } process.exit(1); }
      } catch { /* A transient account connection does not erase a graph in flight. */ }
      finally { checking = false; }
    };
    await check(); setInterval(() => { void check(); }, 15_000);
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(portText), '0.0.0.0', resolve); });
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
