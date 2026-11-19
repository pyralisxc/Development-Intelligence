import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
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
const MAX_SLICE_BYTES = 16 * 1024 * 1024;
const MAX_SLICE_NODES = 25000;
const MAX_SLICE_EDGES = 75000;
const MAX_SOURCE_FILES = 250;
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_CODE_CHARS = 1024;

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
  producer: { name: 'joern-slice'; version: string; sliceSha256: string; independentlyAttested: false };
  source: { revision: string | null; headRevision?: string; graphId: string; projectPrefix: string };
  counts: {
    sliceNodes: number;
    sliceEdges: number;
    sourceLocatedNodes: number;
    sourceUnlocatedNodes: number;
    sourceFilesChecked: number;
    candidateFlowEdges: number;
    unlocatedFlowEdges: number;
    assertionSpanAnchors: number;
    sourceExpressionAnchors: number;
  };
  candidates: Array<{
    from: string;
    to: string;
    label: string;
    edgeId: string;
  }>;
  policy: {
    sourceSpansAreExactGitVerified: boolean;
    sourceSpansMatchWorkingFingerprint: boolean;
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
function parseNode(raw: unknown): SliceNode {
  const item = record(raw, 'Joern slice node');
  const lineNumber = item.lineNumber === null || item.lineNumber === undefined
    ? null : requiredInt(item.lineNumber, 'Joern node.lineNumber', 1);
  const columnNumber = item.columnNumber === null || item.columnNumber === undefined
    ? null : requiredInt(item.columnNumber, 'Joern node.columnNumber', 0);
  return {
    id: requiredInt(item.id, 'Joern node.id', 0),
    label: boundedText(item.label, 'Joern node.label', 100),
    code: boundedText(item.code, 'Joern node.code', MAX_CODE_CHARS),
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

async function sourceFile(root: string, relative: string, graph: IntelligenceGraph): Promise<LocalSource | null> {
  if (!canonicalRelative(relative)
    || !graph.coverage?.files.some(file => file.path === relative && (file.status === 'complete' || file.status === 'partial'))
    || !graph.nodes.some(node => node.id === 'file:' + relative && node.kind === 'file')) return null;
  const location = path.resolve(root, relative);
  if (!inside(root, location)) return null;
  try {
    const stat = await fs.lstat(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_FILE_BYTES) return null;
    const real = await fs.realpath(location);
    if (!inside(root, real)) return null;
    const text = await fs.readFile(real, 'utf8');
    const expected = graph.coverage?.files.find(file => file.path === relative)?.contentSha256;
    if (!expected || createHash('sha256').update(text).digest('hex') !== expected) return null;
    if (!graph.sourceState) {
      const [headBlob, localBlob] = await Promise.all([
        runChecked('git', ['-C', root, 'rev-parse', 'HEAD:' + relative]),
        runChecked('git', ['-C', root, 'hash-object', '--', relative]),
      ]);
      if (headBlob.stdout.trim() !== localBlob.stdout.trim()) return null;
    }
    if (text.includes('\0')) return null;
    const { lines, starts } = lineStarts(text);
    return { path: relative, lines, starts };
  } catch { return null; }
}

function tokens(text: string): Array<{ kind: ts.SyntaxKind; value: string; start: number }> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const found: Array<{ kind: ts.SyntaxKind; value: string; start: number }> = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const value = kind === ts.SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText();
    found.push({ kind, value, start: scanner.getTokenPos() });
  }
  return found;
}

function exactLocation(file: LocalSource, item: SliceNode): { locator: string; offset: number; match: 'exact' | 'normalized-syntax' } | null {
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
  if (matching.length === 1 && (item.columnNumber !== null || sourceLine.lastIndexOf(code) === matching[0])) {
    const location = matching[0]!;
    return { locator: file.path + ':' + item.lineNumber + ':' + (location + 1), offset: sourceStart + location, match: 'exact' };
  }
  // Compare lexical tokens, not rendered quote style. This preserves the
  // original Git source and does not infer that distinct expressions agree.
  const wanted = tokens(code);
  if (!wanted.length) return null;
  const available = tokens(sourceLine);
  const normalized = available.flatMap((token, index) => {
    if (item.columnNumber !== null && !positions.includes(token.start)) return [];
    return wanted.every((part, step) => available[index + step]?.kind === part.kind
      && available[index + step]?.value === part.value) ? [token.start] : [];
  });
  if (normalized.length !== 1) return null;
  const location = normalized[0]!;
  return { locator: file.path + ':' + item.lineNumber + ':' + (location + 1), offset: sourceStart + location, match: 'normalized-syntax' };
}

/** Resolve an operator-selected slice inside the checkout for the existing evidence CLI. */
export async function projectLocalJoernDataflow(input: {
  root: string; graph: IntelligenceGraph; slicePath: string; producerVersion: string;
  projectPrefix?: string; testCatalog?: TestClaimCatalog;
}): Promise<JoernEvidenceProjection> {
  const root = await fs.realpath(path.resolve(input.root));
  const location = path.resolve(root, input.slicePath);
  if (!inside(root, location)) throw new Error('Joern slice path must be confined to the inspected checkout');
  const stat = await fs.lstat(location);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_SLICE_BYTES) throw new Error('Joern slice must be a bounded, ordinary file');
  const real = await fs.realpath(location);
  if (!inside(root, real)) throw new Error('Joern slice physical path escapes the checkout');
  return projectJoernDataflowBytes({ ...input, root, bytes: await fs.readFile(real) });
}

/** Reconcile explicit producer output against the graph's exact committed or working source. */
export async function projectJoernDataflowBytes(input: {
  root: string; graph: IntelligenceGraph; bytes: Uint8Array; producerVersion: string;
  projectPrefix?: string; testCatalog?: TestClaimCatalog;
}): Promise<JoernEvidenceProjection> {
  const root = await fs.realpath(path.resolve(input.root));
  const head = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const working = Boolean(input.graph.sourceState);
  if (head !== (input.graph.sourceState?.headRevision ?? input.graph.repositoryRevision)) throw new Error('Joern evidence requires the selected source HEAD and graph to agree');
  if (working) {
    const { sourceFingerprint } = await import('./repository.js');
    if (!input.graph.sourceFingerprint || await sourceFingerprint(root, true) !== input.graph.sourceFingerprint) throw new Error('Working source differs from the selected graph');
  }
  const prefix = input.projectPrefix ?? '';
  if (prefix && !canonicalRelative(prefix)) throw new Error('Joern project prefix must be canonical and repository-relative');
  const version = boundedText(input.producerVersion, 'Joern producer version', 100);
  if (!version.trim()) throw new Error('Joern producer version is required; caller version is not attestation');
  if (input.testCatalog && (working || input.testCatalog.revision !== head || input.testCatalog.analyzerVersion !== input.graph.analyzerVersion)) throw new Error('Joern test assertion catalog must match the exact committed source revision and analyzer');
  // The existing TypeScript source facts carry compiler-derived UTF-16 spans.
  // Index them once so a verified Joern source occurrence can be navigated
  // from its containing expression without treating the reported flow as fact.
  const sourceFacts = new Map<string, Array<{ node: GraphNode; start: number; end: number }>>();
  for (const node of input.graph.nodes) {
    if (node.kind !== 'source-effect' && node.kind !== 'source-condition') continue;
    const value = node.value as { expressionStructure?: { start?: unknown; end?: unknown }; predicateStructure?: { start?: unknown; end?: unknown } } | null;
    const span = node.kind === 'source-effect' ? value?.expressionStructure : value?.predicateStructure;
    if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
      || (span.start as number) < 0 || (span.end as number) <= (span.start as number)) continue;
    const items = sourceFacts.get(node.sourceId) ?? [];
    items.push({ node, start: span.start as number, end: span.end as number });
    sourceFacts.set(node.sourceId, items);
  }
  const bytes = input.bytes;
  if (!bytes.length || bytes.length > MAX_SLICE_BYTES) throw new Error('Joern slice must be bounded and nonempty');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const parsed = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), 'Joern DataFlowSlice');
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length > MAX_SLICE_NODES
    || !Array.isArray(parsed.edges) || parsed.edges.length > MAX_SLICE_EDGES) {
    throw new Error('Joern DataFlowSlice nodes/edges must be bounded arrays');
  }
  const sliceNodes = parsed.nodes.map(parseNode);
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
  let sourceExpressionAnchors = 0;
  for (const item of sliceNodes) {
    const relative = normalizePath(root, item.parentFile, prefix);
    if (!relative) { missing++; continue; }
    if (!fileCache.has(relative)) {
      if (fileCache.size >= MAX_SOURCE_FILES) throw new Error('Joern slice exceeds bounded source-file census');
      fileCache.set(relative, sourceFile(root, relative, input.graph));
    }
    const file = await fileCache.get(relative)!;
    const exact = file ? exactLocation(file, item) : null;
    if (!exact) { missing++; continue; }
    const id = 'joern-span:' + stableHash([working ? input.graph.sourceFingerprint : head, relative, exact.locator, item.label, item.code.trim()]);
    const node = observation({
      id, sourceId: 'repo:' + relative, kind: 'source-located-dataflow-node',
      locator: exact.locator, name: item.label, field: 'joern.slice-node',
      value: { label: item.label, code: item.code.trim(), method: item.parentMethod,
        sourceAnchorExact: exact.match === 'exact', sourceAnchorMatch: exact.match, JoernFlowProven: false },
      layer: 'structural', checkpoint: false,
    });
    mapped.set(item.id, { node, path: relative, offset: exact.offset, locator: exact.locator });
    addedNodes.set(id, node);
    const contains = resolution({
      from: 'file:' + relative, to: id, kind: 'contains',
      strategy: working ? 'working-source-span.v1' : exact.match === 'exact' ? 'exact-git-source-span.v1' : 'normalized-git-source-syntax.v1', confidence: 1, status: 'resolved',
      evidence: [exact.locator, working ? 'Source content matches the selected working graph; does not corroborate Joern flow' : exact.match === 'exact'
        ? 'Source text and Git blob independently matched; does not corroborate Joern flow'
        : 'Source tokens and literal values match the Git blob after syntax normalization; does not corroborate Joern flow'],
      layer: 'structural', checkpoint: false,
    });
    addedEdges.set(contains.id, contains);
    if (exact.match === 'exact') {
      const matches = (sourceFacts.get('repo:' + relative) ?? []).filter(fact =>
        fact.start <= exact.offset && exact.offset + item.code.trim().length <= fact.end);
      const minimum = matches.reduce((size, fact) => Math.min(size, fact.end - fact.start), Infinity);
      for (const fact of matches.filter(candidate => candidate.end - candidate.start === minimum)) {
        const link = resolution({ from: fact.node.id, to: id, kind: 'contains-source-span',
          strategy: 'verified-source-expression-span.v1', confidence: 1, status: 'resolved',
          evidence: [fact.node.locator, exact.locator, 'Lexical source-span containment only; producer-reported flow remains a candidate'],
          layer: 'structural', checkpoint: false });
        if (!addedEdges.has(link.id)) { addedEdges.set(link.id, link); sourceExpressionAnchors++; }
      }
    }
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
      identity: [working ? input.graph.sourceFingerprint : head, from.node.id, to.node.id, item.label.toUpperCase(), JOERN_DATAFLOW_STRATEGY],
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
  if (working) {
    const { sourceFingerprint } = await import('./repository.js');
    if (await sourceFingerprint(root, true) !== input.graph.sourceFingerprint) throw new Error('Working source changed during Joern reconciliation');
  }
  const nodes = [...addedNodes.values()].sort((a,b) => a.id.localeCompare(b.id));
  const edges = [...addedEdges.values()].sort((a,b) => a.id.localeCompare(b.id));
  return {
    graph: {
      ...input.graph,
      graphId: 'joern-overlay-' + stableHash([input.graph.graphId, digest, version, prefix]),
      nodes: [...input.graph.nodes, ...nodes],
      edges: [...input.graph.edges, ...edges],
    },
    producer: { name: 'joern-slice', version, sliceSha256: digest, independentlyAttested: false },
    source: { revision: input.graph.repositoryRevision, ...(working ? { headRevision: head } : {}), graphId: input.graph.graphId, projectPrefix: prefix },
    counts: {
      sliceNodes: sliceNodes.length,
      sliceEdges: sliceEdges.length,
      sourceLocatedNodes: mapped.size,
      sourceUnlocatedNodes: missing,
      sourceFilesChecked: fileCache.size,
      candidateFlowEdges: imported,
      unlocatedFlowEdges: lost,
      assertionSpanAnchors: assertionPairs.size,
      sourceExpressionAnchors,
    },
    candidates,
    policy: {
      sourceSpansAreExactGitVerified: !working,
      sourceSpansMatchWorkingFingerprint: working,
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
