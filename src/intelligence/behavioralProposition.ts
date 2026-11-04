import ts from 'typescript';
import type { GraphNode, IntelligenceGraph } from '../types.js';
import { getCodeSnippet } from './code.js';

const BEHAVIOR_EVALUATOR_VERSION = '1.0.0';

interface PropositionEvidence {
  file: string;
  line: number;
  text: string;
  kind: 'condition' | 'effect' | 'outcome' | 'sequence';
}

interface BehavioralProposition {
  kind: 'conditional-accumulator-outcome' | 'conditional-value-selection' | 'sequential-await-fallback';
  status: 'supported';
  statement: string;
  conditions: string[];
  evidence: PropositionEvidence[];
}

function sourceFileFromLocator(locator: string): string {
  return locator.replace(/^file:\/\//u, '').replace(/:\d+(?::\d+)?$/u, '');
}

function explicitSubjectCandidates(graph: IntelligenceGraph, question: string, scope?: string): GraphNode[] {
  const normalizedScope = scope?.replace(/^\.\//u, '');
  const eligible = graph.nodes.filter(node => {
    if (!['function', 'method'].includes(node.kind)) return false;
    if (!normalizedScope) return true;
    const file = sourceFileFromLocator(node.locator).replace(/^\.\//u, '');
    return file === normalizedScope || file.startsWith(normalizedScope.replace(/\/$/u, '') + '/');
  });
  const mentioned = eligible.filter(node => {
    const name = node.name?.trim();
    if (!name || name.length < 3) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}([^\\p{L}\\p{N}_]|$)`, 'iu').test(question);
  });
  const grammaticalName = question.match(/\b(?:does|do|is|are|can|will|would)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/iu)?.[1];
  if (grammaticalName) {
    const grammatical = eligible.filter(node => node.name === grammaticalName);
    if (grammatical.length) return grammatical.sort((a, b) => a.id.localeCompare(b.id));
  }
  const exactIds = eligible.filter(node => question.includes(node.id));
  const selected = exactIds.length ? exactIds : mentioned;
  return selected.sort((a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0) || a.id.localeCompare(b.id));
}

function nodeLine(source: ts.SourceFile, node: ts.Node, startLine: number): number {
  return startLine + source.getLineAndCharacterOfPosition(node.getStart(source)).line;
}

function evidence(source: ts.SourceFile, node: ts.Node, file: string, startLine: number, kind: PropositionEvidence['kind']): PropositionEvidence {
  return { file, line: nodeLine(source, node, startLine), text: node.getText(source), kind };
}

function functionLike(root: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  let found: ts.FunctionLikeDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(root) === name) {
      found = node;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function descendants<T extends ts.Node>(node: ts.Node, guard: (value: ts.Node) => value is T): T[] {
  const values: T[] = [];
  const visit = (value: ts.Node): void => {
    if (guard(value)) values.push(value);
    ts.forEachChild(value, visit);
  };
  visit(node);
  return values;
}

function functionBodyDescendants<T extends ts.Node>(fn: ts.FunctionLikeDeclaration, guard: (value: ts.Node) => value is T): T[] {
  if (!fn.body) return [];
  const values: T[] = [];
  const visit = (value: ts.Node): void => {
    if (guard(value)) values.push(value);
    if (value !== fn.body && ts.isFunctionLike(value)) return;
    ts.forEachChild(value, visit);
  };
  visit(fn.body);
  return values;
}

function literalText(node: ts.Expression, source: ts.SourceFile): string | null {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (node.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.getText(source);
  return null;
}

function accumulatorPropositions(source: ts.SourceFile, fn: ts.FunctionLikeDeclaration, file: string, startLine: number): BehavioralProposition[] {
  if (!fn.body) return [];
  const pushes = functionBodyDescendants(fn, ts.isIfStatement).flatMap(branch => descendants(branch.thenStatement, ts.isCallExpression)
    .filter(call => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'push' && call.arguments.length === 1)
    .map(call => {
      const access = call.expression as ts.PropertyAccessExpression;
      const value = literalText(call.arguments[0]!, source);
      return value === null ? null : { branch, call, receiver: access.expression.getText(source), value };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item)));
  const results: BehavioralProposition[] = [];
  for (const returned of functionBodyDescendants(fn, ts.isReturnStatement)) {
    if (!returned.expression || !ts.isObjectLiteralExpression(returned.expression)) continue;
    for (const property of returned.expression.properties) {
      if (!ts.isPropertyAssignment(property) || property.name.getText(source).replace(/["']/gu, '') !== 'eligible') continue;
      const expression = property.initializer;
      if (!ts.isBinaryExpression(expression) || !['===', '=='].includes(expression.operatorToken.getText(source))) continue;
      const length = ts.isPropertyAccessExpression(expression.left) && expression.left.name.text === 'length' ? expression.left : null;
      if (!length || literalText(expression.right, source) !== '0') continue;
      const receiver = length.expression.getText(source);
      for (const push of pushes.filter(item => item.receiver === receiver)) {
        const condition = push.branch.expression.getText(source);
        results.push({
          kind: 'conditional-accumulator-outcome',
          status: 'supported',
          statement: `When ${condition}, ${receiver} receives ${JSON.stringify(push.value)}; the returned eligible value (${expression.getText(source)}) is therefore false on that path.`,
          conditions: [condition, `${receiver}.push completes normally`, `${receiver}.length === 0 determines eligible`],
          evidence: [
            evidence(source, push.branch.expression, file, startLine, 'condition'),
            evidence(source, push.call, file, startLine, 'effect'),
            evidence(source, property, file, startLine, 'outcome'),
          ],
        });
      }
    }
  }
  return results;
}

function conditionalValuePropositions(source: ts.SourceFile, fn: ts.FunctionLikeDeclaration, file: string, startLine: number): BehavioralProposition[] {
  if (!fn.body) return [];
  return functionBodyDescendants(fn, ts.isConditionalExpression).flatMap(expression => {
    const whenTrue = literalText(expression.whenTrue, source);
    const whenFalse = literalText(expression.whenFalse, source);
    if (whenTrue === null || whenFalse === null) return [];
    const condition = expression.condition.getText(source);
    return [{
      kind: 'conditional-value-selection' as const,
      status: 'supported' as const,
      statement: `${condition} selects ${expression.whenTrue.getText(source)} when truthy and ${expression.whenFalse.getText(source)} otherwise.`,
      conditions: [condition, 'template substitutions and called expressions are evaluated at runtime'],
      evidence: [evidence(source, expression, file, startLine, 'outcome')],
    }];
  });
}

function awaitedCall(expression: ts.Expression | undefined): ts.CallExpression | null {
  const value = expression && ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  return value && ts.isAwaitExpression(value) && ts.isCallExpression(value.expression) ? value.expression : null;
}

function unwrappedExpression(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  return value;
}

function sequentialFallbackPropositions(source: ts.SourceFile, fn: ts.FunctionLikeDeclaration, file: string, startLine: number): BehavioralProposition[] {
  if (!fn.body || !ts.isBlock(fn.body)) return [];
  const results: BehavioralProposition[] = [];
  for (let index = 0; index < fn.body.statements.length; index += 1) {
    const statement = fn.body.statements[index]!;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const first = awaitedCall(declaration.initializer);
      if (!first) continue;
      const later = fn.body.statements.slice(index + 1).find(ts.isReturnStatement);
      if (!later?.expression || !ts.isBinaryExpression(later.expression) || later.expression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) continue;
      if (!ts.isIdentifier(later.expression.left) || later.expression.left.text !== declaration.name.text) continue;
      const retryExpression = unwrappedExpression(later.expression.right);
      if (!ts.isConditionalExpression(retryExpression)) continue;
      const retry = retryExpression;
      const second = awaitedCall(retry.whenTrue);
      if (!second || first.expression.getText(source) !== second.expression.getText(source)) continue;
      results.push({
        kind: 'sequential-await-fallback',
        status: 'supported',
        statement: `${declaration.name.text} awaits ${first.getText(source)} before the return expression; ${second.getText(source)} is evaluated only when ${declaration.name.text} is nullish and ${retry.condition.getText(source)} is truthy. If the first await throws, the later fallback expression is not reached.`,
        conditions: ['ordinary sequential JavaScript evaluation', `${declaration.name.text} is the value produced by the first await`, retry.condition.getText(source)],
        evidence: [
          evidence(source, statement, file, startLine, 'sequence'),
          evidence(source, later, file, startLine, 'outcome'),
        ],
      });
    }
  }
  return results;
}

function unsupportedConstructs(source: ts.SourceFile, fn: ts.FunctionLikeDeclaration): string[] {
  if (!fn.body) return ['selected subject has no inspectable function body'];
  const unknowns = new Set<string>();
  for (const node of functionBodyDescendants(fn, (value): value is ts.Node => true)) {
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) unknowns.add('loop effects are not evaluated');
    if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(node.argumentExpression)) unknowns.add('dynamic property access remains unresolved');
    if (ts.isCallExpression(node) && (ts.isFunctionExpression(node.expression) || ts.isArrowFunction(node.expression))) unknowns.add('opaque callback effects remain unresolved');
  }
  return [...unknowns].sort();
}

export function isConditionalBehaviorQuestion(question: string): boolean {
  const conditional = /\b(?:if|when|unless|otherwise|fallback|retry|throws?|error|always|never)\b|\bonly\s+after\b|\bnot\s+reached\b/iu.test(question);
  const explicitFunctionSubject = /\b(?:does|do|can|will|would)\s+[A-Za-z_$][A-Za-z0-9_$]*\b/iu.test(question);
  return conditional && explicitFunctionSubject;
}

export async function evaluateBehavioralProposition(input: {
  project: string;
  graph: IntelligenceGraph;
  question: string;
  scope?: string;
  subject?: GraphNode;
}): Promise<Record<string, unknown> | null> {
  if (!isConditionalBehaviorQuestion(input.question)) return null;
  const candidates = input.subject ? [input.subject] : explicitSubjectCandidates(input.graph, input.question, input.scope);
  const uniqueIds = [...new Set(candidates.map(item => item.id))];
  if (uniqueIds.length !== 1) {
    return {
      evaluatorVersion: BEHAVIOR_EVALUATOR_VERSION,
      verdict: 'unproven',
      subject: null,
      candidates: candidates.slice(0, 12).map(node => ({ id: node.id, name: node.name ?? node.id, kind: node.kind, locator: node.locator })),
      propositions: [],
      unknowns: [candidates.length ? 'multiple explicit function identities match the question' : 'no explicit function identity was established'],
    };
  }
  const subject = candidates[0]!;
  const snippet = await getCodeSnippet({ project: input.project, graphId: input.graph.graphId, node: subject.id, context: 100 }) as any;
  if (snippet.ambiguous || !Array.isArray(snippet.lines)) return null;
  const sourceText = snippet.lines.map((line: any) => String(line.text ?? '')).join('\n');
  const file = String(snippet.file ?? sourceFileFromLocator(subject.locator));
  const parsed = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, /\.tsx$/iu.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const fn = functionLike(parsed, subject.name ?? '');
  if (!fn) {
    return {
      evaluatorVersion: BEHAVIOR_EVALUATOR_VERSION,
      verdict: 'unproven',
      subject: { id: subject.id, name: subject.name ?? subject.id, kind: subject.kind, locator: subject.locator },
      propositions: [],
      unknowns: ['the exact function body was not available inside the bounded source window'],
    };
  }
  const startLine = Number(snippet.startLine ?? 1);
  const propositions = [
    ...accumulatorPropositions(parsed, fn, file, startLine),
    ...conditionalValuePropositions(parsed, fn, file, startLine),
    ...sequentialFallbackPropositions(parsed, fn, file, startLine),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.statement.localeCompare(b.statement));
  const incident = input.graph.edges.filter(edge => edge.from === subject.id || edge.to === subject.id)
    .map(edge => ({ id: edge.id, kind: edge.kind, status: edge.status, from: edge.from, to: edge.to, evidenceIds: [...(edge.evidenceIds ?? [])].sort() }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const externalBoundary = /\b(?:browser|network|database|provider|delivery|delivered|duplicate|authoritative|actually|runtime)\b/iu.test(input.question);
  const unknowns = unsupportedConstructs(parsed, fn);
  if (externalBoundary) unknowns.push('source control flow does not prove external or runtime outcomes');
  if (!propositions.length) unknowns.push('no supported local conditional proposition matched the bounded function body');
  return {
    evaluatorVersion: BEHAVIOR_EVALUATOR_VERSION,
    graphId: input.graph.graphId,
    revision: input.graph.repositoryRevision,
    analyzerVersion: input.graph.analyzerVersion,
    question: input.question,
    subject: { id: subject.id, name: subject.name ?? subject.id, kind: subject.kind, locator: subject.locator },
    verdict: propositions.length ? (externalBoundary || unknowns.length ? 'partial' : 'supported') : 'unproven',
    propositions,
    relationships: incident,
    unknowns: [...new Set(unknowns)].sort(),
    boundary: { codeDerived: true, runtimeObserved: false, externalEffectsProven: false, persisted: false },
  };
}
