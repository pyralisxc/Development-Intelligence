import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('Vercel skip check requires known history and proven absence of runtime changes', async () => {
  const conf = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const command = conf.ignoreCommand;
  assert.ok(command.length <= 256, 'Vercel schema rejects ignoreCommand longer than 256 chars');
  const nativeScript = await readFile(new URL('./vercel-ignore-command.sh', import.meta.url), 'utf8');
  assert.equal(typeof command, 'string');
  const dir = await mkdtemp(join(tmpdir(), 'di-vercel-ignore-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ': ' + result.stderr);
    return result.stdout.trim();
  };
  const sh = (previous, current) =>
    spawnSync('sh', ['-c', command], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env,
        VERCEL_GIT_PREVIOUS_SHA: previous, VERCEL_GIT_COMMIT_SHA: current },
    });
  try {
    git('init', '-q');
    git('config', 'user.name', 'DI Test');
    git('config', 'user.email', 'di-test@example.invalid');
    await mkdir(join(dir, 'src'));
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts', 'vercel-ignore-command.sh'), nativeScript);
    await writeFile(join(dir, 'src', 'http.ts'), 'export const version = 1;\n');
    await writeFile(join(dir, 'README.md'), 'documentation v1\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(dir, 'README.md'), 'documentation v2\n');
    git('add', '.'); git('commit', '-qm', 'docs only');
    const docs = git('rev-parse', 'HEAD');
    await writeFile(join(dir, 'src', 'http.ts'), 'export const version = 2;\n');
    git('add', '.'); git('commit', '-qm', 'runtime');
    const runtime = git('rev-parse', 'HEAD');
    await writeFile(join(dir, 'scripts', 'vercel-ignore-command.sh'), nativeScript + '\n# changed skip policy\n');
    git('add', 'scripts/vercel-ignore-command.sh'); git('commit', '-qm', 'skip-policy change');
    const policyChange = git('rev-parse', 'HEAD');

    // Vercel ignores a build only on exit 0. If the previous SHA is not in
    // its shallow checkout, prefer a build, never fatal "bad object".
    for (const [label, previous, current, expected] of [
      ['empty history', '', runtime, 1],
      ['missing prior object', 'f'.repeat(40), runtime, 1],
      ['docs-only changes', base, docs, 0],
      ['runtime changes', docs, runtime, 1],
      ['skip-policy changes', runtime, policyChange, 1],
      ['identical revisions', runtime, runtime, 1],
    ]) {
      const result = sh(previous, current);
      assert.equal(result.status, expected, label + ': ' + result.stderr);
      assert.doesNotMatch(result.stderr, /fatal: bad object/u, label);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
