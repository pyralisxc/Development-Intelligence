import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  oauthSharedAuthorizationStateConfigured,
  oauthSharedAuthorizationStateRequired,
  storeOAuthAuthorizationCode,
  takeOAuthAuthorizationCode,
} from './oauthCodeStore.js';

const DEFAULT_SCOPE = 'development-intelligence.read';
const DEFAULT_REDIRECT_ORIGINS = ['https://chatgpt.com'];
const AUTHORIZATION_CODE_TTL_SECONDS = 300;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  grantTypes: string[];
  responseTypes: string[];
  applicationType?: string;
}

export interface OAuthAuthorizationRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  state?: string;
  codeChallenge: string;
}

interface SignedTokenPayload {
  v: 1;
  typ: 'access' | 'refresh' | 'client';
  iat: number;
  exp?: number;
  iss?: string;
  aud?: string;
  sub?: string;
  scope?: string;
  clientId?: string;
  redirectUris?: string[];
  clientName?: string;
  grantTypes?: string[];
  responseTypes?: string[];
  applicationType?: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signingSecret(): string {
  const secret = process.env.DEVINT_SESSION_SECRET?.trim();
  if (!secret) throw Object.assign(new Error('DEVINT_SESSION_SECRET is required for OAuth mode'), { status: 503 });
  return createHmac('sha256', secret).update('development-intelligence/oauth/v1').digest('base64url');
}

function signPayload(prefix: string, payload: SignedTokenPayload): string {
  const encoded = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', signingSecret()).update(`${prefix}.${encoded}`).digest('base64url');
  return `${prefix}.${encoded}.${signature}`;
}

function verifyPayload(token: string, prefix: string): SignedTokenPayload | null {
  const [actualPrefix, encoded, signature, extra] = token.split('.');
  if (actualPrefix !== prefix || !encoded || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', signingSecret()).update(`${prefix}.${encoded}`).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedTokenPayload;
    if (payload.v !== 1 || typeof payload.iat !== 'number') return null;
    if (payload.exp !== undefined && (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds())) return null;
    return payload;
  } catch {
    return null;
  }
}

function normalizedOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('OAuth URLs must not include credentials, query strings, or fragments');
  if (parsed.pathname !== '/' && parsed.pathname !== '') throw new Error('DEVINT_PUBLIC_BASE_URL must be an origin without a path');
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) throw new Error('DEVINT_PUBLIC_BASE_URL must use HTTPS outside loopback development');
  return parsed.origin;
}

export function oauthPublicBaseUrl(): string {
  const value = process.env.DEVINT_PUBLIC_BASE_URL?.trim();
  if (!value) throw Object.assign(new Error('DEVINT_PUBLIC_BASE_URL is required for OAuth mode'), { status: 503 });
  try { return normalizedOrigin(value); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 503 }); }
}

export function oauthResourceUrl(): string {
  return `${oauthPublicBaseUrl()}/mcp`;
}

function supportedScopes(): string[] {
  const raw = process.env.DEVINT_OAUTH_SCOPES?.trim();
  const values = (raw ? raw.split(/[\s,]+/u) : [DEFAULT_SCOPE]).map(value => value.trim()).filter(Boolean);
  const unique = [...new Set(values.filter(value => value !== 'offline_access'))];
  return unique.length ? unique : [DEFAULT_SCOPE];
}

function allowedRedirectOrigins(): string[] {
  const raw = process.env.DEVINT_OAUTH_ALLOWED_REDIRECT_ORIGINS?.trim();
  const origins = raw ? raw.split(',').map(value => value.trim()).filter(Boolean) : DEFAULT_REDIRECT_ORIGINS;
  return origins.map(value => new URL(value).origin);
}

function validateRedirectUri(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw Object.assign(new Error('redirect_uri must be an absolute URL'), { status: 400, oauthError: 'invalid_redirect_uri' }); }
  if (parsed.username || parsed.password || parsed.hash) throw Object.assign(new Error('redirect_uri must not contain credentials or a fragment'), { status: 400, oauthError: 'invalid_redirect_uri' });
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  if (loopback && parsed.protocol === 'http:' && process.env.DEVINT_OAUTH_ALLOW_LOOPBACK === '1') return parsed.toString();
  if (parsed.protocol !== 'https:' || !allowedRedirectOrigins().includes(parsed.origin)) {
    throw Object.assign(new Error(`redirect_uri origin is not allowed: ${parsed.origin}`), { status: 400, oauthError: 'invalid_redirect_uri' });
  }
  return parsed.toString();
}

function parseStringArray(value: unknown, name: string, fallback: string[]): string[] {
  const actual = value === undefined ? fallback : value;
  if (!Array.isArray(actual) || !actual.length || actual.some(item => typeof item !== 'string' || !item)) {
    throw Object.assign(new Error(`${name} must be a non-empty string array`), { status: 400, oauthError: 'invalid_client_metadata' });
  }
  return actual as string[];
}

function staticClient(clientId: string): RegisteredClient | null {
  const expected = process.env.DEVINT_OAUTH_CLIENT_ID?.trim();
  if (!expected || clientId !== expected) return null;
  const redirects = (process.env.DEVINT_OAUTH_REDIRECT_URIS ?? '').split(',').map(value => value.trim()).filter(Boolean).map(validateRedirectUri);
  if (!redirects.length) throw Object.assign(new Error('DEVINT_OAUTH_REDIRECT_URIS is required when DEVINT_OAUTH_CLIENT_ID is configured'), { status: 503 });
  return {
    clientId,
    redirectUris: redirects,
    clientName: process.env.DEVINT_OAUTH_CLIENT_NAME?.trim() || 'ChatGPT',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
    applicationType: 'web',
  };
}

function signedClient(clientId: string): RegisteredClient | null {
  const payload = verifyPayload(clientId, 'dic');
  if (!payload || payload.typ !== 'client' || !Array.isArray(payload.redirectUris) || !payload.clientName) return null;
  return {
    clientId,
    redirectUris: payload.redirectUris,
    clientName: payload.clientName,
    grantTypes: payload.grantTypes ?? ['authorization_code', 'refresh_token'],
    responseTypes: payload.responseTypes ?? ['code'],
    ...(payload.applicationType ? { applicationType: payload.applicationType } : {}),
  };
}

function resolveClient(clientId: string): RegisteredClient {
  const client = staticClient(clientId) ?? signedClient(clientId);
  if (!client) throw Object.assign(new Error('Unknown OAuth client'), { status: 400, oauthError: 'invalid_client' });
  return client;
}

export function registerOAuthClient(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('OAuth client registration body must be an object'), { status: 400, oauthError: 'invalid_client_metadata' });
  const record = body as Record<string, unknown>;
  const redirectUris = parseStringArray(record.redirect_uris, 'redirect_uris', []).map(validateRedirectUri);
  const grantTypes = parseStringArray(record.grant_types, 'grant_types', ['authorization_code', 'refresh_token']);
  const responseTypes = parseStringArray(record.response_types, 'response_types', ['code']);
  if (grantTypes.some(value => value !== 'authorization_code' && value !== 'refresh_token') || !grantTypes.includes('authorization_code')) {
    throw Object.assign(new Error('Only authorization_code and refresh_token grants are supported'), { status: 400, oauthError: 'invalid_client_metadata' });
  }
  if (responseTypes.some(value => value !== 'code')) throw Object.assign(new Error('Only code response_type is supported'), { status: 400, oauthError: 'invalid_client_metadata' });
  const tokenAuth = record.token_endpoint_auth_method ?? 'none';
  if (tokenAuth !== 'none') throw Object.assign(new Error('Only public PKCE clients with token_endpoint_auth_method=none are supported'), { status: 400, oauthError: 'invalid_client_metadata' });
  const clientName = typeof record.client_name === 'string' && record.client_name.trim() ? record.client_name.trim().slice(0, 128) : 'MCP client';
  const applicationType = typeof record.application_type === 'string' ? record.application_type : undefined;
  const issuedAt = nowSeconds();
  const clientId = signPayload('dic', {
    v: 1,
    typ: 'client',
    iat: issuedAt,
    redirectUris,
    clientName,
    grantTypes,
    responseTypes,
    ...(applicationType ? { applicationType } : {}),
  });
  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: 'none',
    client_name: clientName,
    ...(applicationType ? { application_type: applicationType } : {}),
  };
}

function requestedScopes(value: string | null): string[] {
  const resourceScopes = supportedScopes();
  const values = value ? value.split(/\s+/u).map(item => item.trim()).filter(Boolean) : resourceScopes;
  const allowed = new Set([...resourceScopes, 'offline_access']);
  if (values.some(scope => !allowed.has(scope))) throw Object.assign(new Error('Requested scope is not supported'), { status: 400, oauthError: 'invalid_scope' });
  for (const required of resourceScopes) {
    if (!values.includes(required)) values.push(required);
  }
  return [...new Set(values)];
}

function codeChallengeValid(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/u.test(value);
}

export function parseOAuthAuthorizationRequest(params: URLSearchParams): OAuthAuthorizationRequest {
  const responseType = params.get('response_type');
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  const codeChallengeMethod = params.get('code_challenge_method');
  if (responseType !== 'code') throw Object.assign(new Error('Only response_type=code is supported'), { status: 400, oauthError: 'unsupported_response_type' });
  if (!clientId) throw Object.assign(new Error('client_id is required'), { status: 400, oauthError: 'invalid_request' });
  const client = resolveClient(clientId);
  const normalizedRedirect = validateRedirectUri(redirectUri);
  if (!client.redirectUris.includes(normalizedRedirect)) throw Object.assign(new Error('redirect_uri is not registered for this client'), { status: 400, oauthError: 'invalid_request' });
  if (codeChallengeMethod !== 'S256' || !codeChallengeValid(codeChallenge)) throw Object.assign(new Error('OAuth authorization requires PKCE S256'), { status: 400, oauthError: 'invalid_request' });
  const scopes = requestedScopes(params.get('scope'));
  const state = params.get('state') ?? undefined;
  return {
    clientId,
    clientName: client.clientName,
    redirectUri: normalizedRedirect,
    scope: scopes.join(' '),
    ...(state ? { state } : {}),
    codeChallenge,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function renderOAuthConsent(request: OAuthAuthorizationRequest): string {
  const hidden = [
    ['response_type', 'code'],
    ['client_id', request.clientId],
    ['redirect_uri', request.redirectUri],
    ['scope', request.scope],
    ['code_challenge', request.codeChallenge],
    ['code_challenge_method', 'S256'],
    ...(request.state ? [['state', request.state]] : []),
  ].map(([name, value]) => `<input type="hidden" name="${escapeHtml(name!)}" value="${escapeHtml(value!)}">`).join('');
  const redirectHost = new URL(request.redirectUri).host;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize — Development Intelligence</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#070a10;color:#edf4ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 15%,#13233a 0,#070a10 46%)}.card{width:min(520px,calc(100vw - 28px));border:1px solid #293a54;background:#0b121ddf;box-shadow:0 26px 70px #0008;border-radius:18px;padding:26px}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#142943;border:1px solid #365579;color:#a4e4fa;font-weight:800}.eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8093aa;margin-top:20px}h1{font-size:24px;margin:7px 0 7px}p{color:#91a2b8;font-size:13px;line-height:1.55}.box{border:1px solid #283a52;background:#0d1725;border-radius:10px;padding:12px;margin:16px 0;font-size:12px;line-height:1.6}.box strong{color:#d8ecff}button{width:100%;border:1px solid #3d6488;background:#173451;color:#ecf8ff;border-radius:10px;padding:11px 12px;font-weight:700;cursor:pointer}.note{margin-top:16px;padding-top:14px;border-top:1px solid #213047;color:#74869d;font-size:10px;line-height:1.45}</style></head><body><main class="card"><div class="mark">DI</div><div class="eyebrow">MCP authorization</div><h1>Allow ${escapeHtml(request.clientName)}?</h1><p>This grants read access to Development Intelligence through the MCP endpoint. Git/source remains implementation authority and this authorization does not grant repository write access.</p><div class="box"><strong>Client</strong>: ${escapeHtml(request.clientName)}<br><strong>Return host</strong>: ${escapeHtml(redirectHost)}<br><strong>Scope</strong>: ${escapeHtml(request.scope)}</div><form method="post" action="/oauth/authorize">${hidden}<button type="submit">Authorize Development Intelligence</button></form><div class="note">Only approve this request if you initiated the connection from ChatGPT or another trusted MCP client.</div></main></body></html>`;
}

export async function issueAuthorizationCode(request: OAuthAuthorizationRequest): Promise<string> {
  const now = nowSeconds();
  const code = randomBytes(32).toString('base64url');
  await storeOAuthAuthorizationCode(code, { ...request, expiresAt: now + AUTHORIZATION_CODE_TTL_SECONDS }, AUTHORIZATION_CODE_TTL_SECONDS);
  return code;
}

export function authorizationRedirect(request: OAuthAuthorizationRequest, code: string): string {
  const target = new URL(request.redirectUri);
  target.searchParams.set('code', code);
  if (request.state) target.searchParams.set('state', request.state);
  target.searchParams.set('iss', oauthPublicBaseUrl());
  return target.toString();
}

function positiveInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), minimum), maximum) : fallback;
}

function issueToken(kind: 'access' | 'refresh', clientId: string, scope: string): string {
  const issuedAt = nowSeconds();
  const ttl = kind === 'access'
    ? positiveInt('DEVINT_OAUTH_ACCESS_TOKEN_TTL_SECONDS', ACCESS_TOKEN_TTL_SECONDS, 300, 86_400)
    : positiveInt('DEVINT_OAUTH_REFRESH_TOKEN_TTL_SECONDS', REFRESH_TOKEN_TTL_SECONDS, 3_600, 90 * 24 * 60 * 60);
  return signPayload(kind === 'access' ? 'dia' : 'dir', {
    v: 1,
    typ: kind,
    iat: issuedAt,
    exp: issuedAt + ttl,
    iss: oauthPublicBaseUrl(),
    aud: oauthResourceUrl(),
    sub: 'owner',
    scope,
    clientId,
  });
}

function tokenResponse(clientId: string, scope: string): Record<string, unknown> {
  return {
    access_token: issueToken('access', clientId, scope),
    token_type: 'Bearer',
    expires_in: positiveInt('DEVINT_OAUTH_ACCESS_TOKEN_TTL_SECONDS', ACCESS_TOKEN_TTL_SECONDS, 300, 86_400),
    refresh_token: issueToken('refresh', clientId, scope),
    scope,
  };
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return false;
  const actual = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(actual, challenge);
}

export async function exchangeOAuthToken(params: URLSearchParams): Promise<Record<string, unknown>> {
  const grantType = params.get('grant_type');
  const clientId = params.get('client_id') ?? '';
  if (!clientId) throw Object.assign(new Error('client_id is required'), { status: 400, oauthError: 'invalid_client' });
  resolveClient(clientId);
  if (grantType === 'authorization_code') {
    const code = params.get('code') ?? '';
    const record = await takeOAuthAuthorizationCode(code);
    if (!record) throw Object.assign(new Error('Authorization code is invalid or expired'), { status: 400, oauthError: 'invalid_grant' });
    if (record.expiresAt <= nowSeconds() || record.clientId !== clientId) throw Object.assign(new Error('Authorization code is invalid or expired'), { status: 400, oauthError: 'invalid_grant' });
    if ((params.get('redirect_uri') ?? '') !== record.redirectUri) throw Object.assign(new Error('redirect_uri does not match the authorization request'), { status: 400, oauthError: 'invalid_grant' });
    const verifier = params.get('code_verifier') ?? '';
    if (!pkceMatches(verifier, record.codeChallenge)) throw Object.assign(new Error('PKCE verification failed'), { status: 400, oauthError: 'invalid_grant' });
    return tokenResponse(clientId, record.scope);
  }
  if (grantType === 'refresh_token') {
    const refreshToken = params.get('refresh_token') ?? '';
    const payload = verifyPayload(refreshToken, 'dir');
    if (!payload || payload.typ !== 'refresh' || payload.clientId !== clientId || payload.iss !== oauthPublicBaseUrl() || payload.aud !== oauthResourceUrl() || !payload.scope) {
      throw Object.assign(new Error('Refresh token is invalid or expired'), { status: 400, oauthError: 'invalid_grant' });
    }
    return tokenResponse(clientId, payload.scope);
  }
  throw Object.assign(new Error('Unsupported grant_type'), { status: 400, oauthError: 'unsupported_grant_type' });
}

export function oauthAccessTokenValid(token: string): boolean {
  try {
    const payload = verifyPayload(token, 'dia');
    if (!payload || payload.typ !== 'access' || payload.iss !== oauthPublicBaseUrl() || payload.aud !== oauthResourceUrl() || payload.sub !== 'owner' || !payload.scope) return false;
    const granted = new Set(payload.scope.split(/\s+/u));
    return supportedScopes().every(scope => granted.has(scope));
  } catch {
    return false;
  }
}

export function oauthProtectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: oauthResourceUrl(),
    authorization_servers: [oauthPublicBaseUrl()],
    scopes_supported: supportedScopes(),
    bearer_methods_supported: ['header'],
    resource_name: 'Development Intelligence',
  };
}

export function oauthAuthorizationServerMetadata(): Record<string, unknown> {
  const base = oauthPublicBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...supportedScopes(), 'offline_access'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

export function oauthResourceMetadataUrl(): string {
  return `${oauthPublicBaseUrl()}/.well-known/oauth-protected-resource/mcp`;
}

export function oauthWwwAuthenticate(error?: 'invalid_token'): string {
  const parts = [`Bearer resource_metadata="${oauthResourceMetadataUrl()}"`, `scope="${supportedScopes().join(' ')}"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}

export function oauthConfigurationValid(): boolean {
  try {
    oauthPublicBaseUrl();
    signingSecret();
    allowedRedirectOrigins();
    if (oauthSharedAuthorizationStateRequired() && !oauthSharedAuthorizationStateConfigured()) return false;
    return Boolean(process.env.DEVINT_OWNER_PASSWORD?.trim());
  } catch {
    return false;
  }
}
