import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { generateTestClaimCatalog } from '../src/intelligence/testClaimInventory.js';
import { pageNodeTestEvents, projectNodeTestEvents } from '../src/intelligence/nodeTestEvidence.js';
import { joinAssertionEvidence } from '../src/intelligence/assertionEvidenceRouting.js';
import { run, runChecked } from '../src/util/process.js';

const TOTAL_OBSERVED = 150;

test('a real >100-native-test suite joins ALL executed source tests before output pagination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-native-full-events-'));
  try {
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(root, 'observations'), { recursive: true });
    const source = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      ...Array.from({ length: TOTAL_OBSERVED }, (_, i) =>
        "test('capacity " + i + "', () => { assert.equal(" + i + ", " + i + "); });"),
      '',
    ].join('\n');
    await fs.writeFile(path.join(root, 'scripts', 'capacity.test.mjs'), source);
    await fs.writeFile(path.join(root, 'scripts', 'unrun.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('not executed', () => { assert.equal(1, 1); });",
      '',
    ].join('\n'));
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', 'scripts']);
    await runChecked('git', ['-C', root, '-c', 'user.email=di-fixture@example.invalid',
      '-c', 'user.name=DI Fixture', 'commit', '-m', '150 reported and one unrun test']);
    const graph = await buildLocalGraph(root, 'di-event-capacity-fixture', 'W');
    const catalog = await generateTestClaimCatalog(root, graph, {
      sourcePrefixes: ['scripts/'], sourceSuffixes: ['.test.mjs'],
    });
    assert.equal(catalog.declarations.length, TOTAL_OBSERVED + 1);
    assert.equal(catalog.assertions.length, TOTAL_OBSERVED + 1);

    const reporter = pathToFileURL(path.resolve('scripts/node-test-events-reporter.mjs')).href;
    const executed = await run(process.execPath, [
      '--test', '--test-reporter=' + reporter,
      path.join(root, 'scripts', 'capacity.test.mjs'),
    ], { cwd: root, timeoutMs: 40000, env: { NODE_TEST_CONTEXT: undefined } });
    assert.equal(executed.code, 0, executed.stderr);
    const reportPath = path.join(root, 'observations', 'native.jsonl');
    await fs.writeFile(reportPath, executed.stdout);
    const first = await projectNodeTestEvents({
      root, graph, catalog, eventPath: 'observations/native.jsonl', nodeVersion: process.version,
    });
    assert.equal(first.counts.reportedPass, TOTAL_OBSERVED);
    assert.equal(first.counts.sourceMatched, TOTAL_OBSERVED, JSON.stringify({
      expected: TOTAL_OBSERVED,
      catalog: {
        declarations: catalog.declarations.length, assertions: catalog.assertions.length,
        titles: catalog.declarations.slice(0, 4).map(item => ({
          sourceId: item.sourceId, start: item.start, end: item.end,
        })),
      },
      population: first.counts,
      rows: first.tests.slice(0, 12).map(item => ({
        name: item.testName, file: item.file,
        status: item.evidenceStatus, declarationId: item.declarationId,
      })),
      reporter: executed.stdout.split('\\n').slice(0, 5).map(line => {
        try { const event = JSON.parse(line); return {
          type: event.type, name: event.data?.name, file: event.data?.file,
        }; } catch { return null; }
      }),
    }).slice(0, 4000));
    assert.equal(first.tests.length, TOTAL_OBSERVED,
      'a display cap must NEVER truncate internal evidence used to judge assertions');
    const joined = joinAssertionEvidence({ graph, catalog, testEvents: first }) as any;
    assert.equal(joined.counts.assertions, TOTAL_OBSERVED + 1);
    const containment = catalog.assertions.map(assertion => ({
      id: assertion.id, file: assertion.sourceId,
      start: assertion.start, end: assertion.end,
      owners: catalog.declarations.filter(declaration =>
        declaration.sourceId === assertion.sourceId
        && declaration.start <= assertion.start
        && declaration.end >= assertion.end && !declaration.dynamic).length,
    }));
    const missingOwners = containment.filter(item => item.owners !== 1);
    assert.equal(joined.counts.assertionsWithUniqueContainingTest, TOTAL_OBSERVED + 1,
      JSON.stringify({
        counts: joined.counts, declarationCount: catalog.declarations.length,
        assertionCount: catalog.assertions.length,
        missingCount: missingOwners.length, missing: missingOwners.slice(0, 12),
        declarations: catalog.declarations.slice(0, 4),
        assertions: catalog.assertions.slice(0, 4),
      }).slice(0, 4800));
    assert.equal(joined.counts.assertionsInsideReportedPassingTests, TOTAL_OBSERVED);
    assert.equal(joined.counts.assertionsWhoseOwnRuntimeExecutionIsProven, 0);
    assert.equal(joined.counts.assertionsWithExpectedValueProven, 0);
    assert.equal(joined.counts.independentlyProvenReplacements, 0);

    const page1 = pageNodeTestEvents(first);
    const page2 = pageNodeTestEvents(first, 100, 100);
    assert.equal(page1.tests.length, 100);
    assert.equal(page2.tests.length, 50);
    assert.equal(page1.page.total, TOTAL_OBSERVED);
    assert.equal(page2.page.total, TOTAL_OBSERVED);
    assert.equal(page2.page.hasMore, false);
    assert.equal(new Set([...page1.tests, ...page2.tests].map(item => item.eventId)).size,
      TOTAL_OBSERVED, 'every event must be recoverable exactly once');
    assert.throws(() => pageNodeTestEvents(first, -1, 20), /offset/u);
    assert.throws(() => pageNodeTestEvents(first, 0, 1001), /page size/u);

    const cliBase = [
      path.resolve('dist/src/graphCli.js'), 'node-test-evidence',
      '--repo-path', root, '--project', 'di-event-capacity-fixture',
      '--node-test-events-jsonl', 'observations/native.jsonl',
      '--node-version', process.version,
    ];
    const defaultCli = await run(process.execPath, cliBase);
    assert.equal(defaultCli.code, 0, defaultCli.stderr);
    const pageOne = JSON.parse(defaultCli.stdout);
    assert.equal(pageOne.tests.length, 100);
    assert.equal(pageOne.page.total, TOTAL_OBSERVED);
    assert.equal(pageOne.assertionEvidence.counts.assertionsInsideReportedPassingTests, TOTAL_OBSERVED,
      'the CLI must use full source-bound evidence, not the 100 displayed rows');

    const pageLater = await run(process.execPath, [
      ...cliBase, '--node-events-offset', '100', '--node-events-page-size', '100',
      '--node-events-expected-sha256', first.identity.reportSha256,
    ]);
    assert.equal(pageLater.code, 0, pageLater.stderr);
    const pageTwo = JSON.parse(pageLater.stdout);
    assert.equal(pageTwo.tests.length, 50);
    assert.equal(pageTwo.page.hasMore, false);
    assert.equal(pageTwo.identity.reportSha256, pageOne.identity.reportSha256);
    assert.equal(pageTwo.assertionEvidence.counts.assertionsInsideReportedPassingTests, TOTAL_OBSERVED);
    assert.equal(new Set([...pageOne.tests, ...pageTwo.tests].map((item: any) => item.eventId)).size,
      TOTAL_OBSERVED);

    const missingDigest = await run(process.execPath, [...cliBase, '--node-events-offset', '100']);
    assert.notEqual(missingDigest.code, 0);
    assert.match(missingDigest.stderr, /expected-sha256/u);
    const wrongDigest = await run(process.execPath, [
      ...cliBase, '--node-events-offset', '100', '--node-events-expected-sha256',
      '0'.repeat(64),
    ]);
    assert.notEqual(wrongDigest.code, 0);
    assert.match(wrongDigest.stderr, /does not match/u);

    const worker = await run(process.execPath, [
      path.resolve('scripts/run-oss-understanding.mjs'),
      '--repo-path', root, '--project', 'di-event-capacity-fixture',
      '--node-test-file', 'scripts/capacity.test.mjs',
    ], { timeoutMs: 45000 });
    assert.equal(worker.code, 0, worker.stderr);
    const receipt = JSON.parse(worker.stdout);
    assert.equal(receipt.nodeTests.tests.length, 20,
      'compact worker display is legitimate when full counts remain available');
    assert.equal(receipt.nodeTests.eventPresentation.total, TOTAL_OBSERVED);
    assert.equal(receipt.nodeTests.eventPresentation.hasMore, true);
    assert.equal(receipt.assertionEvidence.counts.assertionsInsideReportedPassingTests, TOTAL_OBSERVED);
    assert.equal(receipt.assertionEvidence.counts.assertions, TOTAL_OBSERVED + 1);
    assert.equal(receipt.oneCanonicalGraph, true);
    assert.equal(receipt.changedCanonicalAuthority, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
