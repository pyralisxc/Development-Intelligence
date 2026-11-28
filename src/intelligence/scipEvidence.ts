import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphEdge, GraphNode, GraphProducerContribution, IntelligenceGraph } from '../types.js';
import { observation, resolution } from './model.js';
import { stableHash } from '../util/hash.js';
import { decodeScipIndex, type ScipDocument, type ScipOccurrence } from './scipWire.js';
import { runChecked } from '../util/process.js';
import { compilerTypeScriptReferences, TYPESCRIPT_COMPILER_LENS } from './typescriptCompilerLens.js';
import { loadCompilerOptions } from './repository.js';

/**
 * SCIP contributes source-located symbols and references. DI-run producer
 * output belongs to the build's selected checkout; separately supplied index
 * relationships remain candidates unless the compiler corroborates them.
 * A reference is not itself a call or a claim about runtime execution.
 */
export const SCIP_EVIDENCE_STRATEGY = 'scip-source-correlated.v2';
const DECLARATION_KINDS = new Set(['function', 'method', 'class', 'constructor', 'interface', 'type', 'declaration', 'struct', 'enum']);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

interface ScipDefinition { target: GraphNode; file: string | null; line: number | null }
interface SourceDocument { file: string; text: string; lines: string[]; index: ScipDocument }

export interface ScipEvidenceProjection {
  graph: IntelligenceGraph;
  index: {
    sha256: string;
    contentSha256: string;
    producer: { name: string; version: string };
    documents: number;
    occurrences: number;
    projectPrefix: string;
    legacyPositionEncoding: 'utf8' | 'utf16' | 'utf32' | null;
    assumedPositionEncodingDocuments: number;
  };
  counts: {
    sourceDocumentsMatched: number;
    sourceDocumentsSkipped: number;
    sourceDocumentsNotIndexed: number;
    definitionsMatched: number;
    referencedSymbolsMatched: number;
    candidateEdges: number;
    resolvedEdges: number;
    compilerCorroboratedOccurrences: number;
    consolidatedReferences: number;
    compilerVerification: 'completed' | 'not-applicable' | 'bounded-out' | 'unavailable';
    ambiguousDefinitions: number;
    unresolvedOrUnsafeOccurrences: number;
    externalReferences: number;
    referencesWithoutIndexedDefinition: number;
  };
  unindexedSourcePaths: string[];
  compilerOverlap: {
    baseline: 'canonical-typescript-checker';
    comparisonUnit: 'exact-caller-file-line-column-and-declaration';
    canonicalCompilerVerifiedSites: number;
    scipCompilerVerifiedSites: number;
    alreadyInCanonicalCompilerLensSites: number;
    notInCanonicalCompilerLensSites: number;
    notObservedIsNotProofOfNovelMeaning: true;
  };
  policy: {
    independentlyCompilerProvenTechnicalEdgesAreResolved: true;
    remainingUnverifiedPositiveReferencesStayCandidates: boolean;
    externallySuppliedIndexNotAttested: boolean;
    assumedLegacyPositionEncodingIsNotIndependentProof: true;
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
  if (!range || range.line >= source.lines.length) return null;
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

async function trackedDocument(root: string, doc: ScipDocument, eligiblePaths: ReadonlySet<string>): Promise<SourceDocument | null> {
  if (!safeRelative(doc.path)) throw new Error('SCIP document path is not canonical or would escape the repository');
  if (![1, 2, 3].includes(doc.positionEncoding)) return null;
  if (!eligiblePaths.has(doc.path)) return null;
  const location = path.resolve(root, doc.path);
  if (!within(root, location)) throw new Error('SCIP document escapes the inspected checkout');
  try {
    const link = await fs.lstat(location);
    if (!link.isFile() || link.isSymbolicLink()) return null;
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
  if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.size < 1) {
    throw new Error('SCIP index must be a non-empty regular non-symlink file');
  }
  const real = await fs.realpath(absolute);
  if (!within(root, real)) throw new Error('SCIP index resolves outside the checkout root');
  return await fs.readFile(real);
}

/** Build a source-backed, ephemeral DI graph projection from a precomputed .scip index. */
export async function projectLocalScipEvidence(input: {
  root: string;
  indexPath?: string;
  /** A producer run by DI in this checkout can pass its generated index directly. */
  indexBytes?: Uint8Array;
  producerRanOnCheckout?: boolean;
  graph: IntelligenceGraph;
  projectPrefix?: string;
  /** Explicit, non-authoritative fallback ONLY for SCIP documents with unspecified offset encoding. */
  legacyPositionEncoding?: 'utf8' | 'utf16' | 'utf32';
}): Promise<ScipEvidenceProjection> {
  const root = await fs.realpath(path.resolve(input.root));
  const changed = (await runChecked('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (input.graph.sourceState && !input.producerRanOnCheckout) throw new Error('Working-tree SCIP evidence must be produced with this graph build');
  if (changed && !input.graph.sourceState) throw new Error('SCIP evidence requires tracked source identical to the exact Git HEAD');
  const sha = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (sha !== (input.graph.sourceState?.headRevision ?? input.graph.repositoryRevision)) throw new Error('SCIP evidence graph must match the checked-out Git revision');
  const prefix = projectPrefix(input.projectPrefix);
  const legacy = input.legacyPositionEncoding ?? null;
  const encodings = { utf8: 1, utf16: 2, utf32: 3 } as const;
  if (legacy !== null && !(legacy in encodings)) throw new Error('SCIP legacy position encoding must be utf8, utf16 or utf32');
  if (prefix && !input.graph.coverage?.files.some(item => item.path.startsWith(prefix + '/'))) {
    throw new Error('SCIP project prefix has no tracked source files in the inspected graph');
  }
  if (!input.indexBytes && !input.indexPath) throw new Error('SCIP index is required');
  const bytes = input.indexBytes ?? await readUntrackedIndex(root, input.indexPath!);
  const parsed = decodeScipIndex(bytes);
  const indexHash = createHash('sha256').update(bytes).digest('hex');
  // The wire metadata embeds the temporary checkout path. Hash the decoded
  // repository-relative facts separately so replay at the same revision has a
  // stable identity even when its checkout lives in another directory.
  // Hash the same JSON representation incrementally. Stringifying a large
  // index as one value temporarily holds another graph-sized string in memory.
  const contentHasher = createHash('sha256');
  contentHasher.update('{"producer":').update(JSON.stringify(parsed.producer)).update(',"documents":[');
  for (let i = 0; i < parsed.documents.length; i += 1) {
    if (i) contentHasher.update(',');
    contentHasher.update(JSON.stringify(parsed.documents[i]));
  }
  contentHasher.update('],"externalSymbols":').update(JSON.stringify(parsed.externalSymbols))
    .update(',"occurrenceCount":').update(JSON.stringify(parsed.occurrenceCount)).update('}');
  const contentHash = contentHasher.digest('hex');

  const actual = new Map<string, SourceDocument>();
  const graphFiles = new Map(input.graph.nodes.filter(node => node.kind === 'file').map(node => [node.id, node]));
  const eligiblePaths = new Set((input.graph.coverage?.files ?? [])
    .filter(item => (item.status === 'complete' || item.status === 'partial') && graphFiles.has('file:' + item.path))
    .map(item => item.path));
  const seenDocuments = new Set<string>();
  let skipped = 0;
  let assumedPositionEncodingDocuments = 0;
  for (const doc of parsed.documents) {
    // Validate the producer's relative paths before adding any explicit prefix.
    // A mapped document never gains authority solely by existing in the index.
    const producerPath = doc.path.replace(/\\/gu, '/');
    if (!safeRelative(producerPath)) throw new Error('SCIP document path is not canonical or would escape the repository');
    const mappedPath = prefix ? prefix + '/' + producerPath : producerPath;
    if (seenDocuments.has(mappedPath)) throw new Error('SCIP index repeats the same canonical document path');
    seenDocuments.add(mappedPath);
    const assumed = doc.positionEncoding === 0 && legacy !== null;
    if (assumed) assumedPositionEncodingDocuments += 1;
    const mapped = { ...doc, path: mappedPath,
      positionEncoding: assumed ? encodings[legacy!] : doc.positionEncoding };
    const file = await trackedDocument(root, mapped, eligiblePaths);
    if (file) actual.set(mappedPath, file);
    else skipped += 1;
  }
  const unindexedSourcePaths = [...eligiblePaths].filter(file =>
    /\.[cm]?[jt]sx?$/iu.test(file) && (!prefix || file.startsWith(prefix + '/')) && !actual.has(file)).sort();

  // Source bindings can contain a reference that SCIP resolves to a symbol
  // DI's local-binding pass did not create (for example a module constant).
  // Join the exact identifier occurrence, never a name-only match, and keep
  // nested callable bodies under their own lexical owners.
  const bindingOccurrences = new Map<string, Map<string, GraphNode[]>>();
  const startsByFile = new Map<string, number[]>();
  for (const binding of input.graph.nodes) {
    if (binding.kind !== 'source-binding' || !binding.sourceId.startsWith('repo:') || !binding.value || typeof binding.value !== 'object' || Array.isArray(binding.value)) continue;
    const file = actual.get(binding.sourceId.slice(5));
    if (!file) continue;
    const value = binding.value as { identifierOffset?: unknown; expressionStructure?: unknown; iterationStructure?: unknown };
    let starts = startsByFile.get(file.file);
    if (!starts) {
      starts = [0];
      for (const match of file.text.matchAll(/\r\n|\r|\n/gu)) starts.push(match.index! + match[0].length);
      startsByFile.set(file.file, starts);
    }
    let occurrences = bindingOccurrences.get(file.file);
    if (!occurrences) { occurrences = new Map(); bindingOccurrences.set(file.file, occurrences); }
    const pending = [value.expressionStructure, value.iterationStructure];
    while (pending.length) {
      const part = pending.pop() as { kind?: unknown; start?: unknown; end?: unknown; children?: unknown } | undefined;
      if (!part || typeof part !== 'object') continue;
      if (typeof part.kind === 'string' && ['ArrowFunction', 'FunctionExpression', 'FunctionDeclaration', 'MethodDeclaration'].includes(part.kind)) continue;
      if (Array.isArray(part.children) && part.children.length) { pending.push(...part.children); continue; }
      if (part.kind !== 'Identifier' || typeof part.start !== 'number' || typeof part.end !== 'number' || part.start === value.identifierOffset) continue;
      let low = 0, high = starts.length;
      while (low < high) { const mid = (low + high) >>> 1; if (starts[mid]! <= part.start) low = mid + 1; else high = mid; }
      const line = Math.max(0, low - 1), column = part.start - starts[line]!;
      const key = [line, column, part.end - part.start].join('\0');
      const list = occurrences.get(key) ?? [];
      if (!list.some(node => node.id === binding.id)) list.push(binding);
      occurrences.set(key, list);
    }
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
  const producerNodes = new Map<string, GraphNode>();
  const contributions = new Map<string, GraphProducerContribution[]>();
  const producerContainment = new Map<string, GraphEdge>();
  let definitionsMatched = 0;
  let rejectedOccurrences = 0;
  for (const file of actual.values()) {
    for (const occurrence of file.index.occurrences) {
      if (!(occurrence.roles & 1) || !occurrence.symbol || occurrence.symbol.startsWith('local ')) continue;
      // SCIP's TypeScript producer represents a document/module definition by
      // a zero-width document occurrence. The file already has an identity in
      // the shared graph; use it rather than discarding the producer's symbol.
      if (occurrence.documentOccurrence && occurrence.symbol.endsWith('/')) {
        const fileNode = graphFiles.get('file:' + file.file);
        if (fileNode) {
          const group = definitions.get(occurrence.symbol) ?? [];
          group.push({ target: fileNode, file: file.file, line: 1 });
          definitions.set(occurrence.symbol, group);
          definitionsMatched += 1;
          continue;
        }
      }
      const name = sourceSlice(file, occurrence);
      if (!name || !occurrence.range) { rejectedOccurrences += 1; continue; }
      const line = occurrence.range.line + 1;
      const candidates = declarationIndex.get(file.file + '\0' + String(line) + '\0' + name) ?? [];
      if (candidates.length > 1) { rejectedOccurrences += 1; continue; }
      let target = candidates[0];
      if (!target) {
        const column = utf16Start(file, occurrence);
        if (column === null) { rejectedOccurrences += 1; continue; }
        const locator = file.file + ':' + line + ':' + (column + 1);
        const id = 'scip-declaration:' + stableHash([file.file, occurrence.range.line,
          occurrence.range.start, occurrence.range.end, occurrence.symbol]);
        target = observation({ id, sourceId: 'repo:' + file.file, kind: 'declaration', locator,
          name, field: 'scip-symbol', raw: name,
          value: { symbol: occurrence.symbol, producer: parsed.producer,
            sourceRange: occurrence.range, positionEncoding: file.index.positionEncoding },
          layer: 'structural', checkpoint: false });
        producerNodes.set(id, target);
        const contains = resolution({ from: 'file:' + file.file, to: id, kind: 'contains',
          strategy: SCIP_EVIDENCE_STRATEGY, confidence: 1, status: 'resolved',
          evidence: [locator], layer: 'structural', checkpoint: false });
        producerContainment.set(contains.id, contains);
      }
      if (input.producerRanOnCheckout) {
        const column = utf16Start(file, occurrence);
        if (column !== null) {
          const items = contributions.get(target.id) ?? [];
          items.push({ producer: parsed.producer.name, version: parsed.producer.version,
            symbol: occurrence.symbol, locator: `${file.file}:${line}:${column + 1}` });
          contributions.set(target.id, items);
        }
      }
      const item = { target, file: file.file, line };
      const group = definitions.get(occurrence.symbol) ?? [];
      group.push(item);
      definitions.set(occurrence.symbol, group);
      definitionsMatched += 1;
    }
  }

  // For separately supplied indexes, cross-check source references and
  // destinations with the TypeScript checker when possible.
  const compiler = input.producerRanOnCheckout ? { edges: [], state: 'not-applicable' as const }
    : compilerTypeScriptReferences({
      root, sourceTexts: new Map([...actual.values()]
        .filter(value => /\.(?:[cm]?[jt]s|tsx|jsx)$/iu.test(value.file))
        .map(value => [value.file, value.text])), nodes: input.graph.nodes,
      fileNodes: new Map(input.graph.nodes.filter(node => node.kind === 'file' && node.sourceId.startsWith('repo:'))
        .map(node => [node.sourceId.slice(5), node])),
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

  // Compare exact static reference/target proof against the already present
  // canonical TypeChecker lens. An overlapping SCIP edge is *corroboration*,
  // not a newly discovered technical relationship or application meaning.
  const canonicalCompilerSites = new Set<string>();
  for (const edge of input.producerRanOnCheckout ? [] : input.graph.edges) {
    if (edge.strategy !== TYPESCRIPT_COMPILER_LENS || edge.kind !== 'references-symbol'
      || edge.status !== 'resolved' || !edge.from || !edge.to) continue;
    for (const locator of edge.evidence) {
      if (!locator.startsWith('repo:') && /^[^\n]+:\d+:\d+$/u.test(locator)) {
        canonicalCompilerSites.add([edge.from, edge.to, locator].join('\0'));
      }
    }
  }
  const scipVerifiedSites = new Set<string>();
  const canonicalOverlappingSites = new Set<string>();

  const byId = new Map<string, GraphEdge>();
  const aggregateEvidence = new Map<string, Set<string>>();
  const externalSymbols = new Set(parsed.externalSymbols);
  let corroborated = 0;
  let referencedSymbolsMatched = 0;
  let ambiguous = 0;
  let externalReferences = 0;
  let referencesWithoutIndexedDefinition = 0;
  const producerEvidence = 'SCIP index ' + (input.producerRanOnCheckout ? contentHash : indexHash) + ' (' + parsed.producer.name + ' ' + parsed.producer.version + '); '
    + (input.producerRanOnCheckout ? 'produced by DI on this checkout' : 'caller-supplied, not independently attested');
  for (const file of actual.values()) {
    for (const occurrence of file.index.occurrences) {
      if ((occurrence.roles & 1) || !occurrence.symbol || occurrence.symbol.startsWith('local ')) continue;
      const text = sourceSlice(file, occurrence);
      if (!text || !occurrence.range) { rejectedOccurrences += 1; continue; }
      const matches = definitions.get(occurrence.symbol) ?? [];
      const identities = new Set(matches.map(item => item.target.id));
      if (identities.size > 1) { ambiguous += 1; continue; }
      let target: ScipDefinition;
      if (identities.size === 0) {
        const external = externalSymbols.has(occurrence.symbol);
        if (external) externalReferences += 1;
        else referencesWithoutIndexedDefinition += 1;
        const id = 'scip-symbol:' + stableHash([occurrence.symbol]);
        const symbol = producerNodes.get(id) ?? observation({
          id, sourceId: 'repository', kind: external ? 'external-symbol' : 'unlocated-symbol',
          locator: 'scip:' + occurrence.symbol, name: text, field: 'scip-symbol', raw: text,
          value: { symbol: occurrence.symbol, producer: parsed.producer, definitionLocation: null },
          layer: 'structural', checkpoint: false,
        });
        producerNodes.set(id, symbol);
        target = { target: symbol, file: null, line: null };
      } else {
        target = matches[0]!;
      }
      const from = 'file:' + file.file;
      const unicodePosition = utf16Start(file, occurrence);
      if (unicodePosition === null) { rejectedOccurrences += 1; continue; }
      const locator = file.file + ':' + (occurrence.range.line + 1) + ':' + (unicodePosition + 1);
      const compilerLocator = unicodePosition === null ? null
        : file.file + ':' + (occurrence.range.line + 1) + ':' + (unicodePosition + 1);
      const provenSiteKey = compilerLocator === null ? null
        : [from, target.target.id, compilerLocator].join('\0');
      const independentProof = provenSiteKey !== null && compilerSiteProof.has(provenSiteKey);
      if (independentProof && provenSiteKey !== null) {
        corroborated += 1;
        scipVerifiedSites.add(provenSiteKey);
        if (canonicalCompilerSites.has(provenSiteKey)) canonicalOverlappingSites.add(provenSiteKey);
      }
      const sourceEvidence = [
        locator,
        ...(target.file && target.line ? [target.file + ':' + target.line] : ['Definition location was not present in the indexed checkout']),
        producerEvidence,
        ...(independentProof ? [
          'Independent TypeScript TypeChecker (' + TYPESCRIPT_COMPILER_LENS + ') resolved this exact source reference and target; compile-time binding only',
        ] : []),
      ];
      const occurrenceId = 'scip-reference:' + stableHash([file.file, occurrence.range.line,
        occurrence.range.start, occurrence.range.end, occurrence.symbol]);
      producerNodes.set(occurrenceId, observation({
        id: occurrenceId, sourceId: 'repo:' + file.file, kind: 'source-reference', locator,
        name: text, field: 'scip-symbol-reference', raw: text,
        value: { symbol: occurrence.symbol, producer: parsed.producer,
          sourceRange: occurrence.range, positionEncoding: file.index.positionEncoding },
        layer: 'structural', checkpoint: false,
      }));
      const contains = resolution({ from, to: occurrenceId, kind: 'contains',
        strategy: SCIP_EVIDENCE_STRATEGY, confidence: 1, status: 'resolved',
        evidence: [locator], layer: 'structural', checkpoint: false });
      producerContainment.set(contains.id, contains);
      for (const binding of bindingOccurrences.get(file.file)?.get([occurrence.range.line, unicodePosition, text.length].join('\0')) ?? []) {
        const bindingReference = resolution({ from: binding.id, to: occurrenceId, kind: 'has-source-occurrence',
          strategy: 'scip-source-binding-occurrence.v1', confidence: independentProof || input.producerRanOnCheckout ? 1 : null,
          status: independentProof || input.producerRanOnCheckout ? 'resolved' : 'candidate',
          evidence: [binding.locator, ...sourceEvidence], ...(binding.evidenceIds ? { evidenceIds: binding.evidenceIds } : {}), layer: 'structural', checkpoint: false });
        producerContainment.set(bindingReference.id, bindingReference);
      }
      const occurrenceEdge = resolution({ from: occurrenceId, to: target.target.id,
        kind: 'references-symbol', strategy: SCIP_EVIDENCE_STRATEGY,
        confidence: independentProof || input.producerRanOnCheckout ? 1 : null,
        status: independentProof || input.producerRanOnCheckout ? 'resolved' : 'candidate',
        evidence: sourceEvidence, layer: 'structural', checkpoint: false });
      byId.set(occurrenceEdge.id, occurrenceEdge);
      const edge = resolution({
        from, to: target.target.id, kind: 'references-symbol',
        strategy: SCIP_EVIDENCE_STRATEGY,
        confidence: independentProof || input.producerRanOnCheckout ? 1 : null,
        status: independentProof || input.producerRanOnCheckout ? 'resolved' : 'candidate',
        evidence: sourceEvidence, layer: 'structural', checkpoint: false,
      });
      const prior = byId.get(edge.id);
      if (prior) {
        const evidence = aggregateEvidence.get(edge.id)!;
        for (const item of edge.evidence) evidence.add(item);
      } else {
        byId.set(edge.id, edge);
        aggregateEvidence.set(edge.id, new Set(edge.evidence));
      }
      referencedSymbolsMatched += 1;
    }
  }

  for (const [id, evidence] of aggregateEvidence) byId.get(id)!.evidence = [...evidence].sort();
  const added = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  // A DI-produced index is merged into the fresh graph owned by this build.
  // Supplied indexes keep their existing non-mutating projection contract.
  const resultNodes = input.producerRanOnCheckout ? input.graph.nodes : [...input.graph.nodes];
  for (const node of producerNodes.values()) resultNodes.push(node);
  for (let i = 0; i < resultNodes.length; i += 1) {
    const node = resultNodes[i]!;
    const additions = contributions.get(node.id);
    if (!additions?.length) continue;
    const unique = new Map([...(node.contributions ?? []), ...additions]
      .map(item => [JSON.stringify(item), item]));
    resultNodes[i] = { ...node, contributions: [...unique.values()] };
  }
  const resultEdges = input.producerRanOnCheckout ? input.graph.edges : [...input.graph.edges];
  for (const edge of producerContainment.values()) resultEdges.push(edge);
  // The compiler and SCIP may independently establish the same file-to-symbol
  // relationship. Keep one owner, retaining each producer's evidence and the
  // separate source-occurrence nodes. Candidate relationships remain separate.
  const nativeReferences = new Map<string, number[]>();
  const referenceKey = (edge: GraphEdge) => JSON.stringify([edge.from, edge.to, edge.kind, edge.status]);
  if (input.producerRanOnCheckout) for (let index = 0; index < resultEdges.length; index += 1) {
    const edge = resultEdges[index]!;
    if (edge.kind !== 'references-symbol' || edge.status !== 'resolved' || !edge.from?.startsWith('file:') || edge.strategy !== TYPESCRIPT_COMPILER_LENS) continue;
    const key = referenceKey(edge);
    nativeReferences.set(key, [...(nativeReferences.get(key) ?? []), index]);
  }
  let consolidatedReferences = 0;
  for (const edge of added) {
    const candidates = edge.kind === 'references-symbol' && edge.status === 'resolved' && edge.from?.startsWith('file:')
      ? nativeReferences.get(referenceKey(edge)) : undefined;
    if (candidates?.length !== 1) { resultEdges.push(edge); continue; }
    const index = candidates[0]!;
    const native = resultEdges[index]!;
    const evidence = [...new Set([...native.evidence, ...edge.evidence])].sort();
    const layer = (strategy: string, values: string[], evidenceIds?: string[]) => ({ strategy,
      evidenceIndexes: values.map(value => evidence.indexOf(value)), ...(evidenceIds?.length ? { evidenceIds } : {}) });
    resultEdges[index] = { ...native, evidence,
      evidenceIds: [...new Set([...(native.evidenceIds ?? []), ...(edge.evidenceIds ?? [])])].sort(),
      evidenceLayers: [layer(native.strategy, native.evidence, native.evidenceIds), layer(edge.strategy, edge.evidence, edge.evidenceIds)] };
    consolidatedReferences += 1;
  }
  return {
    graph: {
      ...input.graph,
      graphId: 'scip-overlay-' + createHash('sha256')
        .update(JSON.stringify([input.graph.graphId, sha, indexHash, prefix, legacy, SCIP_EVIDENCE_STRATEGY]))
        .digest('hex').slice(0, 24),
      nodes: resultNodes,
      edges: resultEdges,
    },
    index: { sha256: indexHash, contentSha256: contentHash, producer: parsed.producer, documents: parsed.documents.length,
      occurrences: parsed.occurrenceCount, projectPrefix: prefix,
      legacyPositionEncoding: legacy, assumedPositionEncodingDocuments },
    counts: {
      sourceDocumentsMatched: actual.size,
      sourceDocumentsSkipped: skipped,
      sourceDocumentsNotIndexed: unindexedSourcePaths.length,
      definitionsMatched,
      referencedSymbolsMatched,
      candidateEdges: added.filter(edge => edge.status === 'candidate').length,
      resolvedEdges: added.filter(edge => edge.status === 'resolved').length,
      compilerCorroboratedOccurrences: corroborated,
      consolidatedReferences,
      compilerVerification: compiler.state,
      ambiguousDefinitions: ambiguous,
      unresolvedOrUnsafeOccurrences: rejectedOccurrences,
      externalReferences,
      referencesWithoutIndexedDefinition,
    },
    unindexedSourcePaths,
    compilerOverlap: {
      baseline: 'canonical-typescript-checker',
      comparisonUnit: 'exact-caller-file-line-column-and-declaration',
      canonicalCompilerVerifiedSites: canonicalCompilerSites.size,
      scipCompilerVerifiedSites: scipVerifiedSites.size,
      alreadyInCanonicalCompilerLensSites: canonicalOverlappingSites.size,
      notInCanonicalCompilerLensSites: scipVerifiedSites.size - canonicalOverlappingSites.size,
      notObservedIsNotProofOfNovelMeaning: true,
    },
    policy: {
      independentlyCompilerProvenTechnicalEdgesAreResolved: true,
      remainingUnverifiedPositiveReferencesStayCandidates: !input.producerRanOnCheckout,
      externallySuppliedIndexNotAttested: !input.producerRanOnCheckout,
      assumedLegacyPositionEncodingIsNotIndependentProof: true,
      negativeCoverageNotEstablished: true,
      canonicalAuthorityUnaffected: true,
      runtimeExecutionNotProven: true,
      stored: false,
    },
  };
}
