import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateConfiguration, verifyPayload, scratchInventory } from '../packaging/windows/managed-runtime.mjs';

test('managed activation requires explicit credentials and rejects arbitrary environment configuration', () => {
  const valid = { formatVersion: 1, authMode: 'bearer', agentToken: 'x'.repeat(32), projects: {} };
  assert.equal(validateConfiguration(valid), valid);
  assert.throws(() => validateConfiguration({ ...valid, agentToken: '' }));
  assert.throws(() => validateConfiguration({ ...valid, agentToken: ' '.repeat(32) }));
  assert.throws(() => validateConfiguration({ ...valid, DEVINT_CANONICAL_GRAPH_DIR: '/authority' }));
  assert.throws(() => validateConfiguration({ ...valid, remoteStorage: {} }));
});

test('package verification rejects changed bytes and escaping manifest paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-package-'));
  try {
    const manifest = { formatVersion: 1, engineSha: 'a'.repeat(40), packagingSha: 'a'.repeat(40), files: [{ path: 'runtime', sha256: createHash('sha256').update('original').digest('hex') }] };
    await fs.writeFile(path.join(root, 'runtime'), 'original');
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    await verifyPayload(root);
    await fs.writeFile(path.join(root, 'undeclared'), 'injected');
    await assert.rejects(verifyPayload(root), /undeclared/);
    await fs.unlink(path.join(root, 'undeclared'));
    await fs.writeFile(path.join(root, 'runtime'), 'corrupt');
    await assert.rejects(verifyPayload(root), /integrity/);
    manifest.files[0].path = '../outside';
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyPayload(root), /manifest path/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('scratch inventory refuses links rather than traversing outside its owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-scratch-'));
  try {
    await fs.writeFile(path.join(root, 'data'), '123');
    assert.equal((await scratchInventory(root))[0].bytes, 3);
    await fs.symlink(os.tmpdir(), path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(scratchInventory(root), /reparse link/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
