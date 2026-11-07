import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { resolution } from './model.js';
import { decodeScipIndex, type ScipDocument, type ScipOccurrence } from './scipWire.js';
import { runChecked } from '../util/process.js';

/**
 * SCIP evidence is an opt-in source sensor. A caller-supplied index cannot
 * certify its own producer, exact revision, compiler configuration, or full
 * source coverage. Positive matching references remain CANDIDATES until a
 * separate controlled indexer run establishes that provenance.
 */
export const SCIP_EVIDENCE_STRATEGY = 'scip-source-correlated.v1';
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_EDGES = 100_000;
const DECLARATION_KINDS = new Set(['function', 'method', 'class', 'constructor', 'interface', 'type', 'declaration', 'struct', 'enum']);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

interface ScipDefinition { target: GraphNode; file: string; line: number }
interface SourceDocument { file: string; lines: string[]; index: ScipDocument }

export interface ScipEvidenceProjection {
  graph: IntelligenceGraph;
  index: {
    sha256: string;
    producer: { name: string; version: string };
    documents: number;
    occurrences: number;
  };
  counts: {
    sourceDocumentsMatched: number;
    sourceDocumentsSkipped: number;
    definitionsMatched: number;
    referencedSymbolsMatched: number;
    candidateEdges: number;
    ambiguousDefinitions: number;
    unresolvedOrUnsafeOccurrences: number;
  };
  policy: {
    sourceBackedPositiveCandidatesOnly: true;
    externallySuppliedIndexNotAttested: true;
    negativeCoverageNotEstablished: true;
    canonicalAuthorityUnaffected: true;
    runtimeExecutionNotProven: true;
    stored: false;
  };
}

function safeRelative(value: string): boolean {
  if (!value || value.length > 2048 || value.startsWith('/') || value.includes('\\') || value.includes('\0')
    || /^[A-Za-z]:/u.test(value)) return false;
  return value.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function declarationLine(node: GraphNode, relative: string): number | null {
  if (!node.locator.startsWith(relative + ':')) return null;
  const match = /^(\d+)(?::|$)/u.exec(node.locator.slice(relative.length + 1));
  return match ? Number(match[1]) : null;
}

function sourceSlice(source: SourceDocument, occurrence: ScipOccurrence): string | null {
  const range = occurrence.range;
  if (!range || range.line >= source.lines.length || range.end > 4096) return null;
  const line = source.lines[range.line]!;
  if (source.index.positionEncoding === 2) { // UTF-16 code-unit offsets
    if (range.end > line.length) return null;
    const text = line.slice(range.start, range.end);
    // Exclude spans splitting a surrogate pair; caller indexes cannot prove
    // declaration identity using malformed UTF-16 boundaries.
    const before = line.charCodeAt(range.start - 1);
    const atStart = line.charCodeAt(range.start);
    const beforeEnd = line.charCodeAt(range.end - 1);
    const atEnd = line.charCodeAt(range.end);
    if ((before >= 0xD800 && before <= 0xDBFF && atStart >= 0xDC00 && atStart <= 0xDFFF)
      || (beforeEnd >= 0xD800 && beforeEnd <= 0xDBFF && atEnd >= 0xDC00 && atEnd <= 0xDFFF)) return null;
    return text || null;
  }
  if (source.index.positionEncoding === 3) { // UTF-32 code points
    const characters = [...line];
    return range.end <= characters.length ? characters.slice(range.start, range.end).join('') || null : null;
  }
  if (source.index.positionEncoding === 1) { // UTF-8 bytes
    const buffer = Buffer.from(line, 'utf8');
    if (range.end > buffer.length) return null;
    try {
      const bytes = buffer.subarray(range.start, range.end);
      return utf8Decoder.decode(bytes) || null;
    } catch { return null; }
  }
  return null;
}

async function trackedDocument(root: string, doc: ScipDocument, graph: IntelligenceGraph): Promise<SourceDocument | null> {
  if (!safeRelative(doc.path)) throw new Error('SCIP document path is not canonical or would escape the repository');
  if (![1, 2, 3].includes(doc.positionEncoding)) return null;
  if (!graph.coverage?.files.some(item => item.path === doc.path && item.status === 'complete')) return null;
  if (!graph.nodes.some(node => node.id === 'file:' + doc.path && node.kind === 'file')) return null;
  const location = path.resolve(root, doc.path);
  if (!within(root, location)) throw new Error('SCIP document escapes the inspected checkout');
  try {
    const link = await fs.lstat(location);
    if (!link.isFile() || link.isSymbolicLink() || link.size > MAX_SOURCE_BYTES) return null;
    const physical = await fs.realpath(location);
    if (!within(root, physical)) return null;
    const buffer = await fs.readFile(physical);
    const contents = utf8Decoder.decode(buffer);
    if (contents.includes('\0')) return null;
    return { file: doc.path, lines: contents.split(/\r?\n|\r/u), index: doc };
  } catch { return null; }
}

async function readUntrackedIndex(root: string, indexPath: string): Promise<Uint8Array> {
  if (!indexPath.trim()) throw new Error('SCIP index path must be non-empty');
  const absolute = path.resolve(root, indexPath);
  if (!within(root, absolute)) throw new Error('SCIP index path escapes the checkout root');
  const lstat = await fs.lstat(absolute);
  if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.size < 1 || lstat.size > MAX_INDEX_BYTES) {
    throw new Error('SCIP index must be a bounded regular non-symlink file');
  }
  const real = await fs.realpath(absolute);
  if (!within(root, real)) throw new Error('SCIP index resolves outside the checkout root');
  return await fs.readFile(real);
}

/** Build a source-backed, ephemeral DI graph projection from a precomputed .scip index. */
export async function projectLocalScipEvidence(input: {
  root: string;
  indexPath: string;
  graph: IntelligenceGraph;
}): Promise<ScipEvidenceProjection> {
  const root = await fs.realpath(path.resolve(input.root));
  const changed = (await runChecked('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (changed) throw new Error('SCIP evidence requires tracked source identical to the exact Git HEAD');
  const sha = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (sha !== input.graph.repositoryRevision) throw new Error('SCIP evidence graph must match the exact checked-out Git revision');
  const bytes = await readUntrackedIndex(root, input.indexPath);
  const parsed = decodeScipIndex(bytes);
  const indexHash = createHash('sha256').update(bytes).digest('hex');

  const actual = new Map<string, SourceDocument>();
  let skipped = 0;
  for (const doc of parsed.documents) {
    if (actual.has(doc.path)) throw new Error('SCIP index repeats the same canonical document path');
    const file = await trackedDocument(root, doc, input.graph);
    if (file) actual.set(doc.path, file);
    else skipped += 1;
  }

  const declarationIndex = new Map<string, GraphNode[]>();
  for (const node of input.graph.nodes) {
    if (!node.name || !DECLARATION_KINDS.has(node.kind) || !node.sourceId.startsWith('repo:')) continue;
    const file = node.sourceId.slice(5);
    const line = declarationLine(node, file);
    if (line === null) continue;
    const key = file + '\0' + String(line) + '\0' + node.name;
    const group = declarationIndex.get(key) ?? [];
    group.push(node);
    declarationIndex.set(key, group);
  }

  const definitions = new Map<string, ScipDefinition[]>();
  let definitionsMatched = 0;
  let rejectedOccurrences = 0;
  for (const file of actual.values()) {
    for (const occurrence of file.index.occurrences) {
      if (!(occurrence.roles & 1) || !occurrence.symbol || occurrence.symbol.startsWith('local ')) continue;
      const name = sourceSlice(file, occurrence);
      if (!name || !occurrence.range) { rejectedOccurrences += 1; continue; }
      const line = occurrence.range.line + 1;
      const candidates = declarationIndex.get(file.file + '\0' + String(line) + '\0' + name) ?? [];
      if (candidates.length !== 1) { rejectedOccurrences += 1; continue; }
      const item = { target: candidates[0]!, file: file.file, line };
      const group = definitions.get(occurrence.symbol) ?? [];
      group.push(item);
      definitions.set(occurrence.symbol, group);
      definitionsMatched += 1;
    }
  }

  const byId = new Map<string, GraphEdge>();
  let referencedSymbolsMatched = 0;
  let ambiguous = 0;
  for (const file of actual.values()) {
    for (const occurrence of file.index.occurrences) {
      if ((occurrence.roles & 1) || !occurrence.symbol || occurrence.symbol.startsWith('local ')) continue;
      const text = sourceSlice(file, occurrence);
      if (!text || !occurrence.range) { rejectedOccurrences += 1; continue; }
      const matches = definitions.get(occurrence.symbol) ?? [];
      const identities = new Set(matches.map(item => item.target.id));
      if (identities.size > 1) { ambiguous += 1; continue; }
      if (identities.size !== 1) { rejectedOccurrences += 1; continue; }
      const target = matches[0]!;
      if (target.file === file.file) continue;
      const from = 'file:' + file.file;
      const locator = file.file + ':' + (occurrence.range.line + 1) + ':' + (occurrence.range.start + 1);
      const sourceEvidence = [
        locator,
        target.file + ':' + target.line,
        'SCIP index ' + indexHash + ' (' + parsed.producer.name + ' ' + parsed.producer.version + '); caller-supplied, not independently attested',
      ];
      const edge = resolution({
        from, to: target.target.id, kind: 'references-symbol',
        strategy: SCIP_EVIDENCE_STRATEGY, confidence: null, status: 'candidate',
        evidence: sourceEvidence, layer: 'structural', checkpoint: false,
      });
      const prior = byId.get(edge.id);
      if (prior) {
        prior.evidence = [...new Set([...prior.evidence, ...edge.evidence])].sort();
      } else if (byId.size < MAX_EDGES) {
        byId.set(edge.id, edge);
      } else throw new Error('SCIP correlated relationships exceed the bounded capacity');
      referencedSymbolsMatched += 1;
    }
  }

  const added = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    graph: {
      ...input.graph,
      graphId: 'scip-overlay-' + sha.slice(0, 12) + '-' + indexHash.slice(0, 12),
      edges: [...input.graph.edges, ...added],
    },
    index: { sha256: indexHash, producer: parsed.producer, documents: parsed.documents.length, occurrences: parsed.occurrenceCount },
    counts: {
      sourceDocumentsMatched: actual.size,
      sourceDocumentsSkipped: skipped,
      definitionsMatched,
      referencedSymbolsMatched,
      candidateEdges: added.length,
      ambiguousDefinitions: ambiguous,
      unresolvedOrUnsafeOccurrences: rejectedOccurrences,
    },
    policy: {
      sourceBackedPositiveCandidatesOnly: true,
      externallySuppliedIndexNotAttested: true,
      negativeCoverageNotEstablished: true,
      canonicalAuthorityUnaffected: true,
      runtimeExecutionNotProven: true,
      stored: false,
    },
  };
}
