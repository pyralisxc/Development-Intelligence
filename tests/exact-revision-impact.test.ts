import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  changedFilesBetweenRevisions,
  exactFastForwardGitHubChangedFiles,
  parseExactGitDiffNameStatus,
} from '../src/source/git.js';
import { runChecked } from '../src/util/process.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('merge-base GitHub compare is eligible only for exact fast-forward ancestry', () => {
  const fastForward = {
    base_commit: { sha: A }, merge_base_commit: { sha: A },
    status: 'ahead',
    files: [
      { filename: 'src/new.ts', status: 'added' },
      { filename: 'migrations/002.sql', status: 'modified' },
      { filename: 'src/renamed.ts', previous_filename: 'src/old.ts', status: 'renamed' },
    ],
  };
  assert.deepEqual(exactFastForwardGitHubChangedFiles(A, fastForward), [
    { path: 'src/new.ts', status: 'A' },
    { path: 'migrations/002.sql', status: 'M' },
    { path: 'src/renamed.ts', previousPath: 'src/old.ts', status: 'R' },
  ]);
  assert.equal(exactFastForwardGitHubChangedFiles(A, {
    ...fastForward, merge_base_commit: { sha: C },
  }), null, 'diverged histories cannot supply direct tree differences');
  assert.equal(exactFastForwardGitHubChangedFiles(A, {
    ...fastForward, merge_base_commit: { sha: B }, files: [],
  }), null, 'an empty merge-base comparison cannot prove identical trees');
  assert.equal(exactFastForwardGitHubChangedFiles(A, {
    ...fastForward, status: 'behind',
  }), null, 'reversed ancestry requires a direct tree diff');
  assert.equal(exactFastForwardGitHubChangedFiles(A, {
    ...fastForward, base_commit: { sha: C },
  }), null, 'a claimed wrong base is not trusted');
  assert.equal(exactFastForwardGitHubChangedFiles(A, {
    ...fastForward, files: Array.from({ length: 300 }, (_, i) =>
      ({ filename: 'src/' + i + '.ts', status: 'modified' })),
  }), null, 'GitHub result cap cannot establish population completeness');
  assert.equal(exactFastForwardGitHubChangedFiles(A, {
    ...fastForward, files: [{ filename: 'src/unknown.ts', status: 'invented' }],
  }), null);
});

test('native NUL-delimited Git changes retain tabs, newlines, and rename paths', () => {
  const raw = 'M\0src/a\tb.ts\0A\0src/new\nfile.ts\0R100\0src/old.ts\0src/new.ts\0';
  assert.deepEqual(parseExactGitDiffNameStatus(raw), [
    { status: 'M', path: 'src/a\tb.ts' },
    { status: 'A', path: 'src/new\nfile.ts' },
    { status: 'R100', previousPath: 'src/old.ts', path: 'src/new.ts' },
  ]);
  assert.throws(() => parseExactGitDiffNameStatus('R100\0src/old.ts\0'), /target/u);
  assert.throws(() => parseExactGitDiffNameStatus('M\0src/file.ts'), /nonterminated/u);
  assert.throws(() => parseExactGitDiffNameStatus('F\0src/file.ts\0'), /unsupported/u);
});

async function git(root: string, args: string[]) {
  return (await runChecked('git', ['-C', root, ...args])).stdout.trim();
}
async function commit(root: string, message: string) {
  await git(root, ['add', '-A']);
  await git(root, ['-c', 'user.name=DI Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

test('independent histories with identical trees require zero impact; source and SQL changes remain visible', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'di-exact-tree-impact-'));
  const checkout = path.join(dir, 'source');
  const bare = path.join(dir, 'remote.git');
  const config = path.join(dir, 'projects.json');
  const prior = process.env.DEVINT_PROJECTS_FILE;
  try {
    await fs.mkdir(path.join(checkout, 'src'), { recursive: true });
    await git(checkout, ['init', '--initial-branch=main']);
    await fs.writeFile(path.join(checkout, 'src', 'same.ts'), 'export const value = 1;\n');
    const initial = await commit(checkout, 'initial');
    await git(checkout, ['switch', '-c', 'verified']);
    await fs.writeFile(path.join(checkout, 'src', 'added.ts'), 'export const added = 2;\n');
    const verified = await commit(checkout, 'verified source tree');
    const treeVerified = await git(checkout, ['rev-parse', verified + '^{tree}']);
    await git(checkout, ['switch', 'main']);
    await fs.writeFile(path.join(checkout, 'src', 'added.ts'), 'export const added = 2;\n');
    const mergedEquivalent = await commit(checkout, 'merge-like identical content from another history');
    assert.notEqual(verified, mergedEquivalent);
    assert.equal(treeVerified, await git(checkout, ['rev-parse', mergedEquivalent + '^{tree}']));

    await fs.writeFile(path.join(checkout, 'src', 'added.ts'), 'export const added = 3;\n');
    await fs.mkdir(path.join(checkout, 'migrations'));
    await fs.writeFile(path.join(checkout, 'migrations', '001.sql'),
      'create or replace function public.change() returns int language sql as $$ select 3 $$;\n');
    await git(checkout, ['mv', 'src/same.ts', 'src/renamed.ts']);
    const changed = await commit(checkout, 'actual code, migration and rename');

    await runChecked('git', ['init', '--bare', bare]);
    await git(checkout, ['remote', 'add', 'origin', pathToFileURL(bare).href]);
    await git(checkout, ['push', '--all', 'origin']);
    await fs.writeFile(config, JSON.stringify({
      TreeImpact: {
        repository: pathToFileURL(bare).href,
        defaultRef: 'refs/heads/main',
        allowedRefs: ['refs/heads/main'],
        revisionPolicy: 'repository-history',
        credential: { type: 'none' },
      },
    }));
    process.env.DEVINT_PROJECTS_FILE = config;

    const equal = await changedFilesBetweenRevisions('TreeImpact',
      'commit:' + verified, 'commit:' + mergedEquivalent);
    assert.deepEqual(equal.files, [], 'equivalent content must never trigger recheck by Git history alone');
    const forward = await changedFilesBetweenRevisions('TreeImpact',
      'commit:' + mergedEquivalent, 'commit:' + changed);
    assert.ok(forward.files.some(file => file.status === 'M' && file.path === 'src/added.ts'));
    assert.ok(forward.files.some(file => file.status === 'A' && file.path === 'migrations/001.sql'));
    assert.ok(forward.files.some(file => file.status.startsWith('R')
      && file.previousPath === 'src/same.ts' && file.path === 'src/renamed.ts'));
    const reverse = await changedFilesBetweenRevisions('TreeImpact',
      'commit:' + changed, 'commit:' + mergedEquivalent);
    assert.ok(reverse.files.some(file => file.status === 'D' && file.path === 'migrations/001.sql'));
    const genuine = await changedFilesBetweenRevisions('TreeImpact',
      'commit:' + initial, 'commit:' + changed);
    assert.ok(genuine.files.length >= 3);
  } finally {
    if (prior === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = prior;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
