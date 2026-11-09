import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, runChecked } from '../src/util/process.js';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { deriveNativeTestScope } from '../src/intelligence/nativeTestScope.js';

test('bounded native runner batches recover all 43 executed tests, plus one unrun unknown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-native-event-batch-'));
  try {
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(root, 'observations'), { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < 43; i += 1) {
      const relative = 'scripts/test-' + String(i).padStart(3, '0') + '.test.mjs';
      names.push(relative);
      await fs.writeFile(path.join(root, relative), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('native capacity " + i + "', () => { assert.equal(" + i + ", " + i + "); });",
        '',
      ].join('\n'));
    }
    await fs.writeFile(path.join(root, 'scripts/unrun.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('unrun sibling', () => { assert.equal(1, 1); });",
    ].join('\n'));
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', 'scripts']);
    await runChecked('git', ['-C', root, '-c', 'user.email=di@example.invalid',
      '-c', 'user.name=DI Fixture', 'commit', '-m', '43 real source tests, one not run']);
    const args = [
      path.resolve('scripts/run-oss-understanding.mjs'),
      '--repo-path', root, '--project', 'di-native-batches',
      '--node-batch-size', '20', '--node-max-files', '200',
      '--node-evidence-dir', 'observations/proof',
      ...names.flatMap(name => ['--node-test-file', name]),
    ];
    const executed = await run(process.execPath, args, { timeoutMs: 120000 });
    assert.equal(executed.code, 0, executed.stderr);
    const receipt = JSON.parse(executed.stdout);
    assert.equal(receipt.oneCanonicalGraph, true);
    assert.equal(receipt.changedCanonicalAuthority, false);
    assert.equal(receipt.nodeTests.exitCode, 0);
    assert.equal(receipt.nodeTests.counts.sourceMatched, 43);
    assert.equal(receipt.assertionEvidence.counts.assertions, 44);
    assert.equal(receipt.assertionEvidence.counts.assertionsWithUniqueContainingTest, 44);
    assert.equal(receipt.assertionEvidence.counts.assertionsInsideReportedPassingTests, 43);
    assert.equal(receipt.assertionEvidence.counts.independentlyProvenReplacements, 0);
    const display = receipt.nodeTests.eventPresentation;
    assert.equal(display.batchCount, 3);
    assert.equal(display.batchFileLimit, 20);
    assert.equal(display.total, 43);
    assert.equal(display.returned, 20);
    assert.equal(display.completeInternalPopulationUsedForAssertionJoin, true);
    assert.equal(display.artifactPersistence, 'operator-requested-local-files');
    assert.equal(display.recoverableReportFiles.length, 3);
    assert.equal(new Set(display.boundedInputReportSha256s).size, 3);
    const base = [
      path.resolve('dist/src/graphCli.js'), 'node-test-evidence',
      '--repo-path', root, '--project', 'di-native-batches',
      '--node-version', process.version,
      ...display.recoverableReportFiles.flatMap((p: string) => ['--node-test-events-jsonl', p]),
      '--node-events-page-size', '20',
    ];
    const pages: any[] = [];
    for (const offset of [0,20,40]) {
      const invoked = await run(process.execPath, [
        ...base,
        ...(offset ? ['--node-events-offset', String(offset),
          '--node-events-expected-sha256', receipt.nodeTests.identity.reportSha256] : []),
      ], { timeoutMs: 30000 });
      assert.equal(invoked.code, 0, invoked.stderr);
      pages.push(JSON.parse(invoked.stdout));
    }
    assert.deepEqual(pages.map(page => page.tests.length), [20, 20, 3]);
    const joined = pages.flatMap(page => page.tests.map((item: any) => item.eventId));
    assert.equal(new Set(joined).size, 43, 'every native source event is recoverable exactly once');
    assert.ok(pages.every(page => page.assertionEvidence.counts.assertionsInsideReportedPassingTests === 43));
    assert.ok(pages.every(page => page.identity.reportSha256 === receipt.nodeTests.identity.reportSha256));
    assert.equal(pages[2].page.hasMore, false);
    assert.equal(pages[2].identity.batchReportSha256s.length, 3);
    const bad = await run(process.execPath, [...base, '--node-events-offset', '20',
      '--node-events-expected-sha256', '0'.repeat(64)]);
    assert.notEqual(bad.code, 0, 'a stale digest must reject cross-batch recovery');
    assert.match(bad.stderr, /does not match/u);
    const replay = await run(process.execPath, [...base,
      '--node-test-events-jsonl', display.recoverableReportFiles[0]]);
    assert.notEqual(replay.code, 0, 'duplicate raw report must not double-count execution');
    assert.match(replay.stderr, /duplicate/u);
    const tooLow = await run(process.execPath, [
      path.resolve('scripts/run-oss-understanding.mjs'), '--repo-path', root,
      '--node-max-files', '40', ...names.flatMap(name => ['--node-test-file', name]),
    ]);
    assert.notEqual(tooLow.code, 0, 'resource cap must disclose inability, not a negative test verdict');
    assert.match(tooLow.stderr, /configured max-files/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('native test census can inspect nested sources and never claim other runner coverage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-native-nested-scope-'));
  try {
    await fs.mkdir(path.join(root, 'packages', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages/nested/actual.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('nested native evidence', () => { assert.equal(2, 2); });",
      '',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'packages/nested/other.test.py'), 'assert 1 + 1 == 2\n');
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', 'packages']);
    await runChecked('git', ['-C', root, '-c', 'user.email=fixture@example.invalid',
      '-c', 'user.name=DI Fixture', 'commit', '-m', 'multi-runner source census']);
    const graph = await buildLocalGraph(root, 'native-scope-oracle', 'W');
    const defaultScope = deriveNativeTestScope(graph);
    assert.equal(defaultScope.discovery.mode, 'default');
    assert.equal(defaultScope.discovery.scopedFilenameCandidates, 0);
    assert.equal(defaultScope.discovery.unselectedFilenameCandidates, 2);
    const complete = deriveNativeTestScope(graph, { allSupported: true });
    assert.equal(complete.discovery.filenameCandidates, 2);
    assert.equal(complete.discovery.scopedFilenameCandidates, 1);
    assert.equal(complete.discovery.unselectedFilenameCandidates, 1,
      'Python test remains visible but requires its own native runner');
    assert.equal(complete.discovery.negativeTestAbsenceProven, false);
    assert.equal(complete.discovery.otherRunnerFrameworksCovered, false);
    assert.ok(complete.scope.sourcePrefixes.includes('packages/'));
    assert.throws(() => deriveNativeTestScope(graph, {
      sourcePrefixes: ['../unsafe/'],
    }), /canonical repository-relative/u);
    assert.throws(() => deriveNativeTestScope(graph, {
      sourcePrefixes: ['packages/'], allSupported: true,
    }), /cannot silently combine/u);

    const workerBase = [
      path.resolve('scripts/run-oss-understanding.mjs'),
      '--repo-path', root, '--project', 'native-scope-oracle',
      '--node-test-file', 'packages/nested/actual.test.mjs',
    ];
    const scoped = await run(process.execPath, [...workerBase,
      '--native-test-scope', 'all-supported'], { timeoutMs: 45000 });
    assert.equal(scoped.code, 0, scoped.stderr);
    const actual = JSON.parse(scoped.stdout);
    assert.equal(actual.nodeTests.counts.sourceMatched, 1);
    assert.equal(actual.assertionEvidence.counts.assertions, 1);
    assert.equal(actual.assertionEvidence.counts.assertionsInsideReportedPassingTests, 1);
    assert.equal(actual.nativeTestDiscovery.unselectedFilenameCandidates, 1);
    const explicit = await run(process.execPath, [...workerBase,
      '--native-test-prefix', 'packages/'], { timeoutMs: 45000 });
    assert.equal(explicit.code, 0, explicit.stderr);
    const explicitReceipt = JSON.parse(explicit.stdout);
    assert.equal(explicitReceipt.nativeTestDiscovery.mode, 'explicit');
    assert.equal(explicitReceipt.nodeTests.counts.sourceMatched, 1);

    const defaultRun = await run(process.execPath, workerBase, { timeoutMs: 45000 });
    assert.equal(defaultRun.code, 0, defaultRun.stderr);
    const omitted = JSON.parse(defaultRun.stdout);
    assert.equal(omitted.nodeTests.counts.sourceMatched, 0);
    assert.equal(omitted.nativeTestDiscovery.unselectedFilenameCandidates, 2);
    assert.equal(omitted.assertionEvidence.counts.assertions, 0);
    assert.equal(omitted.nodeTests.policy.noneOrMissingDoesNotProveNoExecution, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
