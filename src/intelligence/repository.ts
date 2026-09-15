import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { GraphCoverage, GraphEdge, GraphNode, IntelligenceGraph, SourceDescriptor } from '../types.js';
import { runChecked } from '../util/process.js';
import { stableHash } from '../util/hash.js';
import { analyzeByTechnology } from './analyzers/index.js';
import { observation, resolution } from './model.js';
import { deriveNamingDivergences, deriveUnmatched, resolveCrossSource } from './resolver.js';

export const GRAPH_DIRECTORY = '.development-intelligence';
export const GRAPH_CHECKPOINT_PATH = `${GRAPH_DIRECTORY}/graph.ndjson`;

const MAX_FILE_BYTES = Number(process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? process.env.DEVINT_PARITY_MAX_FILE_BYTES ?? 1_000_000);
const MAX_FILES = Number(process.env.DEVINT_GRAPH_MAX_FILES ?? process.env.DEVINT_PARITY_MAX_FILES ?? 10_000);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.html', '.htm']);

interface TrackedFile {
  path: string;
  mode: string;
  blob: string;
}

async function trackedFiles(root: string): Promise<TrackedFile[]> {
  const result = await runChecked('git', ['-C', root, 'ls-files', '-s', '-z']);
  const output: TrackedFile[] = [];
  for (const record of result.stdout.split('\0').filter(Boolean)) {
    const match = /^(\d+)\s+([0-9a-f]+)\s+\d+\t(.+)$/u.exec(record);
    if (!match) continue;
    const mode = match[1]!;
    const blob = match[2]!;
    const filePath = match[3]!;
    if (filePath === GRAPH_DIRECTORY || filePath.startsWith(`${GRAPH_DIRECTORY}/`)) continue;
    output.push({ path: filePath, mode, blob });
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

export async function sourceFingerprint(root: string): Promise<string> {
  const tracked = await trackedFiles(root);
  if (tracked.some(file => file.path.includes('\n'))) throw new Error('Tracked filenames containing newlines are not supported by graph sealing');
  const regular = tracked.filter(file => file.mode !== '120000' && file.mode !== '160000');
  const regularHashes = regular.length
    ? (await runChecked('git', ['-C', root, 'hash-object', '--no-filters', '--stdin-paths'], { input: `${regular.map(file => file.path).join('\n')}\n` })).stdout.trim().split(/\r?\n/u)
    : [];
  if (regularHashes.length !== regular.length) throw new Error('Unable to fingerprint every tracked regular source file');
  const regularByPath = new Map(regular.map((file, index) => [file.path, regularHashes[index]!]));
  const hash = createHash('sha256');
  for (const file of tracked) {
    let contentHash: string;
    if (file.mode === '120000') {
      const target = await fs.readlink(path.join(root, file.path));
      contentHash = createHash('sha256').update(target).digest('hex');
    } else if (file.mode === '160000') {
      contentHash = file.blob;
    } else {
      contentHash = regularByPath.get(file.path)!;
    }
    hash.update(`${file.mode}\0${contentHash}\0${file.path}\0`);
  }
  return hash.digest('hex');
}

function fileNode(source: SourceDescriptor, relative: string): GraphNode {
  return observation({
    sourceId: source.id,
    kind: 'file',
    locator: relative,
    name: relative,
    field: 'path',
    value: relative,
    tags: ['repository'],
  });
}

function containsEdge(file: GraphNode, child: GraphNode, relative: string): GraphEdge {
  return resolution({
    from: file.id,
    to: child.id,
    kind: 'contains',
    strategy: 'syntax',
    confidence: 1,
    status: 'resolved',
    evidence: [relative],
  });
}

export async function buildRepositoryGraph(input: {
  project: string;
  repository: string;
  revision: string;
  root: string;
  role?: 'A' | 'W' | 'B';
}): Promise<IntelligenceGraph> {
  const createdAt = new Date().toISOString();
  const tracked = await trackedFiles(input.root);
  const eligible = tracked.filter(file => TEXT_EXTENSIONS.has(path.extname(file.path).toLowerCase()));
  const selected = eligible.slice(0, MAX_FILES);
  const warnings: string[] = [];
  if (selected.length < eligible.length) warnings.push(`Graph file limit reached: analyzed ${selected.length} of ${eligible.length} eligible tracked files.`);

  let skippedOversizedFiles = 0;
  let skippedNonRegularFiles = 0;
  let analyzedFiles = 0;
  const nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];

  for (const trackedFile of selected) {
    const root = path.resolve(input.root);
    const absolute = path.resolve(root, trackedFile.path);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      warnings.push(`Skipped tracked path outside repository root: ${trackedFile.path}`);
      skippedNonRegularFiles += 1;
      continue;
    }
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      warnings.push(`Skipped non-regular tracked file: ${trackedFile.path}`);
      skippedNonRegularFiles += 1;
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      skippedOversizedFiles += 1;
      continue;
    }
    const fileSource: SourceDescriptor = {
      id: `repo:${trackedFile.path}`,
      kind: 'repository-file',
      locator: trackedFile.path,
      revision: input.revision,
      observedAt: createdAt,
      available: true,
    };
    const file = fileNode(fileSource, trackedFile.path);
    const text = await fs.readFile(absolute, 'utf8');
    const result = analyzeByTechnology({ source: fileSource, text, locatorBase: trackedFile.path });
    nodes.push(file, ...result.observations);
    edges.push(...result.resolutions, ...result.observations.map(node => containsEdge(file, node, trackedFile.path)));
    analyzedFiles += 1;
  }

  if (skippedOversizedFiles > 0) warnings.push(`Skipped ${skippedOversizedFiles} tracked files larger than ${MAX_FILE_BYTES} bytes.`);
  const repositorySource: SourceDescriptor = {
    id: 'repository',
    kind: 'repository',
    locator: input.repository,
    revision: input.revision,
    observedAt: createdAt,
    available: true,
    ...(warnings.length ? { warnings } : {}),
  };

  edges = resolveCrossSource(nodes, edges);
  const fingerprint = await sourceFingerprint(input.root);
  const coverage: GraphCoverage = {
    trackedFiles: tracked.length,
    eligibleFiles: eligible.length,
    analyzedFiles,
    skippedOversizedFiles,
    skippedNonRegularFiles,
  };
  return {
    schemaVersion: 1,
    graphId: `repo-${input.revision.slice(0, 12)}-${stableHash([fingerprint]).slice(0, 10)}`,
    project: input.project,
    role: input.role ?? 'W',
    createdAt,
    repositoryRevision: input.revision,
    sourceFingerprint: fingerprint,
    sources: [repositorySource],
    nodes,
    edges,
    namingDivergences: deriveNamingDivergences(nodes, edges),
    explicitValueConflicts: [],
    unmatchedNodeIds: deriveUnmatched(nodes, edges),
    unavailableSourceIds: [],
    coverage,
  };
}
