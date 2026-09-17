import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRegistry } from '../src/config/registry.js';

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
