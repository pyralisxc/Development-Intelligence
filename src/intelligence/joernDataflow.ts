import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import type { TestClaimCatalog } from './testClaimInventory.js';
import { observation, resolution } from './model.js';
import { runChecked } from '../util/process.js';
import { stableHash } from '../util/hash.js';

/**
 * Ephemeral, OSS-only Joern dataflow evidence over ONE already-built DI graph.
 * Joern's DataFlowSlice contains source-located nodes plus directed DDG edges.
 * Independently confirmed Git source spans are resolved *locations*, while
 * Joern-reported flows remain candidates (may-flow, not runtime, not a value
 * proof). No Joern CPG, report, or extra graph becomes durable authority.
 */
export const JOERN_DATAFLOW_STRATEGY = 'joern-slice-source-correlated.v1';
export interface JoernSourceBudget {
  maxSliceBytes: number;
  maxSliceNodes: number;
  maxSliceEdges: number;
  maxSourceFiles: number;
  maxSourceFileBytes: number;
  maxCodeChars: number;
}
/** Each source shard remains resource-bounded; corpora may union many shards. */
export const DEFAULT_JOERN_SOURCE_BUDGET: Readonly<JoernSourceBudget> = Object.freeze({
  maxSliceBytes: 16 * 1024 * 1024,
  maxSliceNodes: 25000,
  maxSliceEdges: 75000,
  maxSourceFiles: 250,
  maxSourceFileBytes: 1024 * 1024,
  maxCodeChars: 1024,
});
function sourceBudget(overrides: Partial<JoernSourceBudget> | undefined): JoernSourceBudget {
  const budget = { ...DEFAULT_JOERN_SOURCE_BUDGET, ...overrides };
  const hardMaximums: JoernSourceBudget = {
    maxSliceBytes: 256 * 1024 * 1024, maxSliceNodes: 500000,
    maxSliceEdges: 1000000, maxSourceFiles: 20000,
    maxSourceFileBytes: 16 * 1024 * 1024, maxCodeChars: 16000,
  };
  for (const key of Object.keys(budget) as Array<keyof JoernSourceBudget>) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 1
      || budget[key] > hardMaximums[key]) {
      throw new Error('Invalid Joern producer resource budget ' + key);
    }
  }
  return budget;
}

type UnknownRecord = Record<string, unknown>;
interface SliceNode {
  id: number;
  label: string;
  code: string;
  parentFile: string;
  parentMethod: string;
  lineNumber: number | null;
  columnNumber: number | null;
}
interface SliceEdge { src: number; dst: number; label: string }
interface LocalSource {
  path: string;
  lines: string[];
  starts: number[];
}
export interface JoernEvidenceProjection {
  graph: IntelligenceGraph;
  producer: { name: 'joern-slice'; version: string; sliceSha256: string;
    batchSliceSha256s?: string[]; independentlyAttested: false };
  source: { revision: string; graphId: string; projectPrefix: string };
  counts: {
    sliceNodes: number;
    sliceEdges: number;
    sourceLocatedNodes: number;
    sourceUnlocatedNodes: number;
    sourceFilesChecked: number;
    candidateFlowEdges: number;
    unlocatedFlowEdges: number;
    assertionSpanAnchors: number;
  };
  candidates: Array<{
    from: string;
    to: string;
    label: string;
    edgeId: string;
  }>;
  budget?: JoernSourceBudget;
  segmentPopulation?: {
    sourceArtifacts: number; totalSegmentSourceNodes: number;
    uniqueValidatedSourceNodes: number; uniqueCandidateFlowEdges: number;
    duplicateCandidateEdges: number;
  };
  policy: {
    sourceSpansAreExactGitVerified: true;
    flowIsPotentialNotRuntime: true;
    candidateFlowIsNotIndependentlyCorroborated: true;
    generatedBySourceOnly: true;
    missingFlowDoesNotProveAbsence: true;
    actualAssertionOutcomeProven: false;
    testReplacementProven: false;
    canonicalAuthorityUnaffected: true;
    stored: false;
  };
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a JSON object');
  }
  return value as UnknownRecord;
}
function requiredInt(value: unknown, label: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(label + ' must be a safe integer >= ' + min);
  }
  return value;
}
function boundedText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
    throw new Error(label + ' must be bounded UTF-8 text');
  }
  return value;
}
function canonicalRelative(value: string): boolean {
  return Boolean(value && value.length <= 2048 && !value.includes('\\')
    && !value.includes('\0') && !value.startsWith('/')
    && !/^[A-Za-z]:/u.test(value)
    && value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..'));
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative && relative !== '..'
    && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function lineStarts(text: string): { lines: string[]; starts: number[] } {
  const lines = text.split(/\r\n|\n|\r/u);
  const starts: number[] = [];
  let start = 0;
  for (const line of lines) {
    starts.push(start);
    start += line.length;
    if (text.slice(start, start + 2) === '\r\n') start += 2;
    else if (text[start] === '\r' || text[start] === '\n') start += 1;
  }
  return { lines, starts };
}
function normalizePath(root: string, parentFile: string, prefix: string): string | null {
  let value: string;
  if (path.isAbsolute(parentFile)) {
    value = path.relative(root, parentFile).split(path.sep).join('/');
  } else {
    value = prefix ? prefix + '/' + parentFile : parentFile;
  }
  return canonicalRelative(value) ? value : null;
}
function parseNode(raw: unknown, codeLimit: number): SliceNode {
  const item = record(raw, 'Joern slice node');
  const lineNumber = item.lineNumber === null || item.lineNumber === undefined
    ? null : requiredInt(item.lineNumber, 'Joern node.lineNumber', 1);
  const columnNumber = item.columnNumber === null || item.columnNumber === undefined
    ? null : requiredInt(item.columnNumber, 'Joern node.columnNumber', 0);
  return {
    id: requiredInt(item.id, 'Joern node.id', 0),
    label: boundedText(item.label, 'Joern node.label', 100),
    code: boundedText(item.code, 'Joern node.code', codeLimit),
    parentFile: boundedText(item.parentFile, 'Joern node.parentFile', 2048),
    parentMethod: boundedText(item.parentMethod ?? '', 'Joern node.parentMethod', 1024),
    lineNumber, columnNumber,
  };
}
function parseEdge(raw: unknown): SliceEdge {
  const item = record(raw, 'Joern slice edge');
  return {
    src: requiredInt(item.src, 'Joern edge.src', 0),
    dst: requiredInt(item.dst, 'Joern edge.dst', 0),
    label: boundedText(item.label, 'Joern edge.label', 100),
  };
}

async function sourceFile(root: string, relative: string, graph: IntelligenceGraph, maxBytes: number): Promise<LocalSource | null> {
  if (!canonicalRelative(relative)
    || !graph.coverage?.files.some(file => file.path === relative && file.status === 'complete')
    || !graph.nodes.some(node => node.id === 'file:' + relative && node.kind === 'file')) return null;
  const location = path.resolve(root, relative);
  if (!inside(root, location)) return null;
  try {
    const stat = await fs.lstat(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    const real = await fs.realpath(location);
    if (!inside(root, real)) return null;
    // A consumer-supplied Joern slice must not become a source fact after the
    // checkout has diverged from its selected immutable Git revision.
    const [headBlob, localBlob] = await Promise.all([
      runChecked('git', ['-C', root, 'rev-parse', 'HEAD:' + relative]),
      runChecked('git', ['-C', root, 'hash-object', '--', relative]),
    ]);
    if (headBlob.stdout.trim() !== localBlob.stdout.trim()) return null;
    const text = await fs.readFile(real, 'utf8');
    if (text.includes('\0')) return null;
    const { lines, starts } = lineStarts(text);
    return { path: relative, lines, starts };
  } catch { return null; }
}

function exactLocation(file: LocalSource, item: SliceNode): { locator: string; offset: number } | null {
  if (item.lineNumber === null) return null;
  const sourceLine = file.lines[item.lineNumber - 1];
  const sourceStart = file.starts[item.lineNumber - 1];
  const code = item.code.trim();
  if (sourceLine === undefined || sourceStart === undefined || !code
    || code.includes('\n') || code.includes('\r')) return null;
  // Joern frontends differ in zero- vs one-indexed columns. No convention
  // is asserted without exact source-text agreement. Refuse an ambiguous
  // position when both conventions match different source occurrences.
  const positions = item.columnNumber === null
    ? [sourceLine.indexOf(code)] : [item.columnNumber, item.columnNumber - 1];
  const matching = [...new Set(positions)].filter(pos => pos >= 0
    && sourceLine.slice(pos, pos + code.length) === code);
  if (matching.length !== 1
    || (item.columnNumber === null && sourceLine.lastIndexOf(code) !== matching[0])) return null;
  const location = matching[0]!;
  return { locator: file.path + ':' + item.lineNumber + ':' + (location + 1), offset: sourceStart + location };
}

/** Call with the same exact source checkout used to build graph, not a guessed ref. */
export async function projectLocalJoernDataflow(input: {
  root: string;
  graph: IntelligenceGraph;
  slicePath: string;
  producerVersion: string;
  projectPrefix?: string;
  testCatalog?: TestClaimCatalog;
  budget?: Partial<JoernSourceBudget>;
}): Promise<JoernEvidenceProjection> {
  const budget = sourceBudget(input.budget);
  const root = await fs.realpath(path.resolve(input.root));
  const head = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (head !== input.graph.repositoryRevision) {
    throw new Error('Joern evidence requires the selected exact Git HEAD and graph revision to agree');
  }
  const prefix = input.projectPrefix ?? '';
  if (prefix && !canonicalRelative(prefix)) throw new Error('Joern project prefix must be canonical and repository-relative');
  const version = boundedText(input.producerVersion, 'Joern producer version', 100);
  if (!version.trim()) throw new Error('Joern producer version is required; caller version is not attestation');
  if (input.testCatalog && (input.testCatalog.revision !== head
    || input.testCatalog.analyzerVersion !== input.graph.analyzerVersion)) {
    throw new Error('Joern test assertion catalog must match the exact source revision and analyzer');
  }

  const location = path.resolve(root, input.slicePath);
  if (!inside(root, location)) throw new Error('Joern slice path must be confined to the inspected checkout');
  const stat = await fs.lstat(location);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > budget.maxSliceBytes) {
    throw new Error('Joern slice must be a bounded, ordinary file');
  }
  const real = await fs.realpath(location);
  if (!inside(root, real)) throw new Error('Joern slice physical path escapes the checkout');
  const bytes = await fs.readFile(real);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const parsed = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), 'Joern DataFlowSlice');
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length > budget.maxSliceNodes
    || !Array.isArray(parsed.edges) || parsed.edges.length > budget.maxSliceEdges) {
    throw new Error('Joern DataFlowSlice nodes/edges must be bounded arrays');
  }
  const sliceNodes = parsed.nodes.map(item => parseNode(item, budget.maxCodeChars));
  const sliceEdges = parsed.edges.map(parseEdge);
  const ids = new Set<number>();
  for (const item of sliceNodes) {
    if (ids.has(item.id)) throw new Error('Joern DataFlowSlice contains duplicate node ids');
    ids.add(item.id);
  }

  const fileCache = new Map<string, Promise<LocalSource | null>>();
  const mapped = new Map<number, { node: GraphNode; path: string; offset: number; locator: string }>();
  const addedNodes = new Map<string, GraphNode>();
  const addedEdges = new Map<string, GraphEdge>();
  const assertionPairs = new Set<string>();
  const catalogAssertions = new Map<string, TestClaimCatalog['assertions']>();
  for (const assertion of input.testCatalog?.assertions ?? []) {
    const existing = catalogAssertions.get(assertion.sourceId) ?? [];
    existing.push(assertion);
    catalogAssertions.set(assertion.sourceId, existing);
  }
  let missing = 0;
  for (const item of sliceNodes) {
    const relative = normalizePath(root, item.parentFile, prefix);
    if (!relative) { missing++; continue; }
    if (!fileCache.has(relative)) {
      if (fileCache.size >= budget.maxSourceFiles) throw new Error('Joern slice exceeds configured per-shard source-file budget');
      fileCache.set(relative, sourceFile(root, relative, input.graph, budget.maxSourceFileBytes));
    }
    const file = await fileCache.get(relative)!;
    const exact = file ? exactLocation(file, item) : null;
    if (!exact) { missing++; continue; }
    const id = 'joern-span:' + stableHash([head, relative, exact.locator, item.label, item.code.trim()]);
    const node = observation({
      id, sourceId: 'repo:' + relative, kind: 'source-located-dataflow-node',
      locator: exact.locator, name: item.label, field: 'joern.slice-node',
      value: { label: item.label, code: item.code.trim(), method: item.parentMethod,
        sourceAnchorExact: true, JoernFlowProven: false },
      layer: 'structural', checkpoint: false,
    });
    mapped.set(item.id, { node, path: relative, offset: exact.offset, locator: exact.locator });
    addedNodes.set(id, node);
    const contains = resolution({
      from: 'file:' + relative, to: id, kind: 'contains',
      strategy: 'exact-git-source-span.v1', confidence: 1, status: 'resolved',
      evidence: [exact.locator, 'Source text and Git blob independently matched; does not corroborate Joern flow'],
      layer: 'structural', checkpoint: false,
    });
    addedEdges.set(contains.id, contains);
    for (const assertion of catalogAssertions.get(relative) ?? []) {
      if (exact.offset < assertion.start || exact.offset >= assertion.end) continue;
      const assertionNode = observation({
        id: assertion.id, sourceId: 'repo:' + relative, kind: 'test-assertion',
        locator: relative + ':' + assertion.start, field: 'assertion-span',
        value: { spanSha256: assertion.spanSha256, dynamic: assertion.dynamic },
        layer: 'structural', checkpoint: false,
      });
      addedNodes.set(assertion.id, assertionNode);
      const membership = resolution({
        from: id, to: assertion.id, kind: 'within-test-assertion',
        strategy: 'exact-git-assertion-span.v1', confidence: 1, status: 'resolved',
        evidence: [exact.locator, assertion.id, 'AST assertion source-span membership only'],
        layer: 'structural', checkpoint: false,
      });
      addedEdges.set(membership.id, membership);
      assertionPairs.add(assertion.id + '\0' + id);
    }
  }
  let imported = 0;
  let lost = 0;
  const candidates: JoernEvidenceProjection['candidates'] = [];
  for (const item of sliceEdges) {
    const from = mapped.get(item.src);
    const to = mapped.get(item.dst);
    if (!from || !to) { lost++; continue; }
    if (!['DDG', 'REACHING_DEF'].includes(item.label.toUpperCase())) { lost++; continue; }
    const edge = resolution({
      from: from.node.id, to: to.node.id,
      kind: 'dataflow-reported', strategy: JOERN_DATAFLOW_STRATEGY,
      identity: [head, from.node.id, to.node.id, item.label.toUpperCase(), JOERN_DATAFLOW_STRATEGY],
      confidence: null, status: 'candidate',
      evidence: [
        from.locator, to.locator, 'Joern ' + version + ' slice ' + digest + ' reports possible ' + item.label,
        'Producer report is caller-supplied/unattested; no runtime, path feasibility, or assertion equivalence proof',
      ],
      layer: 'structural', checkpoint: false,
    });
    if (!addedEdges.has(edge.id)) {
      addedEdges.set(edge.id, edge);
      imported++;
      if (candidates.length < 20) candidates.push({
        from: from.locator, to: to.locator, label: item.label, edgeId: edge.id,
      });
    }
  }
  const nodes = [...addedNodes.values()].sort((a,b) => a.id.localeCompare(b.id));
  const edges = [...addedEdges.values()].sort((a,b) => a.id.localeCompare(b.id));
  return {
    graph: {
      ...input.graph,
      graphId: 'joern-overlay-' + stableHash([input.graph.graphId, digest, version, prefix, budget]),
      nodes: [...input.graph.nodes, ...nodes],
      edges: [...input.graph.edges, ...edges],
    },
    producer: { name: 'joern-slice', version, sliceSha256: digest, independentlyAttested: false },
    source: { revision: head, graphId: input.graph.graphId, projectPrefix: prefix },
    counts: {
      sliceNodes: sliceNodes.length,
      sliceEdges: sliceEdges.length,
      sourceLocatedNodes: mapped.size,
      sourceUnlocatedNodes: missing,
      sourceFilesChecked: fileCache.size,
      candidateFlowEdges: imported,
      unlocatedFlowEdges: lost,
      assertionSpanAnchors: assertionPairs.size,
    },
    candidates, budget,
    policy: {
      sourceSpansAreExactGitVerified: true,
      flowIsPotentialNotRuntime: true,
      candidateFlowIsNotIndependentlyCorroborated: true,
      generatedBySourceOnly: true,
      missingFlowDoesNotProveAbsence: true,
      actualAssertionOutcomeProven: false,
      testReplacementProven: false,
      canonicalAuthorityUnaffected: true,
      stored: false,
    },
  };
}
