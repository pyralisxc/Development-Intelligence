import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claimIndexRequest } from '../src/storage/control.js';
import { indexRevisionNow, readProjectState, refreshCodebase } from '../src/codebase/sourceManager.js';
import { runChecked } from '../src/util/process.js';

async function commit(repo: string, message: string): Promise<string> {
  await runChecked('git', ['-C', repo, 'add', '.']);
  await runChecked('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message]);
  return (await runChecked('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-concurrency-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const data = path.join(root, 'data');
  await runChecked('git', ['init', '--bare', '--initial-branch=main', remote]);
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await fs.writeFile(path.join(source, 'index.ts'), 'export const version = 1;\n');
  const sha = await commit(source, 'initial');
  await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await runChecked('git', ['-C', source, 'push', '-u', 'origin', 'main']);

  const project = 'ConcurrencyProject';
  const repository = pathToFileURL(remote).href;
  await fs.writeFile(config, JSON.stringify({
    [project]: {
      repository,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      credential: { type: 'none' },
    },
  }, null, 2));

  process.env.DEVINT_PROJECTS_FILE = config;
  process.env.DEVINT_DATA_DIR = data;
  process.env.DEVINT_ARTIFACT_DIR = path.join(data, 'artifacts');
  process.env.DEVINT_CONTROL_DIR = path.join(data, 'control');
  process.env.DEVINT_EPHEMERAL_DIR = path.join(data, 'ephemeral');
  delete process.env.DEVINT_FIRESTORE_ENABLED;
  delete process.env.DEVINT_GCS_BUCKET;
  return { root, source, project, repository, sha };
}

function clearEnv() {
  delete process.env.DEVINT_CLOUD_RUN_JOB_RESOURCE;
  delete process.env.DEVINT_INDEX_EXECUTION;
  delete process.env.DEVINT_INDEX_PROJECT;
  delete process.env.DEVINT_INDEX_REF;
  delete process.env.DEVINT_INDEX_SHA;
}

test('refresh deduplicates an already queued request for the same revision before dispatch', async () => {
  const value = await fixture();
  try {
    const requestedAt = new Date().toISOString();
    const claimed = await claimIndexRequest(value.project, value.sha, {
      project: value.project,
      repository: value.repository,
      ref: 'refs/heads/main',
      lastIndexStatus: 'queued',
      lastIndexRequestedAt: requestedAt,
    });
    assert.equal(claimed, true);

    // A real dispatch would require Google credentials. The duplicate claim must return
    // before reaching the provider boundary.
    process.env.DEVINT_CLOUD_RUN_JOB_RESOURCE = 'projects/test/locations/us-central1/jobs/development-intelligence-index';
    const result = await refreshCodebase(value.project) as any;
    assert.equal(result.deduplicated, true);
    assert.equal(result.queued, true);
    assert.equal(result.upstreamSha, value.sha);

    const state = await readProjectState(value.project);
    assert.equal(state.indexingSha, value.sha);
    assert.equal(state.lastIndexStatus, 'queued');
  } finally {
    clearEnv();
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('a worker bound to an older revision becomes superseded instead of following a moved ref', async () => {
  const value = await fixture();
  try {
    const claimed = await claimIndexRequest(value.project, value.sha, {
      project: value.project,
      repository: value.repository,
      ref: 'refs/heads/main',
      lastIndexStatus: 'queued',
      lastIndexRequestedAt: new Date().toISOString(),
    });
    assert.equal(claimed, true);

    await fs.writeFile(path.join(value.source, 'index.ts'), 'export const version = 2;\n');
    const newerSha = await commit(value.source, 'newer');
    await runChecked('git', ['-C', value.source, 'push', 'origin', 'main']);
    assert.notEqual(newerSha, value.sha);

    const result = await indexRevisionNow(value.project, 'refs/heads/main', value.sha) as any;
    assert.equal(result.superseded, true);
    assert.equal(result.promoted, false);

    const state = await readProjectState(value.project);
    assert.equal(state.selectedSha, null);
    assert.equal(state.selectedBundleId, null);
    assert.equal(state.indexingSha, null);
    assert.equal(state.lastIndexStatus, 'superseded');
    assert.match(state.lastError ?? '', /superseded/);
  } finally {
    clearEnv();
    await fs.rm(value.root, { recursive: true, force: true });
  }
});
