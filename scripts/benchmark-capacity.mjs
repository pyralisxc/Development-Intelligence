import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const workerMarker = 'DEVINT_CAPACITY_RESULT=';

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? round((ordered[midpoint - 1] + ordered[midpoint]) / 2)
    : ordered[midpoint];
}

function metric(values) {
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

async function runWorker(root, sourceFiles) {
  const localModule = pathToFileURL(path.join(repositoryRoot, 'dist/src/intelligence/local.js')).href;
  const { buildLocalGraph } = await import(localModule);
  const started = process.hrtime.bigint();
  const graph = await buildLocalGraph(root, `Synthetic-${sourceFiles}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const memory = process.memoryUsage();
  const usage = process.resourceUsage();
  const result = {
    elapsedMs: round(elapsedMs),
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    evidence: graph.evidence.length,
    coverage: {
      trackedFiles: graph.coverage.trackedFiles,
      eligibleFiles: graph.coverage.eligibleFiles,
      analyzedFiles: graph.coverage.analyzedFiles,
      completeFiles: graph.coverage.completeFiles,
      partialFiles: graph.coverage.partialFiles,
      unsupportedFiles: graph.coverage.unsupportedFiles,
      skippedFiles: graph.coverage.skippedFiles,
      failedFiles: graph.coverage.failedFiles,
    },
    heapUsedMiB: round(memory.heapUsed / 1_048_576, 1),
    rssMiB: round(memory.rss / 1_048_576, 1),
    peakRssMiB: round(usage.maxRSS / 1024, 1),
    userCpuMs: round(usage.userCPUTime / 1000, 1),
    systemCpuMs: round(usage.systemCPUTime / 1000, 1),
  };
  console.log(`${workerMarker}${JSON.stringify(result)}`);
}

async function writeSyntheticRepository(root, sourceFiles) {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const batchSize = 250;
  for (let offset = 0; offset < sourceFiles; offset += batchSize) {
    const writes = [];
    for (let index = offset; index < Math.min(offset + batchSize, sourceFiles); index += 1) {
      const id = String(index).padStart(5, '0');
      const previous = String(Math.max(0, index - 1)).padStart(5, '0');
      const dependency = index === 0 ? '' : `import { compute${previous} } from './module-${previous}.js';\n`;
      const body = `${dependency}export interface Item${id} { id: string; value: number }\nexport function compute${id}(input: number): number { return ${index === 0 ? 'input + 1' : `compute${previous}(input) + 1`}; }\nexport const item${id}: Item${id} = { id: '${id}', value: compute${id}(${index}) };\n`;
      writes.push(fs.writeFile(path.join(root, 'src', `module-${id}.ts`), body));
    }
    await Promise.all(writes);
  }
  await fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: `devint-capacity-${sourceFiles}`, private: true, type: 'module' }, null, 2)}\n`);
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', root]);
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Development Intelligence Capacity Benchmark']);
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'capacity-benchmark@example.invalid']);
  await execFileAsync('git', ['-C', root, 'add', '.']);
  await execFileAsync('git', ['-C', root, 'commit', '--quiet', '-m', `synthetic ${sourceFiles}`]);
}

async function sample(root, sourceFiles, maxFiles) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--worker', root, String(sourceFiles)], {
    cwd: repositoryRoot,
    env: { ...process.env, DEVINT_GRAPH_MAX_FILES: String(maxFiles) },
    maxBuffer: 10 * 1024 * 1024,
  });
  const line = stdout.split(/\r?\n/u).find(value => value.startsWith(workerMarker));
  if (!line) throw new Error(`Capacity worker returned no result${stderr ? `: ${stderr.trim()}` : ''}`);
  return JSON.parse(line.slice(workerMarker.length));
}

function assertCoverage(result, sourceFiles, maxFiles) {
  const eligibleFiles = sourceFiles + 1;
  const analyzedFiles = Math.min(eligibleFiles, maxFiles);
  const skippedFiles = eligibleFiles - analyzedFiles;
  if (result.coverage.eligibleFiles !== eligibleFiles) throw new Error(`Expected ${eligibleFiles} eligible files, got ${result.coverage.eligibleFiles}`);
  if (result.coverage.analyzedFiles !== analyzedFiles) throw new Error(`Expected ${analyzedFiles} analyzed files, got ${result.coverage.analyzedFiles}`);
  if (result.coverage.skippedFiles !== skippedFiles) throw new Error(`Expected ${skippedFiles} skipped files, got ${result.coverage.skippedFiles}`);
  if (result.coverage.failedFiles !== 0 || result.coverage.partialFiles !== 0) throw new Error('Synthetic capacity benchmark requires complete analysis for every considered file');
}

async function main() {
  const maxFiles = positiveInteger(process.env.DEVINT_CAPACITY_MAX_FILES ?? '10000', 'DEVINT_CAPACITY_MAX_FILES');
  const repetitions = positiveInteger(process.env.DEVINT_CAPACITY_REPETITIONS ?? '3', 'DEVINT_CAPACITY_REPETITIONS');
  const scales = [...new Set((process.env.DEVINT_CAPACITY_SCALES ?? '100,1000,5000,10000')
    .split(',')
    .map(value => positiveInteger(value.trim(), 'DEVINT_CAPACITY_SCALES')))]
    .sort((left, right) => left - right);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-capacity-benchmark-'));
  const cases = [];
  try {
    for (const sourceFiles of scales) {
      const root = path.join(temp, `source-${sourceFiles}`);
      await writeSyntheticRepository(root, sourceFiles);
      const samples = [];
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const result = await sample(root, sourceFiles, maxFiles);
        assertCoverage(result, sourceFiles, maxFiles);
        samples.push(result);
      }
      const representative = samples[0];
      cases.push({
        sourceFiles,
        eligibleFiles: representative.coverage.eligibleFiles,
        analyzedFiles: representative.coverage.analyzedFiles,
        skippedFiles: representative.coverage.skippedFiles,
        nodes: representative.nodes,
        edges: representative.edges,
        evidence: representative.evidence,
        elapsedMs: metric(samples.map(item => item.elapsedMs)),
        peakRssMiB: metric(samples.map(item => item.peakRssMiB)),
        userCpuMs: metric(samples.map(item => item.userCpuMs)),
        systemCpuMs: metric(samples.map(item => item.systemCpuMs)),
        samples,
      });
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }

  for (let index = 1; index < cases.length; index += 1) {
    if (cases[index].nodes < cases[index - 1].nodes || cases[index].edges < cases[index - 1].edges) {
      throw new Error('Synthetic graph size must remain monotonic as analyzed source count grows');
    }
  }

  const report = {
    benchmark: 'Development Intelligence deterministic synthetic capacity curve',
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      logicalCpuCount: os.availableParallelism(),
      maxFiles,
      repetitions,
    },
    cases,
  };
  const jsonPath = process.env.DEVINT_CAPACITY_JSON ?? path.resolve('benchmark-capacity.json');
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const summary = [
    '# Development Intelligence synthetic capacity benchmark',
    '',
    `- Environment: **${process.version} / ${process.platform} ${process.arch} / ${os.availableParallelism()} logical CPUs**`,
    `- Repetitions per scale: **${repetitions}**`,
    `- Configured eligible-file analysis ceiling: **${maxFiles}**`,
    '',
    '| Generated source files | Eligible / analyzed | Graph | Build time median (range) | Peak RSS median (range) |',
    '| ---: | ---: | ---: | ---: | ---: |',
    ...cases.map(item => `| ${item.sourceFiles} | ${item.eligibleFiles} / ${item.analyzedFiles}${item.skippedFiles ? ` (${item.skippedFiles} skipped)` : ''} | ${item.nodes} nodes / ${item.edges} edges | ${item.elapsedMs.median} ms (${item.elapsedMs.min}–${item.elapsedMs.max}) | ${item.peakRssMiB.median} MiB (${item.peakRssMiB.min}–${item.peakRssMiB.max}) |`),
    '',
    '> Synthetic files isolate scale behavior and the configured safety ceiling. Pinned real-repository benchmarks remain authoritative for language complexity and agent usefulness.',
  ].join('\n');
  const markdownPath = process.env.DEVINT_CAPACITY_MARKDOWN ?? path.resolve('benchmark-capacity.md');
  await fs.writeFile(markdownPath, `${summary}\n`);
  console.log(summary);
}

if (process.argv[2] === '--worker') {
  await runWorker(path.resolve(process.argv[3]), positiveInteger(process.argv[4], 'sourceFiles'));
} else {
  await main();
}
