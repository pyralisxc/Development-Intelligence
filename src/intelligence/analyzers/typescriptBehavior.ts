import ts from 'typescript';

function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node;
  while (current && (
    ts.isAsExpression(current)
    || ts.isSatisfiesExpression?.(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)
  )) current = current.expression;
  return current;
}

export function templateTarget(node: ts.Expression | undefined, sourceFile: ts.SourceFile): { text: string; dynamic: boolean } | undefined {
  const current = unwrap(node);
  if (!current) return undefined;
  if (ts.isStringLiteralLike(current)) return { text: current.text, dynamic: false };
  if (ts.isNoSubstitutionTemplateLiteral(current)) return { text: current.text, dynamic: false };
  if (!ts.isTemplateExpression(current)) return undefined;
  let text = current.head.text;
  for (const span of current.templateSpans) text += `\${${span.expression.getText(sourceFile)}}${span.literal.text}`;
  return { text, dynamic: true };
}

function callIdentifier(expression: ts.Expression): string | undefined {
  const current = unwrap(expression) ?? expression;
  if (ts.isCallExpression(current)) {
    if (ts.isIdentifier(current.expression)) return current.expression.text;
    if (ts.isPropertyAccessExpression(current.expression)) return current.expression.name.text;
  }
  if (ts.isVoidExpression(current)) return callIdentifier(current.expression);
  return undefined;
}

export function callbackIdentifier(expression: ts.Expression): string | undefined {
  const current = unwrap(expression) ?? expression;
  if (ts.isIdentifier(current)) return current.text;
  if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) return undefined;
  if (ts.isBlock(current.body)) {
    for (const statement of current.body.statements) {
      if (ts.isExpressionStatement(statement)) {
        const identifier = callIdentifier(statement.expression);
        if (identifier) return identifier;
      }
      if (ts.isReturnStatement(statement) && statement.expression) {
        const identifier = callIdentifier(statement.expression);
        if (identifier) return identifier;
      }
    }
    return undefined;
  }
  return callIdentifier(current.body);
}

export function destructuredParameterNames(parameters: readonly ts.ParameterDeclaration[]): Set<string> {
  const names = new Set<string>();
  for (const parameter of parameters) {
    if (!ts.isObjectBindingPattern(parameter.name)) continue;
    for (const element of parameter.name.elements) if (ts.isIdentifier(element.name)) names.add(element.name.text);
  }
  return names;
}

export function callLeafName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}
