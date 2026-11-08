import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { generateTestClaimCatalog } from '../src/intelligence/testClaimInventory.js';
import { projectNodeTestEvents } from '../src/intelligence/nodeTestEvidence.js';
import { joinAssertionEvidence } from '../src/intelligence/assertionEvidenceRouting.js';
import { runChecked, run } from '../src/util/process.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-node-events-'));
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'observations'), { recursive: true });
  await fs.writeFile(path.join(root, 'scripts', 'observable.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('observable result', () => { assert.equal(2, 2); });",
    '',
  ].join('\n'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  await runChecked('git', ['-C', root, 'add', 'scripts']);
  await runChecked('git', ['-C', root, '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=DI Fixture', 'commit', '-m', 'node test fixture']);
  const graph = await buildLocalGraph(root, 'node-events-fixture', 'W');
  const catalog = await generateTestClaimCatalog(root, graph, {
    sourcePrefixes: ['scripts/'], sourceSuffixes: ['.test.mjs'],
  });
  return { root, graph, catalog };
}

test('real Node TestStream reporter maps an exact Git test declaration without asserting coverage', async () => {
  const { root, graph, catalog } = await fixture();
  try {
    const reporter = path.resolve('scripts/node-test-events-reporter.mjs');
    const eventFile = path.join(root, 'observations', 'node.jsonl');
    const result = await run(process.execPath, [
      '--test',
      '--test-reporter=' + reporter,
      path.join(root, 'scripts', 'observable.test.mjs'),
    ], { cwd: root, timeoutMs: 30000, env: { NODE_TEST_CONTEXT: undefined } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"type":"test:pass"/u,
      'real TestStream must produce a pass event, not an empty reporter file');
    await fs.writeFile(eventFile, result.stdout);
    const first = await projectNodeTestEvents({
      root, graph, catalog, eventPath: 'observations/node.jsonl',
      nodeVersion: process.version, runId: 'local-fixture',
    });
    const repeated = await projectNodeTestEvents({
      root, graph, catalog, eventPath: 'observations/node.jsonl',
      nodeVersion: process.version, runId: 'local-fixture',
    });
    assert.equal(first.counts.reportedPass, 1);
    assert.equal(first.counts.reportedFail, 0);
    assert.equal(first.counts.sourceMatched, 1);
    assert.ok(first.counts.summariesObserved >= 1);
    assert.equal(first.tests[0]?.file, 'scripts/observable.test.mjs');
    assert.equal(first.tests[0]?.testName, 'observable result');
    assert.equal(first.tests[0]?.outcome, 'reported-pass');
    assert.ok(first.tests[0]?.declarationId?.startsWith('declaration:'));
    assert.equal(first.tests[0]?.evidenceStatus, 'source-associated-unattested');
    assert.equal(first.identity.independentlyAttested, false);
    assert.equal(first.policy.sourceAssociatedEventsProveAssertionResults, false);
    assert.equal(first.policy.canonicalAuthorityUnaffected, true);
    const joined = joinAssertionEvidence({ graph, catalog, testEvents: first }) as any;
    assert.equal(joined.counts.assertionsInsideReportedPassingTests, 1);
    assert.equal(joined.counts.assertionsWhoseOwnRuntimeExecutionIsProven, 0);
    assert.equal(joined.counts.independentlyProvenReplacements, 0);
    assert.deepEqual(first, repeated);

    const cli = await run(process.execPath, [
      path.resolve('dist/src/graphCli.js'), 'node-test-evidence',
      '--repo-path', root, '--project', 'node-events-fixture',
      '--node-test-events-jsonl', 'observations/node.jsonl',
      '--node-version', process.version,
    ]);
    assert.equal(cli.code, 0, cli.stderr);
    const decoded = JSON.parse(cli.stdout);
    assert.equal(decoded.mode, 'ephemeral-node-test-event-evidence');
    assert.equal(decoded.counts.sourceMatched, 1);
    assert.equal(decoded.identity.independentlyAttested, false);
    assert.equal(decoded.assertionEvidence.counts.assertionsInsideReportedPassingTests, 1);

    // End-to-end self-hosted worker runs the real native test under one graph,
    // without invoking a proprietary service or a second semantic store.
    const worker = await run(process.execPath, [
      path.resolve('scripts/run-oss-understanding.mjs'),
      '--repo-path', root, '--project', 'node-events-fixture',
      '--node-test-file', 'scripts/observable.test.mjs',
    ], { timeoutMs: 45000 });
    assert.equal(worker.code, 0, worker.stderr);
    const receipt = JSON.parse(worker.stdout);
    assert.equal(receipt.mode, 'operator-owned-open-source-understanding');
    assert.equal(receipt.oneCanonicalGraph, true);
    assert.equal(receipt.changedCanonicalAuthority, false);
    assert.equal(receipt.nodeTests.exitCode, 0);
    assert.equal(receipt.nodeTests.counts.sourceMatched, 1);
    assert.equal(receipt.nodeTests.policy.reportIntegrityIsNotCIExecutionAttestation, true);
    assert.equal(receipt.assertionEvidence.counts.assertionsInsideReportedPassingTests, 1);
    assert.equal(receipt.joern, null, 'unrequested heavy Joern is not invoked by default');

    const lines = (await fs.readFile(eventFile, 'utf8')).trim().split('\n');
    const altered = lines.map((line: string) => {
      const event = JSON.parse(line);
      if (event.type === 'test:pass') event.data.file = '../untracked.test.mjs';
      return JSON.stringify(event);
    });
    await fs.writeFile(eventFile, altered.join('\n') + '\n');
    const forged = await projectNodeTestEvents({
      root, graph, catalog, eventPath: 'observations/node.jsonl',
      nodeVersion: process.version,
    });
    assert.equal(forged.counts.sourceMatched, 0);
    assert.equal(forged.counts.unavailable >= 1, true);
    assert.equal(forged.policy.noneOrMissingDoesNotProveNoExecution, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
