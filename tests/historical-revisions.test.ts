import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { diffRevisions } from '../src/intelligence/query.js';
import { callTool } from '../src/mcp.js';
import { parseRevisionSelector, resolveProjectRevision, revisionIdentity } from '../src/source/git.js';
import { runChecked } from '../src/util/process.js';

async function makeHistoricalFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-history-test-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  await fs.mkdir(source, { recursive: true });
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await runChecked('git', ['-C', source, 'config', 'user.name', 'Development Intelligence Test']);
  await runChecked('git', ['-C', source, 'config', 'user.email', 'devint@example.invalid']);
  await fs.writeFile(path.join(source, 'history.txt'), 'first\n');
  await runChecked('git', ['-C', source, 'add', 'history.txt']);
  await runChecked('git', ['-C', source, 'commit', '-m', 'first']);
  const first = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  await runChecked('git', ['-C', source, 'tag', 'v1']);
  await fs.writeFile(path.join(source, 'history.txt'), 'second\n');
  await runChecked('git', ['-C', source, 'commit', '-am', 'second']);
  const second = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  await runChecked('git', ['init', '--bare', remote]);
  await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await runChecked('git', ['-C', source, 'push', '--all', 'origin']);
  await runChecked('git', ['-C', source, 'push', '--tags', 'origin']);
  await fs.writeFile(config, JSON.stringify({
    History: {
      repository: pathToFileURL(remote).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      revisionPolicy: 'repository-history',
      credential: { type: 'none' },
    },
  }));
  return { root, config, first, second };
}

test('repository-history projects resolve typed immutable commit, branch, and tag selectors', async () => {
  const fixture = await makeHistoricalFixture();
  const previous = process.env.DEVINT_PROJECTS_FILE;
  process.env.DEVINT_PROJECTS_FILE = fixture.config;
  try {
    const commit = await resolveProjectRevision('History', `commit:${fixture.first}`);
    assert.equal(commit.sha, fixture.first);
    assert.deepEqual(revisionIdentity(commit), {
      selector: `commit:${fixture.first}`,
      kind: 'commit',
      resolvedRef: fixture.first,
      sha: fixture.first,
    });

    const branch = await resolveProjectRevision('History', 'branch:main');
    assert.equal(branch.sha, fixture.second);
    assert.equal(branch.resolvedRef, 'refs/heads/main');

    const tag = await resolveProjectRevision('History', 'tag:v1');
    assert.equal(tag.sha, fixture.first);
    assert.equal(tag.resolvedRef, 'refs/tags/v1');

    const resolved = await callTool('resolve_revision', { project: 'History', ref: 'tag:v1' }) as any;
    assert.equal(resolved.identity.sha, fixture.first);
    assert.equal(resolved.identity.kind, 'tag');

    const comparison = await diffRevisions({
      project: 'History',
      baseRef: `commit:${fixture.first}`,
      ref: 'branch:main',
    }) as any;
    assert.equal(comparison.comparisonMode, 'current-analyzer-replay');
    assert.equal(comparison.base.identity.sha, fixture.first);
    assert.equal(comparison.base.identity.kind, 'commit');
    assert.equal(comparison.head.identity.sha, fixture.second);
    assert.equal(comparison.head.identity.kind, 'branch');
    assert.equal(comparison.base.analyzerVersion, comparison.head.analyzerVersion);

    await assert.rejects(resolveProjectRevision('History', 'refs/heads/other'), /not allowed/u);
    assert.throws(() => parseRevisionSelector('branch:feature..escape'), /Invalid branch/u);
    assert.throws(() => parseRevisionSelector('branch:feature/.hidden'), /Invalid branch/u);
    assert.throws(() => parseRevisionSelector('branch:-option'), /Invalid branch/u);
    assert.throws(() => parseRevisionSelector('tag:release.LOCK'), /Invalid tag/u);
    assert.throws(() => parseRevisionSelector(`branch:feature${String.fromCharCode(127)}name`), /Invalid branch/u);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = previous;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('GitHub pull-request selectors preserve proposal, base, and accepted-result identity', async () => {
  const previous = {
    registry: process.env.DEVINT_PROJECTS_JSON,
    owners: process.env.DEVINT_GITHUB_ALLOWED_OWNERS,
    token: process.env.DEVINT_GITHUB_TOKEN,
  };
  const originalFetch = globalThis.fetch;
  process.env.DEVINT_PROJECTS_JSON = '{}';
  process.env.DEVINT_GITHUB_ALLOWED_OWNERS = 'pyralisxc';
  process.env.DEVINT_GITHUB_TOKEN = 'test-token';
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const mergeSha = 'c'.repeat(40);
  globalThis.fetch = async (input: any, init?: any) => {
    assert.match(String(input), /api\.github\.com\/repos\/pyralisxc\/CardForge\/pulls\/(75|243)$/u);
    assert.equal(init?.headers?.authorization, 'Bearer test-token');
    const merged = String(input).endsWith('/75');
    return new Response(JSON.stringify({
      state: 'closed',
      merged_at: merged ? '2026-07-21T00:32:27Z' : null,
      base: { sha: baseSha },
      head: { sha: headSha },
      merge_commit_sha: merged ? mergeSha : null,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const head = await resolveProjectRevision('pyralisxc/CardForge', 'pr:243/head');
    assert.equal(head.sha, headSha);
    assert.equal(head.selectorKind, 'pr-head');
    assert.equal(head.pullRequest?.merged, false);

    const base = await resolveProjectRevision('pyralisxc/CardForge', 'pr:243/base');
    assert.equal(base.sha, baseSha);

    const result = await resolveProjectRevision('pyralisxc/CardForge', 'pr:75/result');
    assert.equal(result.sha, mergeSha);
    assert.equal(result.pullRequest?.merged, true);

    await assert.rejects(resolveProjectRevision('pyralisxc/CardForge', 'pr:243/result'), /has no accepted result/u);
  } finally {
    globalThis.fetch = originalFetch;
    const restore = (key: string, value: string | undefined) => value === undefined ? delete process.env[key] : process.env[key] = value;
    restore('DEVINT_PROJECTS_JSON', previous.registry);
    restore('DEVINT_GITHUB_ALLOWED_OWNERS', previous.owners);
    restore('DEVINT_GITHUB_TOKEN', previous.token);
  }
});
