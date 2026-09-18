import ts from 'typescript';
import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { evidenceRecord, observation, redactSensitiveValue, resolution, semanticEntity, semanticRelationship } from '../model.js';
import type { EvidenceRecord, Observation } from '../../types.js';
import { callbackIdentifier, callLeafName, destructuredParameterNames, templateTarget } from './typescriptBehavior.js';

const UI_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'form', 'label']);
const SEMANTIC_DECLARATION_FIELD = 'developmentIntelligence';

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

function staticString(node: ts.Expression | undefined): string | undefined {
  const current = unwrap(node);
  return current && ts.isStringLiteralLike(current) ? current.text : undefined;
}

function scalar(node: ts.Expression): unknown | undefined {
  const current = unwrap(node) ?? node;
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isNumericLiteral(current)) return Number(current.text);
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (current.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(current)) {
    const values = current.elements.map(element => ts.isExpression(element) ? scalar(element) : undefined);
    if (values.every(value => value !== undefined)) return values;
  }
  return undefined;
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function objectProperties(node: ts.Expression | undefined): Map<string, ts.Expression> {
  const current = unwrap(node);
  if (!current || !ts.isObjectLiteralExpression(current)) return new Map();
  const output = new Map<string, ts.Expression>();
  for (const property of current.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (!name) continue;
    output.set(name, ts.isPropertyAssignment(property) ? property.initializer : property.name);
  }
  return output;
}

function semanticId(kind: string, id: string): string {
  return id.startsWith(`${kind}:`) ? id : `${kind}:${id}`;
}

function safeIdentityPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.@/\-[\]]+/g, '_');
}

function hasBody(node: ts.Node): boolean {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) ? Boolean(node.body) : false;
}

function sameOverloadFamily(left: ts.Node, right: ts.Node): boolean {
  const functions = ts.isFunctionDeclaration(left) && ts.isFunctionDeclaration(right);
  const methods = ts.isMethodDeclaration(left) && ts.isMethodDeclaration(right);
  return (functions || methods) && (!hasBody(left) || !hasBody(right));
}

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
  const evidence: EvidenceRecord[] = [];
  const symbols = new Map<string, Observation[]>();
  const symbolsByIdentity = new Map<string, { observation: Observation; declaration: ts.Node }>();
  const identityCollisions = new Map<string, number>();
  const pendingHandlers: Array<{ ui: Observation; handler: string; line: number; ownerId: string | null }> = [];
  const pendingReferences: Array<{ from: Observation; targetName: string; kind: string; line: number }> = [];
  const functionStack: Observation[] = [];
  const scopeStack: string[] = [];
  const componentPropsByOwner = new Map<string, Set<string>>();
  const stateSetters = new Map<string, { state: string; binding: Observation }>();
  const routerBindings = new Set<string>();

  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const locator = (node: ts.Node, suffix = '') => `${context.locatorBase}:${lineOf(node)}${suffix}`;

  const addSymbol = (name: string, kind: string, node: ts.Node, identityScope?: string) => {
    const qualified = [...scopeStack, ...(identityScope ? [identityScope] : []), name].join('.');
    const baseId = `symbol:${context.locatorBase}#${safeIdentityPart(kind)}:${safeIdentityPart(qualified)}`;
    const existing = symbolsByIdentity.get(baseId);
    if (existing && sameOverloadFamily(existing.declaration, node)) return existing.observation;

    const collision = existing ? (identityCollisions.get(baseId) ?? 1) + 1 : 1;
    identityCollisions.set(baseId, collision);
    const id = existing ? `${baseId}~${collision}` : baseId;
    const obs = observation({
      id,
      sourceId: context.source.id,
      kind,
      locator: locator(node),
      name,
      field: 'identifier',
      value: name,
      layer: 'structural',
      checkpoint: false,
    });
    observations.push(obs);
    symbolsByIdentity.set(id, { observation: obs, declaration: node });
    if (!existing) symbolsByIdentity.set(baseId, { observation: obs, declaration: node });
    const bucket = symbols.get(name) ?? [];
    bucket.push(obs);
    symbols.set(name, bucket);
    return obs;
  };

  const flattenObject = (owner: Observation, object: ts.ObjectLiteralExpression, prefix = '') => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))) continue;
      const key = property.name.text;
      const field = prefix ? `${prefix}.${key}` : key;
      const value = scalar(property.initializer);
      if (value !== undefined) {
        const redacted = redactSensitiveValue(field, value);
        const obs = observation({
          sourceId: context.source.id,
          kind: 'declared-field',
          locator: locator(property, `:${field}`),
          field,
          name: key,
          value: redacted.value,
          ...(redacted.raw ? { raw: redacted.raw } : {}),
          layer: 'representation',
          checkpoint: false,
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
          layer: 'representation',
          checkpoint: false,
        }));
      } else if (ts.isObjectLiteralExpression(unwrap(property.initializer) ?? property.initializer) && prefix.split('.').length < 3) {
        flattenObject(owner, unwrap(property.initializer)! as ts.ObjectLiteralExpression, field);
      }
    }
  };

  const functionOwner = () => functionStack.at(-1) ?? null;

  const parseSemanticDeclaration = (outer: ts.ObjectLiteralExpression): void => {
    const outerProps = objectProperties(outer);
    const semanticExpression = outerProps.get(SEMANTIC_DECLARATION_FIELD);
    const semanticObject = unwrap(semanticExpression);
    if (!semanticObject || !ts.isObjectLiteralExpression(semanticObject)) return;
    const props = objectProperties(semanticObject);
    const kind = staticString(props.get('kind'));
    const declaredId = staticString(props.get('id'));
    if (!kind || !declaredId) return;
    const entityId = semanticId(kind, declaredId);
    const label = staticString(props.get('label')) ?? declaredId;
    const evidenceItem = evidenceRecord({
      sourceId: context.source.id,
      kind: 'semantic-declaration',
      locator: locator(semanticObject),
      message: `Declared current ${kind} ${entityId}`,
      field: SEMANTIC_DECLARATION_FIELD,
      value: { kind, id: entityId },
    });
    evidence.push(evidenceItem);

    const value: Record<string, unknown> = { id: entityId, kind, label };
    for (const [key, expression] of props) {
      if (['id', 'kind', 'label', 'relationships'].includes(key)) continue;
      const parsed = scalar(expression);
      if (parsed !== undefined) value[key] = redactSensitiveValue(key, parsed).value;
    }
    observations.push(semanticEntity({
      id: entityId,
      sourceId: context.source.id,
      kind,
      locator: locator(semanticObject),
      name: label,
      value,
      evidenceIds: [evidenceItem.id],
      tags: ['declared'],
    }));

    const relationshipsExpression = unwrap(props.get('relationships'));
    if (relationshipsExpression && ts.isArrayLiteralExpression(relationshipsExpression)) {
      for (const item of relationshipsExpression.elements) {
        if (!ts.isExpression(item)) continue;
        const relationshipObject = unwrap(item);
        if (!relationshipObject || !ts.isObjectLiteralExpression(relationshipObject)) continue;
        const relationshipProps = objectProperties(relationshipObject);
        const relationshipKind = staticString(relationshipProps.get('kind'));
        const target = staticString(relationshipProps.get('to'));
        if (!relationshipKind || !target) continue;
        resolutions.push(semanticRelationship({
          from: entityId,
          to: target,
          kind: relationshipKind,
          evidence: [locator(relationshipObject)],
          evidenceIds: [evidenceItem.id],
          strategy: 'source-adjacent-declaration',
        }));
      }
    }
  };

  const visit = (node: ts.Node): void => {
    let pushedFunction = false;
    let pushedScope = false;

    if (ts.isFunctionDeclaration(node) && node.name) {
      const symbol = addSymbol(node.name.text, 'function', node);
      const props = destructuredParameterNames(node.parameters);
      if (props.size) componentPropsByOwner.set(symbol.id, props);
      functionStack.push(symbol);
      scopeStack.push(node.name.text);
      pushedFunction = true;
      pushedScope = true;
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const memberScope = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ? 'static' : 'instance';
      const symbol = addSymbol(node.name.text, 'method', node, memberScope);
      functionStack.push(symbol);
      scopeStack.push(`${memberScope}:${node.name.text}`);
      pushedFunction = true;
      pushedScope = true;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const parentFunction = functionOwner();
      const nested = addSymbol(node.name.text, 'function', node);
      const props = destructuredParameterNames(node.initializer.parameters);
      if (props.size) componentPropsByOwner.set(nested.id, props);
      if (parentFunction) resolutions.push(resolution({ from: parentFunction.id, to: nested.id, kind: 'contains', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(node)}`], layer: 'structural', checkpoint: false }));
      functionStack.push(nested);
      scopeStack.push(node.name.text);
      pushedFunction = true;
      pushedScope = true;
    } else if (ts.isClassDeclaration(node) && node.name) {
      addSymbol(node.name.text, 'class', node);
      scopeStack.push(node.name.text);
      pushedScope = true;
    } else if (ts.isInterfaceDeclaration(node)) addSymbol(node.name.text, 'interface', node);
    else if (ts.isTypeAliasDeclaration(node)) addSymbol(node.name.text, 'type', node);

    if (ts.isObjectLiteralExpression(node)) parseSemanticDeclaration(node);

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrap(node.initializer) ?? node.initializer;
      if (ts.isArrayBindingPattern(node.name) && ts.isCallExpression(initializer) && callLeafName(initializer.expression) === 'useState') {
        const stateElement = node.name.elements[0];
        const setterElement = node.name.elements[1];
        if (stateElement && setterElement && ts.isBindingElement(stateElement) && ts.isBindingElement(setterElement) && ts.isIdentifier(stateElement.name) && ts.isIdentifier(setterElement.name)) {
          const state = stateElement.name.text;
          const setter = setterElement.name.text;
          const binding = observation({ sourceId: context.source.id, kind: 'state-binding', locator: locator(node, ':state'), name: state, field: 'state', value: { state, setter }, layer: 'representation', checkpoint: false });
          observations.push(binding);
          stateSetters.set(setter, { state, binding });
          const owner = functionOwner();
          if (owner) resolutions.push(resolution({ from: owner.id, to: binding.id, kind: 'declares-state', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(node)}`], layer: 'representation', checkpoint: false }));
        }
      }
      if (ts.isIdentifier(node.name) && ts.isCallExpression(initializer) && callLeafName(initializer.expression) === 'useRouter') routerBindings.add(node.name.text);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(unwrap(node.initializer) ?? node.initializer)) {
      const owner = symbols.get(node.name.text)?.[0] ?? addSymbol(node.name.text, 'declaration', node);
      flattenObject(owner, unwrap(node.initializer)! as ts.ObjectLiteralExpression);
    }
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(unwrap(node.expression) ?? node.expression)) {
      const owner = functionOwner();
      if (owner) flattenObject(owner, unwrap(node.expression)! as ts.ObjectLiteralExpression);
    }
    if (ts.isArrowFunction(node) && ts.isObjectLiteralExpression(unwrap(node.body as ts.Expression) ?? node.body)) {
      const owner = functionOwner();
      if (owner) flattenObject(owner, unwrap(node.body as ts.Expression)! as ts.ObjectLiteralExpression);
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
        const ui = observation({ sourceId: context.source.id, kind: 'ui-element', locator: locator(opening, `:${tagName}`), name: label ?? tagName, field: 'element', value: { tag: tagName, label: label ?? null, href: hrefValue ?? null }, layer: 'representation', checkpoint: false });
        observations.push(ui);
        if (hrefValue) {
          const route = observation({ sourceId: context.source.id, kind: 'route-reference', locator: locator(opening, ':href'), name: hrefValue, field: 'href', value: hrefValue, layer: 'representation', checkpoint: false });
          observations.push(route);
          resolutions.push(resolution({ from: ui.id, to: route.id, kind: 'links_to', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(opening)}`], layer: 'representation', checkpoint: false }));
        }
        if (onClick?.initializer && ts.isJsxExpression(onClick.initializer) && onClick.initializer.expression) {
          const expression = onClick.initializer.expression;
          const handler = callbackIdentifier(expression);
          if (handler) pendingHandlers.push({ ui, handler, line: lineOf(onClick), ownerId: functionOwner()?.id ?? null });
        }
      }
      if (!UI_TAGS.has(tagName.toLowerCase()) && /^[A-Z]/u.test(tagName)) {
        const attrs = opening.attributes.properties.filter(ts.isJsxAttribute);
        for (const attr of attrs) {
          const prop = attr.name.getText(sourceFile);
          if (!/^on[A-Z]/u.test(prop) || !attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) continue;
          const handler = callbackIdentifier(attr.initializer.expression);
          if (!handler) continue;
          const binding = observation({ sourceId: context.source.id, kind: 'component-prop-binding', locator: locator(attr, `:${tagName}.${prop}`), name: `${tagName}.${prop}`, field: 'component-prop', value: { component: tagName, prop, handler }, layer: 'representation', checkpoint: false });
          observations.push(binding);
          pendingReferences.push({ from: binding, targetName: handler, kind: 'binds_to', line: lineOf(attr) });
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const owner = functionOwner();
      const expressionText = node.expression.getText(sourceFile);
      if (expressionText === 'fetch' && node.arguments.length >= 1) {
        const target = templateTarget(node.arguments[0], sourceFile);
        if (target) {
          const url = target.text;
          let method = 'GET';
          const init = node.arguments[1];
          if (init && ts.isObjectLiteralExpression(unwrap(init) ?? init)) {
            const methodProp = (unwrap(init)! as ts.ObjectLiteralExpression).properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'method');
            if (methodProp && ts.isPropertyAssignment(methodProp) && ts.isStringLiteralLike(methodProp.initializer)) method = methodProp.initializer.text.toUpperCase();
          }
          const call = observation({ sourceId: context.source.id, kind: 'http-call', locator: locator(node, ':fetch'), name: `${method} ${url}`, field: 'http', value: { method, url, dynamic: target.dynamic }, layer: 'representation', checkpoint: false });
          observations.push(call);
          if (owner) resolutions.push(resolution({ from: owner.id, to: call.id, kind: 'invokes', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(node)}`], layer: 'representation', checkpoint: false }));
        }
      }
      if (ts.isIdentifier(node.expression)) {
        const state = stateSetters.get(node.expression.text);
        if (state) {
          const write = observation({ sourceId: context.source.id, kind: 'state-write', locator: locator(node, ':state-write'), name: state.state, field: 'state', value: { state: state.state, setter: node.expression.text, expression: node.arguments[0]?.getText(sourceFile) ?? null }, layer: 'representation', checkpoint: false });
          observations.push(write);
          resolutions.push(resolution({ from: state.binding.id, to: write.id, kind: 'writes', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(node)}`], layer: 'representation', checkpoint: false }));
          if (owner) resolutions.push(resolution({ from: owner.id, to: write.id, kind: 'invokes', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(node)}`], layer: 'representation', checkpoint: false }));
        }
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'rpc') {
        const routine = staticString(node.arguments[0]);
        if (routine) {
          const call = observation({ sourceId: context.source.id, kind: 'rpc-call', locator: locator(node, ':rpc'), name: routine, field: 'rpc', value: { routine }, layer: 'representation', checkpoint: false });
          observations.push(call);
          if (owner) resolutions.push(resolution({ from: owner.id, to: call.id, kind: 'invokes', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(node)}`], layer: 'representation', checkpoint: false }));
        }
      }
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && routerBindings.has(node.expression.expression.text) && ['push', 'replace'].includes(node.expression.name.text)) {
        const target = templateTarget(node.arguments[0], sourceFile);
        const navTarget = target?.text ?? node.arguments[0]?.getText(sourceFile) ?? null;
        const nav = observation({ sourceId: context.source.id, kind: 'navigation-call', locator: locator(node, ':navigation'), name: String(navTarget ?? node.expression.getText(sourceFile)), field: 'navigation', value: { operation: `router.${node.expression.name.text}`, target: navTarget, dynamic: target?.dynamic ?? null }, layer: 'representation', checkpoint: false });
        observations.push(nav);
        if (owner) resolutions.push(resolution({ from: owner.id, to: nav.id, kind: 'invokes', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(node)}`], layer: 'representation', checkpoint: false }));
      }
      if ((expressionText.endsWith('.assign') || expressionText.endsWith('.replace')) && /location/.test(expressionText)) {
        const target = node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : node.arguments[0]?.getText(sourceFile) ?? null;
        const nav = observation({ sourceId: context.source.id, kind: 'navigation-call', locator: locator(node, ':navigation'), name: String(target ?? expressionText), field: 'navigation', value: { operation: expressionText, target }, layer: 'representation', checkpoint: false });
        observations.push(nav);
        if (owner) resolutions.push(resolution({ from: owner.id, to: nav.id, kind: 'invokes', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${lineOf(node)}`], layer: 'representation', checkpoint: false }));
      }
      if (expressionText.endsWith('.registerTool') && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const name = node.arguments[0].text;
        const tool = observation({ sourceId: context.source.id, kind: 'mcp-tool', locator: locator(node, ':mcp'), name, field: 'tool', value: name, layer: 'representation', checkpoint: false });
        observations.push(tool);
        const config = node.arguments[1];
        if (config && ts.isObjectLiteralExpression(unwrap(config) ?? config)) flattenObject(tool, unwrap(config)! as ts.ObjectLiteralExpression);
      }
      if (owner && ts.isIdentifier(node.expression)) pendingReferences.push({ from: owner, targetName: node.expression.text, kind: 'calls', line: lineOf(node) });
    }

    ts.forEachChild(node, visit);
    if (pushedFunction) functionStack.pop();
    if (pushedScope) scopeStack.pop();
  };

  visit(sourceFile);

  for (const pending of pendingHandlers) {
    const targets = symbols.get(pending.handler) ?? [];
    const target = targets.length === 1 ? targets[0] : undefined;
    if (target) {
      resolutions.push(resolution({ from: pending.ui.id, to: target.id, kind: 'handled_by', strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${pending.line}`], layer: 'representation', checkpoint: false }));
      continue;
    }
    const owner = pending.ownerId ? symbolsByIdentity.get(pending.ownerId)?.observation : undefined;
    const props = pending.ownerId ? componentPropsByOwner.get(pending.ownerId) : undefined;
    if (targets.length === 0 && owner && props?.has(pending.handler)) {
      const prop = observation({ sourceId: context.source.id, kind: 'component-prop-handler', locator: `${context.locatorBase}:${pending.line}:prop-handler`, name: `${owner.name ?? owner.id}.${pending.handler}`, field: 'component-prop', value: { component: owner.name ?? owner.id, prop: pending.handler }, layer: 'representation', checkpoint: false });
      observations.push(prop);
      resolutions.push(resolution({ from: pending.ui.id, to: prop.id, kind: 'handled_by', strategy: 'component-prop', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${pending.line}`], layer: 'representation', checkpoint: false }));
      continue;
    }
    resolutions.push(resolution({ from: pending.ui.id, to: null, kind: 'handled_by', strategy: targets.length > 1 ? 'ambiguous' : 'unresolved', confidence: null, status: 'unresolved', evidence: [targets.length > 1 ? `handler identifier ${pending.handler} is ambiguous in ${context.locatorBase}:${pending.line}` : `handler identifier ${pending.handler} was not resolved in ${context.locatorBase}:${pending.line}`], layer: 'representation', checkpoint: false }));
  }
  for (const pending of pendingReferences) {
    const targets = symbols.get(pending.targetName) ?? [];
    if (targets.length === 1 && targets[0]!.id !== pending.from.id) resolutions.push(resolution({ from: pending.from.id, to: targets[0]!.id, kind: pending.kind, strategy: 'syntax', confidence: 1, status: 'resolved', evidence: [`${context.locatorBase}:${pending.line}`], layer: 'structural', checkpoint: false }));
  }

  return { observations, resolutions, evidence };
}