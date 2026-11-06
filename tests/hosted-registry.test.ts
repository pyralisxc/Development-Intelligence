import assert from 'node:assert/strict';
import test from 'node:test';
import { getProjectConfig, listAuthorizedGithubOwners, loadRegistry } from '../src/config/registry.js';
import { callTool } from '../src/mcp.js';
import { renderProjectChooser } from '../src/viewer.js';
import { canonicalProjectStorageKey } from '../src/intelligence/canonicalStore.js';
import { resolveProjectRevision } from '../src/source/git.js';

test('hosted deployments may supply the operational project registry through DEVINT_PROJECTS_JSON', async () => {
  const previous = process.env.DEVINT_PROJECTS_JSON;
  process.env.DEVINT_PROJECTS_JSON = JSON.stringify({
    Example: {
      repository: 'https://github.com/example/project.git',
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      credential: { type: 'none' },
    },
  });
  try {
    const registry = await loadRegistry();
    assert.equal(registry.Example?.repository, 'https://github.com/example/project.git');
    assert.deepEqual(registry.Example?.allowedRefs, ['refs/heads/main']);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_PROJECTS_JSON;
    else process.env.DEVINT_PROJECTS_JSON = previous;
  }
});

test('authorized GitHub owners provide read-only dynamic repository projects without semantic project configuration', async () => {
  const previous = {
    registry: process.env.DEVINT_PROJECTS_JSON,
    owners: process.env.DEVINT_GITHUB_ALLOWED_OWNERS,
    tokenEnv: process.env.DEVINT_GITHUB_TOKEN_ENV,
    appId: process.env.DEVINT_GITHUB_APP_ID,
    appKey: process.env.DEVINT_GITHUB_APP_PRIVATE_KEY,
  };
  process.env.DEVINT_PROJECTS_JSON = '{}';
  process.env.DEVINT_GITHUB_ALLOWED_OWNERS = 'pyralisxc, PyralisXC';
  delete process.env.DEVINT_GITHUB_TOKEN_ENV;
  delete process.env.DEVINT_GITHUB_APP_ID;
  delete process.env.DEVINT_GITHUB_APP_PRIVATE_KEY;
  try {
    assert.deepEqual(listAuthorizedGithubOwners(), ['pyralisxc']);
    const config = await getProjectConfig('pyralisxc/CardForge');
    assert.equal(config.repository, 'https://github.com/pyralisxc/CardForge.git');
    assert.equal(config.defaultRef, 'HEAD');
    assert.deepEqual(config.allowedRefs, ['HEAD']);
    assert.equal(config.revisionPolicy, 'repository-history');
    assert.deepEqual(config.credential, { type: 'token-env', tokenEnv: 'DEVINT_GITHUB_TOKEN', username: 'x-access-token' });
    const listed = await callTool('list_projects') as any;
    assert.deepEqual(listed.githubOwnerNamespaces, [{
      owner: 'pyralisxc',
      projectPattern: 'pyralisxc/<repository>',
      defaultRef: 'HEAD',
      revisionPolicy: 'repository-history',
      selectors: ['commit:<full-sha>', 'branch:<name>', 'tag:<name>', 'pr:<number>/head', 'pr:<number>/base', 'pr:<number>/result'],
      access: 'read-only',
    }]);
    const chooser = renderProjectChooser([], listAuthorizedGithubOwners());
    assert.match(chooser, /Open a GitHub repository/u);
    assert.match(chooser, /pyralisxc\/repository/u);
    await assert.rejects(getProjectConfig('someone-else/CardForge'), /Unknown project/u);
    await assert.rejects(getProjectConfig('pyralisxc/CardForge.git'), /Unknown project/u);
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('DEVINT_PROJECTS_JSON', previous.registry);
    restore('DEVINT_GITHUB_ALLOWED_OWNERS', previous.owners);
    restore('DEVINT_GITHUB_TOKEN_ENV', previous.tokenEnv);
    restore('DEVINT_GITHUB_APP_ID', previous.appId);
    restore('DEVINT_GITHUB_APP_PRIVATE_KEY', previous.appKey);
  }
});


test('Preview-only canonical project identity isolates derived storage without broadening GitHub access', async () => {
  const variables = ['DEVINT_PROJECTS_JSON', 'DEVINT_GITHUB_ALLOWED_OWNERS', 'DEVINT_GITHUB_APP_ID',
    'DEVINT_GITHUB_APP_PRIVATE_KEY', 'VERCEL_ENV', 'VERCEL_TARGET_ENV'] as const;
  const prior = Object.fromEntries(variables.map(key => [key, process.env[key]]));
  const alias = 'pyralisxc/Development-Intelligence@preview';
  try {
    process.env.DEVINT_PROJECTS_JSON = '{}';
    process.env.DEVINT_GITHUB_ALLOWED_OWNERS = 'pyralisxc';
    delete process.env.DEVINT_GITHUB_APP_ID;
    delete process.env.DEVINT_GITHUB_APP_PRIVATE_KEY;
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_TARGET_ENV = 'preview';
    const config = await getProjectConfig(alias);
    assert.equal(config.repository, 'https://github.com/pyralisxc/Development-Intelligence.git');
    assert.equal(config.defaultRef, 'refs/heads/preview');
    assert.deepEqual(config.allowedRefs, ['refs/heads/preview']);
    assert.equal(config.revisionPolicy, 'allowlisted');
    assert.notEqual(canonicalProjectStorageKey(alias), canonicalProjectStorageKey('pyralisxc/Development-Intelligence'));
    assert.notEqual(canonicalProjectStorageKey(alias), canonicalProjectStorageKey('Development-Intelligence'));
    await assert.rejects(resolveProjectRevision(alias, 'commit:' + 'a'.repeat(40)), /not allowed/u);
    await assert.rejects(getProjectConfig('someone-else/Development-Intelligence@preview'), /Unknown project/u);
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'production';
    await assert.rejects(getProjectConfig(alias), /Unknown project/u);
  } finally {
    for (const key of variables) {
      const value = prior[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
