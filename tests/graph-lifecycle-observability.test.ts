import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { callTool } from '../src/mcp.js';
import { clearGraphCache, graphStatus } from '../src/intelligence/service.js';
import { clearToolExecutionDiagnostics } from '../src/observability.js';
import { runChecked } from '../src/util/process.js';

async function commit(repo: string, message: string): Promise<string> {
  await runChecked('git', ['-C', repo, 'add', '.']);
  await runChecked('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message]);
  return (await runChecked('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-observe-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const scratch = path.join(root, 'scratch');
  const project = 'LifecycleFixture';
  await fs.mkdir(scratch, { recursive: true });
  await runChecked('git', ['init', '--bare', '--initial-branch=main', remote]);
  await runChecked('git', ['init', '--initial-branch=main', source]);
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'panel.ts'), "export function Panel() { return 'ok'; }\n");
  await fs.writeFile(path.join(source, 'README.md'), '# Lifecycle Fixture\n');
  await commit(source, 'initial');
  await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
  await runChecked('git', ['-C', source, 'push', '-u', 'origin', 'main']);
  await fs.writeFile(config, JSON.stringify({
    [project]: {
      repository: pathToFileURL(remote).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      revisionPolicy: 'repository-history',
      credential: { type: 'none' },
      runtimeOrigins: [],
    },
  }, null, 2));
  process.env.DEVINT_PROJECTS_FILE = config;
  process.env.DEVINT_SCRATCH_DIR = scratch;
  process.env.DEVINT_GRAPH_CACHE_SIZE = '2';
  clearGraphCache();
  clearToolExecutionDiagnostics();
  return { root, project };
}

test('graph lifecycle diagnostics distinguish cold acquisition from warm process-cache access', async () => {
  const fixture = await makeFixture();
  try {
    const cold = await graphStatus(fixture.project) as any;
    assert.equal(cold.observability.graphAccess.cacheState, 'miss');
    assert.equal(cold.observability.persistence.mode, 'process-only');
    assert.equal(cold.observability.persistence.durable, false);
    assert.equal(cold.observability.persistence.state, 'not-configured');
    assert.ok(cold.observability.graphAccess.revisionResolutionMs >= 0);
    assert.ok(cold.observability.graphAccess.graphLoadMs >= 0);
    assert.ok(cold.observability.graphAccess.totalMs >= 0);
    assert.ok(cold.observability.coldBuild);
    assert.ok(cold.observability.coldBuild.checkout.totalMs >= 0);
    assert.ok(cold.observability.coldBuild.checkout.fetchMs >= 0);
    assert.ok(cold.observability.coldBuild.graphBuildMs >= 0);
    assert.ok(cold.observability.coldBuild.checkpointReadMs >= 0);

    const warm = await graphStatus(fixture.project) as any;
    assert.equal(warm.observability.graphAccess.cacheState, 'hit');
    assert.equal(warm.revision, cold.revision);
    assert.equal(warm.working.graphId, cold.working.graphId);
  } finally {
    clearGraphCache();
    clearToolExecutionDiagnostics();
    delete process.env.DEVINT_PROJECTS_FILE;
    delete process.env.DEVINT_SCRATCH_DIR;
    delete process.env.DEVINT_GRAPH_CACHE_SIZE;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('project status exposes the previous completed MCP tool execution timing', async () => {
  const fixture = await makeFixture();
  try {
    await callTool('search_graph', { project: fixture.project, query: 'Panel' });
    const status = await callTool('project_status', { project: fixture.project }) as any;
    assert.equal(status.graph.observability.lastToolCall.tool, 'search_graph');
    assert.equal(status.graph.observability.lastToolCall.project, fixture.project);
    assert.equal(status.graph.observability.lastToolCall.status, 'ok');
    assert.ok(status.graph.observability.lastToolCall.durationMs >= 0);
  } finally {
    clearGraphCache();
    clearToolExecutionDiagnostics();
    delete process.env.DEVINT_PROJECTS_FILE;
    delete process.env.DEVINT_SCRATCH_DIR;
    delete process.env.DEVINT_GRAPH_CACHE_SIZE;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
