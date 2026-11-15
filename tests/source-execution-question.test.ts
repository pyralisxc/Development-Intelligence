import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parseSourceExecutionQuestion } from '../src/intelligence/sourceExecutionQuestion.js';
import { clearGraphCache } from '../src/intelligence/service.js';
import { queryWorkbench } from '../src/intelligence/workbench.js';
import { callTool } from '../src/mcp.js';
import { runChecked } from '../src/util/process.js';

test('source-execution question grammar preserves existing code and runtime question routes', () => {
  assert.deepEqual(parseSourceExecutionQuestion(
    'Which assertions must execute if the test in tests/decisions.test.ts passes?'),
    { mode: 'file', path: 'tests/decisions.test.ts' });
  assert.deepEqual(parseSourceExecutionQuestion(
    'How many source-derived test assertions are must-on-success versus unknown?'),
    { mode: 'repository' });
  assert.deepEqual(parseSourceExecutionQuestion(
    'Which assertions must execute in tests/first.test.ts and tests/second.test.ts?'),
    { mode: 'ambiguous' });
  assert.deepEqual(parseSourceExecutionQuestion(
    'Which assertions must execute in tests/../outside.test.ts?'),
    { mode: 'invalid' });
  assert.equal(parseSourceExecutionQuestion('Which tests cover saveRecord?'), null);
  assert.equal(parseSourceExecutionQuestion('What does saveRecord call?'), null);
  assert.equal(parseSourceExecutionQuestion('Which test assertions actually executed in CI?'), null,
    'run-evidence questions must not be misrepresented as source-only proof');
});

test('ordinary investigate uses canonical source execution facts and rejects unknown test paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-source-exec-questions-'));
  const source = path.join(root, 'source');
  const bare = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const priorFile = process.env.DEVINT_PROJECTS_FILE;
  const priorProducer = process.env.DEVINT_BUILD_SHA;
  try {
    await fs.mkdir(path.join(source, 'tests'), { recursive: true });
    await runChecked('git', ['init', '--initial-branch=main', source]);
    await fs.writeFile(path.join(source, 'tests', 'decisions.test.ts'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('direct', () => { assert.equal(1, 1); });",
      "test('cleanup', () => { try { assert.equal(2, 2); } finally { void 0; } });",
      "test('conditional', () => { if (process.env.FLAG) assert.equal(3, 3); });",
      "test('masked', () => { try { if (process.env.FLAG) throw Error('masked'); assert.equal(4, 4); } finally { return; } });",
      '',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'tests', 'other.test.ts'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('other', () => { assert.equal(5, 5); });",
      '',
    ].join('\n'));
    await runChecked('git', ['-C', source, 'add', '.']);
    await runChecked('git', ['-C', source, '-c', 'user.email=di@example.invalid',
      '-c', 'user.name=DI Test', 'commit', '-m', 'source execution question fixture']);
    const sha = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    await runChecked('git', ['init', '--bare', bare]);
    await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(bare).href]);
    await runChecked('git', ['-C', source, 'push', '--all', 'origin']);
    await fs.writeFile(config, JSON.stringify({ ExecutionQuestionFixture: {
      repository: pathToFileURL(bare).href, defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'], revisionPolicy: 'repository-history',
      credential: { type: 'none' },
    } }));
    process.env.DEVINT_PROJECTS_FILE = config;
    process.env.DEVINT_BUILD_SHA = 'a'.repeat(40);
    clearGraphCache();
    const selected = { project: 'ExecutionQuestionFixture', ref: 'commit:' + sha };
    const q = 'Which assertions must execute if the test in tests/decisions.test.ts passes?';
    const ordinary = await queryWorkbench({ ...selected, text: q }) as any;
    assert.equal(ordinary.intent, 'source-execution-facts');
    assert.equal(ordinary.routing.tool, 'get_test_claim_report');
    assert.equal(ordinary.answerClassification, 'established-bounded');
    assert.equal(ordinary.result.sourceOnly, true);
    assert.equal(ordinary.result.counts.assertions, 4);
    assert.equal(ordinary.result.counts.sourceMust, 2);
    assert.equal(ordinary.result.counts.sourceMay, 1);
    assert.equal(ordinary.result.counts.sourceUnknown, 1);
    assert.equal(ordinary.result.executionObservedFromThisReport, false);
    assert.match(ordinary.answer, /no authenticated run evidence/i);
    assert.match(ordinary.answer, /tests\/decisions\.test\.ts:3/u);
    assert.match(ordinary.answer, /tests\/decisions\.test\.ts:4/u);

    const direct = await callTool('get_test_claim_report', {
      ...selected, sourcePrefixes: ['tests/decisions.test.ts'], sourceSuffixes: ['.test.ts'],
      pageSize: 500, populationDetail: 'summary',
    }) as any;
    assert.deepEqual(ordinary.result.counts, direct.sourceExecutionFacts.counts &&
      { assertions: direct.sourceExecutionFacts.counts.assertions,
        sourceMust: direct.sourceExecutionFacts.counts.sourceMust,
        sourceMay: direct.sourceExecutionFacts.counts.sourceMay,
        sourceNever: direct.sourceExecutionFacts.counts.sourceNever,
        sourceUnknown: direct.sourceExecutionFacts.counts.sourceUnknown,
        insideReportedPass: direct.sourceExecutionFacts.counts.insideReportedPass });
    assert.equal(ordinary.result.sourceFactsSha256, direct.sourceExecutionFacts.sourceFactsSha256);

    const batch = await callTool('investigate', { ...selected, questions: [q,
      'How many source-derived test assertions are must-on-success versus unknown?',
      'Which assertions must execute in tests/decisions.test.ts or tests/other.test.ts?',
      'Which assertions must execute in tests/missing.test.ts?',
    ] }) as any;
    assert.equal(batch.items[0].intent, 'source-execution-facts');
    assert.equal(batch.items[0].result.sourceFactsSha256, ordinary.result.sourceFactsSha256);
    assert.equal(batch.items[1].result.counts.assertions, 5);
    assert.equal(batch.items[1].result.counts.sourceMust, 3);
    assert.equal(batch.items[2].result.reason, 'multiple-test-files');
    assert.equal(batch.items[3].result.reason, 'source-or-facts-unavailable');
    assert.match(batch.items[3].answer, /not establish/i);
    assert.equal(batch.counts.error, 0);
    const again = await queryWorkbench({ ...selected, text: q }) as any;
    assert.equal(again.result.sourceFactsSha256, ordinary.result.sourceFactsSha256);
  } finally {
    if (priorFile === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = priorFile;
    if (priorProducer === undefined) delete process.env.DEVINT_BUILD_SHA;
    else process.env.DEVINT_BUILD_SHA = priorProducer;
    clearGraphCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
