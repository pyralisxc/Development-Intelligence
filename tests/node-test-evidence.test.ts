import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { generateTestClaimCatalog } from '../src/intelligence/testClaimInventory.js';
import { projectNodeTestEvents } from '../src/intelligence/nodeTestEvidence.js';
import { joinAssertionEvidence } from '../src/intelligence/assertionEvidenceRouting.js';
import { runChecked, run } from '../src/util/process.js';

async function fixture(includeSkipTodo = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-node-events-'));
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'observations'), { recursive: true });
  await fs.writeFile(path.join(root, 'scripts', 'observable.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('observable result', () => { assert.equal(2, 2); });",
    ...(includeSkipTodo ? [
      "test('skipped result', { skip: 'not executed' }, () => { assert.equal(0, 1); });",
      "test('todo result', { todo: 'future behavior' }, () => { assert.equal(1, 1); });",
    ] : []),
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
    const reporter = pathToFileURL(path.resolve('scripts/node-test-events-reporter.mjs')).href;
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
    // Synthetic fixture only: if a platform reports a different native
    // TestStream file identity, disclose the exact bounded mapping evidence
    // instead of guessing a match or weakening the gate.
    const testPassEvents = result.stdout.trim().split('\n')
      .map((line: string) => JSON.parse(line))
      .filter((event: any) => event.type === 'test:pass')
      .map((event: any) => ({ name: event.data?.name, file: event.data?.file }));
    assert.equal(first.counts.sourceMatched, 1, JSON.stringify({
      reportedEvents: testPassEvents, observedTests: first.tests,
      counts: first.counts,
      declarations: catalog.declarations.map(item => ({
        id: item.id, sourceId: item.sourceId, start: item.start, end: item.end,
      })),
    }).slice(0, 3000));
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

    // A traversal-looking reporter filename must be rejected without trying
    // to load or parse an arbitrary on-disk file outside the checkout.
    const escaped = lines.map((line: string) => {
      const event = JSON.parse(line);
      if (event.type === 'test:pass') event.data.file = 'scripts/../../outside.test.mjs';
      return JSON.stringify(event);
    });
    await fs.writeFile(eventFile, escaped.join('\n') + '\n');
    const invalid = await projectNodeTestEvents({
      root, graph, catalog, eventPath: 'observations/node.jsonl',
      nodeVersion: process.version,
    });
    assert.equal(invalid.counts.sourceMatched, 0);
    assert.ok(invalid.counts.unavailable >= 1);

    // Native file:// and absolute reporter paths must map to the same exact
    // tracked declaration rather than merely matching the test title.
    const urlEvents = lines.map((line: string) => {
      const event = JSON.parse(line);
      if (event.type === 'test:pass') {
        event.data.file = pathToFileURL(
          path.join(root, 'scripts', 'observable.test.mjs')).href;
      }
      return JSON.stringify(event);
    });
    await fs.writeFile(eventFile, urlEvents.join('\n') + '\n');
    const urlResult = await projectNodeTestEvents({
      root, graph, catalog, eventPath: 'observations/node.jsonl',
      nodeVersion: process.version,
    });
    assert.equal(urlResult.counts.sourceMatched, 1);
    assert.equal(urlResult.tests[0]?.declarationId, first.tests[0]?.declarationId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('real Node TestStream skips and TODOs never appear as passing assertion evidence', async () => {
  const { root, graph, catalog } = await fixture(true);
  try {
    const reporter = pathToFileURL(path.resolve('scripts/node-test-events-reporter.mjs')).href;
    const result = await run(process.execPath, [
      '--test', '--test-reporter=' + reporter,
      path.join(root, 'scripts', 'observable.test.mjs'),
    ], { cwd: root, timeoutMs: 30000, env: { NODE_TEST_CONTEXT: undefined } });
    assert.equal(result.code, 0, result.stderr);
    const rawEvents = result.stdout.trim().split('\\n').map((line: string) => JSON.parse(line));
    assert.equal(rawEvents.filter((e:any) => e.type === 'test:pass').length, 3);
    assert.equal(rawEvents.some((e:any) => e.type === 'test:pass'
      && e.data.skip === true), true);
    assert.equal(rawEvents.some((e:any) => e.type === 'test:pass'
      && e.data.todo === true), true);
    const file=path.join(root,'observations','native.jsonl');
    await fs.writeFile(file,result.stdout);
    const observed=await projectNodeTestEvents({root,graph,catalog,
      eventPath:'observations/native.jsonl',nodeVersion:process.version});
    assert.equal(observed.counts.testEvents,3);
    assert.equal(observed.counts.reportedPass,1);
    assert.equal(observed.counts.reportedSkip,1);
    assert.equal(observed.counts.reportedTodo,1);
    assert.equal(observed.counts.legacyPassUnclassified,0);
    assert.equal(observed.counts.sourceMatched,3);
    const joined=joinAssertionEvidence({graph,catalog,testEvents:observed}) as any;
    assert.equal(joined.counts.assertionsInsideReportedPassingTests,1);
    assert.equal(joined.counts.assertionsInsideReportedSkippedTests,1);
    assert.equal(joined.counts.assertionsInsideReportedTodoTests,1);
    assert.equal(joined.counts.assertionsWhoseOwnRuntimeExecutionIsProven,0);
    assert.equal(joined.counts.independentlyProvenReplacements,0);
    // Schema v1 omitted skip/todo metadata; no old pass may be upgraded
    // merely because Node emitted a test:pass event.
    const legacy=rawEvents.map((e:any) => {
      const x=structuredClone(e); x.schemaVersion=1;
      if (x.type === 'test:pass') { delete x.data.skip; delete x.data.todo; }
      return JSON.stringify(x);
    }).join('\\n')+'\\n';
    await fs.writeFile(file,legacy);
    const old=await projectNodeTestEvents({root,graph,catalog,
      eventPath:'observations/native.jsonl',nodeVersion:process.version});
    assert.equal(old.counts.reportedPass,0);
    assert.equal(old.counts.legacyPassUnclassified,3);
    assert.equal(old.counts.sourceMatched,3);
    const oldJoined=joinAssertionEvidence({graph,catalog,testEvents:old}) as any;
    assert.equal(oldJoined.counts.assertionsInsideReportedPassingTests,0);
    assert.equal(oldJoined.counts.assertionsInsideLegacyUnclassifiedTestCases,3);
    // A v2 event missing its flags is not valid execution status evidence.
    const broken=rawEvents.map((e:any) => {
      const x=structuredClone(e);
      if(x.type==='test:pass' && x.data.name==='skipped result')delete x.data.skip;
      return JSON.stringify(x);
    }).join('\\n')+'\\n';
    await fs.writeFile(file,broken);
    await assert.rejects(() => projectNodeTestEvents({root,graph,catalog,
      eventPath:'observations/native.jsonl',nodeVersion:process.version}),
      /unambiguous boolean skip and todo flags/u);
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
});
