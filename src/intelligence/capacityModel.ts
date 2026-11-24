import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { runChecked } from '../util/process.js';
import { resolveProjectRevision, withResolvedProjectCheckoutObserved } from '../source/git.js';
import { supportsSourcePath } from './analyzers/index.js';
import { isRepositoryAnalysisIgnoredPath } from './repository.js';
import { assertProjectAccessCurrent } from '../config/projectAccess.js';

/** Inventory source before constructing a graph. Counts and byte totals are
 * measured; graph expansion and producer peaks are deliberately not guessed. */
export async function measureSourceCapacity(rootInput: string, workingTree = false, scratchInput?: string, graphDataInput?: string): Promise<Record<string, unknown>> {
  const root = path.resolve(rootInput);
  const args = workingTree ? ['ls-files', '--cached', '--others', '--exclude-standard', '-z'] : ['ls-files', '--cached', '-z'];
  const result = await runChecked('git', ['-C', root, ...args]);
  const paths = [...new Set(result.stdout.split('\0').filter(Boolean))].filter(file => !isRepositoryAnalysisIgnoredPath(file));
  const byExtension = new Map<string, { files: number; bytes: number; supported: boolean }>();
  let regularFiles = 0, regularBytes = 0, supportedFiles = 0, supportedBytes = 0, largestFileBytes = 0, unavailableFiles = 0, nonRegularFiles = 0;
  let next = 0;
  const concurrency = Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= paths.length) return;
      const relative = paths[index]!;
      let stat: any;
      try { stat = await fs.lstat(path.join(root, relative)); }
      catch { unavailableFiles++; continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) { nonRegularFiles++; continue; }
      const bytes = Number(stat.size), supported = supportsSourcePath(relative);
      const extension = path.extname(relative).toLowerCase() || '(no extension)';
      const key = `${extension}\0${supported}`;
      const group = byExtension.get(key) ?? { files: 0, bytes: 0, supported };
      group.files++; group.bytes += bytes; byExtension.set(key, group);
      regularFiles++; regularBytes += bytes; largestFileBytes = Math.max(largestFileBytes, bytes);
      if (supported) { supportedFiles++; supportedBytes += bytes; }
    }
  }));
  const scratch = path.resolve(scratchInput ?? process.env.DEVINT_SCRATCH_DIR ?? os.tmpdir());
  const graphDataValue = graphDataInput ?? process.env.DEVINT_MACHINE_GRAPH_DIR ?? process.env.DEVINT_LOCAL_GRAPH_DIR;
  const graphData = graphDataValue ? path.resolve(graphDataValue) : null;
  const availableSpace = async (directory: string | null): Promise<number | null> => {
    if (!directory) return null;
    try { const stat = await fs.statfs(directory); return Number(stat.bavail) * Number(stat.bsize); }
    catch { return null; }
  };
  const [scratchAvailableBytes, graphDataAvailableBytes] = await Promise.all([availableSpace(scratch), availableSpace(graphData)]);
  const head = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  // Some Node/Linux combinations report UINT64_MAX when there is no cgroup
  // ceiling. It is a sentinel, not an 18-exabyte allocation available to DI.
  const processConstrainedMemoryBytes = Number.isSafeInteger(constrained) && constrained > 0 ? constrained : null;
  return {
    source: { headRevision: head, selection: workingTree ? 'working-files' : 'checkout', listedPaths: paths.length,
      regularFiles, regularBytes, supportedFiles, supportedBytes, largestFileBytes, unavailableFiles, nonRegularFiles,
      extensions: [...byExtension.entries()].map(([key, data]) => ({ extension: key.split('\0')[0], ...data })).sort((a, b) => b.bytes - a.bytes || a.extension!.localeCompare(b.extension!)) },
    host: { logicalProcessors: concurrency, osTotalMemoryBytes: os.totalmem(), osFreeMemoryBytes: os.freemem(),
      processConstrainedMemoryBytes,
      processAvailableMemoryBytes: typeof process.availableMemory === 'function' ? process.availableMemory() : null,
      nodeHeapLimitBytes: getHeapStatistics().heap_size_limit, scratchAvailableBytes, graphDataAvailableBytes },
    settings: {
      graphMaxFiles: process.env.DEVINT_GRAPH_MAX_FILES ?? process.env.DEVINT_PARITY_MAX_FILES ?? null,
      graphMaxFileBytes: process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? process.env.DEVINT_PARITY_MAX_FILE_BYTES ?? null,
      graphWorkerHeapMiB: process.env.DEVINT_GRAPH_WORKER_HEAP_MB ?? null,
      scipHeapMiB: process.env.DEVINT_SCIP_HEAP_MB ?? null,
      graphBuildConcurrency: process.env.DEVINT_GRAPH_BUILD_CONCURRENCY ?? '1',
      gitTimeoutMs: process.env.DEVINT_GIT_TIMEOUT_MS ?? null,
      dependencyInstallTimeoutMs: process.env.DEVINT_DEPENDENCY_INSTALL_TIMEOUT_MS ?? null,
      scratchDirectory: scratch,
      graphDataDirectory: graphData,
    },
    model: { sourceSnapshotBytesLowerBound: regularBytes,
      graphBytes: null, indexBytes: null, dependencyBytes: null, producerPeakMemoryBytes: null, graphBuildPeakMemoryBytes: null,
      basis: 'The source bytes are the measured payload for one complete on-disk copy, not the full build requirement. Graph expansion, producer memory and dependency storage depend on the selected code and integrations; supported means DI recognizes the path, not that every relationship is covered. The reported heap is this inspecting process, not the worker or a producer. Host memory and filesystem space can change while a build runs.' },
  };
}

/** Hosted source inventory resolves and reads the same authorized exact Git
 * revision as graph construction, without constructing a graph. */
export async function projectCapacity(project: string, ref?: string): Promise<Record<string, unknown>> {
  await assertProjectAccessCurrent(project);
  const revision = await resolveProjectRevision(project, ref);
  const observed = await withResolvedProjectCheckoutObserved(revision, checkout => measureSourceCapacity(checkout.root));
  await assertProjectAccessCurrent(project);
  return { project, revision: revision.sha, ...observed.value, checkout: observed.timing };
}
