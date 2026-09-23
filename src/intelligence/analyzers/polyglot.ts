import csharpRegistration from '@ast-grep/lang-csharp';
import javaRegistration from '@ast-grep/lang-java';
import pythonRegistration from '@ast-grep/lang-python';
import { parse, registerDynamicLanguage, type SgNode } from '@ast-grep/napi';
import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { observation, resolution } from '../model.js';
import { stableHash } from '../../util/hash.js';
import type { Observation, Resolution } from '../../types.js';

type Language = 'csharp' | 'java' | 'python';

interface Declaration {
  kind: string;
  name: string;
  opensScope: boolean;
  callable: boolean;
}

interface ImportBinding {
  module: string;
  imported: string;
  local: string;
  mode: 'module' | 'namespace' | 'symbol' | 'static';
  relative?: boolean;
}

const LANGUAGE_BY_EXTENSION: Record<string, Language> = {
  '.cs': 'csharp',
  '.java': 'java',
  '.py': 'python',
};

registerDynamicLanguage({
  csharp: csharpRegistration,
  java: javaRegistration,
  python: pythonRegistration,
});

function safeIdentityPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.@/\-[\]]+/gu, '_');
}

function childOfKind(node: SgNode, kinds: string[]): SgNode | null {
  return node.namedChildren().find(child => kinds.includes(String(child.kind()))) ?? null;
}

function nameFromField(node: SgNode): string | null {
  return node.field('name')?.text().trim() || null;
}

function packageOrNamespaceName(node: SgNode): string | null {
  return nameFromField(node)
    ?? node.namedChildren().find(child => ['identifier', 'qualified_name', 'scoped_identifier'].includes(String(child.kind())))?.text().trim()
    ?? null;
}

function hasAncestor(node: SgNode, kinds: string[]): boolean {
  return node.ancestors().some(ancestor => kinds.includes(String(ancestor.kind())));
}

function nearestAncestorKind(node: SgNode, kinds: string[]): string | null {
  let current = node.parent();
  while (current) {
    const kind = String(current.kind());
    if (kinds.includes(kind)) return kind;
    current = current.parent();
  }
  return null;
}

function declarationFor(language: Language, node: SgNode): Declaration | null {
  const syntaxKind = String(node.kind());
  const name = nameFromField(node);

  if (language === 'csharp') {
    if (['namespace_declaration', 'file_scoped_namespace_declaration'].includes(syntaxKind)) {
      const namespaceName = packageOrNamespaceName(node);
      return namespaceName ? { kind: 'namespace', name: namespaceName, opensScope: true, callable: false } : null;
    }
    const typeKinds: Record<string, string> = {
      class_declaration: 'class',
      interface_declaration: 'interface',
      struct_declaration: 'struct',
      record_declaration: 'record',
      enum_declaration: 'enum',
      delegate_declaration: 'delegate',
    };
    if (typeKinds[syntaxKind] && name) return { kind: typeKinds[syntaxKind]!, name, opensScope: syntaxKind !== 'delegate_declaration', callable: false };
    if (syntaxKind === 'method_declaration' && name) return { kind: 'method', name, opensScope: true, callable: true };
    if (syntaxKind === 'constructor_declaration' && name) return { kind: 'constructor', name, opensScope: true, callable: true };
    if (syntaxKind === 'local_function_statement' && name) return { kind: 'function', name, opensScope: true, callable: true };
    if (syntaxKind === 'property_declaration' && name) return { kind: 'property', name, opensScope: false, callable: false };
    if (syntaxKind === 'variable_declarator' && name && hasAncestor(node, ['field_declaration'])) return { kind: 'field', name, opensScope: false, callable: false };
    return null;
  }

  if (language === 'java') {
    if (syntaxKind === 'package_declaration') {
      const packageName = packageOrNamespaceName(node);
      return packageName ? { kind: 'package', name: packageName, opensScope: true, callable: false } : null;
    }
    const typeKinds: Record<string, string> = {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      record_declaration: 'record',
      annotation_type_declaration: 'annotation',
      module_declaration: 'module',
    };
    if (typeKinds[syntaxKind] && name) return { kind: typeKinds[syntaxKind]!, name, opensScope: true, callable: false };
    if (syntaxKind === 'method_declaration' && name) return { kind: 'method', name, opensScope: true, callable: true };
    if (syntaxKind === 'constructor_declaration' && name) return { kind: 'constructor', name, opensScope: true, callable: true };
    if (syntaxKind === 'variable_declarator' && name && hasAncestor(node, ['field_declaration', 'constant_declaration'])) return { kind: 'field', name, opensScope: false, callable: false };
    return null;
  }

  if (syntaxKind === 'class_definition' && name) return { kind: 'class', name, opensScope: true, callable: false };
  if (syntaxKind === 'function_definition' && name) {
    const ownerKind = nearestAncestorKind(node, ['class_definition', 'function_definition']);
    const kind = ownerKind === 'class_definition' ? 'method' : 'function';
    return { kind, name, opensScope: true, callable: true };
  }
  return null;
}

function callableSignature(node: SgNode): string | null {
  const parameters = childOfKind(node, ['parameter_list', 'formal_parameters', 'parameters']);
  if (!parameters) return null;
  const parameterKinds = parameters.namedChildren().map(parameter => {
    const type = parameter.field('type');
    if (type) return type.text().replace(/\s+/gu, '');
    return parameter.kind() === 'identifier' ? '_' : String(parameter.kind());
  });
  return `(${parameterKinds.join(',')})`;
}

function staticMember(node: SgNode): boolean {
  const modifier = childOfKind(node, ['modifiers']);
  if (modifier?.text().split(/\s+/u).includes('static')) return true;
  return node.namedChildren().some(child => child.kind() === 'modifier' && child.text() === 'static');
}

function sourceOwner(node: SgNode): boolean {
  return ['file_scoped_namespace_declaration', 'package_declaration'].includes(String(node.kind()));
}

function csharpBaseTypes(node: SgNode): string[] {
  const baseList = childOfKind(node, ['base_list']);
  if (!baseList) return [];
  return baseList.namedChildren()
    .map(child => child.text().trim())
    .filter(Boolean);
}

function argumentCount(node: SgNode): number | null {
  const argumentsNode = childOfKind(node, ['argument_list']);
  return argumentsNode ? argumentsNode.namedChildren().length : null;
}

function csharpInvocationTarget(node: SgNode): { name: string; qualifier: string | null; arity: number | null } | null {
  if (String(node.kind()) !== 'invocation_expression') return null;
  const text = node.text().trim();
  const match = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:<[^()]+>)?\s*\(/u.exec(text);
  if (!match) return null;
  const parts = match[1]!.split('.');
  const name = parts.at(-1)!;
  const qualifier = parts.length > 1 ? parts.slice(0, -1).join('.') : null;
  if (qualifier && qualifier !== 'this' && qualifier !== 'base' && !/^[A-Z]/u.test(qualifier.split('.').at(-1) ?? '')) return null;
  return { name, qualifier, arity: argumentCount(node) };
}

function csharpConstructorTarget(node: SgNode): { typeName: string; arity: number | null } | null {
  if (String(node.kind()) !== 'object_creation_expression') return null;
  const match = /^new\s+([A-Za-z_][A-Za-z0-9_.]*(?:<[^()]+>)?)\s*\(/u.exec(node.text().trim());
  if (!match) return null;
  return { typeName: match[1]!.replace(/<.*>$/u, ''), arity: argumentCount(node) };
}

function importBindingsFor(language: Language, node: SgNode): ImportBinding[] {
  const syntaxKind = String(node.kind());
  const text = node.text().trim();
  if (language === 'csharp' && syntaxKind === 'using_directive') {
    const match = /^(?:global\s+)?using\s+(?:(static)\s+)?(?:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)?([A-Za-z_][A-Za-z0-9_.]*)\s*;$/u.exec(text);
    if (!match) return [];
    const target = match[3]!;
    const alias = match[2];
    return [{
      module: target,
      imported: alias ? target.split('.').at(-1)! : '*',
      local: alias ?? '*',
      mode: alias ? 'symbol' : match[1] ? 'static' : 'namespace',
    }];
  }

  if (language === 'java' && syntaxKind === 'import_declaration') {
    const match = /^import\s+(?:(static)\s+)?([A-Za-z_][A-Za-z0-9_.]*?)(\.\*)?\s*;$/u.exec(text);
    if (!match) return [];
    const target = match[2]!;
    const wildcard = Boolean(match[3]);
    const parts = target.split('.');
    if (wildcard) return [{ module: target, imported: '*', local: '*', mode: match[1] ? 'static' : 'namespace' }];
    const imported = parts.at(-1)!;
    return [{ module: parts.slice(0, -1).join('.'), imported, local: imported, mode: match[1] ? 'static' : 'symbol' }];
  }

  if (language === 'python' && syntaxKind === 'import_statement') {
    return node.namedChildren().flatMap(child => {
      const name = child.field('name')?.text().trim() || child.text().split(/\s+as\s+/u)[0]?.trim();
      if (!name) return [];
      const alias = child.field('alias')?.text().trim();
      return [{ module: name, imported: '*', local: alias || name.split('.')[0]!, mode: 'module' as const }];
    });
  }

  if (language === 'python' && syntaxKind === 'import_from_statement') {
    const match = /^from\s+([.A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([\s\S]+)$/u.exec(text);
    if (!match) return [];
    const module = match[1]!;
    const imported = match[2]!.replace(/[()]/gu, ' ').split(',').map(value => value.trim()).filter(Boolean);
    return imported.map(value => {
      const [name, alias] = value.split(/\s+as\s+/u).map(part => part.trim());
      return { module, imported: name!, local: alias || name!, mode: name === '*' ? 'namespace' : 'symbol', relative: module.startsWith('.') };
    });
  }

  return [];
}

export function analyzePolyglot(context: AnalyzeContext, extension: string): AnalyzeResult {
  const language = LANGUAGE_BY_EXTENSION[extension];
  if (!language) return { observations: [], resolutions: [] };

  const root = parse(language, context.text).root();
  const observations: Observation[] = [];
  const resolutions: Resolution[] = [];
  const identities = new Map<string, number>();
  const importIdentities = new Map<string, number>();
  const referenceIdentities = new Map<string, number>();
  let parseErrors = 0;

  const lineOf = (node: SgNode) => node.range().start.line + 1;
  const addDeclaration = (node: SgNode, declaration: Declaration, scope: string[], owner: Observation | null): Observation => {
    const memberScope = ['method', 'constructor', 'property', 'field'].includes(declaration.kind)
      ? staticMember(node) ? 'static' : 'instance'
      : null;
    const qualifiedParts = [...scope, ...(memberScope ? [memberScope] : []), declaration.name];
    const signature = declaration.callable ? callableSignature(node) : null;
    const signatureIdentity = signature ? `@${stableHash([signature]).slice(0, 10)}` : '';
    const baseId = `symbol:${context.locatorBase}#${safeIdentityPart(declaration.kind)}:${safeIdentityPart(qualifiedParts.join('.'))}${signatureIdentity}`;
    const ordinal = (identities.get(baseId) ?? 0) + 1;
    identities.set(baseId, ordinal);
    const id = ordinal === 1 ? baseId : `${baseId}~${ordinal}`;
    const qualifiedName = [...scope, declaration.name].join('.');
    const symbol = observation({
      id,
      sourceId: context.source.id,
      kind: declaration.kind,
      locator: `${context.locatorBase}:${lineOf(node)}`,
      name: declaration.name,
      field: 'identifier',
      value: {
        language,
        syntaxKind: node.kind(),
        qualifiedName,
        ...(signature ? { signature } : {}),
        ...(memberScope ? { memberScope } : {}),
        ...(language === 'csharp' && ['class', 'interface', 'struct', 'record'].includes(declaration.kind) && csharpBaseTypes(node).length
          ? { baseTypes: csharpBaseTypes(node) }
          : {}),
      },
      tags: [language, 'tree-sitter'],
      layer: 'structural',
      checkpoint: false,
    });
    observations.push(symbol);
    if (owner) {
      resolutions.push(resolution({
        from: owner.id,
        to: symbol.id,
        kind: 'contains',
        strategy: 'syntax',
        confidence: 1,
        status: 'resolved',
        evidence: [`${context.locatorBase}:${lineOf(node)}`],
        layer: 'structural',
        checkpoint: false,
      }));
    }
    return symbol;
  };

  const visit = (node: SgNode, scope: string[], owner: Observation | null): void => {
    if (node.kind() === 'ERROR') parseErrors += 1;
    if (language === 'csharp' && owner) {
      const ownerValue = owner.value && typeof owner.value === 'object' ? owner.value as Record<string, unknown> : null;
      const ownerQualifiedName = typeof ownerValue?.qualifiedName === 'string' ? ownerValue.qualifiedName : null;
      const call = csharpInvocationTarget(node);
      const constructor = csharpConstructorTarget(node);
      const reference = call
        ? { kind: 'call-reference', name: call.name, field: 'call', value: { language, referenceKind: 'call', targetName: call.name, qualifier: call.qualifier, arity: call.arity, ownerQualifiedName } }
        : constructor
          ? { kind: 'constructor-reference', name: constructor.typeName, field: 'constructor', value: { language, referenceKind: 'constructor', targetName: constructor.typeName, arity: constructor.arity, ownerQualifiedName } }
          : null;
      if (reference) {
        const baseId = `reference:${context.locatorBase}#csharp:${reference.kind}:${safeIdentityPart(owner.id)}:${safeIdentityPart(reference.name)}`;
        const ordinal = (referenceIdentities.get(baseId) ?? 0) + 1;
        referenceIdentities.set(baseId, ordinal);
        const observed = observation({
          id: ordinal === 1 ? baseId : `${baseId}~${ordinal}`,
          sourceId: context.source.id,
          kind: reference.kind,
          locator: `${context.locatorBase}:${lineOf(node)}`,
          name: reference.name,
          field: reference.field,
          value: reference.value,
          tags: [language, 'tree-sitter', 'reference'],
          layer: 'structural',
          checkpoint: false,
        });
        observations.push(observed);
        resolutions.push(resolution({
          from: owner.id,
          to: observed.id,
          kind: 'invokes',
          strategy: 'syntax',
          confidence: 1,
          status: 'resolved',
          evidence: [`${context.locatorBase}:${lineOf(node)}`],
          layer: 'structural',
          checkpoint: false,
        }));
      }
    }
    for (const binding of importBindingsFor(language, node)) {
      const baseId = `import:${context.locatorBase}#${language}:${safeIdentityPart(binding.module)}:${safeIdentityPart(binding.local)}`;
      const ordinal = (importIdentities.get(baseId) ?? 0) + 1;
      importIdentities.set(baseId, ordinal);
      observations.push(observation({
        id: ordinal === 1 ? baseId : `${baseId}~${ordinal}`,
        sourceId: context.source.id,
        kind: 'import-binding',
        locator: `${context.locatorBase}:${lineOf(node)}`,
        name: binding.local === '*' ? binding.module : binding.local,
        field: 'import',
        value: { language, ...binding },
        tags: [language, 'tree-sitter', 'import'],
        layer: 'structural',
        checkpoint: false,
      }));
    }
    const declaration = declarationFor(language, node);
    const symbol = declaration ? addDeclaration(node, declaration, scope, owner) : null;
    const nextScope = declaration?.opensScope ? [...scope, declaration.name] : scope;
    const nextOwner = declaration?.opensScope && symbol ? symbol : owner;
    for (const child of node.namedChildren()) visit(child, nextScope, nextOwner);
  };

  const topLevel = root.namedChildren();
  const sourceDeclarationNode = topLevel.find(sourceOwner) ?? null;
  let sourceDeclaration: Observation | null = null;
  let rootScope: string[] = [];
  if (sourceDeclarationNode) {
    const declaration = declarationFor(language, sourceDeclarationNode);
    if (declaration) {
      sourceDeclaration = addDeclaration(sourceDeclarationNode, declaration, [], null);
      rootScope = [declaration.name];
      if (sourceDeclarationNode.kind() === 'namespace_declaration' || sourceDeclarationNode.kind() === 'module_declaration') {
        for (const child of sourceDeclarationNode.namedChildren()) visit(child, rootScope, sourceDeclaration);
      }
    }
  }

  for (const child of topLevel) {
    if (child.id() === sourceDeclarationNode?.id()) continue;
    visit(child, rootScope, sourceDeclaration);
  }

  return {
    observations,
    resolutions,
    coverage: parseErrors > 0
      ? { status: 'partial', reason: `${language} parser recovered from ${parseErrors} syntax error node${parseErrors === 1 ? '' : 's'}` }
      : { status: 'complete' },
  };
}
