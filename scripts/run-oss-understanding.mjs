#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLocalGraph } from '../dist/src/intelligence/local.js';
import { generateTestClaimCatalog } from '../dist/src/intelligence/testClaimInventory.js';
import { projectLocalJoernDataflow } from '../dist/src/intelligence/joernDataflow.js';
import { projectNodeTestEvents } from '../dist/src/intelligence/nodeTestEvidence.js';
import { joinAssertionEvidence } from '../dist/src/intelligence/assertionEvidenceRouting.js';
import { run, runChecked } from '../dist/src/util/process.js';

/**
 * Operator-owned, self-hosted OSS evidence worker. Intentionally never
 * reachable through a hosted HTTP/MCP question: Joern is a heavyweight JVM.
 * One canonical DI graph is built and shared across source/dataflow/test views.
 */
const flag = name => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const flags = name => process.argv.flatMap((value, i) =>
  value === name && process.argv[i + 1] ? [process.argv[i + 1]] : []);
function limit(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || value.includes('\0')) throw new Error(name + ' must be a bounded nonempty value');
  return value;
}
function inside(root, absolute) {
  const rel = path.relative(root, absolute);
  return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
async function trustedTarget(root, name) {
  if (!name || name.startsWith('-')) throw new Error('Node test file must be an explicit tracked path');
  const full = path.resolve(root, name);
  if (!inside(root, full) || !/\.test\.mjs$/u.test(full)) {
    throw new Error('Only tracked direct .test.mjs source files can be executed by this worker');
  }
  const relative = path.relative(root, full).split(path.sep).join('/');
  const stat = await fs.lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing nonregular test source');
  const [expected, actual] = await Promise.all([
    runChecked('git', ['-C', root, 'rev-parse', 'HEAD:' + relative]),
    runChecked('git', ['-C', root, 'hash-object', '--', relative]),
  ]);
  if (expected.stdout.trim() !== actual.stdout.trim()) {
    throw new Error('Test file differs from the exact Git revision');
  }
  return { full, relative };
}
async function main() {
  const root = await fs.realpath(path.resolve(flag('--repo-path') || '.'));
  const project = flag('--project') || path.basename(root);
  const joern = flag('--joern-executable');
  const requestedVersion = flag('--joern-version');
  const requestedTestFiles = flags('--node-test-file');
  if (!joern && !requestedTestFiles.length) {
    throw new Error('Supply a local --joern-executable and/or explicit --node-test-file');
  }
  if (joern && !requestedVersion) {
    throw new Error('Joern binary requires a pinned --joern-version');
  }
  const status = await runChecked('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no']);
  if (status.stdout.trim()) throw new Error('Exact-source evidence worker requires a clean tracked checkout');
  const graph = await buildLocalGraph(root, project);
  const catalog = await generateTestClaimCatalog(root, graph, {
    sourcePrefixes: ['tests/', 'scripts/', 'packaging/'],
    sourceSuffixes: ['.test.ts', '.test.mjs', '.test.tsx', '.spec.ts', '.spec.tsx'],
  });
  const scratch = await fs.mkdtemp(path.join(root, '.di-oss-evidence-'));
  let joernResult = null, testResult = null, runExit = null;
  let joernProjection = null, nodeProjection = null;
  const measures = {};
  try {
    if (joern) {
      const fileFilter = limit(flag('--joern-file-filter') || '.*test.*',
        'Joern file filter', 160);
      const sinkFilter = limit(flag('--joern-sink-filter') || '.*assert.*',
        'Joern sink filter', 160);
      const depth = Number(flag('--joern-depth') || '12');
      if (!Number.isInteger(depth) || depth < 1 || depth > 20) {
        throw new Error('Joern depth must be from 1 to 20');
      }
      const executable = await fs.realpath(path.resolve(joern));
      const output = path.join(scratch, 'joern-dataflow.json');
      const start = Date.now();
      const processResult = await run(executable, ['data-flow', root,
        '-o', output, '--file-filter', fileFilter, '--sink-filter', sinkFilter,
        '--slice-depth', String(depth)],
      { cwd: root, timeoutMs: 600000 });
      measures.joernMs = Date.now() - start;
      if (processResult.code !== 0) {
        throw new Error('Pinned Joern process failed (no graph evidence admitted); '
          + processResult.stderr.slice(-450));
      }
      const names = (await fs.readdir(scratch)).filter(name =>
        name.startsWith('joern-dataflow') && name.endsWith('.json'));
      if (names.length !== 1) throw new Error('Joern must emit exactly one bounded JSON slice');
      const projected = await projectLocalJoernDataflow({
        root, graph, slicePath: path.relative(root, path.join(scratch, names[0])),
        producerVersion: requestedVersion, testCatalog: catalog,
      });
      joernProjection = projected;
      joernResult = {
        producer: projected.producer,
        overlayGraphId: projected.graph.graphId,
        counts: projected.counts,
        candidates: projected.candidates,
        policy: projected.policy,
        executedPinnedBinaryLocally: true,
        fileFilter, sinkFilter, depth,
      };
    }
    if (requestedTestFiles.length) {
      const uniqueTargets = [...new Set(requestedTestFiles)];
      if (uniqueTargets.length > 40) throw new Error('Native test run supports max 40 exact sources');
      const targets = await Promise.all(uniqueTargets.map(name => trustedTarget(root, name)));
      const reporterPath = new URL('./node-test-events-reporter.mjs', import.meta.url).href;
      const start = Date.now();
      const executed = await run(process.execPath, [
        '--test', '--test-reporter=' + reporterPath, ...targets.map(item => item.full),
      ], { cwd: root, timeoutMs: 180000, env: { NODE_TEST_CONTEXT: undefined } });
      measures.nodeTestMs = Date.now() - start;
      const reportPath = path.join(scratch, 'node-test-events.jsonl');
      if (!executed.stdout.trim()) throw new Error('Node test runner emitted no structured events');
      await fs.writeFile(reportPath, executed.stdout);
      const associated = await projectNodeTestEvents({
        root, graph, catalog, eventPath: path.relative(root, reportPath),
        nodeVersion: process.version, runId: 'operator-owned-local-execution',
      });
      nodeProjection = associated;
      runExit = executed.code;
      testResult = {
        exitCode: executed.code, exactSourceFiles: targets.map(item => item.relative),
        identity: associated.identity, counts: associated.counts,
        tests: associated.tests.slice(0, 20), policy: associated.policy,
        executedLocally: true,
      };
    }
    const after = await runChecked('git', ['-C', root, 'rev-parse', 'HEAD']);
    if (after.stdout.trim() !== graph.repositoryRevision) {
      throw new Error('Source revision changed during OSS evidence run');
    }
    const result = {
      mode: 'operator-owned-open-source-understanding',
      project: graph.project, exactRevision: graph.repositoryRevision,
      canonicalGraphId: graph.graphId, analyzerVersion: graph.analyzerVersion,
      joern: joernResult, nodeTests: testResult, measures,
      assertionEvidence: joinAssertionEvidence({ graph, catalog,
        joern: joernProjection, testEvents: nodeProjection }),
      oneCanonicalGraph: true, changedCanonicalAuthority: false,
      noAutomaticTestDeletion: true,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (runExit !== null && runExit !== 0) process.exitCode = 1;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(JSON.stringify({
    valid: false, error: error instanceof Error ? error.message : String(error),
    noFalseNegativeFromMissingProducer: true,
  }));
  process.exitCode = 1;
});
