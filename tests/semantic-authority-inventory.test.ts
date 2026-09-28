import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { inventorySemanticAuthority } from '../src/intelligence/semanticAuthorityInventory.js';
import { clearRepositoryCredentialCacheForTests } from '../src/source/repositoryCredential.js';

test('semantic authority inventory is installation-scoped, revision-bound, coverage-qualified, and never authorizes deletion', async () => {
  const previous = {
    appId: process.env.DEVINT_GITHUB_APP_ID,
    appKey: process.env.DEVINT_GITHUB_APP_PRIVATE_KEY,
    owners: process.env.DEVINT_GITHUB_ALLOWED_OWNERS,
  };
  const originalFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.DEVINT_GITHUB_APP_ID = '123456';
  process.env.DEVINT_GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.DEVINT_GITHUB_ALLOWED_OWNERS = 'pyralisxc';
  clearRepositoryCredentialCacheForTests();

  const sha = (digit: string) => digit.repeat(40);
  globalThis.fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.endsWith('/users/pyralisxc/installation')) {
      return Response.json({ id: 42, account: { login: 'pyralisxc' } });
    }
    if (url.endsWith('/app/installations/42/access_tokens')) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.repositories, undefined);
      assert.deepEqual(body.permissions, { contents: 'read', pull_requests: 'read' });
      return Response.json({
        token: 'owner-read-token',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        permissions: { contents: 'read', metadata: 'read', pull_requests: 'read' },
      });
    }
    if (url.endsWith('/installation/repositories?per_page=100&page=1')) {
      return Response.json({
        total_count: 5,
        repositories: [
          { name: 'CardForge', full_name: 'pyralisxc/CardForge', default_branch: 'main', archived: false, disabled: false, private: false, fork: false, owner: { login: 'pyralisxc' } },
          { name: 'Construction', full_name: 'pyralisxc/Construction', default_branch: 'main', archived: false, disabled: false, private: true, fork: false, owner: { login: 'pyralisxc' } },
          { name: 'Development-Intelligence', full_name: 'pyralisxc/Development-Intelligence', default_branch: 'main', archived: false, disabled: false, private: false, fork: false, owner: { login: 'pyralisxc' } },
          { name: 'CleanRepo', full_name: 'pyralisxc/CleanRepo', default_branch: 'main', archived: false, disabled: false, private: false, fork: false, owner: { login: 'pyralisxc' } },
          { name: 'TruncatedRepo', full_name: 'pyralisxc/TruncatedRepo', default_branch: 'main', archived: false, disabled: false, private: false, fork: false, owner: { login: 'pyralisxc' } },
        ],
      });
    }

    const commit = url.match(/\/repos\/pyralisxc\/([^/]+)\/commits\/main$/u);
    if (commit) {
      const digitByRepo: Record<string, string> = {
        CardForge: '1',
        Construction: '2',
        'Development-Intelligence': '3',
        CleanRepo: '4',
        TruncatedRepo: '5',
      };
      const digit = digitByRepo[decodeURIComponent(commit[1]!)]!;
      return Response.json({ sha: sha(digit), commit: { tree: { sha: sha(String((Number(digit) + 4) % 10)) } } });
    }

    const tree = url.match(/\/repos\/pyralisxc\/([^/]+)\/git\/trees\/[0-9a-f]{40}\?recursive=1$/u);
    if (tree) {
      const name = decodeURIComponent(tree[1]!);
      if (name === 'CardForge') return Response.json({
        truncated: false,
        tree: [
          { path: '.development-intelligence/manifest.json', type: 'blob', size: 200 },
          { path: '.development-intelligence/graph/a.ndjson', type: 'blob', size: 500 },
          { path: 'src/index.ts', type: 'blob', size: 100 },
        ],
      });
      if (name === 'Construction') return Response.json({
        truncated: false,
        tree: [
          { path: 'semantic-meanings/accepted.json', type: 'blob', size: 300 },
          { path: 'docs/architecture.md', type: 'blob', size: 100 },
        ],
      });
      if (name === 'Development-Intelligence') return Response.json({
        truncated: false,
        tree: [{ path: '.development-intelligence/manifest.json', type: 'blob', size: 200 }],
      });
      if (name === 'CleanRepo') return Response.json({
        truncated: false,
        tree: [
          { path: 'docs/semantics.md', type: 'blob', size: 100 },
          { path: 'src/main.ts', type: 'blob', size: 100 },
        ],
      });
      if (name === 'TruncatedRepo') return Response.json({
        truncated: true,
        tree: [{ path: 'src/main.ts', type: 'blob', size: 100 }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await inventorySemanticAuthority({ owners: ['pyralisxc'], limit: 10 }) as any;
    assert.equal(result.discoveredRepositories, 5);
    assert.equal(result.selectedRepositories, 5);
    assert.equal(result.processedRepositories, 5);
    assert.equal(result.complete, false, 'a truncated provider tree must prevent portfolio-complete absence proof');
    assert.equal(result.migrationRequired, 2);
    assert.equal(result.policy.deletionAuthorized, false);
    assert.equal(result.policy.absenceRequiresCompleteTree, true);

    const byProject = new Map(result.items.map((item: any) => [item.project, item]));
    assert.equal(byProject.get('pyralisxc/CardForge')?.status, 'repository-authority');
    assert.deepEqual(byProject.get('pyralisxc/CardForge')?.repositoryAuthorityPaths, [
      '.development-intelligence/graph/a.ndjson',
      '.development-intelligence/manifest.json',
    ]);
    assert.equal(byProject.get('pyralisxc/CardForge')?.revision, sha('1'));
    assert.equal(byProject.get('pyralisxc/CardForge')?.migrationRequired, true);

    assert.equal(byProject.get('pyralisxc/Construction')?.status, 'legacy-candidate');
    assert.deepEqual(byProject.get('pyralisxc/Construction')?.legacyCandidatePaths, ['semantic-meanings/accepted.json']);
    assert.equal(byProject.get('pyralisxc/Construction')?.migrationRequired, true);

    assert.equal(byProject.get('pyralisxc/Development-Intelligence')?.status, 'di-self-metadata');
    assert.equal(byProject.get('pyralisxc/Development-Intelligence')?.migrationRequired, false);

    assert.equal(byProject.get('pyralisxc/CleanRepo')?.status, 'clean');
    assert.equal(byProject.get('pyralisxc/CleanRepo')?.coverageComplete, true);
    assert.deepEqual(byProject.get('pyralisxc/CleanRepo')?.legacyCandidatePaths, [], 'ordinary semantics documentation is not machine authority by name alone');

    assert.equal(byProject.get('pyralisxc/TruncatedRepo')?.status, 'incomplete');
    assert.equal(byProject.get('pyralisxc/TruncatedRepo')?.coverageComplete, false);
    assert.equal(byProject.get('pyralisxc/TruncatedRepo')?.deletionAuthorized, false);
  } finally {
    globalThis.fetch = originalFetch;
    clearRepositoryCredentialCacheForTests();
    const restore = (key: string, value: string | undefined) => value === undefined ? delete process.env[key] : process.env[key] = value;
    restore('DEVINT_GITHUB_APP_ID', previous.appId);
    restore('DEVINT_GITHUB_APP_PRIVATE_KEY', previous.appKey);
    restore('DEVINT_GITHUB_ALLOWED_OWNERS', previous.owners);
  }
});
