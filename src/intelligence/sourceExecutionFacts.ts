import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { TestClaimCatalog } from './testClaimInventory.js';
import type { NodeTestEvidenceProjection } from './nodeTestEvidence.js';

/** A source proof is a conditional execution fact, not an observation of a run. */
export const SOURCE_EXECUTION_FACT_STRATEGY = 'test-success-control-flow.v1';
export type SourceReach = 'must-on-success' | 'may-on-success' | 'never-on-success' | 'unknown';
export type ReportedTestOutcome = 'pass' | 'fail' | 'skip' | 'todo' | 'unknown' | 'unavailable' | 'ambiguous';
export interface SourceExecutionFact {
  assertionId: string;
  sourceId: string;
  testDeclarationId: string | null;
  sourceReach: SourceReach;
  sourceReason: string;
  locator: string;
  reportedTestOutcome: ReportedTestOutcome;
  inferredExecution: 'none' | 'conditional-on-reported-pass' | 'direct-local-run';
  observedAssertionResult: false;
  observedProviderEffect: false;
}
export interface SourceExecutionFactProjection {
  strategy: typeof SOURCE_EXECUTION_FACT_STRATEGY;
  revision: string;
  analyzerVersion: string;
  graphId: string;
  factsSha256: string;
  sourceFactsSha256: string;
  counts: {
    assertions: number;
    sourceMust: number;
    sourceMay: number;
    sourceNever: number;
    sourceUnknown: number;
    insideReportedPass: number;
    conditionalOnReportedPass: number;
    directlyInferredLocalExecution: number;
  };
  facts: SourceExecutionFact[];
  policy: {
    sourceProofIndependentOfRun: true;
    reportedPassIsNotIndependentAttestation: true;
    localExecutionIsScopedToDirectRunner: true;
    staticMustDoesNotProveProviderEffect: true;
    noAutomaticTestReplacement: true;
  };
}

type PathValue = 0 | 1;
interface Paths { active: Set<PathValue>; success: Set<PathValue>; unknown: boolean }
interface Target { start: number; end: number }
interface Budget { left: number }
function union(...inputs: Set<PathValue>[]): Set<PathValue> {
  return new Set(inputs.flatMap(value => [...value]));
}
function identical(node: ts.Node, source: ts.SourceFile, target: Target): boolean {
  return node.getStart(source) === target.start && node.end === target.end;
}
function contains(node: ts.Node, source: ts.SourceFile, target: Target): boolean {
  if (identical(node, source, target)) return true;
  if (target.start < node.getStart(source) || target.end > node.end) return false;
  return ts.forEachChild(node, child => contains(child, source, target) ? true : undefined) === true;
}
function directlyEvaluates(expression: ts.Expression | undefined, source: ts.SourceFile, target: Target): boolean {
  if (!expression) return false;
  if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)) {
    return directlyEvaluates(expression.expression, source, target);
  }
  return ts.isCallExpression(expression) && identical(expression, source, target);
}
function directInStatement(statement: ts.Statement, source: ts.SourceFile, target: Target): boolean {
  if (ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)) {
    return directlyEvaluates(statement.expression, source, target);
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(d => directlyEvaluates(d.initializer, source, target));
  }
  return false;
}
function truth(expression: ts.Expression): boolean | null {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isParenthesizedExpression(expression)) return truth(expression.expression);
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = truth(expression.operand);
    return inner === null ? null : !inner;
  }
  return null;
}
/**
 * A finally block cannot make an earlier thrown exception into a successful
 * test completion unless it overrides that exception with return/break/continue.
 * Inspect all nested syntax (including callbacks) conservatively.
 */
function finallyCanReplaceCompletion(block: ts.Block): boolean {
  let overrides = false;
  const inspect = (node: ts.Node): void => {
    if (overrides) return;
    if (ts.isReturnStatement(node) || ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      overrides = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(block);
  return overrides;
}
function walkStatements(statements: readonly ts.Statement[], input: Paths, source: ts.SourceFile,
  target: Target, budget: Budget, depth: number): Paths {
  let paths = input;
  for (const statement of statements) {
    if (!paths.active.size) break;
    paths = walk(statement, paths, source, target, budget, depth + 1);
  }
  return paths;
}
function walk(statement: ts.Statement, input: Paths, source: ts.SourceFile,
  target: Target, budget: Budget, depth: number): Paths {
  if (--budget.left < 0 || depth > 64) return { ...input, unknown: true };
  if (ts.isBlock(statement)) return walkStatements(statement.statements, input, source, target, budget, depth + 1);
  if (ts.isTryStatement(statement)) {
    // Without catch, a thrown pre-assertion path cannot complete a passing test.
    // A normally-completing finally without an abrupt completion override
    // preserves the try block's reachability facts. Do not model an assertion
    // *inside* finally until explicit handling of all try/return exits exists.
    if (statement.catchClause || !statement.finallyBlock
      || contains(statement.finallyBlock, source, target)
      || finallyCanReplaceCompletion(statement.finallyBlock)) {
      return { ...input, unknown: true };
    }
    return walk(statement.tryBlock, input, source, target, budget, depth + 1);
  }
  if (ts.isIfStatement(statement)) {
    if (contains(statement.expression, source, target)) return { ...input, unknown: true };
    const condition = truth(statement.expression);
    const choice = (branch: ts.Statement | undefined): Paths => branch
      ? walk(branch, { active: new Set(input.active), success: new Set(), unknown: false }, source, target, budget, depth + 1)
      : { active: new Set(input.active), success: new Set(), unknown: false };
    const yes = condition === false ? { active: new Set<PathValue>(), success: new Set<PathValue>(), unknown: false }
      : choice(statement.thenStatement);
    const no = condition === true ? { active: new Set<PathValue>(), success: new Set<PathValue>(), unknown: false }
      : choice(statement.elseStatement);
    return { active: union(yes.active, no.active), success: union(input.success, yes.success, no.success),
      unknown: input.unknown || yes.unknown || no.unknown };
  }
  if (ts.isThrowStatement(statement)) {
    // Unhandled throw cannot be on a passing test's normal-completion path.
    return { active: new Set(), success: new Set(input.success), unknown: input.unknown };
  }
  if (ts.isReturnStatement(statement)) {
    const reached = directInStatement(statement, source, target);
    if (!reached && contains(statement, source, target)) return { ...input, unknown: true };
    return { active: new Set(), success: union(input.success,
      new Set([...input.active].map(value => reached ? 1 as const : value))), unknown: input.unknown };
  }
  if (directInStatement(statement, source, target)) {
    return { active: new Set(input.active.size ? [1] as PathValue[] : []), success: new Set(input.success),
      unknown: input.unknown };
  }
  if (contains(statement, source, target)) return { ...input, unknown: true };
  if (ts.isExpressionStatement(statement) || ts.isVariableStatement(statement)
    || ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement)
    || ts.isClassDeclaration(statement)) return input;
  // Loops, try/catch/finally, switch, labels and other unmodeled exits could
  // complete or bypass the target. Keep them unknown until a control-flow proof.
  return { ...input, unknown: input.unknown || input.active.has(0) };
}
function classify(call: ts.CallExpression, source: ts.SourceFile, target: Target): SourceReach {
  const callback = call.arguments.filter(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
  if (callback.length !== 1) return 'unknown';
  const fn = callback[0] as ts.ArrowFunction | ts.FunctionExpression;
  if (target.start < fn.body.getStart(source) || target.end > fn.body.end) return 'unknown';
  let paths: Paths;
  if (ts.isBlock(fn.body)) {
    paths = walkStatements(fn.body.statements,
      { active: new Set([0]), success: new Set(), unknown: false }, source, target, { left: 2000 }, 0);
  } else {
    if (!directlyEvaluates(fn.body, source, target)) return 'unknown';
    paths = { active: new Set([1]), success: new Set(), unknown: false };
  }
  if (paths.unknown) return 'unknown';
  const successful = union(paths.active, paths.success);
  if (!successful.size) return 'unknown';
  if (successful.has(1) && !successful.has(0)) return 'must-on-success';
  if (successful.has(0) && !successful.has(1)) return 'never-on-success';
  return 'may-on-success';
}
function scriptKind(name: string): ts.ScriptKind {
  if (/\.tsx$/iu.test(name)) return ts.ScriptKind.TSX;
  if (/\.jsx$/iu.test(name)) return ts.ScriptKind.JSX;
  return /\.[cm]?js$/iu.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
function locateCalls(source: ts.SourceFile): Map<string, ts.CallExpression> {
  const calls = new Map<string, ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.set(`${node.getStart(source)}:${node.end}`, node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}
function unknownFact(assertion: TestClaimCatalog['assertions'][number], reason: string): SourceExecutionFact {
  return { assertionId: assertion.id, sourceId: assertion.sourceId, testDeclarationId: null,
    sourceReach: 'unknown', sourceReason: reason, locator: `${assertion.sourceId}:${assertion.start}`,
    reportedTestOutcome: 'unavailable', inferredExecution: 'none',
    observedAssertionResult: false, observedProviderEffect: false };
}
function summarize(projection: SourceExecutionFactProjection): SourceExecutionFactProjection {
  const facts = projection.facts;
  const sourceFactsSha256 = createHash('sha256').update(JSON.stringify({
    strategy: projection.strategy, revision: projection.revision,
    analyzerVersion: projection.analyzerVersion, graphId: projection.graphId,
    sourceFacts: facts.map(({ assertionId, sourceId, testDeclarationId,
      sourceReach, sourceReason, locator }) => ({ assertionId, sourceId, testDeclarationId,
      sourceReach, sourceReason, locator })),
  })).digest('hex');
  return { ...projection, sourceFactsSha256,
    factsSha256: createHash('sha256').update(JSON.stringify({ strategy: projection.strategy,
    revision: projection.revision, analyzerVersion: projection.analyzerVersion,
    graphId: projection.graphId, facts: projection.facts })).digest('hex'), counts: {
    assertions: facts.length,
    sourceMust: facts.filter(f => f.sourceReach === 'must-on-success').length,
    sourceMay: facts.filter(f => f.sourceReach === 'may-on-success').length,
    sourceNever: facts.filter(f => f.sourceReach === 'never-on-success').length,
    sourceUnknown: facts.filter(f => f.sourceReach === 'unknown').length,
    insideReportedPass: facts.filter(f => f.reportedTestOutcome === 'pass').length,
    conditionalOnReportedPass: facts.filter(f => f.inferredExecution === 'conditional-on-reported-pass').length,
    directlyInferredLocalExecution: facts.filter(f => f.inferredExecution === 'direct-local-run').length,
  } };
}
/** Derive actual source constraints without inspecting test-run status. */
export async function deriveSourceExecutionFacts(root: string, catalog: TestClaimCatalog,
  graphId: string): Promise<SourceExecutionFactProjection> {
  const facts: SourceExecutionFact[] = [];
  const byFile = new Map(catalog.files.map(file => [file.sourceId, file]));
  const declarationsByFile = new Map<string, TestClaimCatalog['declarations']>();
  const assertionsByFile = new Map<string, TestClaimCatalog['assertions']>();
  for (const item of catalog.declarations) declarationsByFile.set(item.sourceId,
    [...(declarationsByFile.get(item.sourceId) ?? []), item]);
  for (const item of catalog.assertions) assertionsByFile.set(item.sourceId,
    [...(assertionsByFile.get(item.sourceId) ?? []), item]);
  const realRoot = await fs.realpath(root);
  for (const [fileName, assertions] of assertionsByFile) {
    const record = byFile.get(fileName);
    if (!record || record.disposition !== 'analyzed') {
      facts.push(...assertions.map(a => unknownFact(a, 'source not eligible for execution analysis')));
      continue;
    }
    if (!fileName || fileName.includes('\\') || fileName.startsWith('/') ||
      fileName.split('/').some(part => part === '..' || part === '.' || !part)) {
      throw new Error('Execution fact source path is not canonical');
    }
    const full = path.resolve(realRoot, fileName);
    const relative = path.relative(realRoot, full);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Execution fact source escapes the repository');
    }
    const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) {
      throw new Error('Execution fact source is nonregular or over the source limit');
    }
    const real = await fs.realpath(full);
    const realRelative = path.relative(realRoot, real);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error('Execution fact source resolves outside the repository');
    }
    const content = await fs.readFile(real, 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== record.contentSha256) {
      throw new Error('Execution fact source differs from the exact catalog');
    }
    const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind(fileName));
    const parsed = source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
    const calls = locateCalls(source);
    const declarations = declarationsByFile.get(fileName) ?? [];
    for (const assertion of assertions) {
      if (assertion.dynamic || parsed.parseDiagnostics?.length) {
        facts.push(unknownFact(assertion, 'dynamic or invalid assertion syntax'));
        continue;
      }
      const enclosing = declarations.filter(d => !d.dynamic && d.start <= assertion.start && d.end >= assertion.end);
      if (enclosing.length !== 1) {
        facts.push(unknownFact(assertion, 'test callback identity is missing or ambiguous'));
        continue;
      }
      const owner = enclosing[0]!;
      const call = calls.get(`${owner.start}:${owner.end}`);
      const sourceReach = call ? classify(call, source, { start: assertion.start, end: assertion.end }) : 'unknown';
      const line = source.getLineAndCharacterOfPosition(assertion.start).line + 1;
      facts.push({ assertionId: assertion.id, sourceId: fileName, testDeclarationId: owner.id,
        sourceReach, sourceReason: sourceReach === 'must-on-success' ? 'all modeled normal-completion paths evaluate the source assertion'
          : sourceReach === 'may-on-success' ? 'some but not all normal-completion paths evaluate the assertion'
            : sourceReach === 'never-on-success' ? 'no modeled normal-completion path evaluates the assertion'
              : 'callback or control flow requires more evidence',
        locator: `${fileName}:${line}`, reportedTestOutcome: 'unavailable', inferredExecution: 'none',
        observedAssertionResult: false, observedProviderEffect: false });
    }
  }
  return summarize({ strategy: SOURCE_EXECUTION_FACT_STRATEGY, revision: catalog.revision,
    analyzerVersion: catalog.analyzerVersion, graphId, factsSha256: '', sourceFactsSha256: '', facts: facts.sort((a, b) => a.assertionId.localeCompare(b.assertionId)),
    counts: { assertions: 0, sourceMust: 0, sourceMay: 0, sourceNever: 0, sourceUnknown: 0,
      insideReportedPass: 0, conditionalOnReportedPass: 0, directlyInferredLocalExecution: 0 },
    policy: { sourceProofIndependentOfRun: true, reportedPassIsNotIndependentAttestation: true,
      localExecutionIsScopedToDirectRunner: true, staticMustDoesNotProveProviderEffect: true,
      noAutomaticTestReplacement: true } });
}
/** Join observations only after the independent source reachability pass. */
export function correlateSourceExecutionFacts(source: SourceExecutionFactProjection,
  observed: NodeTestEvidenceProjection, provenance: 'unattested-report' | 'direct-local-run'): SourceExecutionFactProjection {
  if (source.revision !== observed.identity.revision || source.graphId !== observed.identity.graphId) {
    throw new Error('Execution facts and run evidence must refer to the same exact source graph');
  }
  const byId = new Map<string, NodeTestEvidenceProjection['tests']>();
  for (const test of observed.tests) {
    if (!test.declarationId) continue;
    byId.set(test.declarationId, [...(byId.get(test.declarationId) ?? []), test]);
  }
  const facts = source.facts.map(fact => {
    const events = fact.testDeclarationId ? byId.get(fact.testDeclarationId) ?? [] : [];
    let reported: ReportedTestOutcome = 'unavailable';
    if (events.length > 1) reported = 'ambiguous';
    else if (events.length === 1 && events[0]!.evidenceStatus === 'source-associated-unattested') {
      reported = ({ 'reported-pass': 'pass', 'reported-fail': 'fail', 'reported-skip': 'skip',
        'reported-todo': 'todo', 'reported-unknown': 'unknown' } as const)[events[0]!.outcome];
    }
    const inferredExecution: SourceExecutionFact['inferredExecution'] = fact.sourceReach === 'must-on-success' && reported === 'pass'
        ? (provenance === 'direct-local-run' ? 'direct-local-run' : 'conditional-on-reported-pass')
        : 'none';
    return { ...fact, reportedTestOutcome: reported, inferredExecution };
  });
  return summarize({ ...source, facts });
}
