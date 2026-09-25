import assert from 'node:assert/strict';
import test from 'node:test';
import { planVcrRetention } from './vcr-retention-lib.mjs';

const now = Date.parse('2026-09-24T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const sha = digit => digit.repeat(40);
const deployment = (id, commit, ageDays, target = null, state = 'READY') => ({ uid: id, state, target, created: now - ageDays * day, meta: { githubCommitSha: commit } });
const image = (id, tags, ageDays) => ({ id, digest: `sha256:${id}`, tags, createdAt: new Date(now - ageDays * day).toISOString() });

test('retention protects current production, one rollback, and recent previews', () => {
  const plan = planVcrRetention({
    now,
    images: [
      image('current', [sha('1').slice(0, 12)], 30),
      image('rollback', [sha('2').slice(0, 12)], 30),
      image('old-prod', [sha('3').slice(0, 12)], 10),
      image('recent-preview', [sha('4').slice(0, 12)], 0.5),
      image('old-preview', [sha('5').slice(0, 12)], 2),
      image('untagged', [], 2),
      image('shared', ['production', sha('5').slice(0, 12)], 40),
    ],
    deployments: [
      deployment('prod-current', sha('1'), 1, 'production'),
      deployment('prod-rollback', sha('2'), 2, 'production'),
      deployment('prod-old', sha('3'), 10, 'production'),
      deployment('preview-recent', sha('4'), 0.5),
      deployment('preview-old', sha('5'), 2),
    ],
  });
  const actions = Object.fromEntries(plan.decisions.map(item => [item.id, [item.action, item.reason]]));
  assert.equal(actions.current[0], 'keep');
  assert.equal(actions.rollback[0], 'keep');
  assert.equal(actions['old-prod'][0], 'delete');
  assert.equal(actions['recent-preview'][0], 'keep');
  assert.equal(actions['old-preview'][0], 'delete');
  assert.equal(actions.untagged[0], 'delete');
  assert.deepEqual(actions.shared, ['keep', 'protected production tag']);
  assert.equal(plan.counts.delete, 3);
  assert.equal(plan.counts.headroomAfter, 46);
  assert.equal(plan.retainedTargetReached, true);
});

test('unknown old tags require review instead of automatic deletion', () => {
  const plan = planVcrRetention({ now, images: [image('unknown', ['release-candidate'], 30)], deployments: [] });
  assert.deepEqual(plan.decisions[0], {
    id: 'unknown', digest: 'sha256:unknown', tags: ['release-candidate'],
    createdAt: now - 30 * day, ageDays: 30, action: 'review', reason: 'old image has tags not correlated to a deployment', protected: false,
  });
});

test('retention protects the latest READY Preview deployment even when it is old', () => {
  const previewSha = sha('6');
  const plan = planVcrRetention({
    now,
    images: [image('preview', [previewSha.slice(0, 12)], 20)],
    deployments: [{
      ...deployment('preview-ready', previewSha, 20),
      meta: { githubCommitSha: previewSha, githubCommitRef: 'preview' },
    }],
  });
  assert.deepEqual(plan.decisions[0], {
    id: 'preview', digest: 'sha256:preview', tags: [previewSha.slice(0, 12)],
    createdAt: now - 20 * day, ageDays: 20, action: 'keep', reason: 'latest READY preview deployment', protected: true,
  });
});

test('retention trims oldest nonprotected images to the configured target', () => {
  const images = Array.from({ length: 12 }, (_, index) => image(`candidate-${index}`, [sha(String(index % 10)).slice(0, 12)], index / 24));
  const plan = planVcrRetention({ now, images, deployments: [], retainedImageTarget: 10 });
  assert.equal(plan.counts.delete, 2);
  assert.equal(plan.counts.retained, 10);
  assert.equal(plan.retainedTargetReached, true);
  assert.deepEqual(
    plan.decisions.filter(item => item.action === 'delete').map(item => item.id),
    ['candidate-10', 'candidate-11'],
  );
});
