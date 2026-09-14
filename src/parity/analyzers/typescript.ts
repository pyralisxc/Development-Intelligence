import ts from 'typescript';
import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { normalizeName, observation, resolution, stringifyValue } from '../model.js';
import type { Observation } from '../../types.js';

const UI_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'form', 'label']);

export function analyzeTypeScript(context: AnalyzeContext): AnalyzeResult {
  const sourceFile = ts.createSourceFile(
    context.locatorBase,
    context.text,
    ts.ScriptTarget.Latest,
    true,
    context.locatorBase.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const observations: Observation[] = [];
  const resolutions = [] as ReturnType<typeof resolution>[];
  const symbols = new Map<string, Observation>();
  const pendingHandlers: Array<{ ui: Observation; handler: string; line: number }> = [];
  const pendingReferences: Array<{ from: Observation; targetName: string; kind: string; line: number }> = [];
  const functionStack: Observation[] = [];

  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const locator = (node: ts.Node, suffix = '') => `${context.locatorBase}:${lineOf(node)}${suffix}`;

  const addSymbol = (name: string, kind: string, node: ts.Node) => {
    const obs = observation({
      sourceId: context.source.id,
      kind,
      locator: locator(node),
      name,
      field: 'identifier',
      value: name,
    });
    observations.push(obs);
    if (!symbols.has(name)) symbols.set(name, obs);
    return obs;
  };

  const scalar = (node: ts.Expression): unknown | undefined => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.map(element => ts.isExpression(element) ? scalar(element) : undefined);
      if (values.every(value => value !== undefined)) return values;
    }
    return undefined;
  };

  const flattenObject = (owner: Observation, object: ts.ObjectLiteralExpression, prefix = '') => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))) continue;
      const key = ts.isIdentifier(property.name) ? property.name.text : property.name.text;
      const field = prefix ? `${prefix}.${key}` : key;
      const value = scalar(property.initializer);
      if (value !== undefined) {
        const obs = observation({
          sourceId: context.source.id,
          kind: 'declared-field',
          locator: locator(property, `:${field}`),
          field,
          name: key,
          value,
        });
        observations.push(obs);
        resolutions.push(resolution({
          from: owner.id,
          to: obs.id,
          kind: 'declares',
          strategy: 'syntax',
          confidence: 1,
          status: 'resolved',
          evidence: [`${context.locatorBase}:${lineOf(property)}`],
        }));
      } else if (ts.isObjectLiteralExpression(property.initializer) && prefix.split('.').length < 3) {
        flattenObject(owner, property.initializer, field);
      }
    }
  };

  const functionOwner = () => functionStack.at(-1) ?? null;

  const visit = (node: ts.Node): void => {
    let pushed = false;
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionStack.push(addSymbol(node.name.text, 'function', node));
      pushed = true;
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      functionStack.push(addSymbol(node.name.text, 'method', node));
      pushed = true;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functionStack.push(addSymbol(node.name.text, 'function', node));
      pushed = true;
    } else if (ts.isClassDeclaration(node) && node.name) {
      addSymbol(node.name.text, 'class', node);
    } else if (ts.isInterfaceDeclaration(node)) {
      addSymbol(node.name.text, 'interface', node);
    } else if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node.name.text, 'type', node);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const owner = symbols.get(node.name.text) ?? addSymbol(node.name.text, 'declaration', node);
      flattenObject(owner, node.initializer);
    }

    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const owner = functionOwner();
      if (owner) flattenObject(owner, node.expression);
    }
    if (ts.isArrowFunction(node) && ts.isObjectLiteralExpression(node.body)) {
      const owner = functionOwner();
      if (owner) flattenObject(owner, node.body);
    }

    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tagName = opening.tagName.getText(sourceFile);
      if (UI_TAGS.has(tagName.toLowerCase())) {
        const attrs = opening.attributes.properties.filter(ts.isJsxAttribute);
        const aria = attrs.find(attr => attr.name.getText(sourceFile) === 'aria-label');
        const href = attrs.find(attr => attr.name.getText(sourceFile) === 'href');
        const onClick = attrs.find(attr => ['onClick', 'onSubmit', 'onSelect', 'onChange'].includes(attr.name.getText(sourceFile)));
        let label: string | undefined;
        if (aria?.initializer && ts.isStringLiteralLike(aria.initializer)) label = aria.initializer.text;
        if (!label && ts.isJsxElement(node)) {
          const text = node.children.filter(ts.isJsxText).map(child => child.text).join(' ').replace(/\s+/g, ' ').trim();
          if (text) label = text;
        }
        const hrefValue = href?.initializer && ts.isStringLiteralLike(href.initializer) ? href.initializer.text : undefined;
        const ui = observation({
          sourceId: context.source.id,
          kind: 'ui-element',
          locator: locator(opening, `:${tagName}`),
          name: label ?? tagName,
          field: 'element',
          value: { tag: tagName, label: label ?? null, href: hrefValue ?? null },
        });
        observations.push(ui);
        if (hrefValue) {
          const route = observation({
            sourceId: context.source.id,
            kind: 'route-reference',
            locator: locator(opening, ':href'),
            name: hrefValue,
            field: 'href',
            value: hrefValue,
          });
          observations.push(route);
          resolutions.push(resolution({
            from: ui.id,
            to: route.id,
            kind: 'links_to',
            strategy: 'syntax',
            confidence: 1,
            status: 'resolved',
            evidence: [`${context.locatorBase}:${lineOf(opening)}`],
          }));
        }
        if (onClick?.initializer && ts.isJsxExpression(onClick.initializer) && onClick.initializer.expression) {
          const expression = onClick.initializer.expression;
          let handler: string | undefined;
          if (ts.isIdentifier(expression)) handler = expression.text;
          else if (ts.isArrowFunction(expression) && ts.isCallExpression(expression.body) && ts.isIdentifier(expression.body.expression)) handler = expression.body.expression.text;
          if (handler) pendingHandlers.push({ ui, handler, line: lineOf(onClick) });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const owner = functionOwner();
      const expressionText = node.expression.getText(sourceFile);
      if (expressionText === 'fetch' && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
        const url = node.arguments[0]!.text;
        let method = 'GET';
        const init = node.arguments[1];
        if (init && ts.isObjectLiteralExpression(init)) {
          const methodProp = init.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'method');
          if (methodProp && ts.isPropertyAssignment(methodProp) && ts.isStringLiteralLike(methodProp.initializer)) method = methodProp.initializer.text.toUpperCase();
        }
        const call = observation({
          sourceId: context.source.id,
          kind: 'http-call',
          locator: locator(node, ':fetch'),
          name: `${method} ${url}`,
          field: 'http',
          value: { method, url },
        });
        observations.push(call);
        if (owner) resolutions.push(resolution({
          from: owner.id,
          to: call.id,
          kind: 'invokes',
          strategy: 'syntax',
          confidence: 1,
          status: 'resolved',
          evidence: [`${context.locatorBase}:${lineOf(node)}`],
        }));
      }

      if ((expressionText.endsWith('.assign') || expressionText.endsWith('.replace')) && /location/.test(expressionText)) {
        const target = node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : node.arguments[0]?.getText(sourceFile) ?? null;
        const nav = observation({
          sourceId: context.source.id,
          kind: 'navigation-call',
          locator: locator(node, ':navigation'),
          name: String(target ?? expressionText),
          field: 'navigation',
          value: { operation: expressionText, target },
        });
        observations.push(nav);
        if (owner) resolutions.push(resolution({ from: owner.id, to: nav.id, kind: 'invokes', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(node)}`] }));
      }

      if (expressionText.endsWith('.registerTool') && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const name = node.arguments[0].text;
        const tool = observation({ sourceId: context.source.id, kind: 'mcp-tool', locator: locator(node, ':mcp'), name, field: 'tool', value: name });
        observations.push(tool);
        const config = node.arguments[1];
        if (config && ts.isObjectLiteralExpression(config)) flattenObject(tool, config);
      }

      if (owner && ts.isIdentifier(node.expression)) {
        pendingReferences.push({ from: owner, targetName: node.expression.text, kind: 'calls', line: lineOf(node) });
      }
    }

    ts.forEachChild(node, visit);
    if (pushed) functionStack.pop();
  };

  visit(sourceFile);

  for (const pending of pendingHandlers) {
    const target = symbols.get(pending.handler);
    if (target) {
      resolutions.push(resolution({
        from: pending.ui.id,
        to: target.id,
        kind: 'handled_by',
        strategy: 'syntax',
        confidence: 1,
        status: 'resolved',
        evidence: [`${context.locatorBase}:${pending.line}`],
      }));
    } else {
      resolutions.push(resolution({
        from: pending.ui.id,
        to: null,
        kind: 'handled_by',
        strategy: 'unresolved',
        confidence: null,
        status: 'unresolved',
        evidence: [`handler identifier ${pending.handler} was not resolved in ${context.locatorBase}:${pending.line}`],
      }));
    }
  }

  for (const pending of pendingReferences) {
    const target = symbols.get(pending.targetName);
    if (target && target.id !== pending.from.id) {
      resolutions.push(resolution({ from: pending.from.id, to: target.id, kind: pending.kind, strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${pending.line}`] }));
    }
  }

  return { observations, resolutions };
}
