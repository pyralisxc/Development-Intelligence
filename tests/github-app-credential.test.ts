import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { clearRepositoryCredentialCacheForTests, inspectGithubRepositoryPathAtDefaultBranch, inspectGithubRepositoryPathAtRevision, listGithubInstallationRepositories, resolveRepositoryCredential } from '../src/source/repositoryCredential.js';
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


test('GitHub App enumerates every readable repository for an authorized owner with one read-only installation token', async () => {
  const previous = {
    appId: process.env.DEVINT_GITHUB_APP_ID,
    appKey: process.env.DEVINT_GITHUB_APP_PRIVATE_KEY,
  };
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.DEVINT_GITHUB_APP_ID = '123456';
  process.env.DEVINT_GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  clearRepositoryCredentialCacheForTests();

  const requests: string[] = [];
  globalThis.fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/users/pyralisxc/installation')) {
      assert.match(String(init.headers?.authorization ?? ''), /^Bearer /u);
      return Response.json({ id: 42, account: { login: 'pyralisxc' } });
    }
    if (url.endsWith('/app/installations/42/access_tokens')) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.repositories, undefined, 'portfolio token should retain the installation repository scope');
      assert.deepEqual(body.permissions, { contents: 'read', pull_requests: 'read' });
      return Response.json({
        token: 'owner-read-token',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        permissions: { contents: 'read', metadata: 'read', pull_requests: 'read' },
      });
    }
    if (url.endsWith('/installation/repositories?per_page=100&page=1')) {
      assert.equal(String(init.headers?.authorization ?? ''), 'Bearer owner-read-token');
      return Response.json({
        total_count: 3,
        repositories: [
          { name: 'CardForge', full_name: 'pyralisxc/CardForge', default_branch: 'main', pushed_at: '2026-10-02T05:29:30Z', archived: false, disabled: false, private: false, fork: false, owner: { login: 'pyralisxc' } },
          { name: 'Development-Intelligence', full_name: 'pyralisxc/Development-Intelligence', default_branch: 'main', pushed_at: null, archived: false, disabled: false, private: false, fork: false, owner: { login: 'pyralisxc' } },
          { name: 'other-owner-repo', full_name: 'someone/other-owner-repo', default_branch: 'main', archived: false, disabled: false, private: false, fork: false, owner: { login: 'someone' } },
        ],
      });
    }
    if (url.endsWith('/repos/pyralisxc/CardForge/branches/main')) {
      assert.equal(String(init.headers?.authorization ?? ''), 'Bearer owner-read-token');
      return Response.json({ commit: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    }
    if (url.endsWith('/repos/pyralisxc/CardForge/contents/.development-intelligence?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) {
      assert.equal(String(init.headers?.authorization ?? ''), 'Bearer owner-read-token');
      return Response.json([
        { name: 'manifest.json', path: '.development-intelligence/manifest.json', type: 'file', size: 889, sha: 'manifest-sha' },
        { name: 'graph', path: '.development-intelligence/graph', type: 'dir', size: 0, sha: 'graph-sha' },
      ]);
    }
    if (url.endsWith('/repos/pyralisxc/CardForge/contents/.development-intelligence/graph?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) {
      assert.equal(String(init.headers?.authorization ?? ''), 'Bearer owner-read-token');
      return Response.json([
        { name: '0.ndjson', path: '.development-intelligence/graph/0.ndjson', type: 'file', size: 100, sha: 'shard-0' },
        { name: 'f.ndjson', path: '.development-intelligence/graph/f.ndjson', type: 'file', size: 120, sha: 'shard-f' },
      ]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const repositories = await listGithubInstallationRepositories('pyralisxc');
    assert.deepEqual(repositories.map(item => item.fullName), ['pyralisxc/CardForge', 'pyralisxc/Development-Intelligence']);
    const cached = await listGithubInstallationRepositories('pyralisxc');
    assert.deepEqual(cached.map(item => item.fullName), ['pyralisxc/CardForge', 'pyralisxc/Development-Intelligence']);
    const cardForge = repositories.find(item => item.fullName === 'pyralisxc/CardForge')!;
    assert.equal(cardForge.pushedAt, '2026-10-02T05:29:30.000Z');
    assert.equal(repositories.find(item => item.fullName === 'pyralisxc/Development-Intelligence')?.pushedAt, null);
    const inspected = await inspectGithubRepositoryPathAtDefaultBranch(cardForge, '.development-intelligence');
    assert.equal(inspected.revision, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual(inspected.entries.map(item => item.path), [
      '.development-intelligence/graph',
      '.development-intelligence/manifest.json',
    ]);
    const shards = await inspectGithubRepositoryPathAtRevision(cardForge, '.development-intelligence/graph', inspected.revision);
    assert.deepEqual(shards.entries.map(item => item.path), [
      '.development-intelligence/graph/0.ndjson',
      '.development-intelligence/graph/f.ndjson',
    ]);
    assert.equal(requests.filter(url => url.endsWith('/app/installations/42/access_tokens')).length, 1, 'owner installation token should be cached');
  } finally {
    globalThis.fetch = originalFetch;
    clearRepositoryCredentialCacheForTests();
    const restore = (key: string, value: string | undefined) => value === undefined ? delete process.env[key] : process.env[key] = value;
    restore('DEVINT_GITHUB_APP_ID', previous.appId);
    restore('DEVINT_GITHUB_APP_PRIVATE_KEY', previous.appKey);
  }
});
