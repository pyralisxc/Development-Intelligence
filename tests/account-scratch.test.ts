import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withProjectAccess, projectAccessScopeKey, type ProjectAccessBinding } from '../src/config/projectAccess.js';
import { resolveProjectRevision, withResolvedProjectCheckout, changedFilesBetweenRevisions } from '../src/source/git.js';
import { gitAuth } from '../src/source/gitAuth.js';
import { runChecked } from '../src/util/process.js';

function access(repository: string, credential: ProjectAccessBinding['config']['credential'] = { type: 'none' }): ProjectAccessBinding {
  return { accountId: 'fixture-account', bindingId: 'fixture-binding', bindingVersion: 1, authorityId: 'fixture-authority', internalProject: 'Example', canonical: null, secretValues: {},
    config: { repository, defaultRef: 'refs/heads/main', allowedRefs: ['refs/heads/main'], revisionPolicy: 'repository-history', credential } };
}

test('missing credentials clean checkout/diff allocation without contacting a remote source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-account-scratch-failure-'));
  const previous = process.env.DEVINT_SCRATCH_DIR; process.env.DEVINT_SCRATCH_DIR = root;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Remote access must not occur'); }) as typeof fetch;
  const binding = access('https://github.com/fixture/project.git', { type: 'token-env', tokenEnv: 'MISSING_SCOPED_TOKEN' });
  try {
    await withProjectAccess(binding, async () => true, async () => {
      const revision = { project: 'Example', repository: binding.config.repository, ref: 'commit:' + 'a'.repeat(40), selectorKind: 'commit' as const, resolvedRef: 'a'.repeat(40), sha: 'a'.repeat(40) };
      await assert.rejects(() => withResolvedProjectCheckout(revision, async () => assert.fail('No checkout callback expected')), /Missing configured repository credential/);
      assert.deepEqual(await fs.readdir(root), []);
      await assert.rejects(() => changedFilesBetweenRevisions('Example', 'commit:' + 'a'.repeat(40), 'commit:' + 'b'.repeat(40)), /Missing configured repository credential/);
      assert.deepEqual(await fs.readdir(root), []);
    });
  } finally { globalThis.fetch = originalFetch; if (previous === undefined) delete process.env.DEVINT_SCRATCH_DIR; else process.env.DEVINT_SCRATCH_DIR = previous; await fs.rm(root, { recursive: true, force: true }); }
});

test('concurrent same-binding Git checkouts own distinct roots and leave no scratch behind', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-account-scratch-concurrent-'));
  const source = path.join(root, 'source'), scratch = path.join(root, 'scratch'); await fs.mkdir(scratch);
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await fs.writeFile(path.join(source, 'value.txt'), 'disposable fixture\n');
  await runChecked('git', ['-C', source, 'add', '.']);
  await runChecked('git', ['-C', source, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const binding = access(pathToFileURL(source).href);
  const previous = process.env.DEVINT_SCRATCH_DIR; process.env.DEVINT_SCRATCH_DIR = scratch;
  try {
    await runChecked('git', ['ls-remote', binding.config.repository, 'refs/heads/main']);
    const roots = await Promise.all(Array.from({ length: 6 }, async () => await withProjectAccess(binding, async () => true, async () => {
      const revision = await resolveProjectRevision('Example');
      return await withResolvedProjectCheckout(revision, async checkout => {
        assert.ok(checkout.root.includes(`binding-${projectAccessScopeKey()}-checkout-`));
        assert.equal(await fs.readFile(path.join(checkout.root, 'value.txt'), 'utf8'), 'disposable fixture\n');
        await Promise.resolve(); return checkout.root;
      });
    })));
    assert.equal(new Set(roots).size, 6); assert.deepEqual(await fs.readdir(scratch), []);
  } finally { if (previous === undefined) delete process.env.DEVINT_SCRATCH_DIR; else process.env.DEVINT_SCRATCH_DIR = previous; await fs.rm(root, { recursive: true, force: true }); }
});

test('askpass write failure removes its owned directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-account-askpass-failure-'));
  const previous = process.env.DEVINT_SCRATCH_DIR; process.env.DEVINT_SCRATCH_DIR = root;
  const originalWrite = fs.writeFile;
  const binding = access('https://github.com/fixture/project.git', { type: 'token-env', tokenEnv: 'FAKE_TOKEN' });
  binding.secretValues = { FAKE_TOKEN: 'DISPOSABLE-FAKE-TOKEN' };
  fs.writeFile = async (...args: any[]) => { if (String(args[0]).endsWith('askpass.sh')) throw new Error('Disposable fixture write refusal'); return await originalWrite(...args); };
  try {
    await withProjectAccess(binding, async () => true, async () => {
      await assert.rejects(() => gitAuth(binding.config), /fixture write refusal/);
      assert.deepEqual(await fs.readdir(root), []);
    });
  } finally { fs.writeFile = originalWrite; if (previous === undefined) delete process.env.DEVINT_SCRATCH_DIR; else process.env.DEVINT_SCRATCH_DIR = previous; await fs.rm(root, { recursive: true, force: true }); }
});
