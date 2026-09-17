import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeByTechnology } from '../src/intelligence/analyzers/index.js';
import { buildRepositoryGraph } from '../src/intelligence/repository.js';
import { runChecked } from '../src/util/process.js';

const SCRIPT_GUID = '11111111111111111111111111111111';
const PREFAB_GUID = '22222222222222222222222222222222';
const ICON_GUID = '33333333333333333333333333333333';

function analyze(file: string, text: string) {
  return analyzeByTechnology({
    source: { id: `repo:${file}`, kind: 'repository-file', locator: file, revision: null, observedAt: '2026-01-01T00:00:00.000Z', available: true },
    locatorBase: file,
    text,
  });
}

test('Unity serialization preserves objects, local wiring, and GUID reference evidence', () => {
  const result = analyze('Assets/Player.prefab', `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Name: Player
  m_Component:
  - component: {fileID: 200}
--- !u!114 &200
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${SCRIPT_GUID}, type: 3}
  m_Icon: {fileID: 2800000, guid: ${ICON_GUID}, type: 3}
`);
  const gameObject = result.observations.find(node => node.name === 'Player');
  const behaviour = result.observations.find(node => (node.value as { type?: string }).type === 'MonoBehaviour');

  assert.equal(result.coverage?.status, 'complete');
  assert.ok(gameObject && behaviour);
  assert.ok(result.resolutions.some(edge => edge.from === gameObject.id && edge.to === behaviour.id && edge.kind === 'has-component'));
  assert.ok(result.resolutions.some(edge => edge.from === behaviour.id && edge.to === gameObject.id && edge.kind === 'attached-to'));
  assert.equal(result.evidence?.filter(record => record.kind === 'unity-guid-reference').length, 2);
  assert.ok(result.evidence?.some(record => record.field === 'm_Script' && (record.value as { relationship?: string }).relationship === 'uses-script'));
});

test('Unity metadata exposes stable asset identity and reports missing identity honestly', () => {
  const valid = analyze('Assets/Player.cs.meta', `fileFormatVersion: 2\nguid: ${SCRIPT_GUID}\nMonoImporter:\n  externalObjects: {}\n`);
  const invalid = analyze('Assets/Broken.cs.meta', 'fileFormatVersion: 2\nMonoImporter: {}\n');

  assert.equal(valid.coverage?.status, 'complete');
  assert.deepEqual(valid.observations[0]?.value, { guid: SCRIPT_GUID, assetPath: 'Assets/Player.cs' });
  assert.equal(invalid.coverage?.status, 'partial');
});

test('repository graph resolves unique Unity GUIDs to tracked source and referenced binary assets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-unity-coverage-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await fs.mkdir(path.join(root, 'Assets'));
    await fs.writeFile(path.join(root, 'Assets', 'Player.cs'), 'public sealed class Player { }\n');
    await fs.writeFile(path.join(root, 'Assets', 'Player.cs.meta'), `fileFormatVersion: 2\nguid: ${SCRIPT_GUID}\n`);
    await fs.writeFile(path.join(root, 'Assets', 'Player.prefab'), `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Name: Player
  m_Component:
  - component: {fileID: 200}
--- !u!114 &200
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${SCRIPT_GUID}, type: 3}
  m_Icon: {fileID: 2800000, guid: ${ICON_GUID}, type: 3}
`);
    await fs.writeFile(path.join(root, 'Assets', 'Player.prefab.meta'), `fileFormatVersion: 2\nguid: ${PREFAB_GUID}\n`);
    await fs.writeFile(path.join(root, 'Assets', 'icon.png'), 'binary-placeholder');
    await fs.writeFile(path.join(root, 'Assets', 'icon.png.meta'), `fileFormatVersion: 2\nguid: ${ICON_GUID}\n`);
    await fs.writeFile(path.join(root, 'Assets', 'Game.asmdef'), '{"name":"Game","references":[]}');
    await fs.writeFile(path.join(root, 'Assets', 'Input.inputactions'), '{"version":1,"name":"Input"}');
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const graph = await buildRepositoryGraph({ project: 'UnityFixture', repository: root, revision, root, role: 'W' });
    const behaviour = graph.nodes.find(node => node.id === 'unity-object:Assets/Player.prefab#200');

    assert.equal(graph.coverage?.trackedFiles, 8);
    assert.equal(graph.coverage?.eligibleFiles, 7);
    assert.equal(graph.coverage?.completeFiles, 7);
    assert.equal(graph.coverage?.unsupportedFiles, 1);
    assert.ok(behaviour);
    assert.ok(graph.nodes.some(node => node.id === 'file:Assets/icon.png'), 'referenced binary asset is represented without claiming it was analyzed');
    assert.ok(graph.edges.some(edge => edge.from === behaviour!.id && edge.to === 'file:Assets/Player.cs' && edge.kind === 'uses-script' && edge.status === 'resolved'));
    assert.ok(graph.edges.some(edge => edge.from === behaviour!.id && edge.to === 'file:Assets/icon.png' && edge.kind === 'references' && edge.status === 'resolved'));
    assert.ok(graph.edges.some(edge => edge.from === 'file:Assets/Player.cs.meta' && edge.to === 'file:Assets/Player.cs' && edge.kind === 'describes'));
    assert.ok(graph.nodes.some(node => node.sourceId === 'repo:Assets/Game.asmdef' && node.kind === 'structured-value'));
    assert.ok(graph.nodes.some(node => node.sourceId === 'repo:Assets/Input.inputactions' && node.kind === 'structured-value'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
