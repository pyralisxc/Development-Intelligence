import { createHash } from 'node:crypto';
import ts from 'typescript';

/**
 * ONE bounded source-control-flow interpreter for both canonical graph
 * construction and revision-bound legacy/source-only query projections.
 * It observes syntax and path requirements, not feasible or executed paths.
 */
export interface SourceRequirement {
  conditionId: string;
  expectedTruth: boolean;
}
/** Source containment, retained even when the control-flow semantics are not yet modeled. */
export interface SourceControlContext {
  kind: string;
  sourceLine: number;
  sourceOffset: number;
  expression?: string;
  caseValue?: string;
}
export interface SourceEffect {
  kind: 'return' | 'return-call' | 'throw' | 'call' | 'write' | 'initializer-call';
  sourceLine: number;
  /** Exact AST start offset, distinct when statements share a line. */
  sourceOffset?: number;
  expression: string;
  /** Structured source expression with exact offsets in the selected file. */
  expressionStructure?: SourceExpression;
  expressionSha256: string;
  requiredConditions: SourceRequirement[];
  controlContext?: SourceControlContext[];
  requirementsComplete?: boolean;
  /** Syntax presence is established; runtime execution is not. */
  runtimeObserved: false;
}
export interface SourceCondition {
  id: string;
  sourceLine: number;
  sourceOffset?: number;
  predicate: string;
  predicateStructure?: SourceExpression;
  predicateSha256: string;
  priorRequirements: SourceRequirement[];
  controlContext?: SourceControlContext[];
  requirementsComplete?: boolean;
  trueBranchTerminates: boolean;
  falseBranchTerminates: boolean;
  conditionsAreSourceSyntaxOnly: true;
}

export interface SourceExpression {
  kind: string;
  start: number;
  end: number;
  /** Leaf text retains identifiers, operators and literal values. */
  text?: string;
  children?: SourceExpression[];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function expression(node: ts.Node | undefined, parsed: ts.SourceFile): string {
  return node ? node.getText(parsed) : '';
}
function structure(node: ts.Node, parsed: ts.SourceFile): SourceExpression {
  const children: SourceExpression[] = [];
  ts.forEachChild(node, child => { children.push(structure(child, parsed)); });
  const fact: SourceExpression = {
    kind: ts.SyntaxKind[node.kind] ?? String(node.kind),
    start: node.getStart(parsed), end: node.getEnd(),
  };
  if (children.length) fact.children = children;
  else fact.text = node.getText(parsed);
  return fact;
}
function returnCall(node: ts.Expression | undefined): boolean {
  return Boolean(node && (ts.isCallExpression(node) || (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression))));
}
function definitelyTerminates(node: ts.Statement): boolean {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
  if (ts.isBlock(node)) {
    const parts = [...node.statements];
    // A terminating final statement prevents normal fallthrough even when
    // earlier nested if statements may themselves return or throw.
    return parts.length > 0 && definitelyTerminates(parts[parts.length - 1]!);
  }
  if (ts.isIfStatement(node)) return Boolean(node.elseStatement
    && definitelyTerminates(node.thenStatement)
    && definitelyTerminates(node.elseStatement));
  return false;
}

export interface SourceConditionStatementFacts {
  branches: SourceCondition[];
  effects: SourceEffect[];
  unknownConstructs: Array<{line: number; kind: string}>;
  boundedOut: boolean;
  completeForSupportedStatements: boolean;
}
export function analyzeSourceConditionStatements(
  parsed: ts.SourceFile, sourcePath: string, statements: readonly ts.Statement[],
): SourceConditionStatementFacts {
  const branches: SourceCondition[] = [];
  const effects: SourceEffect[] = [];
  const unknownConstructs: Array<{ line: number; kind: string }> = [];
  const boundedOut = false;
  const lineOf = (node: ts.Node) => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
  const recordEffect = (kind: SourceEffect['kind'], node: ts.Node, sourceExpression: ts.Node | undefined, requires: SourceRequirement[], context: SourceControlContext[], complete: boolean) => {
    effects.push({ kind, sourceLine: lineOf(node), sourceOffset: node.getStart(parsed), expression: expression(sourceExpression, parsed),
      ...(sourceExpression ? { expressionStructure: structure(sourceExpression, parsed) } : {}),
      expressionSha256: digest(node.getText(parsed)),
      requiredConditions: [...requires], controlContext: [...context], requirementsComplete: complete && context.length === 0,
      runtimeObserved: false });
  };
  // Conditions can occur inside an expression, including an argument to an
  // otherwise unconditional outer call. Preserve the branch on the nested
  // call occurrence instead of attributing the outer call's path to it.
  const scanExpression = (root: ts.Node | undefined, requirements: SourceRequirement[], context: SourceControlContext[], complete: boolean): void => {
    if (!root) return;
    const visit = (node: ts.Node, active: SourceRequirement[], controls: SourceControlContext[], known: boolean, guarded: boolean): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isConditionalExpression(node)) {
        visit(node.condition, active, controls, known, guarded);
        const predicate = node.condition;
        // The question mark distinguishes this guard from an enclosing if
        // whose entire predicate can start at the same offset.
        const offset = node.questionToken.getStart(parsed);
        const id = sourcePath + ':condition:' + offset;
        branches.push({ id, sourceLine: lineOf(node.questionToken), sourceOffset: offset,
          predicate: expression(predicate, parsed), predicateStructure: structure(predicate, parsed),
          predicateSha256: digest(predicate.getText(parsed)), priorRequirements: [...active],
          controlContext: [...controls], requirementsComplete: known && controls.length === 0,
          trueBranchTerminates: false, falseBranchTerminates: false, conditionsAreSourceSyntaxOnly: true });
        visit(node.whenTrue, [...active, { conditionId: id, expectedTruth: true }], controls, known, true);
        visit(node.whenFalse, [...active, { conditionId: id, expectedTruth: false }], controls, known, true);
        return;
      }
      // Short-circuit and optional evaluation have additional premises that
      // this interpreter does not yet derive. Retain their context honestly.
      const shortCircuit = ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind);
      if (shortCircuit && ts.isBinaryExpression(node)) {
        visit(node.left, active, controls, known, guarded);
        const part = { kind: 'short-circuit-expression', sourceLine: lineOf(node), sourceOffset: node.getStart(parsed), expression: expression(node.left, parsed) };
        visit(node.right, active, [...controls, part], false, guarded);
        return;
      }
      if (ts.isCallExpression(node) && ts.isCallChain(node)) {
        const part = { kind: 'optional-call', sourceLine: lineOf(node), sourceOffset: node.getStart(parsed), expression: expression(node.expression, parsed) };
        if (guarded) recordEffect('call', node, node, active, [...controls, part], false);
        visit(node.expression, active, controls, known, guarded);
        node.arguments.forEach(argument => visit(argument, active, [...controls, part], false, guarded));
        return;
      }
      if (ts.isElementAccessExpression(node) && ts.isElementAccessChain(node)) {
        visit(node.expression, active, controls, known, guarded);
        const part = { kind: 'optional-element-access', sourceLine: lineOf(node), sourceOffset: node.getStart(parsed), expression: expression(node.expression, parsed) };
        if (node.argumentExpression) visit(node.argumentExpression, active, [...controls, part], false, guarded);
        return;
      }
      if (guarded && ts.isCallExpression(node)) recordEffect('call', node, node, active, controls, known);
      ts.forEachChild(node, child => visit(child, active, controls, known, guarded));
    };
    visit(root, requirements, context, complete, false);
  };
  const scan = (list: readonly ts.Statement[], requirements: SourceRequirement[], depth: number, context: SourceControlContext[] = [], inheritedComplete = true): void => {
    const active = [...requirements];
    let complete = inheritedComplete;
    for (const stmt of list) {
      if (ts.isIfStatement(stmt)) {
        scanExpression(stmt.expression, active, context, complete);
        const previousUnknown = unknownConstructs.length;
        const id = sourcePath + ':condition:' + stmt.expression.getStart(parsed);
        const branch: SourceCondition = {
          id, sourceLine: lineOf(stmt.expression), sourceOffset: stmt.expression.getStart(parsed),
          predicate: expression(stmt.expression, parsed), predicateStructure: structure(stmt.expression, parsed),
          predicateSha256: digest(stmt.expression.getText(parsed)),
          priorRequirements: [...active], controlContext: [...context], requirementsComplete: complete && context.length === 0,
          trueBranchTerminates: definitelyTerminates(stmt.thenStatement),
          falseBranchTerminates: Boolean(stmt.elseStatement && definitelyTerminates(stmt.elseStatement)),
          conditionsAreSourceSyntaxOnly: true,
        };
        branches.push(branch);
        const thenNodes = ts.isBlock(stmt.thenStatement) ? [...stmt.thenStatement.statements] : [stmt.thenStatement];
        scan(thenNodes, [...active, { conditionId: id, expectedTruth: true }], depth + 1, context, complete);
        if (stmt.elseStatement) {
          const elseNodes = ts.isBlock(stmt.elseStatement) ? [...stmt.elseStatement.statements] : [stmt.elseStatement];
          scan(elseNodes, [...active, { conditionId: id, expectedTruth: false }], depth + 1, context, complete);
        }
        if (branch.trueBranchTerminates && branch.falseBranchTerminates) return;
        if (branch.trueBranchTerminates) active.push({ conditionId: id, expectedTruth: false });
        else if (branch.falseBranchTerminates) active.push({ conditionId: id, expectedTruth: true });
        if (unknownConstructs.length > previousUnknown) complete = false;
      } else if (ts.isReturnStatement(stmt)) {
        scanExpression(stmt.expression, active, context, complete);
        recordEffect(returnCall(stmt.expression) ? 'return-call' : 'return',
          stmt, stmt.expression, active, context, complete);
        return;
      } else if (ts.isThrowStatement(stmt)) {
        scanExpression(stmt.expression, active, context, complete);
        recordEffect('throw', stmt, stmt.expression, active, context, complete);
        return;
      } else if (ts.isBlock(stmt)) {
        const previousUnknown = unknownConstructs.length;
        scan([...stmt.statements], active, depth + 1, context, complete);
        if (unknownConstructs.length > previousUnknown) complete = false;
      }
      else if (ts.isExpressionStatement(stmt)) {
        const e = stmt.expression;
        scanExpression(e, active, context, complete);
        if (ts.isCallExpression(e) || (ts.isAwaitExpression(e) && ts.isCallExpression(e.expression))) {
          recordEffect('call', stmt, e, active, context, complete);
        } else if (ts.isBinaryExpression(e) &&
          e.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && e.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
          recordEffect('write', stmt, e, active, context, complete);
        }
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          scanExpression(decl.initializer, active, context, complete);
          if (decl.initializer && (ts.isCallExpression(decl.initializer)
            || (ts.isAwaitExpression(decl.initializer) && ts.isCallExpression(decl.initializer.expression)))) {
            recordEffect('initializer-call', decl, decl.initializer, active, context, complete);
          }
        }
      } else if (ts.isTryStatement(stmt) || ts.isSwitchStatement(stmt)
        || ts.isForStatement(stmt) || ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)
        || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
        unknownConstructs.push({ line: lineOf(stmt), kind: ts.SyntaxKind[stmt.kind] ?? 'control-flow' });
        const visitBody = (body: ts.Statement, kind: string, controlExpression?: ts.Node) => {
          const part: SourceControlContext = { kind, sourceLine: lineOf(body), sourceOffset: body.getStart(parsed),
            ...(controlExpression ? { expression: expression(controlExpression, parsed) } : {}) };
          scan(ts.isBlock(body) ? [...body.statements] : [body], active, depth + 1, [...context, part], false);
        };
        if (ts.isTryStatement(stmt)) {
          visitBody(stmt.tryBlock, 'try');
          if (stmt.catchClause) visitBody(stmt.catchClause.block, 'catch', stmt.catchClause.variableDeclaration);
          if (stmt.finallyBlock) visitBody(stmt.finallyBlock, 'finally');
        } else if (ts.isSwitchStatement(stmt)) {
          for (const clause of stmt.caseBlock.clauses) {
            const part: SourceControlContext = { kind: ts.isCaseClause(clause) ? 'case' : 'default',
              sourceLine: lineOf(clause), sourceOffset: clause.getStart(parsed),
              expression: expression(stmt.expression, parsed),
              ...(ts.isCaseClause(clause) ? { caseValue: expression(clause.expression, parsed) } : {}) };
            scan([...clause.statements], active, depth + 1, [...context, part], false);
          }
        } else {
          const controlExpression = ts.isForStatement(stmt) ? stmt.condition
            : ts.isForInStatement(stmt) || ts.isForOfStatement(stmt) ? stmt.expression
              : stmt.expression;
          visitBody(stmt.statement, ts.SyntaxKind[stmt.kind] ?? 'loop', controlExpression);
        }
        complete = false;
      }
    }
  };
  scan(statements, [], 0);

  return {
    branches, effects, unknownConstructs, boundedOut,
    completeForSupportedStatements: !boundedOut && unknownConstructs.length === 0,
  };
}
