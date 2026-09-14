import readline from 'node:readline';
import { handleRpc } from './http.js';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const reply = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of rl) {
  if (!line.trim()) continue;
  let body: any;
  try { body = JSON.parse(line); }
  catch { reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
  const metaVersion = body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const modern = metaVersion === '2026-07-28' || body?.method === 'server/discover';
  const result = await handleRpc(body, { modern });
  if (result.body !== undefined) reply(result.body);
}
