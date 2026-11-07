import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { resolution } from './model.js';
import { decodeScipIndex, type ScipDocument, type ScipOccurrence } from './scipWire.js';
import { runChecked } from '../util/process.js';
import { compilerTypeScriptReferences, TYPESCRIPT_COMPILER_LENS } from './typescriptCompilerLens.js';
import { loadCompilerOptions } from './repository.js';

/**
 * SCIP evidence is an opt-in source sensor. A caller-supplied index cannot
 * certify its own producer, exact revision, compiler configuration, or full
 * source coverage. Independently corroborated static TypeScript bindings are
 * admitted as RESOLVED technical code facts; other references stay CANDIDATE.
 * This never infers runtime execution or accepted product meaning.
 */
export const SCIP_EVIDENCE_STRATEGY = 'scip-source-correlated.v2';
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_EDGES = 100_000;
const DECLARATION_KINDS = new Set(['function', 'method', 'class', 'constructor', 'interface', 'type', 'declaration', 'struct', 'enum']);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

interface ScipDefinition { target: GraphNode; file: string; line: number }
interface SourceDocument { file: string; text: string; lines: string[]; index: ScipDocument }

export interface ScipEvidenceProjection {
  graph: IntelligenceGraph;
  index: {
    sha256: string;
    producer: { name: string; version: string };
    documents: number;
    occurrences: number;
    projectPrefix: string;
  };
  counts: {
    sourceDocumentsMatched: number;
    sourceDocumentsSkipped: number;
    definitionsMatched: number;
    referencedSymbolsMatched: number;
    candidateEdges: number;
    resolvedEdges: number;
    compilerCorroboratedOccurrences: number;
    compilerVerification: 'completed' | 'not-applicable' | 'bounded-out' | 'unavailable';
    ambiguousDefinitions: number;
    unresolvedOrUnsafeOccurrences: number;
  };
  policy: {
    independentlyCompilerProvenTechnicalEdgesAreResolved: true;
    remainingUnverifiedPositiveReferencesStayCandidates: true;
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

/**
 * A SCIP Index is rooted at a single build project, which may be inside the
 * repository. Never infer this prefix from untrusted index metadata: map the
 * producer's document paths only when the caller explicitly pins the actual
 * project subdirectory of the exact inspected checkout.
 */
function projectPrefix(value: string | undefined): string {
  if (value === undefined || value === '.') return '';
  if (!safeRelative(value)) throw new Error('SCIP project prefix must be a canonical repository-relative path');
  return value;
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

/**
 * SCIP ranges use a document-specific position encoding, while the TypeScript
 * compiler returns UTF-16 source offsets. Convert exactly, failing closed when
 * the byte position bisects an encoded character.
 */
function utf16Start(source: SourceDocument, occurrence: ScipOccurrence): number | null {
  const range = occurrence.range;
  if (!range || range.line >= source.lines.length) return null;
  const line = source.lines[range.line]!;
  if (source.index.positionEncoding === 2) return range.start <= line.length ? range.start : null;
  if (source.index.positionEncoding === 3) {
    const characters = [...line];
    return range.start <= characters.length ? characters.slice(0, range.start).join('').length : null;
  }
  if (source.index.positionEncoding === 1) {
    const bytes = Buffer.from(line, 'utf8');
    if (range.start > bytes.length) return null;
    try { return utf8Decoder.decode(bytes.subarray(0, range.start)).length; }
    catch { return null; }
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
    return { file: doc.path, text: contents, lines: contents.split(/\r?\n|\r/u), index: doc };
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
  projectPrefix?: string;
}): Promise<ScipEvidenceProjection> {
  const root = await fs.realpath(path.resolve(input.root));
  const changed = (await runChecked('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (changed) throw new Error('SCIP evidence requires tracked source identical to the exact Git HEAD');
  const sha = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (sha !== input.graph.repositoryRevision) throw new Error('SCIP evidence graph must match the exact checked-out Git revision');
  const prefix = projectPrefix(input.projectPrefix);
  if (prefix && !input.graph.coverage?.files.some(item => item.path.startsWith(prefix + '/'))) {
    throw new Error('SCIP project prefix has no tracked source files in the inspected graph');
  }
  const bytes = await readUntrackedIndex(root, input.indexPath);
  const parsed = decodeScipIndex(bytes);
  const indexHash = createHash('sha256').update(bytes).digest('hex');

  const actual = new Map<string, SourceDocument>();
  const seenDocuments = new Set<string>();
  let skipped = 0;
  for (const doc of parsed.documents) {
    // Validate the producer's relative paths before adding any explicit prefix.
    // A mapped document never gains authority solely by existing in the index.
    if (!safeRelative(doc.path)) throw new Error('SCIP document path is not canonical or would escape the repository');
    const mappedPath = prefix ? prefix + '/' + doc.path : doc.path;
    if (seenDocuments.has(mappedPath)) throw new Error('SCIP index repeats the same canonical document path');
    seenDocuments.add(mappedPath);
    const mapped = prefix ? { ...doc, path: mappedPath } : doc;
    const file = await trackedDocument(root, mapped, input.graph);
    if (file) actual.set(mappedPath, file);
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

  // SCIP symbol strings are caller-controlled. Cross-verify a source callsite
  // and target against a fresh TypeScript TypeChecker over this exact checkout
  // before representing the relationship as resolved evidence.
  const typeScriptSources = new Map([...actual.values()]
    .filter(value => /\.(?:[cm]?[jt]s|tsx|jsx)$/iu.test(value.file))
    .map(value => [value.file, value.text]));
  const nativeFiles = new Map(input.graph.nodes
    .filter(node => node.kind === 'file' && node.sourceId.startsWith('repo:'))
    .map(node => [node.sourceId.slice(5), node]));
  const compiler = compilerTypeScriptReferences({
    root, sourceTexts: typeScriptSources, nodes: input.graph.nodes, fileNodes: nativeFiles,
    options: loadCompilerOptions(root),
  });
  const compilerSiteProof = new Set<string>();
  for (const edge of compiler.edges) {
    if (edge.strategy !== TYPESCRIPT_COMPILER_LENS || edge.kind !== 'references-symbol'
      || edge.status !== 'resolved' || !edge.from || !edge.to) continue;
    for (const locator of edge.evidence) {
      if (locator.startsWith('repo:')) continue;
      if (/^[^\n]+:\d+:\d+$/u.test(locator)) {
        compilerSiteProof.add([edge.from, edge.to, locator].join('\0'));
      }
    }
  }

  const byId = new Map<string, GraphEdge>();
  let corroborated = 0;
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
      const unicodePosition = utf16Start(file, occurrence);
      const locator = file.file + ':' + (occurrence.range.line + 1) + ':' + (occurrence.range.start + 1);
      const compilerLocator = unicodePosition === null ? null
        : file.file + ':' + (occurrence.range.line + 1) + ':' + (unicodePosition + 1);
      const independentProof = compilerLocator !== null
        && compilerSiteProof.has([from, target.target.id, compilerLocator].join('\0'));
      if (independentProof) corroborated += 1;
      const sourceEvidence = [
        locator,
        target.file + ':' + target.line,
        'SCIP index ' + indexHash + ' (' + parsed.producer.name + ' ' + parsed.producer.version + '); caller-supplied, not independently attested',
        ...(independentProof ? [
          'Independent TypeScript TypeChecker (' + TYPESCRIPT_COMPILER_LENS + ') proved this exact source callsite and target; compile-time binding only',
        ] : []),
      ];
      const edge = resolution({
        from, to: target.target.id, kind: 'references-symbol',
        strategy: SCIP_EVIDENCE_STRATEGY,
        confidence: independentProof ? 1 : null,
        status: independentProof ? 'resolved' : 'candidate',
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
      graphId: 'scip-overlay-' + createHash('sha256')
        .update(JSON.stringify([input.graph.graphId, sha, indexHash, prefix, SCIP_EVIDENCE_STRATEGY]))
        .digest('hex').slice(0, 24),
      edges: [...input.graph.edges, ...added],
    },
    index: { sha256: indexHash, producer: parsed.producer, documents: parsed.documents.length,
      occurrences: parsed.occurrenceCount, projectPrefix: prefix },
    counts: {
      sourceDocumentsMatched: actual.size,
      sourceDocumentsSkipped: skipped,
      definitionsMatched,
      referencedSymbolsMatched,
      candidateEdges: added.filter(edge => edge.status === 'candidate').length,
      resolvedEdges: added.filter(edge => edge.status === 'resolved').length,
      compilerCorroboratedOccurrences: corroborated,
      compilerVerification: compiler.state,
      ambiguousDefinitions: ambiguous,
      unresolvedOrUnsafeOccurrences: rejectedOccurrences,
    },
    policy: {
      independentlyCompilerProvenTechnicalEdgesAreResolved: true,
      remainingUnverifiedPositiveReferencesStayCandidates: true,
      externallySuppliedIndexNotAttested: true,
      negativeCoverageNotEstablished: true,
      canonicalAuthorityUnaffected: true,
      runtimeExecutionNotProven: true,
      stored: false,
    },
  };
}
