import { randomBytes } from 'node:crypto';
import { validateAccountNetwork, type AccountNetwork, type AccountNetworkStore } from './network.js';

interface BlobNetworkConfiguration { storeId: string; token: string; baseUrl: string; apiUrl: string; }

/** Separate account metadata namespace. No environment discovery or canonical graph writes. */
export class BlobAccountNetworkStore implements AccountNetworkStore {
  private readonly config: BlobNetworkConfiguration;
  constructor(config: BlobNetworkConfiguration, private readonly request: typeof fetch = fetch) {
    for (const raw of [config.baseUrl, config.apiUrl]) {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Account metadata requires explicit HTTPS storage endpoints');
    }
    if (!/^[A-Za-z0-9_-]+$/u.test(config.storeId) || !config.token) throw new Error('Account metadata storage is not configured');
    this.config = Object.freeze({ ...config, baseUrl: config.baseUrl.replace(/\/$/u, ''), apiUrl: config.apiUrl.replace(/\/$/u, '') });
  }
  private objectPath(accountId: string): string {
    if (!/^account-[a-f0-9]{64}$/u.test(accountId)) throw new Error('Invalid account storage identity');
    return `development-intelligence/accounts/network-v1/${accountId}.json`;
  }
  private headers(): Record<string, string> { return { authorization: `Bearer ${this.config.token}`, 'x-vercel-blob-store-id': this.config.storeId }; }
  async read(accountId: string): Promise<{ document: AccountNetwork; etag: string } | null> {
    const response = await this.request(`${this.config.baseUrl}/${this.objectPath(accountId)}?cache=0`, { headers: this.headers(), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => { throw new Error('Account network storage unavailable'); });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Account network read failed: HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Account network response unavailable');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 256 * 1024) throw new Error('Account network response exceeds bounds'); chunks.push(item.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const etag = response.headers.get('etag');
    if (!etag) throw new Error('Account network concurrency token unavailable');
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid account network response'); }
    return { document: validateAccountNetwork(parsed, accountId), etag };
  }
  async compareAndSwap(accountId: string, document: AccountNetwork, expectedEtag: string | null): Promise<boolean> {
    validateAccountNetwork(document, accountId);
    if (expectedEtag !== null && (!expectedEtag || expectedEtag.length > 512 || /[\r\n]/u.test(expectedEtag))) throw new Error('Invalid account network concurrency token');
    const url = new URL(this.config.apiUrl); url.searchParams.set('pathname', this.objectPath(accountId));
    const response = await this.request(url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: {
      ...this.headers(), 'x-api-version': '12', 'x-api-blob-request-id': randomBytes(16).toString('hex'), 'x-api-blob-request-attempt': '0',
      'x-vercel-blob-access': 'private', 'x-add-random-suffix': '0', 'x-allow-overwrite': expectedEtag === null ? '0' : '1',
      ...(expectedEtag === null ? {} : { 'x-if-match': expectedEtag }), 'content-type': 'application/json', 'x-content-type': 'application/json', 'x-cache-control-max-age': '60',
    }, body: JSON.stringify(document) }).catch(() => { throw new Error('Account network storage unavailable; reconcile before retrying'); });
    if (response.status === 409 || response.status === 412) return false;
    if (!response.ok) throw new Error(`Account network conditional save failed: HTTP ${response.status}`);
    return true;
  }
}
