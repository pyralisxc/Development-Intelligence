import assert from 'node:assert/strict';
import test from 'node:test';
import { oauthConfigurationValid } from '../src/oauth.js';
import { resetOAuthCodeStoreForTests } from '../src/oauthCodeStore.js';

test('Vercel OAuth configuration fails closed without shared authorization-code state', () => {
  const previous = {
    vercel: process.env.VERCEL,
    mode: process.env.DEVINT_AUTH_MODE,
    owner: process.env.DEVINT_OWNER_PASSWORD,
    session: process.env.DEVINT_SESSION_SECRET,
    publicBase: process.env.DEVINT_PUBLIC_BASE_URL,
    upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
    upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    kvUrl: process.env.KV_REST_API_URL,
    kvToken: process.env.KV_REST_API_TOKEN,
  };
  process.env.VERCEL = '1';
  process.env.DEVINT_AUTH_MODE = 'oauth';
  process.env.DEVINT_OWNER_PASSWORD = 'owner-test-password';
  process.env.DEVINT_SESSION_SECRET = 'vercel-test-secret-long-enough';
  process.env.DEVINT_PUBLIC_BASE_URL = 'https://development-intelligence.example.com';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  resetOAuthCodeStoreForTests();
  try {
    assert.equal(oauthConfigurationValid(), false);
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('VERCEL', previous.vercel);
    restore('DEVINT_AUTH_MODE', previous.mode);
    restore('DEVINT_OWNER_PASSWORD', previous.owner);
    restore('DEVINT_SESSION_SECRET', previous.session);
    restore('DEVINT_PUBLIC_BASE_URL', previous.publicBase);
    restore('UPSTASH_REDIS_REST_URL', previous.upstashUrl);
    restore('UPSTASH_REDIS_REST_TOKEN', previous.upstashToken);
    restore('KV_REST_API_URL', previous.kvUrl);
    restore('KV_REST_API_TOKEN', previous.kvToken);
    resetOAuthCodeStoreForTests();
  }
});
