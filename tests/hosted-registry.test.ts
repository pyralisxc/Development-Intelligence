import assert from 'node:assert/strict';
import test from 'node:test';
import { getProjectConfig, listAuthorizedGithubOwners, loadRegistry } from '../src/config/registry.js';
import { callTool } from '../src/mcp.js';
import { renderProjectChooser } from '../src/viewer.js';

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
  };
  process.env.DEVINT_PROJECTS_JSON = '{}';
  process.env.DEVINT_GITHUB_ALLOWED_OWNERS = 'pyralisxc, PyralisXC';
  delete process.env.DEVINT_GITHUB_TOKEN_ENV;
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
  }
});
