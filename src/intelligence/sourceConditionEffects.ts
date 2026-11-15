import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
// Node 22 exposes the high-resolution clock globally via the DOM lib.
import type { GraphNode, IntelligenceGraph } from '../types.js';
import { analyzeSourceConditionStatements,
  type SourceCondition, type SourceEffect } from './sourceConditionFacts.js';
export type { SourceCondition, SourceEffect, SourceRequirement } from './sourceConditionFacts.js';
import { resolveProjectRevision, withResolvedProjectCheckout } from '../source/git.js';
import { isWrittenTestSource } from './independentSourceVerification.js';

export const CONDITION_EFFECT_LENS = 'typescript-ast-condition-effect-source.v1';
const MAX_FILE_BYTES = 1_000_000;
const MAX_PREVIEW_ROWS = 80;
const CALLABLE = new Set(['function', 'method']);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonicalPath(node: GraphNode): string | null {
  return node.sourceId.startsWith('repo:') ? node.sourceId.slice(5) : null;
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
