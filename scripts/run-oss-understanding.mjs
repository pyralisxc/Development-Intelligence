#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLocalGraph } from '../dist/src/intelligence/local.js';
import { generateTestClaimCatalog } from '../dist/src/intelligence/testClaimInventory.js';
import { mergeJoernDataflowEvidence, pageJoernDataflowEvidence, projectLocalJoernDataflow } from '../dist/src/intelligence/joernDataflow.js';
import { mergeNodeTestEventReports, projectNodeTestEvents } from '../dist/src/intelligence/nodeTestEvidence.js';
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
    sourceSuffixes: ['.test.ts', '.test.mjs', '.test.js', '.test.tsx', '.spec.ts', '.spec.tsx', '.spec.js'],
  });
  const scratch = await fs.mkdtemp(path.join(root, '.di-oss-evidence-'));
  let joernResult = null, testResult = null, runExit = null;
  let joernProjection = null, nodeProjection = null;
  const measures = {};
  try {
    if (joern) {
      // Build the open-source CPG once, then use independently bounded
      // source-filtered slices. One large JSON/input cap must not become
      // the maximum evidence corpus that DI is capable of validating.
      const requestedFilters = flags('--joern-file-filter').map(value =>
        limit(value, 'Joern file filter', 160));
      const fileFilters = requestedFilters.length ? [...new Set(requestedFilters)] : [null];
      if (fileFilters.length > 64 || fileFilters.length !== (requestedFilters.length || 1)) {
        throw new Error('Joern source shards require 1..64 unique source filters');
      }
      const sinkFilter = flag('--joern-sink-filter')
        ? limit(flag('--joern-sink-filter'), 'Joern sink filter', 160) : null;
      const depth = Number(flag('--joern-depth') || '12');
      const timeoutMs = Number(flag('--joern-timeout-ms') || '600000');
      if (!Number.isSafeInteger(depth) || depth < 1 || depth > 100
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
        throw new Error('Joern depth 1..100 and subprocess timeout 1s..1h required');
      }
      const limitFlags = [
        ['--joern-max-slice-bytes', 'maxSliceBytes'],
        ['--joern-max-slice-nodes', 'maxSliceNodes'],
        ['--joern-max-slice-edges', 'maxSliceEdges'],
        ['--joern-max-source-files', 'maxSourceFiles'],
        ['--joern-max-source-file-bytes', 'maxSourceFileBytes'],
        ['--joern-max-code-chars', 'maxCodeChars'],
      ];
      const budget = {};
      for (const [flagName, key] of limitFlags) {
        const raw = flag(flagName);
        if (raw !== undefined) budget[key] = Number(raw);
      }
      const requestedDir = flag('--joern-evidence-dir');
      let outputDir = null;
      if (requestedDir) {
        if (path.isAbsolute(requestedDir) || requestedDir.includes('\\')
          || requestedDir.split('/').some(seg => !seg || seg === '.' || seg === '..')) {
          throw new Error('Joern artifact directory must be canonical and inside checkout');
        }
        const dest = path.resolve(root, requestedDir);
        if (!inside(root, dest)) throw new Error('Joern artifact directory escapes checkout');
        const parent = await fs.realpath(path.dirname(dest));
        if (!inside(root, parent)) throw new Error('Joern artifact parent escapes checkout');
        await fs.mkdir(dest, { mode: 0o700 });
        outputDir = dest;
      }
      const executable = await fs.realpath(path.resolve(joern));
      const parser = await fs.realpath(path.resolve(flag('--joern-parse-executable')
        || path.join(path.dirname(executable), 'joern-parse')));
      const cpg = path.join(scratch, 'joern-cpg.bin');
      const parseStarted = Date.now();
      const parsed = await run(parser, [
        root, '--output', cpg,
        ...(requestedLanguage ? ['--language', requestedLanguage] : []),
      ], { cwd: root, timeoutMs });
      measures.joernParseMs = Date.now() - parseStarted;
      if (parsed.code !== 0) {
        throw new Error('Pinned Joern source frontend failed: '
          + (parsed.stderr || parsed.stdout).trim().slice(-700));
      }
      const cpgFile = await fs.lstat(cpg);
      if (!cpgFile.isFile() || cpgFile.size === 0) {
        throw new Error('Joern source frontend produced no ordinary CPG binary');
      }
      const segments = [];
      const unknownSegments = [];
      const outputs = [];
      let cumulativeMs = 0;
      for (const [index, fileFilter] of fileFilters.entries()) {
        const ordinal = String(index).padStart(4, '0');
        const folder = path.join(scratch, 'joern-source-segment-' + ordinal);
        await fs.mkdir(folder);
        const output = path.join(folder, 'dataflow.json');
        const started = Date.now();
        const executed = await run(executable, ['data-flow',
          '-o', output,
          ...(fileFilter ? ['--file-filter', fileFilter] : []),
          ...(sinkFilter ? ['--sink-filter', sinkFilter] : []),
          '--slice-depth', String(depth), cpg],
        { cwd: folder, timeoutMs });
        cumulativeMs += Date.now() - started;
        if (executed.code !== 0) {
          throw new Error('Pinned Joern segment ' + index + ' failed (no absence proof): '
            + (executed.stderr || executed.stdout).trim().slice(-700));
        }
        const produced = await fs.readdir(folder);
        const names = produced.filter(name => name.endsWith('.json'));
        if (names.length === 0) {
          // Upstream reports Empty slice, no file generated. Not a negative
          // dataflow result for an arbitrary source/analysis scope.
          unknownSegments.push({ index, fileFilter, state: 'no-dataflow-json',
            missingOutputIsNotAbsenceProof: true });
          continue;
        }
        if (names.length !== 1) {
          throw new Error('Joern source segment ' + index + ' emitted ambiguous JSON artifacts');
        }
        const generated = path.join(folder, names[0]);
        const projection = await projectLocalJoernDataflow({
          root, graph, slicePath: path.relative(root, generated),
          producerVersion: requestedVersion, testCatalog: catalog, budget,
        });
        segments.push(projection);
        if (outputDir) {
          const retained = 'joern-source-segment-' + ordinal + '.json';
          await fs.copyFile(generated, path.join(outputDir, retained),
            fs.constants.COPYFILE_EXCL);
          outputs.push(path.relative(root, path.join(outputDir, retained))
            .split(path.sep).join('/'));
        }
      }
      measures.joernSliceMs = cumulativeMs;
      if (!segments.length) {
        throw new Error('Pinned Joern returned no source-backed dataflow JSON from '
          + fileFilters.length + ' requested segments; no absence proof established');
      }
      const projected = mergeJoernDataflowEvidence({ canonical: graph, segments });
      joernProjection = projected;
      joernResult = {
        producer: projected.producer,
        overlayGraphId: projected.graph.graphId,
        counts: projected.counts,
        candidates: projected.candidates,
        candidatePresentation: pageJoernDataflowEvidence(projected, 0, 20).page,
        segmentPopulation: projected.segmentPopulation ?? null,
        segmentCoverage: {
          requested: fileFilters.length, sourceValidated: segments.length,
          omitted: unknownSegments.length,
          completeForRequestedFilters: unknownSegments.length === 0,
          unknownSegments,
          persistedJsonPaths: outputs,
          artifactPersistence: outputDir ? 'operator-requested-local-files' : 'scratch-deleted',
        },
        budget: projected.budget,
        policy: projected.policy,
        executedPinnedBinaryLocally: true,
        parsedSourceToEphemeralCpg: true,
        parsedSourceWithLanguage: requestedLanguage ?? 'auto-detected',
        fileFilters, sinkFilter, depth,
      };
    }
    if (requestedTestFiles.length) {
      // Process explicit exact-Git file selections in independently bounded
      // native subprocesses, NOT a one-shot 40-file ceiling. Joined event
      // evidence is source-validated before presentation/paging.
      const uniqueNames = [...new Set(requestedTestFiles)].sort();
      const chunkSize = Number(flag('--node-batch-size') || '40');
      const maxFiles = Number(flag('--node-max-files') || '5000');
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 40
        || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 20000) {
        throw new Error('Native test batch size 1..40 and total budget 1..20000 required');
      }
      if (uniqueNames.length > maxFiles) {
        throw new Error('Exact native test selection exceeds the configured max-files '
          + maxFiles + '; no negative result can be inferred');
      }
      const targets = await Promise.all(uniqueNames.map(name => trustedTarget(root, name)));
      const requestedBundleDir = flag('--node-evidence-dir');
      let outputDir = null;
      if (requestedBundleDir) {
        // Opt-in persistent evidence is locally scoped and untracked.
        // Untrusted native report names are never used as output paths.
        if (path.isAbsolute(requestedBundleDir) || requestedBundleDir.includes('\\')
          || requestedBundleDir.split('/').some(seg => !seg || seg === '.' || seg === '..')) {
          throw new Error('Native evidence directory must be canonical and inside the checkout');
        }
        const target = path.resolve(root, requestedBundleDir);
        if (!inside(root, target)) throw new Error('Native evidence directory escapes checkout');
        const parent = await fs.realpath(path.dirname(target));
        if (!inside(root, parent)) throw new Error('Native evidence directory parent escapes checkout');
        await fs.mkdir(target, { mode: 0o700 });
        outputDir = target;
      }
      const reporterPath = new URL('./node-test-events-reporter.mjs', import.meta.url).href;
      const parts = [];
      const artifactPaths = [];
      const starts = [];
      const exits = [];
      for (let start = 0; start < targets.length; start += chunkSize) {
        const chunk = targets.slice(start, start + chunkSize);
        const started = Date.now();
        const executed = await run(process.execPath, [
          '--test', '--test-reporter=' + reporterPath, ...chunk.map(item => item.full),
        ], { cwd: root, timeoutMs: 180000, env: { NODE_TEST_CONTEXT: undefined } });
        starts.push(Date.now() - started);
        exits.push(executed.code);
        if (!executed.stdout.trim()) {
          throw new Error('Native test batch emitted no structured events; no negative execution proof');
        }
        const ordinal = String(parts.length).padStart(4, '0');
        const name = 'node-test-events-' + ordinal + '.jsonl';
        const reportPath = path.join(scratch, name);
        await fs.writeFile(reportPath, executed.stdout);
        const associated = await projectNodeTestEvents({
          root, graph, catalog, eventPath: path.relative(root, reportPath),
          nodeVersion: process.version, runId: 'operator-owned-local-execution',
        });
        parts.push(associated);
        if (outputDir) {
          await fs.writeFile(path.join(outputDir, name), executed.stdout, {
            encoding: 'utf8', flag: 'wx', mode: 0o600,
          });
          artifactPaths.push(path.relative(root, path.join(outputDir, name)).split(path.sep).join('/'));
        }
      }
      const joined = mergeNodeTestEventReports(parts);
      nodeProjection = joined;
      runExit = exits.every(code => code === 0) ? 0 : 1;
      measures.nodeTestMs = starts.reduce((sum, ms) => sum + ms, 0);
      testResult = {
        exitCode: runExit,
        exactSourceFiles: targets.map(item => item.relative),
        identity: joined.identity, counts: joined.counts,
        tests: joined.tests.slice(0, 20),
        eventPresentation: {
          returned: Math.min(20, joined.tests.length), total: joined.tests.length,
          hasMore: joined.tests.length > 20,
          completeInternalPopulationUsedForAssertionJoin: true,
          batchCount: parts.length, batchFileLimit: chunkSize,
          boundedInputReportSha256s: parts.map(part => part.identity.reportSha256),
          recoverableReportFiles: artifactPaths,
          artifactPersistence: outputDir ? 'operator-requested-local-files' : 'scratch-deleted',
        },
        policy: joined.policy,
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
