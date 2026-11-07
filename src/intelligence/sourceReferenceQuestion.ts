import type { GraphEdge, IntelligenceGraph } from '../types.js';
import { graphQueryContext } from './queryContext.js';

/**
 * A source-reference question names an exact tracked file and one code symbol.
 * Routing is lexical only for those explicit identifiers; the answer comes
 * exclusively from existing resolved graph edges and their source spans.
 * No compiler/indexer is executed, and no new graph authority is created.
 */
const FILE_PATH = /(?<![\p{L}\p{N}_.\/-])(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_.@-]+\.(?:tsx?|jsx?|mts|cts|mjs|cjs|py|cs|java|go|rs)(?![\p{L}\p{N}_.-])/gu;
const REFERENCE_WORD = /\b(?:calls?|called|calling|callers?|referenc(?:e|es|ed|ing)|invok(?:e|es|ed|ing)|us(?:e|es|ed|ing)|usages?|bind(?:s|ing)?|resolv(?:e|es|ed|ing))\b/iu;
const COMMON = new Set(('a an all and are as at be by can could declaration declarations definition definitions ' +
  'does do exact exists file find for from function functions how identifier in into is it its ' +
  'me module name of on or our reference references referenced referencing call called calling calls callers ' +
  'resolve resolves resolved resolving which where what when who why with within would show source ' +
  'symbol symbols this that the these those to used using use uses us about relation relationship ' +
  'relationships method methods invoked invokes invoke binding bindings point points target targets ' +
  'is it does return returns give list locate please').split(/\s+/u));

export interface ExplicitSourceReferenceQuestion {
  paths: string[];
  symbols: string[];
}

export interface SourceReferenceProjection {
  sourcePath: string | null;
  symbol: string | null;
  status: 'supported' | 'unproven';
  reason: 'resolved-static-reference' | 'ambiguous-source' | 'ambiguous-symbol' |
    'out-of-scope' | 'source-unavailable' | 'no-resolved-reference' | 'ambiguous-target';
  sourceNodeId: string | null;
  targetNodeId: string | null;
  totalEdges: number;
  truncated: boolean;
  edges: GraphEdge[];
  targetCandidates: string[];
  coverage: {
    sourceStatus: string | null;
    unavailable: boolean;
    absenceProven: false;
  };
}

/** Explicit identifiers only: no substring matching, fuzzy file lookup or inferred subject. */
export function parseSourceReferenceQuestion(text: string): ExplicitSourceReferenceQuestion | null {
  if (!REFERENCE_WORD.test(text)) return null;
  const paths = [...new Set([...text.matchAll(FILE_PATH)].map(item => item[0]))].sort();
  if (!paths.length) return null;
  let rest = text;
  for (const file of paths) rest = rest.split(file).join(' ');
  const symbols = [...new Set((rest.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? [])
    .filter(token => !COMMON.has(token.toLowerCase())))].sort();
  // Questions about everything a file calls are broad traversal requests,
  // not exact-source/symbol identity requests. Preserve the ordinary route.
  if (!symbols.length) return null;
  return { paths, symbols };
}

function scopeAllows(scope: string | undefined, sourcePath: string): boolean {
  if (!scope?.trim()) return true;
  const clean = scope.trim().replace(/^(?:file:|repo:)/u, '').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (clean === 'repository') return true;
  return sourcePath === clean || sourcePath.startsWith(clean + '/');
}

function sourceStatus(graph: IntelligenceGraph, path: string | null): string | null {
  if (!path) return null;
  return graph.coverage?.files?.find(item => item.path === path)?.status ?? null;
}

export function sourceReferenceProjection(
  graph: IntelligenceGraph,
  parsed: ExplicitSourceReferenceQuestion,
  scope?: string,
  limit = 25,
): SourceReferenceProjection {
  const path = parsed.paths.length === 1 ? parsed.paths[0]! : null;
  const symbol = parsed.symbols.length === 1 ? parsed.symbols[0]! : null;
  const context = graphQueryContext(graph);
  const file = path ? context.node('file:' + path) : undefined;
  const sourceNodeId = file?.kind === 'file' ? file.id : null;
  const status = sourceStatus(graph, path);
  const coverage = { sourceStatus: status, unavailable: status !== 'complete', absenceProven: false as const };
  const unknown = (reason: SourceReferenceProjection['reason'], candidates: string[] = []): SourceReferenceProjection => ({
    sourcePath: path, symbol, status: 'unproven', reason,
    sourceNodeId, targetNodeId: null, totalEdges: 0, truncated: false, edges: [],
    targetCandidates: candidates, coverage,
  });
  if (!path) return unknown('ambiguous-source');
  if (!symbol) return unknown('ambiguous-symbol');
  if (!scopeAllows(scope, path)) return unknown('out-of-scope');
  if (!sourceNodeId || status !== 'complete') return unknown('source-unavailable');

  // Only outgoing resolved static references and source-declared calls can be
  // evidence of this exact caller/target. Import/contains edges are NOT calls.
  const sourceIds = new Set([
    sourceNodeId,
    ...(context.nodesBySource.get('repo:' + path) ?? []).map(node => node.id),
  ]);
  const candidates = new Map<string, GraphEdge>();
  for (const from of sourceIds) for (const edge of context.outgoing(from)) {
    if (edge.status !== 'resolved' || !edge.to) continue;
    const kindAllowed = (edge.kind === 'references-symbol' && from === sourceNodeId)
      || (edge.kind === 'calls' && from !== sourceNodeId);
    if (!kindAllowed) continue;
    const target = context.node(edge.to);
    if (!target || !target.id.startsWith('symbol:') || target.name !== symbol) continue;
    // Compiler callsite evidence must originate in the caller's selected file.
    if (!(edge.evidence ?? []).some(evidence => evidence.startsWith(path + ':')
      && /^\d+(?::\d+)?$/u.test(evidence.slice(path.length + 1)))) continue;
    candidates.set(edge.id, edge);
  }
  const edges = [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id));
  const targetIds = [...new Set(edges.map(edge => edge.to!).filter(Boolean))].sort();
  if (targetIds.length > 1) return unknown('ambiguous-target', targetIds);
  if (!edges.length) return unknown('no-resolved-reference');

  const bounded = edges.slice(0, Math.max(1, Math.min(limit, 100)));
  return {
    sourcePath: path, symbol, status: 'supported', reason: 'resolved-static-reference',
    sourceNodeId, targetNodeId: targetIds[0] ?? null, totalEdges: edges.length,
    truncated: bounded.length !== edges.length, edges: bounded,
    targetCandidates: targetIds, coverage,
  };
}



/**
 * File-level outgoing-call questions share the same exact-source/canonical-graph
 * evidence path as named source-reference questions. The file—not a lexical
 * fragment such as "functions src/http.ts"—is the subject.
 */
export interface FileOutboundQuestion { paths: string[] }
export interface FileOutboundTarget {
  id: string;
  name: string;
  kind: string;
  declaration: string;
  callsites: string[];
  edgeIds: string[];
  compilerVerified: boolean;
}
export interface FileOutboundProjection {
  sourcePath: string | null;
  sourceNodeId: string | null;
  direction: 'outbound';
  status: 'supported' | 'unproven';
  reason: 'resolved-outbound' | 'ambiguous-source' | 'out-of-scope' |
    'source-unavailable' | 'no-resolved-outbound';
  totalTargets: number;
  totalRelationships: number;
  returnedTargets: number;
  truncated: boolean;
  targets: FileOutboundTarget[];
  edges: GraphEdge[];
  unlocatedRelationships: number;
  unprovenRelationships: number;
  coverage: { sourceStatus: string | null; unavailable: boolean; absenceProven: false };
}

/** Only a bounded, explicit file-as-caller question. Never guess the caller. */
export function parseFileOutboundQuestion(text: string): FileOutboundQuestion | null {
  const paths = [...new Set([...text.matchAll(FILE_PATH)].map(match => match[0]))].sort();
  if (!paths.length) return null;
  let shape = text.trim();
  for (const path of paths) shape = shape.split(path).join('__FILE__');
  const question = shape.replace(/\s+/gu, ' ').trim();
  const directed = /^(?:which|what)\s+(?:(?:functions?|methods?|callees?)\s+)?(?:does|do)\s+(?:(?:the|this)\s+)?(?:(?:file|module)\s+)?__FILE__(?:\s+(?:and|or)\s+(?:(?:the|this)\s+)?(?:(?:file|module)\s+)?__FILE__)*\s+(?:directly\s+)?(?:call|invoke|reference)\s*\??$/iu;
  const listed = /^(?:show|list|find)\s+(?:(?:me|all|the)\s+)?(?:outbound\s+)?(?:calls?|callees?|functions?|methods?)\s+(?:from|in)\s+(?:(?:the|this)\s+)?(?:(?:file|module)\s+)?__FILE__\s*\??$/iu;
  return directed.test(question) || listed.test(question) ? { paths } : null;
}

function exactSourceCallsite(path: string, edge: GraphEdge): string | null {
  return (edge.evidence ?? []).find(item => item.startsWith(path + ':')
    && /^\d+(?::\d+)?$/u.test(item.slice(path.length + 1))) ?? null;
}

/**
 * Enumerate only proven static outbound callable relationships with an exact
 * caller source span and a tracked target declaration. Import statements,
 * candidate/unknown edges, and nearby names are never promoted to calls.
 * A direct TypeChecker edge proves a static signature, not runtime dispatch.
 */
export function fileOutboundProjection(
  graph: IntelligenceGraph,
  parsed: FileOutboundQuestion,
  scope?: string,
  limit = 20,
): FileOutboundProjection {
  const path = parsed.paths.length === 1 ? parsed.paths[0]! : null;
  const context = graphQueryContext(graph);
  const file = path ? context.node('file:' + path) : undefined;
  const sourceNodeId = file?.kind === 'file' ? file.id : null;
  const status = sourceStatus(graph, path);
  const coverage = { sourceStatus: status, unavailable: status !== 'complete', absenceProven: false as const };
  const empty = (reason: FileOutboundProjection['reason']): FileOutboundProjection => ({
    sourcePath: path, sourceNodeId, direction: 'outbound',
    status: 'unproven', reason, totalTargets: 0, totalRelationships: 0, returnedTargets: 0,
    truncated: false, targets: [], edges: [], unlocatedRelationships: 0,
    unprovenRelationships: 0, coverage,
  });
  if (!path) return empty('ambiguous-source');
  if (!scopeAllows(scope, path)) return empty('out-of-scope');
  if (!sourceNodeId || status !== 'complete') return empty('source-unavailable');

  const sources = new Set([
    sourceNodeId,
    ...(context.nodesBySource.get('repo:' + path) ?? []).map(node => node.id),
  ]);
  const groups = new Map<string, { id: string; name: string; kind: string; declaration: string; edges: GraphEdge[] }>();
  let unlocatedRelationships = 0;
  let unprovenRelationships = 0;
  for (const source of sources) for (const edge of context.outgoing(source)) {
    const allowable = (edge.kind === 'references-symbol' && source === sourceNodeId)
      || (edge.kind === 'calls' && source !== sourceNodeId);
    if (!allowable) continue;
    if (edge.status !== 'resolved' || !edge.to) { unprovenRelationships += 1; continue; }
    const target = context.node(edge.to);
    if (!target || !['function', 'method', 'constructor'].includes(target.kind)
      || !target.id.startsWith('symbol:')) continue;
    const callsite = exactSourceCallsite(path, edge);
    if (!callsite || !/:\d+(?::\d+)?$/u.test(target.locator)) {
      unlocatedRelationships += 1;
      continue;
    }
    const group = groups.get(target.id) ?? {
      id: target.id, name: target.name ?? target.id, kind: target.kind,
      declaration: target.locator, edges: [],
    };
    if (!group.edges.some(item => item.id === edge.id)) group.edges.push(edge);
    groups.set(target.id, group);
  }

  const ordered = [...groups.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (!ordered.length) return { ...empty('no-resolved-outbound'), unlocatedRelationships, unprovenRelationships };
  const maxTargets = Math.max(1, Math.min(20, Math.trunc(limit) || 20));
  const shown = ordered.slice(0, maxTargets);
  // A compiler-corroborated callsite must remain in the bounded proof even
  // when several parser-level call observations share the same declaration.
  const bestEdges = (edges: GraphEdge[]) => edges.slice().sort((a, b) =>
    Number(b.kind === 'references-symbol' && b.strategy === 'typescript-checker-symbol.v1')
    - Number(a.kind === 'references-symbol' && a.strategy === 'typescript-checker-symbol.v1')
    || a.id.localeCompare(b.id)).slice(0, 3);
  const edges = shown.flatMap(target => bestEdges(target.edges));
  const targets: FileOutboundTarget[] = shown.map(target => {
    const boundedEdges = bestEdges(target.edges);
    return {
      id: target.id, name: target.name, kind: target.kind, declaration: target.declaration,
      callsites: [...new Set(boundedEdges.map(edge => exactSourceCallsite(path, edge)).filter(
        (site): site is string => Boolean(site)))].sort((a, b) =>
        b.split(':').length - a.split(':').length || a.localeCompare(b)),
      edgeIds: boundedEdges.map(edge => edge.id),
      compilerVerified: boundedEdges.some(edge => edge.kind === 'references-symbol'
        && edge.strategy === 'typescript-checker-symbol.v1'),
    };
  });
  const totalRelationships = ordered.reduce((total, group) => total + group.edges.length, 0);
  return {
    sourcePath: path, sourceNodeId, direction: 'outbound', status: 'supported',
    reason: 'resolved-outbound', totalTargets: ordered.length, totalRelationships,
    returnedTargets: targets.length, truncated: shown.length < ordered.length || edges.length < totalRelationships,
    targets, edges, unlocatedRelationships, unprovenRelationships, coverage,
  };
}

export function fileOutboundAnswer(projection: FileOutboundProjection): string {
  if (projection.status !== 'supported') {
    const reason = projection.reason === 'ambiguous-source'
      ? 'Multiple source files were specified; select exactly one caller.'
      : projection.reason === 'out-of-scope'
        ? 'The requested caller file is outside the selected scope.'
        : projection.reason === 'source-unavailable'
          ? 'The exact source file is missing or not completely analyzed.'
          : 'No source-span-backed resolved outbound callable relationship was observed for this file.';
    return reason + ' This is not proof of an absence of runtime calls.';
  }
  const summary = projection.targets.slice(0, 8).map(target =>
    target.name + ' (' + (target.callsites[0] ?? projection.sourcePath) + ' → ' + target.declaration
    + (target.compilerVerified ? ', TypeChecker' : ', static source') + ')').join('; ');
  const omitted = projection.totalTargets > 8
    ? ' Additional targets are available in the bounded result.' : '';
  const partial = projection.truncated ? ' Result is truncated; not an exhaustive callee inventory.' : '';
  const unknown = projection.unlocatedRelationships || projection.unprovenRelationships
    ? ' ' + (projection.unlocatedRelationships + projection.unprovenRelationships)
      + ' additional call/reference observation(s) lack admissible proof.' : '';
  return projection.totalTargets + ' source-resolved outbound callable target(s) observed for '
    + projection.sourcePath + ': ' + summary + '.' + omitted + partial + unknown
    + ' Static source references do not establish runtime invocation.';
}

export function sourceReferenceAnswer(projection: SourceReferenceProjection): string {
  if (projection.status !== 'supported') {
    const detail = projection.reason === 'source-unavailable'
      ? 'The exact requested source file is not completely observed.'
      : projection.reason === 'out-of-scope'
        ? 'The requested source file is outside the supplied scope.'
        : projection.reason.startsWith('ambiguous')
          ? 'The exact source, symbol, or declaration cannot be selected uniquely.'
          : 'No resolved static reference from that exact source file to that exact symbol is observed.';
    return detail + ' This does not prove that a runtime call is absent.';
  }
  const references = projection.edges.map(edge => {
    const callsite = edge.evidence.find(item => item.startsWith(projection.sourcePath + ':')
      && /^\d+(?::\d+)?$/u.test(item.slice((projection.sourcePath ?? '').length + 1)));
    const declaration = edge.evidence.find(item => item !== callsite && /:\d+(?::\d+)?$/u.test(item));
    return (callsite ?? projection.sourcePath) + ' → ' + (declaration ?? edge.to);
  });
  return 'Resolved static source reference(s): ' + references.join('; ') + '. '
    + (projection.truncated ? 'Additional matches omitted. ' : '')
    + 'This does not establish runtime invocation or exhaustive behavior.';
}
