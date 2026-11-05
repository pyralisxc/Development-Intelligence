import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { graphContext } from '../src/intelligence/service.js';
import { verifyTransition } from '../src/intelligence/temporalVerification.js';
import { analyzeImpact } from '../src/intelligence/query.js';
import { runChecked } from '../src/util/process.js';

async function fixture(unmappedOnly = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-transition-test-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await runChecked('git', ['-C', source, 'config', 'user.name', 'Development Intelligence Test']);
  await runChecked('git', ['-C', source, 'config', 'user.email', 'devint@example.invalid']);
  await fs.writeFile(path.join(source, 'src', 'work.ts'), 'export function keep() { return 1; }\nexport function legacy() { return 1; }\n');
  await runChecked('git', ['-C', source, 'add', '.']);
  await runChecked('git', ['-C', source, 'commit', '-m', 'base']);
  const base = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  if (unmappedOnly) {
    await fs.writeFile(path.join(source, 'notes.txt'), 'unmapped change\n');
    await runChecked('git', ['-C', source, 'add', 'notes.txt']);
  } else {
    await fs.writeFile(path.join(source, 'src', 'work.ts'), 'export function keep() { return 2; }\nexport function added() { return keep(); }\n');
  }
  await runChecked('git', ['-C', source, 'commit', '-am', 'head']);
  const head = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  await runChecked('git', ['init', '--bare', remote]);
  await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await runChecked('git', ['-C', source, 'push', '--all', 'origin']);
  await fs.writeFile(config, JSON.stringify({
    Transition: {
      repository: pathToFileURL(remote).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      revisionPolicy: 'repository-history',
      credential: { type: 'none' },
    },
  }));
  return { root, config, base, head };
}

test('bounded impact distinguishes skipped traversal and propagates incomplete paths to transition review', async () => {
  const item = await fixture();
  const previous = process.env.DEVINT_PROJECTS_FILE;
  process.env.DEVINT_PROJECTS_FILE = item.config;
  try {
    const input = { project: 'Transition', baseRef: `commit:${item.base}`, ref: `commit:${item.head}`, limit: 1 };
    const impact = await analyzeImpact(input) as any;
    assert.equal(impact.afterImpact.seedTruncated, true);
    assert.equal(impact.afterImpact.edgeTotal, 0);
    assert.equal(impact.afterImpact.traversalStatus, 'not-performed');
    assert.equal(impact.afterImpact.traversalReason, 'seed-limit');
    const result = await verifyTransition(input) as any;
    assert.equal(result.impact.after.traversalStatus, 'not-performed');
    assert.equal(result.reviewSurface.affectedPathsComplete, false);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = previous;
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('zero-depth and fully traversed empty neighborhoods are distinguished', async () => {
  const item = await fixture();
  const previous = process.env.DEVINT_PROJECTS_FILE;
  process.env.DEVINT_PROJECTS_FILE = item.config;
  try {
    const input = { project: 'Transition', baseRef: `commit:${item.base}`, ref: `commit:${item.head}`, limit: 50 };
    const empty = await analyzeImpact({ ...input, relationshipKinds: ['not-a-relationship'] }) as any;
    assert.equal(empty.afterImpact.edgeTotal, 0);
    assert.equal(empty.afterImpact.traversalStatus, 'complete');
    const complete = await verifyTransition({ ...input, relationshipKinds: ['not-a-relationship'] }) as any;
    assert.equal(complete.reviewSurface.affectedPathsComplete, null);
    assert.equal(complete.reviewSurface.truncated, false);
    const unchanged = await verifyTransition({ ...input, baseRef: input.ref, depth: 0 }) as any;
    assert.equal(unchanged.impact.after.seedTotal, 0);
    assert.equal(unchanged.reviewSurface.affectedPathsComplete, null);
    assert.equal(unchanged.reviewSurface.truncated, false);
    const zero = await analyzeImpact({ ...input, depth: 0 }) as any;
    assert.equal(zero.afterImpact.traversalStatus, 'not-performed');
    assert.equal(zero.afterImpact.traversalReason, 'zero-depth');
    const transition = await verifyTransition({ ...input, depth: 0 }) as any;
    assert.equal(transition.reviewSurface.affectedPathsComplete, false);
    assert.equal(transition.reviewSurface.truncated, true);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = previous;
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('wholly unmapped changes disclose incomplete affected paths', async () => {
  const item = await fixture(true);
  const previous = process.env.DEVINT_PROJECTS_FILE;
  process.env.DEVINT_PROJECTS_FILE = item.config;
  try {
    const result = await verifyTransition({ project: 'Transition', baseRef: `commit:${item.base}`, ref: `commit:${item.head}` }) as any;
    assert.deepEqual(result.impact.mapping.headUnmappedPaths, ['notes.txt']);
    assert.equal(result.impact.after.traversalReason, 'no-seeds');
    assert.deepEqual(result.reviewSurface.affectedPaths, []);
    assert.equal(result.reviewSurface.affectedPathsComplete, false);
    assert.equal(result.reviewSurface.truncated, false);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = previous;
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

test('temporal verification composes exact A/B delta, expectations, invariants, impact, and unexpected change', async () => {
  const item = await fixture();
  const previous = process.env.DEVINT_PROJECTS_FILE;
  process.env.DEVINT_PROJECTS_FILE = item.config;
  try {
    const base = await graphContext('Transition', { ref: `commit:${item.base}` });
    const head = await graphContext('Transition', { ref: `commit:${item.head}` });
    const keepBase = base.graph.nodes.find(node => node.kind === 'function' && node.name === 'keep');
    const keepHead = head.graph.nodes.find(node => node.kind === 'function' && node.name === 'keep');
    const legacy = base.graph.nodes.find(node => node.kind === 'function' && node.name === 'legacy');
    const added = head.graph.nodes.find(node => node.kind === 'function' && node.name === 'added');
    assert.ok(keepBase && keepHead && legacy && added);
    assert.equal(keepBase.id, keepHead.id);

    const result = await verifyTransition({
      project: 'Transition',
      baseRef: `commit:${item.base}`,
      ref: `commit:${item.head}`,
      contract: {
        version: 1,
        head: {
          version: 1,
          entities: [
            { id: added.id, requirement: 'required' },
            { id: legacy.id, requirement: 'forbidden' },
          ],
          predicates: [{
            id: 'added-calls-keep',
            type: 'reachability',
            from: { ids: [added.id] },
            to: { ids: [keepHead.id] },
            requirement: 'required',
            relationshipKinds: ['calls'],
            maxDepth: 2,
            originalClaim: 'The added function delegates to keep.',
          }],
        },
        preserve: {
          version: 1,
          entities: [{ id: keepHead.id, requirement: 'required' }],
        },
      },
      limit: 20,
    }) as any;

    assert.equal(result.base.identity.sha, item.base);
    assert.equal(result.head.identity.sha, item.head);
    assert.equal(result.comparisonMode, 'current-analyzer-replay');
    assert.equal(result.expectations.counts.expectedAndObserved, 2);
    assert.equal(result.expectations.counts.satisfiedAbsence, 1);
    assert.equal(result.expectations.counts.preservedInvariants, 1);
    assert.equal(result.expectations.contractSatisfied, true);
    assert.equal(result.delta.changedFileCount, 1);
    assert.ok(result.unexpectedChanges.total >= 1);
    assert.ok(result.reviewSurface.changedFiles.length <= 20);
    assert.equal(result.policy.persisted, false);
    assert.equal(result.policy.approvesMerge, false);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = previous;
    await fs.rm(item.root, { recursive: true, force: true });
  }
});
