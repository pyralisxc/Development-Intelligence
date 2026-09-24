import { setTimeout as delay } from 'node:timers/promises';
import { toolContract } from '../dist/src/mcp.js';
import { stableHash } from '../dist/src/util/hash.js';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const baseUrl = argument('base-url', process.env.DEVINT_PRODUCTION_URL);
const expectedSha = argument('expected-sha', process.env.DEVINT_EXPECTED_SHA)?.toLowerCase();
const retries = Number(argument('retries', '1'));
const retryDelayMs = Number(argument('retry-delay-ms', '10000'));
const accessToken = process.env.DEVINT_HOSTED_ACCESS_TOKEN;
const requireAuthenticatedTools = process.argv.includes('--require-authenticated-tools');

if (!baseUrl || !expectedSha || !/^[0-9a-f]{40}$/.test(expectedSha)) {
  throw new Error('Usage: node scripts/verify-hosted-production.mjs --base-url <https-url> --expected-sha <40-hex-sha> [--retries N] [--require-authenticated-tools]');
}
if (requireAuthenticatedTools && !accessToken) throw new Error('DEVINT_HOSTED_ACCESS_TOKEN is required for authenticated tool discovery');

const expectedContract = toolContract();
const origin = new URL(baseUrl).origin;

async function fetchJson(url, init) {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function verify() {
  const health = await fetchJson(`${origin}/health`);
  if (health?.deployment?.revision !== expectedSha) {
    throw new Error(`deployed revision ${health?.deployment?.revision ?? 'unavailable'} does not match ${expectedSha}`);
  }
  if (health?.mcp?.toolCount !== expectedContract.toolCount || health?.mcp?.contractFingerprint !== expectedContract.contractFingerprint) {
    throw new Error(`deployed MCP contract ${JSON.stringify(health?.mcp)} does not match ${JSON.stringify(expectedContract)}`);
  }

  if (accessToken) {
    const body = {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
    };
    const result = await fetchJson(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify(body),
    });
    const tools = result?.result?.tools;
    if (!Array.isArray(tools)) throw new Error('authenticated tools/list did not return a tool array');
    const discovered = { toolCount: tools.length, contractFingerprint: stableHash(tools) };
    if (JSON.stringify(discovered) !== JSON.stringify(expectedContract)) {
      throw new Error(`authenticated MCP contract ${JSON.stringify(discovered)} does not match ${JSON.stringify(expectedContract)}`);
    }
  }

  return { origin, revision: expectedSha, ...expectedContract, authenticatedToolDiscovery: Boolean(accessToken) };
}

let lastError;
for (let attempt = 1; attempt <= retries; attempt += 1) {
  try {
    console.log(JSON.stringify(await verify(), null, 2));
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < retries) {
      console.error(`Hosted verification attempt ${attempt}/${retries} failed: ${error.message}`);
      await delay(retryDelayMs);
    }
  }
}
throw lastError;
