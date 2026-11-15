import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, runChecked } from '../src/util/process.js';

test('worker runs every tracked native test beyond former 40-file cap with full source-joined population', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-native-worker-capacity-'));
  const total = 51;
  try {
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    const files: string[] = [];
    for (let i = 0; i < total; i++) {
      const file = 'scripts/capacity-' + String(i).padStart(3, '0') + '.test.mjs';
      files.push(file);
      await fs.writeFile(path.join(root, file), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('capacity " + i + "', () => { assert.equal(" + i + ", " + i + "); });",
        '',
      ].join('\n'));
    }
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', 'scripts']);
    await runChecked('git', ['-C', root, '-c', 'user.name=DI Fixture',
      '-c', 'user.email=di@example.invalid', 'commit', '-m', '51 native source tests']);
    const args = [
      path.resolve('scripts/run-oss-understanding.mjs'), '--repo-path', root,
      '--project', 'native-worker-capacity', '--node-test-batch-size', '13',
      ...files.flatMap(file => ['--node-test-file', file]),
    ];
    const execution = await run(process.execPath, args, { timeoutMs: 120000 });
    assert.equal(execution.code, 0, execution.stderr);
    const receipt = JSON.parse(execution.stdout);
    assert.equal(receipt.nodeTests.batches.length, 4);
    assert.deepEqual(receipt.nodeTests.batches.map((item: any) => item.fileCount), [13,13,13,12]);
    assert.equal(receipt.nodeTests.allBatchesCompleted, true);
    assert.equal(receipt.nodeTests.counts.reportedPass, total);
    assert.equal(receipt.nodeTests.counts.sourceMatched, total);
    assert.equal(receipt.nodeTests.eventPresentation.total, total);
    assert.equal(receipt.nodeTests.eventPresentation.returned, 20);
    assert.equal(receipt.assertionEvidence.counts.assertions, total);
    assert.equal(receipt.assertionEvidence.counts.assertionsInsideReportedPassingTests, total);
    assert.equal(receipt.assertionEvidence.counts.assertionsWithExpectedValueProven, 0);
    assert.equal(receipt.assertionEvidence.counts.independentlyProvenReplacements, 0);
    assert.equal(receipt.oneCanonicalGraph, true);
    assert.equal(receipt.changedCanonicalAuthority, false);

    const invalid = await run(process.execPath, [
      path.resolve('scripts/run-oss-understanding.mjs'),
      '--repo-path', root, '--project', 'native-worker-capacity',
      '--node-test-batch-size', '0', '--node-test-file', files[0]!,
    ]);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /batch size/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
