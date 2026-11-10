import { createHash } from 'node:crypto';
import ts from 'typescript';

/**
 * A deliberately narrow native-TypeScript condition evaluator. It proves
 * selection of a direct return-call under exact caller-supplied bindings.
 * It does NOT execute the callee, establish production configuration, prove
 * all branches, or replace TypeChecker's actual call-edge resolution.
 *
 * Only invoke with exact, already revision-checked source and uniquely bound
 * callable identity. Unsupported syntax or missing inputs fail closed.
 */
export const CONDITIONAL_RETURN_SELECTOR = 'typescript-conditional-return-selector.v1';
type Primitive = string | boolean | null;
const UNKNOWN = Symbol('unknown');
type Value = Primitive | typeof UNKNOWN;

export interface CapturedReturnSelection {
  status: 'established-conditional-selection' | 'unproven';
  reason: string;
  callable: string;
  sourcePath: string;
  sourceSha256: string;
  /** Expression is a source selection, NOT a proven runtime side effect. */
  selectedCall: string | null;
  selectedLine: number | null;
  checkedPredicates: Array<{ line: number; sourceSha256: string; truth: boolean }>;
  proof: {
    boundedSourceSelection: true;
    sourceInputsProvidedByCaller: true;
    externalCalleeExecutionObserved: false;
    environmentIndependentlyAttested: false;
    fullProgramBehaviorProven: false;
  };
}
function hash(s:string):string {
  return createHash('sha256').update(s).digest('hex');
}
function evalExpr(node:ts.Expression, src:ts.SourceFile,
  bindings:Readonly<Record<string,Primitive>>, depth=0):Value {
  if (depth>16) return UNKNOWN;
  if (ts.isParenthesizedExpression(node)) return evalExpr(node.expression,src,bindings,depth+1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind===ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind===ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind===ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node)||ts.isPropertyAccessExpression(node)) {
    const key=node.getText(src);
    return Object.prototype.hasOwnProperty.call(bindings,key) ? bindings[key]! : UNKNOWN;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator===ts.SyntaxKind.ExclamationToken) {
    const v=evalExpr(node.operand,src,bindings,depth+1);
    return v===UNKNOWN ? UNKNOWN : !v;
  }
  if (ts.isBinaryExpression(node)) {
    const kind=node.operatorToken.kind;
    if (kind===ts.SyntaxKind.BarBarToken || kind===ts.SyntaxKind.AmpersandAmpersandToken) {
      const left=evalExpr(node.left,src,bindings,depth+1);
      if (left===UNKNOWN) return UNKNOWN;
      if (kind===ts.SyntaxKind.BarBarToken && Boolean(left)) return true;
      if (kind===ts.SyntaxKind.AmpersandAmpersandToken && !left) return false;
      const right=evalExpr(node.right,src,bindings,depth+1);
      return right===UNKNOWN ? UNKNOWN : Boolean(right);
    }
    if (kind===ts.SyntaxKind.EqualsEqualsEqualsToken || kind===ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      const a=evalExpr(node.left,src,bindings,depth+1);
      const b=evalExpr(node.right,src,bindings,depth+1);
      if (a===UNKNOWN || b===UNKNOWN) return UNKNOWN;
      return kind===ts.SyntaxKind.EqualsEqualsEqualsToken ? a===b : a!==b;
    }
  }
  return UNKNOWN;
}
function bodies(file:ts.SourceFile,name:string):ts.Statement[][] {
  const results:ts.Statement[][]=[];
  for(const statement of file.statements) {
    if(ts.isFunctionDeclaration(statement) && statement.name?.text===name && statement.body) {
      results.push([...statement.body.statements]);
    }
    if(!ts.isVariableStatement(statement)) continue;
    for(const decl of statement.declarationList.declarations) {
      if(!ts.isIdentifier(decl.name) || decl.name.text!==name || !decl.initializer) continue;
      let init=decl.initializer;
      while(ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init=init.expression;
      if((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isBlock(init.body)) {
        results.push([...init.body.statements]);
      }
    }
  }
  return results;
}
export function selectCapturedReturnCall(input:{
  sourcePath:string; source:string; callable:string;
  bindings:Readonly<Record<string,Primitive>>;
}):CapturedReturnSelection {
  const src=ts.createSourceFile(input.sourcePath,input.source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS) as ts.SourceFile & {parseDiagnostics?:readonly ts.Diagnostic[]};
  const base={
    callable:input.callable,sourcePath:input.sourcePath,sourceSha256:hash(input.source),
    proof:{
      boundedSourceSelection:true as const,sourceInputsProvidedByCaller:true as const,
      externalCalleeExecutionObserved:false as const,
      environmentIndependentlyAttested:false as const,
      fullProgramBehaviorProven:false as const,
    },
  };
  const checked:CapturedReturnSelection['checkedPredicates']=[];
  const unknown=(reason:string):CapturedReturnSelection=>({
    ...base,status:'unproven',reason,checkedPredicates:checked,
    selectedCall:null,selectedLine:null,
  });
  if((src.parseDiagnostics?.length??0)>0) return unknown('parse-errors');
  const candidates=bodies(src,input.callable);
  if(candidates.length!==1) return unknown('callable-not-uniquely-resolved');
  let visited=0;
  type Outcome={kind:'call';node:ts.CallExpression}|{kind:'continue'}|{kind:'unknown';reason:string};
  const walk=(stmts:readonly ts.Statement[]):Outcome=>{
    for(const stmt of stmts) {
      if(++visited>64) return {kind:'unknown',reason:'statement-budget'};
      if(ts.isBlock(stmt)) {
        const x=walk(stmt.statements);
        if(x.kind!=='continue') return x;
      } else if(ts.isIfStatement(stmt)) {
        const value=evalExpr(stmt.expression,src,input.bindings);
        if(value===UNKNOWN) return {kind:'unknown',reason:'predicate-or-binding-unresolved'};
        checked.push({
          line:src.getLineAndCharacterOfPosition(stmt.expression.getStart(src)).line+1,
          sourceSha256:hash(stmt.expression.getText(src)),truth:Boolean(value),
        });
        const chosen=Boolean(value) ? stmt.thenStatement : stmt.elseStatement;
        if(chosen) {
          const x=walk(ts.isBlock(chosen) ? chosen.statements : [chosen]);
          if(x.kind!=='continue') return x;
        }
      } else if(ts.isReturnStatement(stmt) && stmt.expression && ts.isCallExpression(stmt.expression)) {
        const call=stmt.expression;
        if(call.arguments.some(arg => !ts.isIdentifier(arg) && !ts.isStringLiteral(arg)
          && !ts.isNumericLiteral(arg))) return {kind:'unknown',reason:'argument-effects-unknown'};
        if(!ts.isIdentifier(call.expression) && !ts.isPropertyAccessExpression(call.expression)) {
          return {kind:'unknown',reason:'dynamic-callee'};
        }
        return {kind:'call',node:call};
      } else return {kind:'unknown',reason:'unsupported-statement'};
    }
    return {kind:'continue'};
  };
  const outcome=walk(candidates[0]!);
  if(outcome.kind!=='call') return unknown(outcome.kind==='unknown'?outcome.reason:'no-direct-return-call');
  return {
    ...base,status:'established-conditional-selection',
    reason:'exact-bounded-source-branch-selection',
    checkedPredicates:checked,
    selectedCall:outcome.node.expression.getText(src),
    selectedLine:src.getLineAndCharacterOfPosition(outcome.node.getStart(src)).line+1,
  };
}
