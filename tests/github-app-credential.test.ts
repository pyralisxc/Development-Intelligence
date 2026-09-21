import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { clearRepositoryCredentialCacheForTests, resolveRepositoryCredential } from '../src/source/repositoryCredential.js';
import type { ProjectConfig } from '../src/types.js';

test('dedicated GitHub App mints single-repository read-only installation credentials', async () => {
  const previous = {
    appId: process.env.DEVINT_GITHUB_APP_ID,
    appKey: process.env.DEVINT_GITHUB_APP_PRIVATE_KEY,
  };
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.DEVINT_GITHUB_APP_ID = '123456';
  process.env.DEVINT_GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  clearRepositoryCredentialCacheForTests();

  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/repos/pyralisxc/pys-authoring/installation')) {
      assert.match(String(init.headers?.authorization ?? ''), /^Bearer /u);
      return Response.json({ id: 42, account: { login: 'pyralisxc' } });
    }
    if (url.endsWith('/app/installations/42/access_tokens')) {
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body.repositories, ['pys-authoring']);
      assert.deepEqual(body.permissions, { contents: 'read', pull_requests: 'read' });
      return Response.json({
        token: 'installation-read-token',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        permissions: { contents: 'read', metadata: 'read', pull_requests: 'read' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const config: ProjectConfig = {
    repository: 'https://github.com/pyralisxc/pys-authoring.git',
    defaultRef: 'HEAD',
    revisionPolicy: 'repository-history',
    credential: {
      type: 'github-app-env',
      appIdEnv: 'DEVINT_GITHUB_APP_ID',
      privateKeyEnv: 'DEVINT_GITHUB_APP_PRIVATE_KEY',
      username: 'x-access-token',
    },
  };

  try {
    const credential = await resolveRepositoryCredential(config);
    assert.equal(credential?.kind, 'github-app-installation');
    assert.equal(credential?.token, 'installation-read-token');
    assert.equal(credential?.username, 'x-access-token');

    const cached = await resolveRepositoryCredential(config);
    assert.equal(cached?.token, 'installation-read-token');
    assert.equal(requests.length, 2, 'valid installation token should be cached');
  } finally {
    globalThis.fetch = originalFetch;
    clearRepositoryCredentialCacheForTests();
    const restore = (key: string, value: string | undefined) => value === undefined ? delete process.env[key] : process.env[key] = value;
    restore('DEVINT_GITHUB_APP_ID', previous.appId);
    restore('DEVINT_GITHUB_APP_PRIVATE_KEY', previous.appKey);
  }
});

test('GitHub App credential fails closed on non-read installation permissions', async () => {
  const previous = {
    appId: process.env.DEVINT_GITHUB_APP_ID,
    appKey: process.env.DEVINT_GITHUB_APP_PRIVATE_KEY,
  };
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.DEVINT_GITHUB_APP_ID = '123456';
  process.env.DEVINT_GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  clearRepositoryCredentialCacheForTests();

  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url.endsWith('/repos/pyralisxc/pys-authoring/installation')) {
      return Response.json({ id: 42, account: { login: 'pyralisxc' } });
    }
    if (url.endsWith('/app/installations/42/access_tokens')) {
      return Response.json({
        token: 'unexpected-write-token',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        permissions: { contents: 'write', metadata: 'read' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const config: ProjectConfig = {
    repository: 'https://github.com/pyralisxc/pys-authoring.git',
    defaultRef: 'HEAD',
    credential: {
      type: 'github-app-env',
      appIdEnv: 'DEVINT_GITHUB_APP_ID',
      privateKeyEnv: 'DEVINT_GITHUB_APP_PRIVATE_KEY',
    },
  };

  try {
    await assert.rejects(resolveRepositoryCredential(config), /non-read permission/u);
  } finally {
    globalThis.fetch = originalFetch;
    clearRepositoryCredentialCacheForTests();
    const restore = (key: string, value: string | undefined) => value === undefined ? delete process.env[key] : process.env[key] = value;
    restore('DEVINT_GITHUB_APP_ID', previous.appId);
    restore('DEVINT_GITHUB_APP_PRIVATE_KEY', previous.appKey);
  }
});
