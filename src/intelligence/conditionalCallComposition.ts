import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { IntelligenceGraph, GraphNode } from '../types.js';

/** A bounded, source-only boolean-return interpreter over two resolved callables. */
export const CONDITIONAL_CALL_COMPOSITION = 'typescript-bounded-boolean-call.v1';
type Primitive = string | boolean | null;
type Expr = Primitive | typeof UNKNOWN;
const UNKNOWN = Symbol('unresolved');
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
type Trace = { file: string; line: number; expressionDigest: string; kind: 'guard' | 'call' | 'return' };

function isBound(node: ts.Expression, file: ts.SourceFile, values: Map<string, Primitive>): Expr {
  const key = node.getText(file);
  return values.has(key) ? values.get(key)! : UNKNOWN;
}
function expression(node: ts.Expression, file: ts.SourceFile, values: Map<string, Primitive>, depth = 0): Expr {
  if (depth > 20) return UNKNOWN;
  if (ts.isParenthesizedExpression(node)) return expression(node.expression, file, values, depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return isBound(node, file, values);
  if (ts.isCallExpression(node)) return isBound(node, file, values);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const v = expression(node.operand, file, values, depth + 1);
    return v === UNKNOWN ? UNKNOWN : !v;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const l = expression(node.left, file, values, depth + 1);
    if (l === UNKNOWN) return UNKNOWN;
    if (op === ts.SyntaxKind.BarBarToken && Boolean(l)) return true;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken && !l) return false;
    const r = expression(node.right, file, values, depth + 1);
    if (r === UNKNOWN) return UNKNOWN;
    if (op === ts.SyntaxKind.BarBarToken) return Boolean(l) || Boolean(r);
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return Boolean(l) && Boolean(r);
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return l === r;
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return l !== r;
  }
  return UNKNOWN;
}
function lineOf(node: ts.Node, file: ts.SourceFile): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}
function statementList(stmt: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(stmt) ? stmt.statements : [stmt];
}
function declaredFunction(file: ts.SourceFile, node: GraphNode): ts.FunctionDeclaration | null {
  const line = Number(/:(\d+)(?::|$)/u.exec(node.locator)?.[1]);
  const functions = file.statements.filter((s): s is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(s) && s.name?.text === node.name && Boolean(s.body)
    && lineOf(s, file) === line);
  return functions.length === 1 ? functions[0]! : null;
}
function sourceCovered(graph: IntelligenceGraph, node: GraphNode, path: string): boolean {
  return node.kind === 'function' && node.layer === 'structural'
    && node.sourceId === 'repo:' + path && node.name !== undefined
    && graph.coverage?.files?.some(f => f.path === path && f.status === 'complete') === true;
}
function resolvedCall(graph: IntelligenceGraph, from: GraphNode, to: GraphNode, path: string, line: number): boolean {
  return graph.edges.some(e =>
    e.from === from.id && e.to === to.id && e.kind === 'calls'
    && e.status === 'resolved' && e.layer === 'structural'
    && e.evidence.some(value => value === path + ':' + line));
}

export interface BooleanChainProof {
  status: 'established-normal-path' | 'unproven';
  reason: string;
  value: boolean | null;
  chain: string[];
  sourceRevision: string | null;
  sourceDigest: string;
  guards: Trace[];
  responseCalls: Trace[];
  returns: Trace[];
  assumptions: {
    externalBindingsAreHypothetical: true;
    selectedBranchesOnly: true;
    allInterveningCallsReturnNormally: true;
    noLiveConfigurationObserved: true;
    notAllProgramPathsProven: true;
  };
}
/** Input graph and source must be independently bound to the SAME exact Git tree upstream. */
export function evaluateCapturedBooleanChain(input: {
  graph: IntelligenceGraph;
  sourcePath: string;
  source: string;
  rootId: string;
  calleeId: string;
  bindings: Readonly<Record<string, Primitive>>;
}): BooleanChainProof {
  const { graph, sourcePath, source } = input;
  const guards: Trace[] = [], responseCalls: Trace[] = [], returns: Trace[] = [];
  const chain: string[] = [];
  const base = {
    sourceRevision: graph.repositoryRevision, sourceDigest: digest(source),
    chain, guards, responseCalls, returns,
    assumptions: {
      externalBindingsAreHypothetical: true as const,
      selectedBranchesOnly: true as const,
      allInterveningCallsReturnNormally: true as const,
      noLiveConfigurationObserved: true as const,
      notAllProgramPathsProven: true as const,
    },
  };
  const unproven = (reason: string): BooleanChainProof => ({
    ...base, status: 'unproven', reason, value: null,
  });
  if (!graph.repositoryRevision || !/^[a-f0-9]{40}$/iu.test(graph.repositoryRevision)) {
    return unproven('missing-exact-source-revision');
  }
  if (source.length > 1_000_000 || source.includes('\0')) return unproven('unbounded-or-nontext-source');
  const root = graph.nodes.find(n => n.id === input.rootId);
  const callee = graph.nodes.find(n => n.id === input.calleeId);
  if (!root || !callee || root.id === callee.id
    || !sourceCovered(graph, root, sourcePath) || !sourceCovered(graph, callee, sourcePath)) {
    return unproven('ambiguous-or-incomplete-function-identity');
  }
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) as
    ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  if (file.parseDiagnostics?.length) return unproven('source-parse-failure');
  const rootFn = declaredFunction(file, root), calleeFn = declaredFunction(file, callee);
  if (!rootFn?.body || !calleeFn?.body || !root.name || !callee.name) {
    return unproven('callable-body-not-uniquely-located');
  }
  const inputs = new Map(Object.entries(input.bindings));
  let visitCount = 0;
  type Outcome = { kind: 'return'; value: boolean } | { kind: 'continue' } | { kind: 'unknown'; reason: string };
  const uncertain = (reason: string): Outcome => ({kind: 'unknown', reason});
  const trace = (kind: Trace['kind'], node: ts.Node): Trace => ({
    kind, file: sourcePath, line: lineOf(node, file), expressionDigest: digest(node.getText(file)),
  });
  const walk = (stmts: readonly ts.Statement[], owner: GraphNode, locals: Map<string, Primitive>, depth: number): Outcome => {
    if (depth > 2) return uncertain('call-depth-limit');
    for (const stmt of stmts) {
      if (++visitCount > 100 || guards.length > 30 || responseCalls.length > 30) {
        return uncertain('bounded-statement-or-effect-budget');
      }
      if (ts.isBlock(stmt)) {
        const outcome = walk(stmt.statements, owner, locals, depth);
        if (outcome.kind !== 'continue') return outcome;
      } else if (ts.isVariableStatement(stmt)) {
        if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) return uncertain('mutable-local-variable');
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer || locals.has(d.name.text)) {
            return uncertain('unbound-local-initializer');
          }
          const value = expression(d.initializer, file, locals);
          if (value === UNKNOWN) return uncertain('unresolved-external-call-or-initializer');
          locals.set(d.name.text, value);
        }
      } else if (ts.isIfStatement(stmt)) {
        const value = expression(stmt.expression, file, locals);
        if (value === UNKNOWN) return uncertain('unresolved-branch-or-configuration');
        guards.push(trace('guard', stmt.expression));
        const branch = Boolean(value) ? stmt.thenStatement : stmt.elseStatement;
        if (branch) {
          const result = walk(statementList(branch), owner, new Map(locals), depth);
          if (result.kind !== 'continue') return result;
        }
      } else if (ts.isExpressionStatement(stmt)) {
        if (!ts.isCallExpression(stmt.expression)
          || !ts.isPropertyAccessExpression(stmt.expression.expression)
          || !ts.isIdentifier(stmt.expression.expression.expression)
          || stmt.expression.expression.expression.text !== 'res'
          || !['writeHead', 'end'].includes(stmt.expression.expression.name.text)) {
          return uncertain('unmodelled-expression-effect');
        }
        responseCalls.push(trace('call', stmt.expression));
      } else if (ts.isReturnStatement(stmt) && stmt.expression) {
        returns.push(trace('return', stmt));
        const ret = stmt.expression;
        if (ts.isCallExpression(ret) && ts.isIdentifier(ret.expression)
          && ret.expression.text === callee.name && owner.id === root.id) {
          if (!resolvedCall(graph, owner, callee, sourcePath, lineOf(ret, file))) {
            return uncertain('callsite-not-resolved-by-canonical-graph');
          }
          const params = calleeFn.parameters.map(p => ts.isIdentifier(p.name) ? p.name.text : null);
          if (params.some(p => !p) || ret.arguments.length !== params.length
            || ret.arguments.some((a, i) => !ts.isIdentifier(a)
              || a.text !== params[i])) {
            return uncertain('argument-parameter-mapping-unproven');
          }
          chain.push(callee.id);
          return walk(calleeFn.body!.statements, callee, new Map(inputs), depth + 1);
        }
        const value = expression(ret, file, locals);
        return typeof value === 'boolean' ? {kind:'return',value}
          : uncertain('unresolved-return-value');
      } else {
        return uncertain('unsupported-control-construct');
      }
    }
    return {kind:'continue'};
  };
  chain.push(root.id);
  const result = walk(rootFn.body.statements, root, new Map(inputs), 0);
  if (result.kind === 'unknown') return unproven(result.reason);
  if (result.kind !== 'return') return unproven('function-fallthrough-without-boolean-return');
  if (chain.length !== 2) return unproven('two-hop-call-not-reached-under-bindings');
  return {...base,status:'established-normal-path',reason:'exact-resolved-source-conditional-return',
    value: result.value};
}

/** A specific HTTP callsite guard: false authorization gives an early return. */
export function verifyGuardedEarlyReturn(input: {
  graph: IntelligenceGraph;
  source: string;
  sourcePath: string;
  guardLine: number;
  callableId: string;
  authorizationResult: boolean;
}): { status:'established-normal-path' | 'unproven'; earlyReturn: boolean | null; reason:string; evidence:string[] } {
  const { graph, source, sourcePath, guardLine, callableId } = input;
  const fail=(reason:string) => ({status:'unproven' as const, earlyReturn:null,reason,evidence:[]});
  if (!Number.isSafeInteger(guardLine) || guardLine < 1 || !graph.repositoryRevision
    || !graph.coverage?.files?.some(f=>f.path===sourcePath&&f.status==='complete')) return fail('incomplete-callsite-source');
  const target=graph.nodes.find(n=>n.id===callableId);
  if (!target || target.kind!=='function') return fail('callable-not-resolved');
  const link=graph.edges.some(e=>e.from==='file:'+sourcePath&&e.to===callableId
    && e.kind==='references-symbol'&&e.status==='resolved'
    && e.strategy==='typescript-checker-symbol.v1'
    && e.evidence.some(s=>s.startsWith(sourcePath+':'+guardLine+':')));
  if (!link) return fail('guard-not-bound-by-compiler');
  const file=ts.createSourceFile(sourcePath,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS) as
    ts.SourceFile & { parseDiagnostics?:readonly ts.Diagnostic[] };
  if(file.parseDiagnostics?.length)return fail('source-parse-failure');
  const matched:ts.IfStatement[]=[];
  const visit=(n:ts.Node):void=>{
    if (ts.isIfStatement(n)&&lineOf(n,file)===guardLine) matched.push(n);
    ts.forEachChild(n,visit);
  };
  visit(file);
  if(matched.length!==1)return fail('guard-line-not-unique');
  const stmt=matched[0]!;
  const cond=stmt.expression;
  if (!ts.isPrefixUnaryExpression(cond)||cond.operator!==ts.SyntaxKind.ExclamationToken
    ||!ts.isCallExpression(cond.operand)||!ts.isIdentifier(cond.operand.expression)
    ||cond.operand.expression.text!==target.name
    ||cond.operand.arguments.length!==2
    ||cond.operand.arguments.some((arg,i)=>!ts.isIdentifier(arg)
      ||arg.text!==['req','res'][i])) return fail('guard-shape-not-established');
  if(!ts.isReturnStatement(stmt.thenStatement)||stmt.thenStatement.expression
    ||stmt.elseStatement)return fail('early-exit-shape-not-established');
  return {status:'established-normal-path',earlyReturn:!input.authorizationResult,
    reason:'guard-condition-evaluated-with-exact-compiler-bound-call',
    evidence:[sourcePath+':'+guardLine,digest(stmt.getText(file))]};
}
