import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);

async function run(command, args, options = {}) {
  const result = await exec(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-real-cbm-'));
const source = path.join(root, 'source');
const remote = path.join(root, 'remote.git');
const config = path.join(root, 'projects.json');
const data = path.join(root, 'data');
const project = 'RealCbmSmoke';

try {
  await run('git', ['init', '--bare', '--initial-branch=main', remote]);
  await run('git', ['init', '--initial-branch=main', source]);
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(source, 'src', 'smoke.ts'),
    `export function developmentIntelligenceSmokeMarker() {\n  return 'portable-artifact-roundtrip';\n}\n`,
  );
  await run('git', ['-C', source, 'add', '.']);
  await run('git', ['-C', source, '-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke', 'commit', '-m', 'smoke fixture']);
  await run('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await run('git', ['-C', source, 'push', '-u', 'origin', 'main']);

  await fs.writeFile(config, JSON.stringify({
    [project]: {
      repository: pathToFileURL(remote).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      credential: { type: 'none' },
    },
  }, null, 2));

  process.env.NODE_ENV = 'test';
  process.env.DEVINT_PROJECTS_FILE = config;
  process.env.DEVINT_DATA_DIR = data;
  process.env.DEVINT_CBM_BINARY = 'codebase-memory-mcp';
  process.env.DEVINT_CBM_VERSION = '0.10.8';
  process.env.DEVINT_INDEX_TIMEOUT_MS = '300000';
  process.env.DEVINT_HYDRATE_TIMEOUT_MS = '300000';
  process.env.CBM_WORKERS = '1';
  delete process.env.DEVINT_GCS_BUCKET;
  delete process.env.DEVINT_FIRESTORE_ENABLED;
  delete process.env.DEVINT_CLOUD_RUN_JOB_RESOURCE;

  const { indexRevisionNow, readProjectState } = await import('../dist/src/codebase/sourceManager.js');
  const { bundleCbmProject, loadBundleManifest } = await import('../dist/src/codebase/bundles.js');
  const { withHydratedBundle } = await import('../dist/src/codebase/hydration.js');
  const { callCurrentCodebase } = await import('../dist/src/codebase/proxy.js');

  const indexed = await indexRevisionNow(project);
  assert.equal(indexed.promoted, true, 'real CBM index must promote a validated revision bundle');

  const state = await readProjectState(project);
  assert.ok(state.selectedBundleId, 'selected bundle must be recorded');
  assert.ok(state.selectedSha, 'selected source SHA must be recorded');

  const manifest = await loadBundleManifest(project, state.selectedBundleId);
  assert.equal(manifest.sourceSha, state.selectedSha);
  assert.equal(manifest.cbmVersion, '0.10.8');
  assert.ok(manifest.artifacts.graph.bytes > 0, 'real CBM must emit a non-empty portable graph artifact');

  await withHydratedBundle(project, async bundle => {
    assert.equal(bundle.cbmProject, bundleCbmProject(project, manifest.bundleId), 'index and hydration must share one bundle-scoped CBM identity');
    assert.equal(bundle.manifest.sourceSha, state.selectedSha);
  });

  const result = await callCurrentCodebase(project, 'search_graph', {
    query: 'developmentIntelligenceSmokeMarker',
    limit: 20,
    format: 'json',
  });
  assert.match(JSON.stringify(result), /developmentIntelligenceSmokeMarker/, 'hydrated graph must answer a real symbol query');

  console.log(JSON.stringify({
    ok: true,
    project,
    sourceSha: state.selectedSha,
    bundleId: state.selectedBundleId,
    graphBytes: manifest.artifacts.graph.bytes,
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
