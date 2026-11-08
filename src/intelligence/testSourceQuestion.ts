import type { GraphEdge, IntelligenceGraph } from '../types.js';
import { graphQueryContext } from './queryContext.js';

/**
 * A deliberately small, exact-name source-to-test projection. "Cover" in the
 * input is a navigation request, never a claim of behavioral or runtime proof.
 * The TypeScript compiler lens emits references-symbol only for statically
 * resolved call/new expressions, not mere imports. The parser calls fallback
 * is likewise restricted to resolved calls with real source spans.
 */
export interface TestSourceQuestion { symbol: string }
export interface TestSourceFile {
  path: string;
  callsites: string[];
  edgeIds: string[];
  compilerVerified: boolean;
}
export interface TestSourceProjection {
  symbol: string;
  targetNodeId: string | null;
  targetCandidates: string[];
  targetDeclaration: string | null;
  status: 'supported' | 'unproven';
  reason: 'resolved-test-calls' | 'missing-target' | 'ambiguous-target'
    | 'target-unavailable' | 'out-of-scope' | 'no-resolved-test-call';
  totalTestFiles: number;
  returnedTestFiles: number;
  totalRelationships: number;
  truncated: boolean;
  tests: TestSourceFile[];
  edges: GraphEdge[];
  coverage: {
    targetSourceStatus: string | null;
    completeForEligibleSources: boolean;
    absenceProven: false;
  };
  executionObserved: false;
  assertionBehaviorEstablished: false;
}

const TEST_PATH = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[mc]?[jt]sx?)$/iu;
const CALLABLE_KINDS = ['function', 'method', 'constructor'] as const;

/** Avoid fuzzy subject selection, aliases, paraphrases and accidental name matches. */
export function parseTestSourceQuestion(text: string): TestSourceQuestion | null {
  const match = text.trim().match(/^(?:which|what)\s+tests?\s+(?:cover|call|invoke|reference|exercise)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\??$/iu);
  return match?.[1] ? { symbol: match[1] } : null;
}

function statusFor(graph: IntelligenceGraph, path: string): string | null {
  return graph.coverage?.files?.find(file => file.path === path)?.status ?? null;
}

function inScope(scope: string | undefined, sourcePath: string): boolean {
  if (!scope?.trim()) return true;
  const clean = scope.trim().replace(/^(?:file:|repo:)/u, '').replace(/^\.\//u, '').replace(/\/+$/u, '');
  return clean === 'repository' || clean === sourcePath || sourcePath.startsWith(clean + '/');
}

function sourcePathOf(nodeSource: string): string | null {
  return nodeSource.startsWith('repo:') ? nodeSource.slice('repo:'.length) : null;
}

function callsite(path: string, evidence: readonly string[]): string | null {
  return evidence.find(item => item.startsWith(path + ':')
    && /^\d+(?::\d+)?$/u.test(item.slice(path.length + 1))) ?? null;
}

export function testSourceProjection(
  graph: IntelligenceGraph, question: TestSourceQuestion, scope?: string, limit = 20,
): TestSourceProjection {
  const context = graphQueryContext(graph);
  const candidates = CALLABLE_KINDS.flatMap(kind => context.nodes(kind))
    .filter(node => node.id.startsWith('symbol:') && node.name === question.symbol)
    .sort((a, b) => a.id.localeCompare(b.id));
  const targetCandidates = candidates.map(node => node.id);
  const target = candidates.length === 1 ? candidates[0]! : null;
  const targetSource = target ? sourcePathOf(target.sourceId) : null;
  const targetSourceStatus = targetSource ? statusFor(graph, targetSource) : null;
  const empty = (reason: TestSourceProjection['reason']): TestSourceProjection => ({
    symbol: question.symbol,
    targetNodeId: target?.id ?? null,
    targetCandidates,
    targetDeclaration: target?.locator ?? null,
    status: 'unproven', reason,
    totalTestFiles: 0, returnedTestFiles: 0, totalRelationships: 0,
    truncated: false, tests: [], edges: [],
    coverage: {
      targetSourceStatus,
      completeForEligibleSources: Boolean(graph.coverage
        && graph.coverage.completeFiles === graph.coverage.eligibleFiles
        && graph.coverage.partialFiles === 0
        && graph.coverage.failedFiles === 0
        && graph.coverage.skippedFiles === 0),
      absenceProven: false,
    },
    executionObserved: false,
    assertionBehaviorEstablished: false,
  });
  if (!candidates.length) return empty('missing-target');
  if (candidates.length !== 1) return empty('ambiguous-target');
  if (!targetSource || targetSourceStatus !== 'complete') return empty('target-unavailable');
  if (!inScope(scope, targetSource)) return empty('out-of-scope');

  const groups = new Map<string, GraphEdge[]>();
  for (const edge of context.incoming(target!.id)) {
    if (edge.status !== 'resolved' || !edge.from || !edge.to) continue;
    const origin = context.node(edge.from);
    if (!origin) continue;
    const path = sourcePathOf(origin.sourceId);
    if (!path || !TEST_PATH.test(path) || statusFor(graph, path) !== 'complete') continue;
    const compilerCall = edge.kind === 'references-symbol'
      && edge.strategy === 'typescript-checker-symbol.v1'
      && edge.from === 'file:' + path;
    const parserCall = edge.kind === 'calls'
      && edge.from !== 'file:' + path;
    if (!(compilerCall || parserCall) || !callsite(path, edge.evidence ?? [])) continue;
    const found = groups.get(path) ?? [];
    if (!found.some(item => item.id === edge.id)) found.push(edge);
    groups.set(path, found);
  }

  const ordered = [...groups].sort(([left], [right]) => left.localeCompare(right));
  if (!ordered.length) return empty('no-resolved-test-call');
  const maximum = Math.max(1, Math.min(20, Math.trunc(limit) || 20));
  const shown = ordered.slice(0, maximum);
  const preferred = (edges: GraphEdge[]) => edges.slice().sort((a, b) =>
    Number(b.kind === 'references-symbol' && b.strategy === 'typescript-checker-symbol.v1')
    - Number(a.kind === 'references-symbol' && a.strategy === 'typescript-checker-symbol.v1')
    || a.id.localeCompare(b.id)).slice(0, 3);
  const tests: TestSourceFile[] = shown.map(([path, observed]) => {
    const selected = preferred(observed);
    return {
      path,
      callsites: [...new Set(selected.map(edge => callsite(path, edge.evidence ?? []))
        .filter((item): item is string => Boolean(item)))].sort(),
      edgeIds: selected.map(edge => edge.id),
      compilerVerified: selected.some(edge =>
        edge.kind === 'references-symbol' && edge.strategy === 'typescript-checker-symbol.v1'),
    };
  });
  const edges = shown.flatMap(([, observations]) => preferred(observations));
  const totalRelationships = ordered.reduce((sum, [, observed]) => sum + observed.length, 0);
  return {
    ...empty('resolved-test-calls'),
    status: 'supported', reason: 'resolved-test-calls',
    totalTestFiles: ordered.length, returnedTestFiles: tests.length,
    totalRelationships,
    truncated: shown.length !== ordered.length || edges.length < totalRelationships,
    tests, edges,
  };
}

export function testSourceAnswer(result: TestSourceProjection): string {
  if (result.status !== 'supported') {
    const reason = result.reason === 'ambiguous-target'
      ? 'More than one callable declaration has that exact name; specify an exact declaration.'
      : result.reason === 'missing-target'
        ? 'The exact callable declaration was not found in this graph.'
        : result.reason === 'out-of-scope'
          ? 'The requested callable is outside the selected scope.'
          : result.reason === 'target-unavailable'
            ? 'The requested callable source is not completely available.'
            : 'No admissible resolved static call from a tracked test file was observed.';
    return reason + ' This does not establish an absence of tests or behavioral coverage.';
  }
  const listed = result.tests.slice(0, 8).map(item =>
    item.path + (item.callsites[0] ? ' (' + item.callsites[0] + ')' : '')
    + (item.compilerVerified ? ' [TypeChecker]' : ' [resolved source call]')).join('; ');
  return result.totalTestFiles + ' test file(s) have resolved static source calls to '
    + result.symbol + ' (' + result.targetDeclaration + '): ' + listed + '.'
    + (result.totalTestFiles > 8 ? ' Additional test files are in the bounded result.' : '')
    + (result.truncated ? ' Result is truncated; not an exhaustive test listing.' : '')
    + ' A static call does not prove that the test ran, which assertion passed, '
    + 'the behavioral outcome, or whether another test independently replaces it.';
}
