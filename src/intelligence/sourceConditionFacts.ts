import { createHash } from 'node:crypto';
import ts from 'typescript';

/**
 * ONE bounded source-control-flow interpreter for both canonical graph
 * construction and revision-bound legacy/source-only query projections.
 * It observes syntax and path requirements, not feasible or executed paths.
 */
const MAX_BRANCHES = 256;
const MAX_EFFECTS = 512;
const MAX_DEPTH = 24;
export interface SourceRequirement {
  conditionId: string;
  expectedTruth: boolean;
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
  let boundedOut = false;
  const lineOf = (node: ts.Node) => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
  const recordEffect = (kind: SourceEffect['kind'], node: ts.Node, sourceExpression: ts.Node | undefined, requires: SourceRequirement[]) => {
    if (effects.length >= MAX_EFFECTS) { boundedOut = true; return; }
    effects.push({ kind, sourceLine: lineOf(node), sourceOffset: node.getStart(parsed), expression: expression(sourceExpression, parsed),
      ...(sourceExpression ? { expressionStructure: structure(sourceExpression, parsed) } : {}),
      expressionSha256: digest(node.getText(parsed)),
      requiredConditions: [...requires], runtimeObserved: false });
  };
  const scan = (list: readonly ts.Statement[], requirements: SourceRequirement[], depth: number): void => {
    if (depth > MAX_DEPTH) { boundedOut = true; return; }
    const active = [...requirements];
    for (const stmt of list) {
      if (boundedOut) return;
      if (ts.isIfStatement(stmt)) {
        if (branches.length >= MAX_BRANCHES) { boundedOut = true; return; }
        const id = sourcePath + ':condition:' + stmt.expression.getStart(parsed);
        const branch: SourceCondition = {
          id, sourceLine: lineOf(stmt.expression), sourceOffset: stmt.expression.getStart(parsed),
          predicate: expression(stmt.expression, parsed), predicateStructure: structure(stmt.expression, parsed),
          predicateSha256: digest(stmt.expression.getText(parsed)),
          priorRequirements: [...active],
          trueBranchTerminates: definitelyTerminates(stmt.thenStatement),
          falseBranchTerminates: Boolean(stmt.elseStatement && definitelyTerminates(stmt.elseStatement)),
          conditionsAreSourceSyntaxOnly: true,
        };
        branches.push(branch);
        const thenNodes = ts.isBlock(stmt.thenStatement) ? [...stmt.thenStatement.statements] : [stmt.thenStatement];
        scan(thenNodes, [...active, { conditionId: id, expectedTruth: true }], depth + 1);
        if (stmt.elseStatement) {
          const elseNodes = ts.isBlock(stmt.elseStatement) ? [...stmt.elseStatement.statements] : [stmt.elseStatement];
          scan(elseNodes, [...active, { conditionId: id, expectedTruth: false }], depth + 1);
        }
        if (branch.trueBranchTerminates && branch.falseBranchTerminates) return;
        if (branch.trueBranchTerminates) active.push({ conditionId: id, expectedTruth: false });
        else if (branch.falseBranchTerminates) active.push({ conditionId: id, expectedTruth: true });
      } else if (ts.isReturnStatement(stmt)) {
        recordEffect(returnCall(stmt.expression) ? 'return-call' : 'return',
          stmt, stmt.expression, active);
        return;
      } else if (ts.isThrowStatement(stmt)) {
        recordEffect('throw', stmt, stmt.expression, active);
        return;
      } else if (ts.isBlock(stmt)) scan([...stmt.statements], active, depth + 1);
      else if (ts.isExpressionStatement(stmt)) {
        const e = stmt.expression;
        if (ts.isCallExpression(e) || (ts.isAwaitExpression(e) && ts.isCallExpression(e.expression))) {
          recordEffect('call', stmt, e, active);
        } else if (ts.isBinaryExpression(e) &&
          e.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && e.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
          recordEffect('write', stmt, e, active);
        }
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer && (ts.isCallExpression(decl.initializer)
            || (ts.isAwaitExpression(decl.initializer) && ts.isCallExpression(decl.initializer.expression)))) {
            recordEffect('initializer-call', decl, decl.initializer, active);
          }
        }
      } else if (ts.isTryStatement(stmt) || ts.isSwitchStatement(stmt)
        || ts.isForStatement(stmt) || ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)
        || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
        unknownConstructs.push({ line: lineOf(stmt), kind: ts.SyntaxKind[stmt.kind] ?? 'control-flow' });
      }
    }
  };
  scan(statements, [], 0);

  return {
    branches, effects, unknownConstructs, boundedOut,
    completeForSupportedStatements: !boundedOut && unknownConstructs.length === 0,
  };
}
