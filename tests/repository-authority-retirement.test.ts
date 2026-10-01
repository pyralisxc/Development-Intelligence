import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

test('repository integration keeps generated semantic checkpoints ephemeral', async () => {
  const action = await fs.readFile(path.resolve('action.yml'), 'utf8');
  const workflow = await fs.readFile(path.resolve('.github/workflows/verify.yml'), 'utf8');

  assert.match(action, /mode:[\s\S]*?default:\s*analyze/u, 'packaged action must default to checkpointless analysis');
  assert.match(workflow, /Analyze this repository through the packaged action[\s\S]*?mode:\s*analyze/u);
  assert.match(workflow, /Generate and verify an ephemeral compatibility checkpoint/u);
  assert.doesNotMatch(workflow, /git push origin HEAD/u, 'compatibility checkpoints must never be pushed into repository authority');
  assert.doesNotMatch(workflow, /git add \.development-intelligence/u, 'compatibility checkpoints must never be staged for commit');

  await assert.rejects(
    fs.stat(path.resolve('.development-intelligence', 'manifest.json')),
    /ENOENT/,
    'Development Intelligence itself must not track a generated semantic checkpoint',
  );
});
