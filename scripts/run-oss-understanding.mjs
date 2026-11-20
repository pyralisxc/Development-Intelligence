#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLocalGraph, buildLocalWorkingGraph } from '../dist/src/intelligence/local.js';
import { sourceFingerprint } from '../dist/src/intelligence/repository.js';
import { saveLocalSourceGraph } from '../dist/src/intelligence/localGraphStore.js';
import { generateTestClaimCatalog } from '../dist/src/intelligence/testClaimInventory.js';
import { projectLocalJoernDataflow, projectJoernDataflowBytes } from '../dist/src/intelligence/joernDataflow.js';
import { projectNodeTestEvents } from '../dist/src/intelligence/nodeTestEvidence.js';
import { joinAssertionEvidence } from '../dist/src/intelligence/assertionEvidenceRouting.js';
import { deriveSourceExecutionFacts, correlateSourceExecutionFacts } from '../dist/src/intelligence/sourceExecutionFacts.js';
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
  if (!inside(root, full) || !/\.(?:test|spec)\.(?:mjs|js)$/u.test(full)) {
    throw new Error('Only tracked direct .test.js/.test.mjs (or .spec) files can be executed by this worker');
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
async function runJoern(executable, args, options) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(executable)) {
    // Joern's batch files expand arguments through cmd. Reject metacharacters
    // before invoking the fixed PowerShell script; no source text is code.
    if ([executable, ...args].some(value => /[&|<>^%!"()\r\n]/u.test(value))) {
      throw new Error('Joern Windows batch arguments cannot contain shell metacharacters');
    }
    const script = '$x=ConvertFrom-Json $env:DI_JOERN_COMMAND; & $x.exe @($x.args); exit $LASTEXITCODE';
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      ...options, killTree: true,
      env: { ...options.env, DI_JOERN_COMMAND: JSON.stringify({ exe: executable, args }) },
    });
  }
  return run(executable, args, { ...options, killTree: true });
}
async function main() {
  const root = await fs.realpath(path.resolve(flag('--repo-path') || '.'));
  const project = flag('--project') || path.basename(root);
  const joern = flag('--joern-executable');
  const requestedVersion = flag('--joern-version');
  const requestedLanguage = flag('--joern-language');
  const sliceOutput = flag('--joern-slice-output');
  const workingData = flag('--activate-working-data-dir');
  const javaHome = flag('--joern-java-home');
  const sourceSelection = flag('--joern-source');
  const memoryMb = Number(flag('--joern-memory-mb') || '1024');
  const timeoutSeconds = Number(flag('--joern-timeout-seconds') || '300');
  if (!Number.isSafeInteger(memoryMb) || memoryMb < 512 || memoryMb > 8192) throw new Error('Joern memory must be 512–8192 MiB');
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) throw new Error('Joern timeout must be 10–3600 seconds per process');
  if (sliceOutput && !joern) throw new Error('--joern-slice-output requires --joern-executable');
  if ((workingData || javaHome || sourceSelection) && !joern) throw new Error('Joern build options require --joern-executable');
  const retain = Number(flag('--retain') || '3');
  if (!Number.isSafeInteger(retain) || retain < 1) throw new Error('--retain must be a positive integer');
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
  if (!workingData && status.stdout.trim()) throw new Error('Exact-source evidence worker requires a clean tracked checkout');
  if (workingData && requestedTestFiles.length) throw new Error('Working Joern graph builds cannot run exact-revision native tests in the same operation');
  const initialFingerprint = workingData ? await sourceFingerprint(root, true) : null;
  if (workingData && (path.resolve(workingData) === root || inside(root, path.resolve(workingData)))) throw new Error('Working graph data directory must be outside the inspected checkout');
  const graph = workingData ? await buildLocalWorkingGraph(root, project) : await buildLocalGraph(root, project);
  const catalog = workingData ? null : await generateTestClaimCatalog(root, graph, {
    sourcePrefixes: ['tests/', 'scripts/', 'packaging/'],
    sourceSuffixes: ['.test.ts', '.test.mjs', '.test.js', '.test.tsx', '.spec.ts', '.spec.tsx', '.spec.js'],
  });
  const sourceExecutionFacts = catalog ? await deriveSourceExecutionFacts(root, catalog, graph.graphId) : null;
  const scratchParent = workingData ? path.resolve(process.env.DEVINT_SCRATCH_DIR || os.tmpdir()) : root;
  await fs.mkdir(scratchParent, { recursive: true });
  const physicalScratch = await fs.realpath(scratchParent);
  if (workingData && (physicalScratch === root || inside(root, physicalScratch))) throw new Error('Joern scratch directory must be outside the inspected checkout');
  const scratch = await fs.mkdtemp(path.join(physicalScratch, '.di-oss-evidence-'));
  let joernResult = null, testResult = null, runExit = null;
  let joernProjection = null, nodeProjection = null;
  let joernBytes = null;
  let joernPrefix;
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
        || path.join(path.dirname(executable), process.platform === 'win32' && /\.bat$/iu.test(executable) ? 'joern-parse.bat' : 'joern-parse');
      const parser = await fs.realpath(path.resolve(parserInput));
      let parseSource = root;
      if (sourceSelection) {
        parseSource = await fs.realpath(path.resolve(root, sourceSelection));
        if (!inside(root, parseSource) || !(await fs.stat(parseSource)).isFile()) throw new Error('Joern source must be a regular file within the checkout');
        const relative = path.relative(root, parseSource).split(path.sep).join('/');
        if (!workingData) await runChecked('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relative]);
        const parent = path.posix.dirname(relative);
        if (parent !== '.') joernPrefix = parent;
      }
      const joernEnv = { JAVA_OPTS: `-Xmx${memoryMb}m`, ...(javaHome ? { JAVA_HOME: await fs.realpath(path.resolve(javaHome)) } : {}) };
      const cpg = path.join(scratch, 'joern-cpg.bin');
      const parseStarted = Date.now();
      const parsed = await runJoern(parser, [
        parseSource, '--output', cpg,
        ...(requestedLanguage ? ['--language', requestedLanguage] : []),
      ], { cwd: root, timeoutMs: timeoutSeconds * 1000, env: joernEnv });
      measures.joernParseMs = Date.now() - parseStarted;
      if (parsed.code !== 0) {
        if (parsed.timedOut) throw new Error(`Joern source frontend exceeded ${timeoutSeconds} seconds; the previous graph remains active`);
        const diagnostic = (parsed.stderr || parsed.stdout).trim();
        throw new Error('Pinned Joern source frontend failed: ' + diagnostic.slice(0, 700));
      }
      const cpgFile = await fs.lstat(cpg);
      if (!cpgFile.isFile() || cpgFile.size === 0) {
        throw new Error('Joern source frontend produced no ordinary CPG binary');
      }
      const output = path.join(scratch, 'joern-dataflow.json');
      const start = Date.now();
      const processResult = await runJoern(executable, ['data-flow',
        '-o', output,
        ...(fileFilter ? ['--file-filter', fileFilter] : []),
        ...(sinkFilter ? ['--sink-filter', sinkFilter] : []),
        '--slice-depth', String(depth), cpg],
      { cwd: scratch, timeoutMs: timeoutSeconds * 1000, env: joernEnv });
      measures.joernSliceMs = Date.now() - start;
      if (processResult.code !== 0) {
        if (processResult.timedOut) throw new Error(`Joern slicer exceeded ${timeoutSeconds} seconds; the previous graph remains active`);
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
        // Diagnostics are opt-in because frontend logs may contain private
        // source paths. The fixture CI explicitly enables them only on synthetic
        // source; source code is never sent to a remote analysis service.
        const debug = process.argv.includes('--joern-debug-producer')
          ? ('; parser=' + (parsed.stdout + '\n' + parsed.stderr).trim().slice(-600)
            + '; slicer=' + (processResult.stdout + '\n' + processResult.stderr).trim().slice(-600))
          : '';
        throw new Error('Joern must emit exactly one bounded JSON dataflow slice; cpgBytes='
          + cpgFile.size + '; files='
          + produced.sort().slice(0, 12).join(',').slice(0, 350) + debug);
      }
      const slicePath = path.join(scratch, names[0]);
      const sliceStat = await fs.lstat(slicePath);
      if (!sliceStat.isFile() || sliceStat.isSymbolicLink() || sliceStat.size < 1 || sliceStat.size > 16 * 1024 * 1024) throw new Error('Joern slice must be a bounded ordinary JSON file');
      joernBytes = await fs.readFile(slicePath);
      const projected = workingData
        ? await projectJoernDataflowBytes({ root, graph, bytes: joernBytes, producerVersion: requestedVersion,
          ...(joernPrefix ? { projectPrefix: joernPrefix } : {}) })
        : await projectLocalJoernDataflow({ root, graph, slicePath: path.relative(root, path.join(scratch, names[0])),
          producerVersion: requestedVersion, testCatalog: catalog, ...(joernPrefix ? { projectPrefix: joernPrefix } : {}) });
      joernProjection = projected;
      let savedSlice = null;
      if (sliceOutput) {
        const destination = path.resolve(limit(sliceOutput, 'Joern slice output', 2048));
        const parent = await fs.realpath(path.dirname(destination));
        const actualDestination = path.join(parent, path.basename(destination));
        if (inside(root, actualDestination) || actualDestination === root) {
          throw new Error('Joern slice output must be outside the inspected checkout');
        }
        // Preserve only on explicit request, without replacing existing data.
        // Projection above has already validated the bounded JSON and source.
        await fs.writeFile(actualDestination, joernBytes, { flag: 'wx', mode: 0o600 });
        savedSlice = actualDestination;
      }
      joernResult = {
        producer: projected.producer,
        overlayGraphId: projected.graph.graphId,
        counts: projected.counts,
        candidates: projected.candidates,
        policy: projected.policy,
        executedPinnedBinaryLocally: true,
        parsedSourceToEphemeralCpg: true,
        parsedSourceWithLanguage: requestedLanguage ?? 'auto-detected',
        fileFilter, sinkFilter, depth, savedSlice, sourceSelection: sourceSelection ?? null, memoryMb, timeoutSeconds,
      };
    }
    if (requestedTestFiles.length) {
      const uniqueTargets = [...new Set(requestedTestFiles)];
      // File count is not a proof limit. Bound each native subprocess for
      // resource isolation, and process every exact tracked target in batches.
      // The complete event population is rejoined before assertion assessment.
      const batchSize = Number(flag('--node-test-batch-size') || '40');
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 200) {
        throw new Error('Node test batch size must be an integer from 1 to 200');
      }
      const targets = await Promise.all(uniqueTargets.map(name => trustedTarget(root, name)));
      const reporterPath = new URL('./node-test-events-reporter.mjs', import.meta.url).href;
      const start = Date.now();
      const batches = [];
      const combined = [];
      let allPassed = true;
      for (let offset = 0; offset < targets.length; offset += batchSize) {
        const group = targets.slice(offset, offset + batchSize);
        const executed = await run(process.execPath, [
          '--test', '--test-reporter=' + reporterPath, ...group.map(item => item.full),
        ], { cwd: root, timeoutMs: 180000, env: { NODE_TEST_CONTEXT: undefined } });
        if (!executed.stdout.trim()) {
          throw new Error('Node test batch ' + batches.length + ' emitted no structured events');
        }
        const events = executed.stdout.trim().split(/\r?\n/u);
        // Validate every event envelope before admitting the aggregate;
        // do not allow a failed batch to disappear behind later successes.
        for (const line of events) {
          const event = JSON.parse(line);
          if ((event.schemaVersion !== 1 && event.schemaVersion !== 2)
            || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)
            || typeof event.type !== 'string') {
            throw new Error('Native test batch emitted an invalid structured event');
          }
          if (event.schemaVersion === 2 && (event.type === 'test:pass' || event.type === 'test:fail')) {
            const { skip, todo } = event.data;
            if (typeof skip !== 'boolean' || typeof todo !== 'boolean'
              || (skip && todo) || (event.type === 'test:fail' && (skip || todo))) {
              throw new Error('Native test batch v2 event has invalid pass/skip/TODO flags');
            }
          }
        }
        combined.push(...events);
        batches.push({
          index: batches.length, fileCount: group.length, exitCode: executed.code,
          eventCount: events.length,
        });
        if (executed.code !== 0) allPassed = false;
      }
      measures.nodeTestMs = Date.now() - start;
      const reportPath = path.join(scratch, 'node-test-events.jsonl');
      await fs.writeFile(reportPath, combined.join('\n') + '\n');
      const associated = await projectNodeTestEvents({
        root, graph, catalog, eventPath: path.relative(root, reportPath),
        nodeVersion: process.version, runId: 'operator-owned-local-execution',
      });
      nodeProjection = associated;
      runExit = allPassed ? 0 : 1;
      testResult = {
        exitCode: runExit, exactSourceFiles: targets.map(item => item.relative),
        batches, batchSize, allBatchesCompleted: batches.length === Math.ceil(targets.length / batchSize),
        identity: associated.identity, counts: associated.counts,
        tests: associated.tests.slice(0, 20),
        eventPresentation: {
          returned: Math.min(20, associated.tests.length), total: associated.tests.length,
          hasMore: associated.tests.length > 20,
          completeInternalPopulationUsedForAssertionJoin: true,
        },
        policy: associated.policy,
        executedLocally: true,
      };
    }
    const after = await runChecked('git', ['-C', root, 'rev-parse', 'HEAD']);
    if (after.stdout.trim() !== (graph.sourceState?.headRevision ?? graph.repositoryRevision)) {
      throw new Error('Source revision changed during OSS evidence run');
    }
    const factsForThisRun = nodeProjection && sourceExecutionFacts
      ? correlateSourceExecutionFacts(sourceExecutionFacts, nodeProjection, 'direct-local-run')
      : sourceExecutionFacts;
    let activatedWorking = null;
    if (workingData && joernBytes) {
      if (runExit !== null && runExit !== 0) throw new Error('A failed native test run cannot activate a graph');
      if (joernProjection.counts.sliceNodes && !joernProjection.counts.sourceLocatedNodes) throw new Error('Joern output could not be located in the selected source; the previous graph remains active');
      await fs.rm(scratch, { recursive: true, force: true });
      if (await sourceFingerprint(root, true) !== initialFingerprint) throw new Error('Working source changed during Joern analysis; the previous graph remains active');
      const working = await buildLocalWorkingGraph(root, project, { bytes: joernBytes, version: requestedVersion, ...(joernPrefix ? { projectPrefix: joernPrefix } : {}) });
      if (working.sourceFingerprint !== initialFingerprint || await sourceFingerprint(root, true) !== initialFingerprint) throw new Error('Working source changed before graph activation; the previous graph remains active');
      const retained = await saveLocalSourceGraph(path.resolve(workingData), working, retain);
      activatedWorking = { graphId: working.graphId, sourceFingerprint: working.sourceFingerprint, retained, producerCoverage: working.producerCoverage };
    }
    const result = {
      mode: 'operator-owned-open-source-understanding',
      project: graph.project, exactRevision: graph.repositoryRevision,
      ...(graph.sourceState ? { sourceState: graph.sourceState, sourceFingerprint: graph.sourceFingerprint } : {}),
      canonicalGraphId: graph.graphId, analyzerVersion: graph.analyzerVersion,
      joern: joernResult, nodeTests: testResult, measures,
      assertionEvidence: catalog ? joinAssertionEvidence({ graph, catalog,
        joern: joernProjection, testEvents: nodeProjection }) : null,
      sourceExecutionFacts: factsForThisRun ? {
        strategy: factsForThisRun.strategy, revision: factsForThisRun.revision,
        graphId: factsForThisRun.graphId, factsSha256: factsForThisRun.factsSha256,
        sourceFactsSha256: factsForThisRun.sourceFactsSha256,
        counts: factsForThisRun.counts, samples: factsForThisRun.facts.slice(0, 20),
        returned: Math.min(20, factsForThisRun.facts.length), total: factsForThisRun.facts.length,
        truncated: factsForThisRun.facts.length > 20, policy: factsForThisRun.policy,
      } : null,
      oneCanonicalGraph: true, changedCanonicalAuthority: Boolean(activatedWorking), activatedWorking,
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
