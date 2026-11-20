import { parse, type SgNode } from '@ast-grep/napi';
import './treeSitterLanguages.js';
import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { observation, resolution } from '../model.js';
import type { Observation, Resolution } from '../../types.js';

/** Use the Go grammar for written structure. A Go call expression may also
 * be a conversion, and a selector may have a dynamic receiver: neither syntax
 * alone nor a matching name establishes a target binding. */
export function analyzeGo(context: AnalyzeContext): AnalyzeResult {
  const root = parse('go', context.text).root();
  const observations: Observation[] = [];
  const resolutions: Resolution[] = [];
  const packageNode = root.namedChildren().find(node => node.kind() === 'package_clause');
  const packageName = packageNode?.namedChildren().find(node => node.kind() === 'package_identifier')?.text().trim();
  if (!packageNode || !packageName) return { observations, resolutions, coverage: { status: 'partial', reason: 'Go parser did not find a package declaration' } };

  const lineOf = (node: SgNode) => node.range().start.line + 1;
  const locatorOf = (node: SgNode) => `${context.locatorBase}:${lineOf(node)}:${node.range().start.column + 1}`;
  const pkg = observation({ id: `symbol:${context.locatorBase}#package:${packageName}`, sourceId: context.source.id,
    kind: 'package', locator: `${context.locatorBase}:${lineOf(packageNode)}`, name: packageName,
    field: 'identifier', value: { language: 'go', qualifiedName: packageName }, tags: ['go', 'tree-sitter'], layer: 'structural', checkpoint: false });
  observations.push(pkg);
  const identities = new Map<string, number>();
  const addDeclaration = (node: SgNode, kind: string, name: string, qualifiedName: string, owner: Observation,
    extra: Record<string, unknown> = {}): Observation => {
    const base = `symbol:${context.locatorBase}#${kind}:${qualifiedName}`;
    const ordinal = (identities.get(base) ?? 0) + 1; identities.set(base, ordinal);
    const locator = `${context.locatorBase}:${lineOf(node)}`;
    const result = observation({ id: ordinal === 1 ? base : `${base}~${ordinal}`, sourceId: context.source.id,
      kind, locator, name, field: 'identifier', value: { language: 'go', qualifiedName, ...extra },
      tags: ['go', 'tree-sitter'], layer: 'structural', checkpoint: false,
      contributions: [{ producer: 'ast-grep/tree-sitter-go', version: '0.0.6', symbol: qualifiedName, locator }] });
    observations.push(result);
    resolutions.push(resolution({ from: owner.id, to: result.id, kind: 'contains', strategy: 'tree-sitter-syntax',
      confidence: 1, status: 'resolved', evidence: [locator], layer: 'structural', checkpoint: false }));
    return result;
  };
  let errors = 0;
  let unreadableImports = 0;
  const visit = (node: SgNode, owner: Observation): void => {
    const syntax = String(node.kind());
    if (syntax === 'ERROR') errors++;
    let nextOwner = owner;
    if (syntax === 'type_spec' || syntax === 'type_alias') {
      const name = node.field('name')?.text().trim();
      const type = node.field('type');
      if (name) {
        const kind = type?.kind() === 'struct_type' ? 'struct' : type?.kind() === 'interface_type' ? 'interface' : 'type';
        addDeclaration(node, kind, name, `${packageName}.${name}`, pkg);
      }
    } else if (syntax === 'function_declaration' || syntax === 'method_declaration') {
      const name = node.field('name')?.text().trim();
      const receiver = node.field('receiver')?.namedChildren().find(child => child.kind() === 'parameter_declaration');
      const receiverSyntax = receiver?.field('type')?.text().trim();
      const receiverType = receiverSyntax?.replace(/^\*+/u, '').replace(/\[[^\]]*\]$/u, '').split('.').at(-1) ?? null;
      if (name) {
        const kind = syntax === 'method_declaration' ? 'method' : 'function';
        const qualified = receiverType ? `${packageName}.${receiverType}.${name}` : `${packageName}.${name}`;
        nextOwner = addDeclaration(node, kind, name, qualified, pkg, {
          ...(receiverType ? { receiverType } : {}), ...(receiver?.field('name') ? { receiverName: receiver.field('name')!.text() } : {}),
          parameterText: node.field('parameters')?.text() ?? '',
        });
      }
    } else if (syntax === 'func_literal') {
      const offset = node.range().start.index;
      nextOwner = addDeclaration(node, 'function', 'callback', `${packageName}.callback-${offset}`, owner, { sourceOffset: offset });
    } else if (syntax === 'import_spec') {
      const written = node.field('path')?.text() ?? '';
      let module = '';
      try { module = written.startsWith('`') ? written.slice(1, -1) : JSON.parse(written); } catch { unreadableImports++; }
      if (typeof module === 'string' && module) {
        const alias = node.field('name')?.text().trim() ?? null;
        const local = alias ?? module.split('/').filter(Boolean).at(-1) ?? module;
        const locator = locatorOf(node);
        observations.push(observation({ id: `import:${context.locatorBase}#go:${module}:${local}:${node.range().start.index}`,
          sourceId: context.source.id, kind: 'import-binding', locator, name: local, field: 'import',
          value: { language: 'go', module, imported: '*', local, mode: 'module', ...(alias ? { alias } : {}) },
          tags: ['go', 'tree-sitter', 'import'], layer: 'structural', checkpoint: false }));
      }
    }
    if (syntax === 'call_expression') {
      const expression = node.field('function');
      const name = expression?.kind() === 'selector_expression' ? expression.field('field')?.text() : expression?.text();
      if (expression && name) {
        const argumentIdentifiers = new Set<string>();
        let nestedCallable = false;
        const collectIdentifiers = (child: SgNode): void => {
          const kind = String(child.kind());
          // A callback has its own lexical owner and its identifiers must not
          // become the outer call's argument vocabulary.
          if (kind === 'func_literal') { nestedCallable = true; return; }
          if (kind === 'identifier' || kind === 'field_identifier') argumentIdentifiers.add(child.text());
          for (const nested of child.namedChildren()) collectIdentifiers(nested);
        };
        const argumentsNode = node.field('arguments');
        if (argumentsNode) collectIdentifiers(argumentsNode);
        const locator = locatorOf(node), offset = node.range().start.index;
        // Nested expressions such as f().Method() can share a start offset.
        const reference = observation({ id: `go-call:${context.locatorBase}:${offset}:${node.range().end.index}`, sourceId: context.source.id,
          kind: 'call-reference', locator, name, field: 'call', raw: node.text(),
          value: { language: 'go', functionId: owner.id, sourceOffset: offset, expression: node.text(),
            targetExpression: expression.text(), expressionKind: expression.kind(), qualifier: expression.kind() === 'selector_expression' ? expression.field('operand')?.text() ?? null : null,
            argumentIdentifiers: [...argumentIdentifiers], nestedCallable,
            binding: 'unresolved', interpretation: 'call-or-conversion' },
          tags: ['go', 'tree-sitter', 'invocation-or-conversion'], layer: 'structural', checkpoint: false,
          contributions: [{ producer: 'ast-grep/tree-sitter-go', version: '0.0.6', symbol: expression.text(), locator }] });
        observations.push(reference);
        resolutions.push(resolution({ from: owner.id, to: reference.id, kind: 'calls-site', strategy: 'tree-sitter-call-expression',
          confidence: null, status: 'candidate', evidence: [locator, 'Go call expression may be an invocation or type conversion; target binding is unresolved'],
          layer: 'structural', checkpoint: false }));
      }
    }
    if (syntax === 'if_statement' || syntax === 'for_statement' || syntax === 'expression_switch_statement') {
      const condition = node.field('condition') ?? (syntax === 'expression_switch_statement' ? node.field('value') : null);
      if (condition && owner.id !== pkg.id) {
        const offset = condition.range().start.index, locator = locatorOf(condition), raw = condition.text();
        const fact = observation({ id: `go-condition:${context.locatorBase}:${offset}`, sourceId: context.source.id,
          kind: 'source-condition', locator, name: `Condition in ${owner.name ?? 'callable'}`, field: 'condition', raw,
          value: { language: 'go', functionId: owner.id, predicate: raw, sourceOffset: offset, syntaxKind: syntax, requirementsComplete: false },
          tags: ['go', 'tree-sitter', 'source-condition'], layer: 'structural', checkpoint: false });
        observations.push(fact);
        resolutions.push(resolution({ from: owner.id, to: fact.id, kind: 'has-condition', strategy: 'tree-sitter-syntax',
          confidence: 1, status: 'resolved', evidence: [locator], layer: 'structural', checkpoint: false }));
      }
    }
    for (const child of node.namedChildren()) visit(child, nextOwner);
  };
  for (const node of root.namedChildren()) if (node !== packageNode) visit(node, pkg);
  const reasons = [errors ? `${errors} Go syntax error node(s)` : '', unreadableImports ? `${unreadableImports} import path(s) could not be decoded` : ''].filter(Boolean);
  return { observations, resolutions, coverage: reasons.length ? { status: 'partial', reason: reasons.join('; ') } : { status: 'complete' } };
}
