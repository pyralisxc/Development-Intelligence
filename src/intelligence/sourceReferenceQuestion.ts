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
