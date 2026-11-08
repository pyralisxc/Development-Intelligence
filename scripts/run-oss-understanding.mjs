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
  const requestedLanguage = flag('--joern-language');
  if (requestedLanguage && !/^[A-Z_]{2,30}$/u.test(requestedLanguage)) {
    throw new Error('Joern language must be a bounded frontend identity');
  }
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
      // Joern data-flow starts at call arguments. Its sink regex matches
      // their code (e.g. "observed"), NOT necessarily the call name
      // (e.g. "assert.equal"). On a disposable small fixture the unfiltered
      // producer is the truthful baseline; a caller may opt into filters.
      const fileFilter = flag('--joern-file-filter')
        ? limit(flag('--joern-file-filter'), 'Joern file filter', 160) : null;
      const sinkFilter = flag('--joern-sink-filter')
        ? limit(flag('--joern-sink-filter'), 'Joern sink filter', 160) : null;
      const depth = Number(flag('--joern-depth') || '12');
      if (!Number.isInteger(depth) || depth < 1 || depth > 20) {
        throw new Error('Joern depth must be from 1 to 20');
      }
      const executable = await fs.realpath(path.resolve(joern));
      // Pinned Joern v4 slicer accepts a CPG binary, not raw Git directories.
      // Build the temporary CPG with the matching open-source frontend first.
      const parserInput = flag('--joern-parse-executable')
        || path.join(path.dirname(executable), 'joern-parse');
      const parser = await fs.realpath(path.resolve(parserInput));
      const cpg = path.join(scratch, 'joern-cpg.bin');
      const parseStarted = Date.now();
      const parsed = await run(parser, [
        root, '--output', cpg,
        ...(requestedLanguage ? ['--language', requestedLanguage] : []),
      ], { cwd: root, timeoutMs: 600000 });
      measures.joernParseMs = Date.now() - parseStarted;
      if (parsed.code !== 0) {
        const diagnostic = (parsed.stderr || parsed.stdout).trim();
        throw new Error('Pinned Joern source frontend failed: ' + diagnostic.slice(0, 700));
      }
      const cpgFile = await fs.lstat(cpg);
      if (!cpgFile.isFile() || cpgFile.size === 0) {
        throw new Error('Joern source frontend produced no ordinary CPG binary');
      }
      const output = path.join(scratch, 'joern-dataflow.json');
      const start = Date.now();
      const processResult = await run(executable, ['data-flow',
        '-o', output,
        ...(fileFilter ? ['--file-filter', fileFilter] : []),
        ...(sinkFilter ? ['--sink-filter', sinkFilter] : []),
        '--slice-depth', String(depth), cpg],
      { cwd: scratch, timeoutMs: 600000 });
      measures.joernSliceMs = Date.now() - start;
      if (processResult.code !== 0) {
        const diagnostic = (processResult.stderr || processResult.stdout).trim();
        throw new Error('Pinned Joern slicer failed (no graph evidence admitted): '
          + diagnostic.slice(0, 900));
      }
      const produced = await fs.readdir(scratch);
      // Joern versions suffix --out differently; only a unique JSON written
      // into our isolated scratch directory can be admitted as evidence.
      const names = produced.filter(name => name.endsWith('.json')
        && name !== 'joern-cpg.bin');
      if (names.length !== 1) {
        throw new Error('Joern must emit exactly one bounded JSON dataflow slice; files='
          + produced.sort().slice(0, 12).join(',').slice(0, 350));
      }
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
        parsedSourceToEphemeralCpg: true,
        parsedSourceWithLanguage: requestedLanguage ?? 'auto-detected',
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
