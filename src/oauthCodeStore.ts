import { Redis } from '@upstash/redis';

export interface StoredOAuthAuthorizationCode {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  state?: string;
  codeChallenge: string;
  expiresAt: number;
}

const memoryCodes = new Map<string, StoredOAuthAuthorizationCode>();
let redisClient: Redis | null | undefined;

function redisCredentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim() || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim() || '';
  if (!url && !token) return null;
  if (!url || !token) throw Object.assign(new Error('OAuth shared state requires both Redis REST URL and token'), { status: 503 });
  return { url, token };
}

function redis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const credentials = redisCredentials();
  redisClient = credentials ? new Redis({ ...credentials, enableTelemetry: false }) : null;
  return redisClient;
}

function key(code: string): string {
  return `devint:oauth:code:${code}`;
}

function cleanMemory(now: number): void {
  for (const [code, record] of memoryCodes) if (record.expiresAt <= now) memoryCodes.delete(code);
}

export function oauthAuthorizationCodeStoreKind(): 'redis' | 'memory' {
  return redisCredentials() ? 'redis' : 'memory';
}

export function oauthSharedAuthorizationStateRequired(): boolean {
  return Boolean(process.env.VERCEL || process.env.DEVINT_REQUIRE_SHARED_OAUTH_STATE === '1');
}

export function oauthSharedAuthorizationStateConfigured(): boolean {
  try { return oauthAuthorizationCodeStoreKind() === 'redis'; }
  catch { return false; }
}

export async function storeOAuthAuthorizationCode(code: string, record: StoredOAuthAuthorizationCode, ttlSeconds: number): Promise<void> {
  const client = redis();
  if (client) {
    await client.set(key(code), record, { ex: ttlSeconds });
    return;
  }
  cleanMemory(Math.floor(Date.now() / 1000));
  memoryCodes.set(code, record);
}

export async function takeOAuthAuthorizationCode(code: string): Promise<StoredOAuthAuthorizationCode | null> {
  const client = redis();
  if (client) {
    return await client.getdel<StoredOAuthAuthorizationCode>(key(code));
  }
  const record = memoryCodes.get(code) ?? null;
  memoryCodes.delete(code);
  return record;
}

export function resetOAuthCodeStoreForTests(): void {
  memoryCodes.clear();
  redisClient = undefined;
}
