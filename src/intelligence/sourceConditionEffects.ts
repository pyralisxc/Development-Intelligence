import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
// Node 22 exposes the high-resolution clock globally via the DOM lib.
import { composeTwoHopSourceEffects } from './twoHopSourceComposition.js';
import { projectRpcSqlSourceCandidates } from './rpcSqlSourceCandidates.js';
import { parseRpcDiscoveryQuestion, projectRpcDiscoveryQuestion, rpcDiscoveryAnswer } from './rpcDiscoveryQuestion.js';
import type { GraphNode, IntelligenceGraph } from '../types.js';
import { analyzeSourceConditionStatements,
  type SourceCondition, type SourceEffect, type SourceRequirement } from './sourceConditionFacts.js';
export type { SourceCondition, SourceEffect, SourceRequirement } from './sourceConditionFacts.js';
import { graphQueryContext } from './queryContext.js';
import { resolveProjectRevision, withResolvedProjectCheckout } from '../source/git.js';
import { isWrittenTestSource } from './independentSourceVerification.js';

export const CONDITION_EFFECT_LENS = 'typescript-ast-condition-effect-source.v1';
const MAX_FILE_BYTES = 1_000_000;
const MAX_PREVIEW_ROWS = 80;
const SOURCE_SUBJECT_SYNTAX: readonly RegExp[] = [
  /\bunder what conditions does\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/iu,
  /\bwhat conditions govern\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/iu,
  /\bwhat (?:must|has to) be true (?:for|in)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/iu,
  /\bwhat does\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+(?:do|return|throw|change)\b/iu,
  /\bwhich branches?\s+(?:in|of)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/iu,
  /\bwhen does\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+(?:return|throw|call|invoke|write|exit|run)\b/iu,
  /\bwhat (?:happens|changes) when\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+(?:returns?|calls?|throws?|writes?|runs?)\b/iu,
  /\b(?:conditions?|branches?|guards?|effects?)\s+(?:of|for|in)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/iu,
];
const CALLABLE = new Set(['function', 'method']);
function explicitCallableSubject(question: string): string | null {
  const names = [...new Set(SOURCE_SUBJECT_SYNTAX.flatMap(pattern => {
    const match = pattern.exec(question);
    return match?.[1] ? [match[1]] : [];
  }))];
  return names.length === 1 ? names[0]! : null;
}
/** Narrow ordinary grammar: require two explicitly named callables. */
export function parseTwoHopSourceQuestion(question: string): { caller: string; callee: string } | null {
  const identifier = '([A-Za-z_$][A-Za-z0-9_$]*)';
  const patterns = [
    new RegExp('\\bwhat happens when\\s+' + identifier + '\\s+(?:calls|invokes)\\s+' + identifier + '\\b', 'iu'),
    new RegExp('\\b(?:what|which)\\s+(?:conditions?|effects?|conditions and effects)\\s+(?:propagate|flow)\\s+from\\s+' + identifier + '\\s+to\\s+' + identifier + '\\b', 'iu'),
    new RegExp('\\bhow does\\s+' + identifier + '\\s+(?:call|invoke)\\s+' + identifier + '\\b', 'iu'),
    new RegExp('\\bunder what conditions does\\s+' + identifier + '\\s+(?:call|invoke)\\s+' + identifier + '\\s*\\??$', 'iu'),
    new RegExp('\\bwhich conditions govern\\s+' + identifier + '\\s+(?:calling|invoking)\\s+' + identifier + '\\s*\\??$', 'iu'),
  ];
  const matches = patterns.flatMap(pattern => {
    const match = pattern.exec(question);
    return match?.[1] && match[2] ? [{ caller: match[1], callee: match[2] }] : [];
  });
  const unique = [...new Map(matches.map(pair => [pair.caller + ':' + pair.callee, pair])).values()];
  return unique.length === 1 && unique[0]!.caller !== unique[0]!.callee
    && !/^(?:a|an|the|this|that|some|any)$/iu.test(unique[0]!.callee)
    ? unique[0]! : null;
}
export function isConditionEffectQuestion(question: string): boolean {
  return parseRpcDiscoveryQuestion(question) !== null
    || parseTwoHopSourceQuestion(question) !== null || explicitCallableSubject(question) !== null;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonicalPath(node: GraphNode): string | null {
  return node.sourceId.startsWith('repo:') ? node.sourceId.slice(5) : null;
}
function relevantFunction(graph: IntelligenceGraph, name: string, scope?: string): {
  node: GraphNode | null; reason: 'resolved' | 'missing-exact-callable' | 'ambiguous-exact-callable' | 'out-of-scope';
  candidates: GraphNode[];
} {
  const cleanScope = scope?.trim().replace(/^(?:repo:|file:)/u, '').replace(/^\.\/+/u, '') ?? '';
  const candidates = graph.nodes.filter(node => CALLABLE.has(node.kind)
    && node.layer === 'structural' && node.name === name
    && !isWrittenTestSource(node.sourceId)
    && (!cleanScope || canonicalPath(node) === cleanScope || canonicalPath(node)?.startsWith(cleanScope + '/')));
  const unique = [...new Map(candidates.map(node => [node.id, node])).values()];
  if (unique.length === 0) return { node: null, reason: cleanScope ? 'out-of-scope' : 'missing-exact-callable', candidates: [] };
  if (unique.length !== 1) return { node: null, reason: 'ambiguous-exact-callable', candidates: unique };
  return { node: unique[0]!, reason: 'resolved', candidates: unique };
}
function scriptKind(source: string): ts.ScriptKind {
  if (/\.(?:tsx|jsx)$/iu.test(source)) return ts.ScriptKind.TSX;
  if (/\.(?:mjs|cjs|js)$/iu.test(source)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
function callableBodies(parsed: ts.SourceFile, name: string, line: number): ts.Statement[] | null {
  const matches: ts.Statement[][] = [];
  const lineAt = (node: ts.Node) => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
  const visit = (node: ts.Node): void => {
    if (lineAt(node) === line) {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
        && node.name && ts.isIdentifier(node.name) && node.name.text === name && node.body) {
        matches.push([...node.body.statements]);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
        && node.initializer) {
        let init: ts.Expression = node.initializer;
        while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          if (ts.isBlock(init.body)) matches.push([...init.body.statements]);
          else return; // Expression-bodied arrows have no ordinary statement span.
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return matches.length === 1 ? matches[0]! : null;
}

export function projectSourceConditionEffects(input: {
  sourcePath: string; source: string; symbol: GraphNode; graph: IntelligenceGraph;
  maxRows?: number;
}): Record<string, unknown> {
  const { sourcePath, source, symbol, graph } = input;
  const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, scriptKind(sourcePath)) as
    ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  const parseErrors = parsed.parseDiagnostics?.length ?? 0;
  const declaredLine = Number(/:(\d+)(?::|$)/u.exec(symbol.locator)?.[1]);
  const statements = parseErrors || !Number.isInteger(declaredLine)
    ? null : callableBodies(parsed, symbol.name ?? '', declaredLine);
  if (!statements) return {
    status: 'unproven', reason: parseErrors ? 'parse-failed' : 'declaration-not-uniquely-located',
    sourcePath, sourceRevision: graph.repositoryRevision, graphId: graph.graphId,
    parseErrors, branches: [], effects: [], sourceOnly: true, currentRuntimeObserved: false,
  };

  const { branches, effects, unknownConstructs, boundedOut, completeForSupportedStatements } =
    analyzeSourceConditionStatements(parsed, sourcePath, statements);
  const maxRows = Math.max(1, Math.min(MAX_PREVIEW_ROWS, Math.floor(input.maxRows ?? MAX_PREVIEW_ROWS)));
  return {
    status: branches.length || effects.length ? 'supported' : 'unproven',
    reason: boundedOut ? 'bounded-source-analysis' : parseErrors ? 'parse-failed'
      : branches.length || effects.length ? 'source-ast-branches-and-effects' : 'no-supported-source-effects',
    identity: { project: graph.project, graphId: graph.graphId, sourceRevision: graph.repositoryRevision,
      analyzerVersion: graph.analyzerVersion, functionId: symbol.id, functionName: symbol.name,
      sourcePath, sourceLine: declaredLine, sourceSha256: digest(source), lens: CONDITION_EFFECT_LENS },
    coverage: {
      parseDiagnostics: parseErrors, branchTotal: branches.length, effectTotal: effects.length,
      unknownConstructs, boundedOut, completeForSupportedStatements,
      presentationTruncated: branches.length > maxRows || effects.length > maxRows,
    },
    branches: branches.slice(0, maxRows), effects: effects.slice(0, maxRows),
    proof: {
      actualSourceSyntaxLocated: true, predicateSatisfiabilityProven: false,
      returnOrCallRuntimeObserved: false, conditionsAndEffectsIndependentlyVerifiedAtRuntime: false,
      callerMayCheckSourceSpans: true, allPossibleExecutionPathsProven: false,
      transitiveCallEffectsProven: false, testReplacementProven: false,
      noSecondGraphOrSemanticHistory: true,
    },
  };
}

/** 
 * Compose source conditions from two exact callables in one already-built graph.
 * No checkout is performed here; callers inject exact-source reads, so this
 * projection can be measured/tested independently of repository construction.
 */
export async function projectTwoHopSourceQuestion(input: {
  graph: IntelligenceGraph;
  project: string;
  question: string;
  scope?: string;
  readSource: (sourcePath: string) => Promise<string | null>;
}): Promise<Record<string, unknown> | null> {
  const pair = parseTwoHopSourceQuestion(input.question);
  if (!pair) return null;
  const started = performance.now();
  const { graph } = input;
  const base = { project: input.project, revision: graph.repositoryRevision,
    graphId: graph.graphId, mode: 'two-hop-conditional-source',
    sourceOnly: true, runtimeObserved: false, requestedQuestion: input.question,
    query: pair };
  const unavailable = (reason: string, extra: Record<string, unknown> = {}) => ({
    ...base, status: 'unproven', reason, paths: [], 
    proof: { jointPredicateSatisfiabilityProven: false,
      argumentMappingProven: false, runtimeExecutionObserved: false,
      deployedConfigurationEstablished: false, independentlyVerifiedTestRun: false },
    timing: { graphBuildIncluded: false,
      existingGraphProjectionMs: Number((performance.now()-started).toFixed(2)) },
    ...extra,
  });
  if (graph.project !== input.project || !graph.repositoryRevision) {
    return unavailable('graph-identity-incomplete');
  }
  const caller = relevantFunction(graph, pair.caller, input.scope);
  if (!caller.node) return unavailable(caller.reason, {
    candidates: caller.candidates.map(node => ({ id: node.id, path: canonicalPath(node) })),
  });
  const targets = new Map(graph.nodes.filter(node =>
    node.layer === 'structural' && CALLABLE.has(node.kind)
    && node.name === pair.callee).map(node => [node.id, node]));
  const candidateEdges = graph.edges.filter(edge =>
    edge.layer === 'structural' && edge.kind === 'calls' && edge.status === 'resolved'
    && edge.from === caller.node!.id && Boolean(edge.to && targets.has(edge.to)));
  const candidateTargetIds = [...new Set(candidateEdges.map(edge => edge.to!))];
  if (candidateTargetIds.length !== 1) {
    if (candidateTargetIds.length === 0) {
      const sql = projectRpcSqlSourceCandidates({
        graph, callerId: caller.node.id, routineName: pair.callee,
      });
      if (sql.proof.exactSourceRpcCallEstablished) {
        return { ...sql, requestedQuestion: input.question,
          timing: { graphBuildIncluded: false,
            existingGraphProjectionMs: Number((performance.now()-started).toFixed(2)) } };
      }
    }
    return unavailable(candidateTargetIds.length > 1
      ? 'ambiguous-resolved-call-target' : 'exact-resolved-call-target-unavailable',
      { callerId: caller.node.id, candidateTargetIds });
  }
  const callee = targets.get(candidateTargetIds[0]!)!;
  const callerPath = canonicalPath(caller.node);
  const calleePath = canonicalPath(callee);
  const paths = [callerPath, calleePath];
  if (paths.some(p => !p || !/\.(?:[cm]?[jt]sx?)$/iu.test(p) || isWrittenTestSource(p))
    || paths.some(p => graph.coverage?.files?.find(file => file.path === p)?.status !== 'complete')) {
    return unavailable('source-coverage-or-language-incomplete', {
      callerId: caller.node.id, calleeId: callee.id });
  }
  // Both callables may already carry the exact same AST facts in canonical W.
  // If so, compose those facts without resolving Git, rereading source, or
  // duplicating source parsing in the question path. Older graphs still work.
  const compiledCaller = projectBuiltSourceControl(graph, caller.node);
  const compiledCallee = projectBuiltSourceControl(graph, callee);
  const compiled = compiledCaller?.status === 'supported' && compiledCallee?.status === 'supported';
  let sourceReadMs = 0;
  let lensMs = 0;
  let callerLens: Record<string, unknown>;
  let calleeLens: Record<string, unknown>;
  if (compiled) {
    callerLens = compiledCaller!;
    calleeLens = compiledCallee!;
  } else {
    const readStarted = performance.now();
    const texts = await Promise.all(paths.map(p => input.readSource(p!)));
    sourceReadMs = performance.now() - readStarted;
    if (texts.some(v => !v || v.includes('\0'))) {
      return unavailable('exact-source-unavailable', { callerId: caller.node.id,
        calleeId: callee.id });
    }
    const lensStarted = performance.now();
    callerLens = projectSourceConditionEffects({
      graph, sourcePath: callerPath!, symbol: caller.node, source: texts[0]!,
    });
    calleeLens = projectSourceConditionEffects({
      graph, sourcePath: calleePath!, symbol: callee, source: texts[1]!,
    });
    lensMs = performance.now() - lensStarted;
  }
  if (callerLens.status !== 'supported' || calleeLens.status !== 'supported') {
    return unavailable('source-lens-unavailable', { callerId: caller.node.id,
      calleeId: callee.id });
  }
  const callerEffects = (callerLens.effects as SourceEffect[]).filter(effect =>
    effect.kind === 'return-call' && effect.expression === pair.callee + '(...)');
  const calleeEffects = (calleeLens.effects as SourceEffect[]).filter(effect =>
    effect.kind === 'return' || effect.kind === 'return-call');
  const callerBranches = new Map((callerLens.branches as SourceCondition[]).map(b => [b.id, b]));
  const calleeBranches = new Map((calleeLens.branches as SourceCondition[]).map(b => [b.id, b]));
  const compositionStarted = performance.now();
  const MAX_COMPOSITIONS = 100;
  const MAX_REPORTED_PATHS = 24;
  const results: Array<{ kind: SourceEffect['kind']; expression: string; sourceLine: number;
    requiredConditions: Array<{ functionId: string; conditionId: string;
      truth: boolean; predicateSha256: string; predicate: string }>;
    sourceWitnesses: string[] }> = [];
  const reasons: Record<string, number> = {};
  const totalPairCount = callerEffects.length * calleeEffects.length;
  let attempted = 0, qualified = 0;
  for (const from of callerEffects) {
    for (const to of calleeEffects) {
      if (attempted >= MAX_COMPOSITIONS) break;
      attempted++;
      const callerAssumptions = Object.fromEntries(from.requiredConditions.map(r =>
        [r.conditionId, r.expectedTruth]));
      const calleeAssumptions = Object.fromEntries(to.requiredConditions.map(r =>
        [r.conditionId, r.expectedTruth]));
      const composed = composeTwoHopSourceEffects({
        graph, caller: callerLens, callee: calleeLens,
        call: { effectLine: from.sourceLine, effectSha256: from.expressionSha256 },
        calleeReturn: { effectLine: to.sourceLine, effectSha256: to.expressionSha256 },
        callerAssumptions, calleeAssumptions,
      });
      if (composed.status !== 'established-conditional-source-path') {
        reasons[composed.reason] = (reasons[composed.reason] ?? 0) + 1;
        continue;
      }
      qualified++;
      if (results.length >= MAX_REPORTED_PATHS) continue;
      const requirements = composed.requiredConditions.map(r => {
        const branch = (r.functionId === caller.node!.id
          ? callerBranches : calleeBranches).get(r.conditionId);
        return { ...r, predicate: branch?.predicate ?? '[unresolved condition]' };
      });
      results.push({ kind: to.kind, expression: to.expression, sourceLine: to.sourceLine,
        requiredConditions: requirements, sourceWitnesses: composed.sourceWitnesses });
    }
    if (attempted >= MAX_COMPOSITIONS) break;
  }
  const compositionMs = performance.now() - compositionStarted;
  const incomplete = totalPairCount > attempted
    || results.length < qualified
    || Object.keys(reasons).length > 0
    || !(callerLens.coverage as {completeForSupportedStatements:boolean}).completeForSupportedStatements
    || !(calleeLens.coverage as {completeForSupportedStatements:boolean}).completeForSupportedStatements;
  return {
    ...base, mode: compiled ? 'canonical-source-two-hop-conditions' : base.mode,
    status: qualified ? 'supported' : 'unproven',
    reason: qualified ? 'exact-two-hop-source-conditions'
      : Object.keys(reasons)[0] ?? 'no-composable-direct-return-call',
    identity: { project: graph.project, graphId: graph.graphId,
      sourceRevision: graph.repositoryRevision, analyzerVersion: graph.analyzerVersion,
      functionId: caller.node.id, functionName: caller.node.name,
      sourcePath: callerPath, calleeId: callee.id, calleeName: callee.name,
      calleeSourcePath: calleePath },
    paths: results,
    counts: { candidatePairCount: totalPairCount, attempted, qualified,
      rejected: attempted-qualified, returned: results.length,
      omitted: totalPairCount-attempted+qualified-results.length,
      incomplete, rejectedReasons: reasons },
    proof: { exactCanonicalCallEdgeUsed: qualified>0,
      sourcePathAssumptionsOnly: true, jointPredicateSatisfiabilityProven: false,
      argumentMappingProven: false, exceptionalOrAsyncCompletionProven: false,
      runtimeExecutionObserved: false, deployedConfigurationEstablished: false,
      independentlyVerifiedTestRun: false, canonicalGraphUnaffected: true },
    timing: { graphBuildIncluded: false,
      sourceReadMs: Number(sourceReadMs.toFixed(2)),
      sourceLensMs: Number(lensMs.toFixed(2)),
      pureCompositionMs: Number(compositionMs.toFixed(2)),
      existingGraphProjectionMs: Number((performance.now()-started).toFixed(2)) },
  };
}


/**
 * Canonical graph-native projection of the SAME source condition/effect lens
 * that now runs during graph construction. No checkout, reparse or new graph.
 * An incomplete/mismatched record falls through to the exact source path.
 */
function projectBuiltSourceControl(graph: IntelligenceGraph, symbol: GraphNode): Record<string, unknown> | null {
  const context = graphQueryContext(graph);
  const summaryEdges = context.outgoing(symbol.id).filter(edge =>
    edge.kind === 'has-source-control' && edge.status === 'resolved' && Boolean(edge.to));
  if (summaryEdges.length !== 1) return null;
  const summary = context.node(summaryEdges[0]!.to!);
  if (summary?.kind !== 'source-control-summary' || !summary.value
    || typeof summary.value !== 'object' || Array.isArray(summary.value)) return null;
  const scope = summary.value as Record<string, unknown>;
  if (scope.functionId !== symbol.id || scope.sourceOnly !== true
    || scope.runtimeObserved !== false || typeof scope.sourceSha256 !== 'string'
    || !Array.isArray(scope.unknownConstructs)) return null;
  const branchNodes = context.outgoing(symbol.id).filter(edge =>
    edge.kind === 'has-condition' && edge.status === 'resolved' && Boolean(edge.to))
    .map(edge => context.node(edge.to!));
  // The full competing evidence remains in the canonical graph. Do not
  // silently turn two equally grounded contradictory source facts into a
  // supported answer based on insertion order; fall back to exact source.
  if (summary.tags?.includes('source-fact-contested')
    || branchNodes.some(node => node?.tags?.includes('source-fact-contested'))) return null;
  const effectNodes = context.outgoing(symbol.id).filter(edge =>
    edge.kind === 'has-effect' && edge.status === 'resolved' && Boolean(edge.to))
    .map(edge => context.node(edge.to!));
  if (branchNodes.length !== scope.branchTotal || effectNodes.length !== scope.effectTotal
    || effectNodes.some(node => node?.tags?.includes('source-fact-contested'))) return null;
  const derivedExecutionEstablished = effectNodes.filter(node => {
    const v = node?.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const conclusion = (v as Record<string, unknown>).derivedExecution;
    return Boolean(conclusion && typeof conclusion === 'object'
      && (conclusion as Record<string, unknown>).status === 'established');
  }).length;
  const conflictedIds = new Set([...branchNodes, ...effectNodes]
    .filter((node): node is GraphNode => Boolean(node)).map(node => node.id));
  const disagreements = (graph.explicitValueConflicts ?? []).filter(item =>
    conflictedIds.has(item.entityId) && item.key === 'value');
  const branches: SourceCondition[] = [];
  for (const node of branchNodes) {
    if (node?.kind !== 'source-condition' || !node.value
      || typeof node.value !== 'object' || Array.isArray(node.value)) return null;
    const branch = node.value as Record<string, unknown>;
    if (branch.functionId !== symbol.id || branch.runtimeObserved !== false
      || branch.conditionsAreSourceSyntaxOnly !== true
      || typeof branch.id !== 'string' || typeof branch.predicateSha256 !== 'string') return null;
    // Return the public source-lens shape: graph ownership/proof metadata is
    // real but not part of the branch data contract.
    const { functionId: _owner, sourceOnly: _source, runtimeObserved: _runtime,
      proofRule: _proofRule, sourceTruth: _sourceTruth, sourceSha256: _sha, ...sourceBranch } = branch;
    branches.push(sourceBranch as unknown as SourceCondition);
  }
  const effects: SourceEffect[] = [];
  for (const node of effectNodes) {
    if (node?.kind !== 'source-effect' || !node.value
      || typeof node.value !== 'object' || Array.isArray(node.value)) return null;
    const effect = node.value as Record<string, unknown>;
    if (effect.functionId !== symbol.id || effect.runtimeObserved !== false
      || typeof effect.expressionSha256 !== 'string'
      || !Array.isArray(effect.requiredConditions)) return null;
    const { functionId: _owner, sourceOnly: _source,
      proofRule: _proofRule, derivedExecution: _derived, sourceSha256: _sha,
      ...sourceEffect } = effect;
    effects.push(sourceEffect as unknown as SourceEffect);
  }
  // A source guard may have multiple truth requirements. The exact requirements
  // remain owned by each effect fact; the graph's edges navigate their predicates.
  const branchIds = new Set(branches.map(branch => branch.id));
  if (effects.some(effect => effect.requiredConditions.some(req => !branchIds.has(req.conditionId)))) return null;
  branches.sort((a, b) => (a.sourceOffset ?? 0) - (b.sourceOffset ?? 0));
  effects.sort((a, b) => (a.sourceOffset ?? 0) - (b.sourceOffset ?? 0));
  const maxRows = MAX_PREVIEW_ROWS;
  const truncated = branches.length > maxRows || effects.length > maxRows;
  return {
    status: branches.length || effects.length ? 'supported' : 'unproven',
    mode: 'canonical-source-condition-effects',
    reason: scope.boundedOut ? 'bounded-canonical-source-control'
      : branches.length || effects.length ? 'canonical-source-control-graph-facts'
        : 'no-supported-source-effects',
    identity: {
      project: graph.project, graphId: graph.graphId,
      sourceRevision: graph.repositoryRevision, analyzerVersion: graph.analyzerVersion,
      functionId: symbol.id, functionName: symbol.name,
      sourcePath: canonicalPath(symbol), sourceLine: Number(/:(\d+)(?::|$)/u.exec(symbol.locator)?.[1]),
      sourceSha256: scope.sourceSha256, lens: CONDITION_EFFECT_LENS,
    },
    coverage: {
      parseDiagnostics: 0, branchTotal: branches.length, effectTotal: effects.length,
      unknownConstructs: scope.unknownConstructs, boundedOut: scope.boundedOut,
      completeForSupportedStatements: scope.completeForSupportedStatements,
      presentationTruncated: truncated,
    },
    branches: branches.slice(0, maxRows), effects: effects.slice(0, maxRows),
    proof: {
      actualSourceSyntaxLocated: true, predicateSatisfiabilityProven: false,
      returnOrCallRuntimeObserved: false,
      conditionsAndEffectsIndependentlyVerifiedAtRuntime: false,
      callerMayCheckSourceSpans: true, allPossibleExecutionPathsProven: false,
      transitiveCallEffectsProven: false, testReplacementProven: false,
      noSecondGraphOrSemanticHistory: true,
      // Positive source-derived execution is a fact *about this code path*,
      // not a runtime-witness claim. Stronger eligible evidence may corroborate
      // or supersede a weaker claim without erasing the disagreement.
      sourceDerivedExecution: {
        status: derivedExecutionEstablished === effects.length && effects.length
          ? 'established' : 'partially-established',
        establishedEffectFacts: derivedExecutionEstablished,
        totalEffectFacts: effects.length,
        scope: 'selected-exact-source-and-necessary-guard-requirements',
        runtimeWitnessRequiredForSourceFact: false,
        runtimeObserved: false,
        disagreements: disagreements.map(item => ({
          entityId: item.entityId, resolution: item.resolution ?? 'contested',
        })),
      },
    },
  };
}

function projectBuiltSourceReturns(graph: IntelligenceGraph, symbol: GraphNode, question: string): Record<string, unknown> | null {
  const context = graphQueryContext(graph);
  const request = /\breturn\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+(true|false)\b/iu.exec(question);
  const expectedKey = request?.[1] ?? null;
  const expectedValue = request ? request[2]!.toLowerCase() === 'true' : null;
  const facts = context.outgoing(symbol.id)
    .filter(edge => ['catch-returns', 'try-returns'].includes(edge.kind)
      && edge.status === 'resolved' && Boolean(edge.to))
    .flatMap(edge => {
      const region = edge.kind === 'try-returns' ? 'try' : 'catch';
      const fact = context.node(edge.to!);
      if (fact?.kind !== 'source-' + region + '-return'
        || !fact.value || typeof fact.value !== 'object') return [];
      const value = fact.value as Record<string, unknown>;
      const outcome = value.outcome;
      if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return [];
      const object = outcome as Record<string, unknown>;
      if (expectedKey && object[expectedKey] !== expectedValue) return [];
      return [{
        id: fact.id, region, locator: fact.locator,
        ...(region === 'try' ? {tryLine: value.tryLine} : {catchLine: value.catchLine}),
        returnLine: value.returnLine, outcome: object,
        evidenceIds: fact.evidenceIds ?? [], proofRule: value.proofRule,
      }];
    }).sort((a, b) => a.locator.localeCompare(b.locator) || a.id.localeCompare(b.id));
  if (!facts.length) return null;
  const regions = new Set(facts.map(fact => fact.region));
  const mode = regions.size === 2 ? 'canonical-source-try-catch-returns'
    : regions.has('try') ? 'canonical-source-try-return' : 'canonical-source-catch-return';
  return {
    mode,
    status: 'supported',
    reason: 'source-return-syntax-in-' + (regions.size === 2 ? 'try-and-catch' : [...regions][0]) + '-not-execution',
    sourceOnly: true,
    project: graph.project, graphId: graph.graphId, revision: graph.repositoryRevision,
    identity: {
      project: graph.project, graphId: graph.graphId, sourceRevision: graph.repositoryRevision,
      analyzerVersion: graph.analyzerVersion,
      functionId: symbol.id, functionName: symbol.name, sourcePath: canonicalPath(symbol),
      // Keep PR379 single-rule consumers compatible while also supporting a mixed result.
      proofRule: regions.size === 1 ? facts[0]?.proofRule ?? null : null,
      proofRules: [...new Set(facts.map(fact => fact.proofRule))],
    },
    sourceReturns: facts.slice(0, 12),
    coverage: {
      sourceReturnsTotal: facts.length,
      returned: Math.min(facts.length, 12),
      omitted: Math.max(facts.length - 12, 0),
      completeForAllExecutionPaths: false,
      tryCompletionProven: false,
      catchReachabilityProven: false,
      absenceOutsideTheseReturnsProven: false,
    },
    proof: {
      actualSourceSyntaxLocated: true,
      catchReturnObservedInSource: regions.has('catch'),
      tryReturnObservedInSource: regions.has('try'),
      tryCompletionProven: false,
      catchReachabilityProven: false, guaranteedOnCatchEntry: false,
      returnOrCallRuntimeObserved: false, externalProviderEffectProven: false,
      allPossibleExecutionPathsProven: false,
      noSecondGraphOrSemanticHistory: true,
    },
  };
}

export async function querySourceConditionEffects(input: {
  graph: IntelligenceGraph; project: string; question: string; scope?: string;
}): Promise<Record<string, unknown> | null> {
  const discovery = parseRpcDiscoveryQuestion(input.question);
  if (discovery) return projectRpcDiscoveryQuestion(input);
  const pair = parseTwoHopSourceQuestion(input.question);
  if (pair) {
    if (!input.graph.repositoryRevision) {
      return { status: 'unproven', reason: 'graph-missing-exact-revision',
        project: input.project, graphId: input.graph.graphId, paths: [] };
    }
    // A graph with independently compiled caller and callee control facts can
    // compose their conditions immediately. Fail-open to exact Git only when
    // the selected revision's graph cannot supply both source lenses.
    const builtPair = await projectTwoHopSourceQuestion({
      graph: input.graph, project: input.project, question: input.question,
      ...(input.scope ? { scope: input.scope } : {}),
      readSource: async () => null,
    });
    if (builtPair?.mode === 'canonical-source-two-hop-conditions') {
      return { ...builtPair, timing: {
        ...(builtPair.timing as Record<string, unknown>),
        graphConstructionIncluded: false, sourceCheckoutRequired: false,
      } };
    }
    // Older snapshots and unsupported paths retain exact Git source analysis.
    // Keep this separate from pure graph-only projection measurements.
    const started = performance.now();
    const revision = await resolveProjectRevision(input.project,
      'commit:' + input.graph.repositoryRevision);
    if (revision.sha !== input.graph.repositoryRevision) {
      throw new Error('Two-hop query did not resolve the exact graph revision');
    }
    const revisionResolutionMs = performance.now() - started;
    const result = await withResolvedProjectCheckout(revision, async checkout =>
      await projectTwoHopSourceQuestion({
        graph: input.graph, project: input.project, question: input.question,
        ...(input.scope ? { scope: input.scope } : {}),
        readSource: async relative => {
          const file = path.resolve(checkout.root, relative);
          const rel = path.relative(checkout.root, file).split(path.sep).join('/');
          if (rel !== relative || rel.startsWith('../') || path.isAbsolute(rel)) return null;
          try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return null;
            const text = await fs.readFile(file, 'utf8');
            return text.includes('\0') ? null : text;
          } catch { return null; }
        },
      }));
    if (!result) return null;
    return { ...result, timing: {
      ...(result.timing as Record<string, unknown>),
      revisionResolutionMs: Number(revisionResolutionMs.toFixed(2)),
      fullQueryAfterGraphLoadMs: Number((performance.now()-started).toFixed(2)),
      graphConstructionIncluded: false,
    } };
  }
  const requestedSymbol = explicitCallableSubject(input.question);
  if (!requestedSymbol) return null;
  const selected = relevantFunction(input.graph, requestedSymbol, input.scope);
  if (!selected.candidates.length && selected.reason === 'missing-exact-callable') return null;
  const base = { project: input.project, graphId: input.graph.graphId,
    revision: input.graph.repositoryRevision, requestedQuestion: input.question,
    selectedCandidates: selected.candidates.map(x => ({ id: x.id, name: x.name, path: canonicalPath(x) })) };
  if (!selected.node) return { ...base, status: 'unproven', reason: selected.reason, branches: [], effects: [] };
  const symbol = selected.node;
  const relative = canonicalPath(symbol);
  if (!relative || !/\.(?:[cm]?[jt]sx?)$/iu.test(relative) || isWrittenTestSource(relative)) {
    return { ...base, status: 'unproven', reason: 'unsupported-source-or-test-source', branches: [], effects: [] };
  }
  if (!input.graph.repositoryRevision || input.graph.coverage?.files?.find(f => f.path === relative)?.status !== 'complete') {
    return { ...base, status: 'unproven', reason: 'source-coverage-not-complete', branches: [], effects: [] };
  }
  // A proved, versioned graph observation needs no new checkout or AST pass.
  const builtFact = projectBuiltSourceReturns(input.graph, symbol, input.question);
  if (builtFact) return builtFact;
  const compiledFacts = projectBuiltSourceControl(input.graph, symbol);
  if (compiledFacts) return compiledFacts;
  const revision = await resolveProjectRevision(input.project, 'commit:' + input.graph.repositoryRevision);
  if (revision.sha !== input.graph.repositoryRevision) throw new Error('Source condition read did not resolve exact graph revision');
  return await withResolvedProjectCheckout(revision, async checkout => {
    const file = path.resolve(checkout.root, relative);
    const rel = path.relative(checkout.root, file);
    if (rel.split(path.sep).join('/') !== relative || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Condition source must stay inside exact Git checkout');
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      return { ...base, status: 'unproven', reason: 'source-not-regular-or-bounded', branches: [], effects: [] };
    }
    const source = await fs.readFile(file, 'utf8');
    if (source.includes('\0')) return { ...base, status: 'unproven', reason: 'nontext-source', branches: [], effects: [] };
    return { ...base, ...projectSourceConditionEffects({ source, sourcePath: relative, graph: input.graph, symbol }) };
  });
}

export function sourceConditionsAnswer(result: Record<string, unknown>): string {
  if (['canonical-source-catch-return', 'canonical-source-try-return',
    'canonical-source-try-catch-returns'].includes(String(result.mode ?? ''))) {
    const identity = result.identity as { functionName?: string } | undefined;
    const facts = result.sourceReturns as Array<{
      locator: string; region: 'catch' | 'try'; outcome: Record<string, unknown>;
    }> | undefined;
    const examples = (facts ?? []).slice(0, 3).map(fact =>
      fact.locator + ': ' + JSON.stringify(fact.outcome)).join('; ');
    const coverage = result.coverage as { omitted?: number } | undefined;
    const region = result.mode === 'canonical-source-catch-return' ? 'a catch block'
      : result.mode === 'canonical-source-try-return' ? 'a try block' : 'try and catch blocks';
    return 'The exact source for ' + (identity?.functionName ?? 'this function')
      + ' contains a directly written literal return in ' + region + ': ' + examples + '. '
      + (coverage?.omitted ? String(coverage.omitted) + ' additional return(s) omitted from this bounded sample. ' : '')
      + 'This is an established source statement, not proof that the catch executes, '
      + 'that the try block completes, that every path reaches a return, or that a real storage/database effect occurred. '
      + 'Other exception and dynamic behavior remains unproven.';
  }
  if (result.mode === 'ordinary-source-rpc-discovery') return rpcDiscoveryAnswer(result);
  if (result.mode === 'rpc-sql-source-candidates') {
    const query = result.routineName as string;
    const candidates = result.candidates as Array<{qualifiedName:string;signature:string;sourcePath:string;
      declaredReferences:Array<{kind:'reads'|'writes';name:string}>}> | undefined;
    const counts = result.counts as {total:number;returned:number;omitted:number;
      nextOffset:number|null} | undefined;
    if (result.status !== 'supported' || !candidates || !counts) {
      return 'No exact source-backed RPC-to-SQL declaration correlation could be established. '
        + 'That does not prove the SQL function is absent or deployed.';
    }
    const examples = candidates.slice(0, 4).map(item => {
      const writes = item.declaredReferences.filter(ref => ref.kind === 'writes')
        .map(ref => ref.name);
      return item.qualifiedName + ' (' + item.signature + ') in '
        + item.sourcePath + (writes.length ? '; source-declared writes to '
          + [...new Set(writes)].slice(0, 4).join(', ') : '');
    });
    return 'The captured source has a resolved invocation of RPC ' + query
      + ' and ' + counts.total + ' tracked SQL function declaration candidate(s): '
      + examples.join('; ') + '. ' + (counts.omitted
        ? counts.omitted + ' candidate(s) are omitted from this page. ' : '')
      + 'The active database routine, migration application, role/RLS context, '
      + 'branch feasibility, transaction completion, and runtime execution '
      + 'are not established by these source declarations.';
  }
  if (result.mode === 'two-hop-conditional-source'
    || result.mode === 'canonical-source-two-hop-conditions') {
    const identity = result.identity as { functionName: string; calleeName: string } | undefined;
    const summary = result.counts as { qualified: number; rejected: number;
      omitted: number; incomplete: boolean } | undefined;
    if (result.status !== 'supported' || !identity || !summary) {
      return 'No complete, uniquely bound two-function source path was established (' +
        String(result.reason ?? 'unknown') + '). This does not establish the behavior is absent.';
    }
    const paths = result.paths as Array<{kind:string;expression:string;sourceLine:number;
      requiredConditions: Array<{predicate:string;truth:boolean}>}>;
    const examples = paths.slice(0, 4).map(item => {
      const guards = item.requiredConditions.map(r =>
        (r.truth ? '(' : 'NOT (') + r.predicate + ')').join(' AND ');
      return (guards ? 'When ' + guards + ', ' : 'Along the direct source call, ')
        + identity.calleeName + ' has a ' + item.kind + ' of ' + item.expression
        + ' (source line ' + item.sourceLine + ')';
    });
    return identity.functionName + ' has a uniquely resolved direct source call to '
      + identity.calleeName + '. ' + examples.join('; ')
      + '. DI established ' + summary.qualified + ' conditional source-path witness(es)'
      + (summary.omitted || summary.rejected ? ', with '
        + summary.omitted + ' omitted and ' + summary.rejected + ' unresolved candidate(s)' : '')
      + '. The conditions are source requirements, not known actual configuration. '
      + 'Joint path feasibility, argument binding, callee completion, test execution, and runtime behavior are not proven.'
      + (summary.incomplete ? ' The composed path population is incomplete.' : '');
  }
  if (result.status !== 'supported') return 'No unique, completely analyzed callable source body could establish these branch/effect facts. ' +
    'This does not establish that the condition or behavior is absent.';
  const identity = result.identity as { functionName: string; sourcePath: string };
  const coverage = result.coverage as { branchTotal: number; effectTotal: number; completeForSupportedStatements: boolean };
  const branches = result.branches as SourceCondition[];
  const effects = result.effects as SourceEffect[];
  const branchById = new Map(branches.map(branch => [branch.id, branch]));
  const examples = effects.slice(0, 5).map(effect => {
    const guards = effect.requiredConditions.map(requirement => {
      const branch = branchById.get(requirement.conditionId);
      return branch ? (requirement.expectedTruth ? '(' : 'NOT (') + branch.predicate + ')' : '[unreturned condition]';
    });
    return (guards.length ? 'When ' + guards.join(' AND ') + ', ' : 'On source fallthrough, ')
      + effect.kind + ' ' + effect.expression + ' (line ' + effect.sourceLine + ')';
  });
  return identity.functionName + ' in ' + identity.sourcePath + ' has ' + coverage.branchTotal
    + ' source-located branch condition(s) and ' + coverage.effectTotal
    + ' direct effect/exit observation(s). ' + examples.join('; ')
    + '. This establishes structural path requirements, not whether the conditions are true, '
    + 'the effects executed, or the transitive behavior of calls.'
    + (coverage.completeForSupportedStatements ? '' : ' Some control-flow constructs or limits remain unmodeled.');
}


export interface ExactConditionSignature {
  functionId: string;
  status: 'supported' | 'unproven';
  reason: string;
  sourcePath: string | null;
  sourceRevision: string | null;
  sourceSha256: string | null;
  branchFingerprints: string[];
  directEffectFingerprints: string[];
  branchCount: number;
  directEffectCount: number;
  /** A source-only comparison is never an execution or replacement verdict. */
  sourceOnly: true;
  runtimeObserved: false;
}

export async function projectExactConditionSignatures(input: {
  project: string;
  graph: IntelligenceGraph;
  functionIds: string[];
}): Promise<ExactConditionSignature[]> {
  const ids = [...new Set(input.functionIds)].sort();
  const empty = (id: string, reason: string, relative: string | null = null): ExactConditionSignature => ({
    functionId: id, status: 'unproven', reason, sourcePath: relative,
    sourceRevision: input.graph.repositoryRevision, sourceSha256: null,
    branchFingerprints: [], directEffectFingerprints: [], branchCount: 0,
    directEffectCount: 0, sourceOnly: true, runtimeObserved: false,
  });
  if (!ids.length) return [];
  if (!input.graph.repositoryRevision) return ids.map(id => empty(id, 'no-immutable-source-revision'));
  const revision = await resolveProjectRevision(input.project, 'commit:' + input.graph.repositoryRevision);
  if (revision.sha !== input.graph.repositoryRevision) throw new Error('Condition signatures require exact canonical source identity');
  const nodes = new Map(input.graph.nodes.filter(node => CALLABLE.has(node.kind) && node.layer === 'structural')
    .map(node => [node.id, node]));
  const coverage = new Map((input.graph.coverage?.files ?? []).map(item => [item.path, item.status]));
  return await withResolvedProjectCheckout(revision, async checkout => {
    const files = new Map<string, string | null>();
    const results: ExactConditionSignature[] = [];
    for (const id of ids) {
      const symbol = nodes.get(id);
      const relative = symbol ? canonicalPath(symbol) : null;
      if (!symbol || !relative) { results.push(empty(id, 'callable-not-exactly-identified')); continue; }
      if (!/\.(?:[cm]?[jt]sx?)$/iu.test(relative) || isWrittenTestSource(relative)) {
        results.push(empty(id, 'not-supported-nontest-source', relative)); continue;
      }
      if (coverage.get(relative) !== 'complete') {
        results.push(empty(id, 'source-coverage-not-complete', relative)); continue;
      }
      if (!files.has(relative)) {
        const file = path.resolve(checkout.root, relative);
        const rel = path.relative(checkout.root, file);
        if (rel.split(path.sep).join('/') !== relative || rel.startsWith('..') || path.isAbsolute(rel)) {
          files.set(relative, null);
        } else {
          try {
            const stat = await fs.lstat(file);
            const body = stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES
              ? await fs.readFile(file, 'utf8') : null;
            files.set(relative, body && !body.includes('\0') ? body : null);
          } catch { files.set(relative, null); }
        }
      }
      const source = files.get(relative);
      if (!source) { results.push(empty(id, 'exact-source-unavailable', relative)); continue; }
      const projected = projectSourceConditionEffects({
        sourcePath: relative, source, symbol, graph: input.graph,
      }) as Record<string, unknown>;
      const rows = projected.branches as SourceCondition[] | undefined;
      const effects = projected.effects as SourceEffect[] | undefined;
      const state = projected.coverage as { boundedOut: boolean; presentationTruncated: boolean;
        unknownConstructs: unknown[] } | undefined;
      if (projected.status !== 'supported' || !rows || !effects || !state
        || state.boundedOut || state.presentationTruncated || state.unknownConstructs.length) {
        results.push(empty(id, 'conditional-source-not-completely-supported', relative));
        continue;
      }
      const byId = new Map(rows.map(item => [item.id, item.predicateSha256]));
      const branchFingerprints = rows.map(item => digest(JSON.stringify([
        item.predicateSha256, item.trueBranchTerminates, item.falseBranchTerminates,
      ])));
      const directEffectFingerprints = effects.map(item => digest(JSON.stringify([
        item.kind, item.expressionSha256,
        item.requiredConditions.map(condition => [
          byId.get(condition.conditionId) ?? 'unknown-condition',
          condition.expectedTruth,
        ]),
      ])));
      results.push({
        functionId: id, status: 'supported', reason: 'exact-source-syntax',
        sourcePath: relative, sourceRevision: input.graph.repositoryRevision,
        sourceSha256: digest(source), branchFingerprints, directEffectFingerprints,
        branchCount: rows.length, directEffectCount: effects.length,
        sourceOnly: true, runtimeObserved: false,
      });
    }
    return results;
  });
}
