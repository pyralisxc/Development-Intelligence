import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { generateTestClaimCatalog } from '../src/intelligence/testClaimInventory.js';
import { projectNodeTestEvents } from '../src/intelligence/nodeTestEvidence.js';
import { deriveSourceExecutionFacts, correlateSourceExecutionFacts } from '../src/intelligence/sourceExecutionFacts.js';
import { run, runChecked } from '../src/util/process.js';

const source = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { appendFileSync } from 'node:fs';",
  "const mark = (name) => { if (process.env.DI_RUNTIME_WITNESS) appendFileSync(process.env.DI_RUNTIME_WITNESS, name + '\\n'); };",
  "test('direct', () => { assert.equal((mark('direct'), 1), 1); });",
  "test('must despite failing branch', () => { if (Date.now() < 0) throw Error('fail'); assert.equal((mark('guard'), 2), 2); });",
  "test('optional', () => { if (process.env.DI_OPTIONAL_UNREACHED === 'yes') assert.equal((mark('optional'), 3), 3); });",
  "test('optional executed', () => { if (process.env.DI_OPTIONAL_EXECUTED === 'yes') assert.equal((mark('optional executed'), 10), 10); });",
  "test('early return', () => { if (process.env.DI_EARLY === 'yes') return; assert.equal((mark('early'), 4), 4); });",
  "test('never', () => { if (false) assert.equal((mark('never'), 5), 5); });",
  "test('nested callback', () => { const nested = () => assert.equal((mark('nested'), 6), 6); });",
  "test('simulated dependency', () => { const fake = { write: () => true }; assert.equal((mark('mock'), fake.write()), true); });",
  "test('awaited', async () => { await Promise.resolve(); assert.equal((mark('awaited'), 8), 8); });",
  "test.skip('skipped', () => { assert.equal((mark('skipped'), 9), 9); });",
  '',
].join('\n');

test('source-derived successful-path facts reconcile with a real native Node run without claiming effects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-source-execution-'));
  try {
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(root, 'observations'), { recursive: true });
    const testFile = 'scripts/reach.test.mjs';
    await fs.writeFile(path.join(root, testFile), source);
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', 'scripts']);
    await runChecked('git', ['-C', root, '-c', 'user.email=fixture@example.invalid',
      '-c', 'user.name=DI Fixture', 'commit', '-m', 'exact execution source']);
    const graph = await buildLocalGraph(root, 'execution-source-proof', 'W');
    const catalog = await generateTestClaimCatalog(root, graph, {
      sourcePrefixes: ['scripts/'], sourceSuffixes: ['.test.mjs'],
    });
    const facts = await deriveSourceExecutionFacts(root, catalog, graph.graphId);
    const inTest = (title: string, from = facts) => {
      const declaration = catalog.declarations.find(d => source.slice(d.start, d.end).includes(`test('${title}'`));
      assert.ok(declaration, `Test declaration ${title} exists`);
      const fact = from.facts.find(f => f.testDeclarationId === declaration.id);
      assert.ok(fact, `Test ${title} has a source execution fact`);
      return fact;
    };
    assert.equal(inTest('direct').sourceReach, 'must-on-success');
    assert.equal(inTest('must despite failing branch').sourceReach, 'must-on-success');
    assert.equal(inTest('optional').sourceReach, 'may-on-success');
    assert.equal(inTest('optional executed').sourceReach, 'may-on-success');
    assert.equal(inTest('early return').sourceReach, 'may-on-success');
    assert.equal(inTest('never').sourceReach, 'never-on-success');
    assert.equal(inTest('nested callback').sourceReach, 'unknown');
    assert.equal(inTest('simulated dependency').sourceReach, 'must-on-success');
    assert.equal(inTest('awaited').sourceReach, 'must-on-success');
    assert.equal(inTest('direct').inferredExecution, 'none');

    const witnessFile = path.join(root, 'observations', 'actual-assertion-reach.txt');
    const reporter = pathToFileURL(path.resolve('scripts/node-test-events-reporter.mjs')).href;
    const executed = await run(process.execPath, [
      '--test', '--test-reporter=' + reporter, path.join(root, testFile),
    ], { cwd: root, timeoutMs: 30000, env: {
      NODE_TEST_CONTEXT: undefined, DI_RUNTIME_WITNESS: witnessFile,
      DI_OPTIONAL_EXECUTED: 'yes', DI_EARLY: 'yes',
    } });
    assert.equal(executed.code, 0, 'real tracked Node test run must succeed');
    const observedHits = (await fs.readFile(witnessFile, 'utf8')).trim().split('\n').sort();
    assert.deepEqual(observedHits, ['awaited', 'direct', 'guard', 'mock', 'optional executed'].sort(),
      'the instrumented runtime witness must distinguish reached and unreached assertion callsites');
    await fs.writeFile(path.join(root, 'observations', 'test-events.jsonl'), executed.stdout);
    const observed = await projectNodeTestEvents({
      root, graph, catalog, eventPath: 'observations/test-events.jsonl',
      nodeVersion: process.version, runId: 'direct-local-test-executor',
    });
    assert.equal(observed.counts.reportedFail, 0);
    assert.equal(observed.counts.reportedSkip, 1);
    const attributed = correlateSourceExecutionFacts(facts, observed, 'unattested-report');
    assert.equal(inTest('direct', attributed).inferredExecution, 'conditional-on-reported-pass');
    const local = correlateSourceExecutionFacts(facts, observed, 'direct-local-run');
    assert.equal(local.sourceFactsSha256, facts.sourceFactsSha256,
      'attaching observed execution must not change independently established source facts');
    assert.notEqual(local.factsSha256, facts.factsSha256,
      'the source-plus-run evidence assessment has its own identity');
    assert.equal(inTest('direct', local).inferredExecution, 'direct-local-run');
    assert.equal(inTest('must despite failing branch', local).inferredExecution, 'direct-local-run');
    assert.equal(inTest('optional', local).inferredExecution, 'none');
    assert.equal(inTest('optional executed', local).inferredExecution, 'none',
      'runtime reached optional assertions, but a test pass alone cannot prove their reach');
    assert.equal(inTest('never', local).inferredExecution, 'none');
    assert.equal(inTest('nested callback', local).inferredExecution, 'none');
    assert.equal(inTest('simulated dependency', local).observedProviderEffect, false);
    assert.equal(inTest('simulated dependency', local).observedAssertionResult, false);
    assert.equal(local.counts.directlyInferredLocalExecution >= 4, true);
    assert.throws(() => correlateSourceExecutionFacts(facts, {
      ...observed, identity: { ...observed.identity, revision: '0'.repeat(40) },
    }, 'direct-local-run'), /same exact source graph/);
    const doubled = correlateSourceExecutionFacts(facts, {
      ...observed, tests: [...observed.tests, ...observed.tests],
    }, 'direct-local-run');
    assert.equal(inTest('direct', doubled).inferredExecution, 'none', 'ambiguous duplicate events cannot prove execution');

    // Rewriting exact source after catalog generation must not silently preserve proof.
    await fs.writeFile(path.join(root, testFile), source + '\n');
    await assert.rejects(deriveSourceExecutionFacts(root, catalog, graph.graphId),
      /differs from the exact catalog/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
