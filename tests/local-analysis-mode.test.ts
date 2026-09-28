import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyzeLocalGraph } from '../src/intelligence/local.js';
import { runChecked } from '../src/util/process.js';

test('analysis-only local mode requires no repository checkpoint and never writes one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-analysis-only-'));
  try {
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await fs.mkdir(path.join(root, 'src', 'features', 'example'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'features', 'example', 'a.ts'), 'export function alpha() { return beta(); }\nfunction beta() { return 1; }\n');
    await fs.writeFile(path.join(root, 'src', 'features', 'example', 'b.ts'), 'export const featureState = { ready: true };\n');
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);

    await assert.rejects(
      fs.stat(path.join(root, '.development-intelligence', 'manifest.json')),
      /ENOENT/,
    );

    const result = await analyzeLocalGraph(root, 'fixture/project') as any;
    assert.equal(result.valid, true);
    assert.equal(result.mode, 'analysis-only');
    assert.equal(result.coverage.completeForEligibleSources, true);
    assert.equal(result.semantic.factualityNeedsReview, 0);
    assert.equal(result.semantic.authoritySafe, true);
    assert.equal(result.policy.checkpointRead, false);
    assert.equal(result.policy.checkpointWritten, false);
    assert.equal(result.policy.acceptedGraphAffected, false);

    await assert.rejects(
      fs.stat(path.join(root, '.development-intelligence', 'manifest.json')),
      /ENOENT/,
      'analysis-only mode must not create repository-owned semantic authority',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
