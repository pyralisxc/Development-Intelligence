import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';

const manifestPath = new URL('../benchmark/accuracy/portfolio.json', import.meta.url);
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

test('accuracy portfolio declares pinned real-repository coverage without ranking unlike benchmarks', async () => {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.policy.exactRevisionRequired, true);
  assert.equal(manifest.policy.performanceMetricsGateCorrectness, false);
  assert.equal(manifest.policy.directCrossBenchmarkRankingAllowed, false);
  const ids = new Set();
  const projects = new Map();
  for (const participant of manifest.participants) {
    assert.ok(!ids.has(participant.id), `duplicate participant id ${participant.id}`);
    ids.add(participant.id);
    assert.match(participant.ref, /^commit:[0-9a-f]{40}$/u);
    assert.ok(Array.isArray(participant.capabilities) && participant.capabilities.length > 0);
    const scriptUrl = new URL(`../${participant.benchmarkScript}`, import.meta.url);
    const source = await fs.readFile(scriptUrl, 'utf8');
    assert.match(source, new RegExp(participant.ref.slice('commit:'.length)), `${participant.project} runner must remain bound to the manifest SHA`);
    projects.set(participant.project, participant);
  }

  for (const [project, language] of [
    ['CardForge', 'typescript'],
    ['Game-Studio-Core', 'csharp'],
    ['Medieval-Sim', 'java'],
    ['AI-Systems-Control', 'typescript'],
  ]) {
    assert.equal(projects.get(project)?.language, language, `${project} must remain in the required representative portfolio`);
  }

  const languages = new Set(manifest.participants.map(participant => participant.language));
  for (const language of ['typescript', 'csharp', 'java', 'go', 'rust']) assert.ok(languages.has(language), language);
});
