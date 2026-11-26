import path from 'node:path';
import ts from 'typescript';
import type { GraphNode, GraphEdge } from '../types.js';
import { observation, resolution } from './model.js';
import { templateTarget } from './analyzers/typescriptBehavior.js';

/**
 * Optional, bounded compiler-symbol lens over the existing graph.
 * Compiler signatures establish static declaration identity, NOT runtime dispatch.
 * No independent symbol authority or persisted TypeScript program is created.
 */
export const TYPESCRIPT_COMPILER_LENS = 'typescript-checker-symbol.v1';
// Canonical builds do not silently stop compiler analysis at a fixed project
// size. Explicit producer budgets remain available to callers that request one.
export const TYPESCRIPT_COMPILER_MAX_FILES = Number.MAX_SAFE_INTEGER;
export const TYPESCRIPT_COMPILER_MAX_SOURCE_BYTES = Number.MAX_SAFE_INTEGER;
export const TYPESCRIPT_COMPILER_MAX_BINDINGS = Number.MAX_SAFE_INTEGER;
export interface TypeScriptCompilerBudget {
  maxFiles: number;
  maxSourceBytes: number;
  maxBindings: number;
}
export const DEFAULT_TYPESCRIPT_COMPILER_BUDGET: Readonly<TypeScriptCompilerBudget> = Object.freeze({
  maxFiles: TYPESCRIPT_COMPILER_MAX_FILES,
  maxSourceBytes: TYPESCRIPT_COMPILER_MAX_SOURCE_BYTES,
  maxBindings: TYPESCRIPT_COMPILER_MAX_BINDINGS,
});
function compilerBudget(overrides: Partial<TypeScriptCompilerBudget> | undefined): TypeScriptCompilerBudget {
  const budget = { ...DEFAULT_TYPESCRIPT_COMPILER_BUDGET, ...overrides };
  for (const [name, value] of [
    ['maxFiles', budget.maxFiles],
    ['maxSourceBytes', budget.maxSourceBytes],
    ['maxBindings', budget.maxBindings],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('Invalid TypeScript compiler resource budget ' + name);
    }
  }
  return budget;
}
const DECLARATION_KINDS = new Set(['function', 'method', 'declaration', 'constructor']);

export interface CompilerBindingResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sourceFiles: number;
  resolvedBindings: number;
  state: 'completed' | 'not-applicable' | 'bounded-out' | 'unavailable';
  reason: string | null;
  coverage?: {
    sourceBytes: number;
    visitedFiles: number;
    maxFiles: number;
    maxSourceBytes: number;
    maxBindings: number;
    completeForEligibleSources: boolean;
  };
}

/** Disclose optional frontend precision gaps without mislabeling syntax as absent. */
export function compilerPrecisionWarning(result: CompilerBindingResult): string | null {
  if (result.state === 'not-applicable' || (result.state === 'completed' && !result.reason)) return null;
  return `Optional TypeScript compiler symbol evidence ${result.state}: ${result.reason ?? 'compiler precision unavailable'}. Syntax/source graph remains available; compiler-level negative or exhaustive conclusions are not established.`;
}

interface NamedLocation { file: string; name: string; line: number }

function relativeFile(root: string, name: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(name)).split(path.sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
  return rel;
}

function declarationLocation(
  root: string,
  declaration: ts.SignatureDeclaration | ts.JSDocSignature,
  tracked: ReadonlySet<string>,
): NamedLocation | null {
  // Documentation-only signatures do not establish a tracked implementation.
  if (ts.isJSDocSignature(declaration)) return null;
  const source = declaration.getSourceFile();
  const file = relativeFile(root, source.fileName);
  if (!file || !tracked.has(file)) return null;
  let candidateName: ts.Node | undefined = 'name' in declaration
    ? (declaration as ts.SignatureDeclaration & { name?: ts.Node }).name
    : undefined;
  if (!candidateName && (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))
    && ts.isVariableDeclaration(declaration.parent)) candidateName = declaration.parent.name;
  if (!candidateName || !(ts.isIdentifier(candidateName) || ts.isStringLiteralLike(candidateName))) return null;
  const line = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
  return { file, name: candidateName.text, line };
}

function graphNodeLine(node: GraphNode, file: string): number | null {
  if (!node.locator.startsWith(file + ':')) return null;
  const match = /^(\d+)(?::|$)/u.exec(node.locator.slice(file.length + 1));
  return match ? Number(match[1]) : null;
}

export function compilerTypeScriptReferences(input: {
  root: string;
  sourceTexts: Map<string, string>;
  nodes: GraphNode[];
  fileNodes: Map<string, GraphNode>;
  options: ts.CompilerOptions;
  /** Explicit local/benchmark-only budget; canonical callers use revision-stable defaults. */
  budget?: Partial<TypeScriptCompilerBudget>;
}): CompilerBindingResult {
  const relatives = [...input.sourceTexts.keys()].sort();
  const budget = compilerBudget(input.budget);
  const sourceBytes = [...input.sourceTexts.values()]
    .reduce((sum, content) => sum + Buffer.byteLength(content, 'utf8'), 0);
  let visitedFiles = 0;
  const coverage = (completeForEligibleSources: boolean) => ({
    sourceBytes, visitedFiles, maxFiles: budget.maxFiles, maxSourceBytes: budget.maxSourceBytes,
    maxBindings: budget.maxBindings, completeForEligibleSources,
  });
  const empty = (state: CompilerBindingResult['state'], reason: string | null): CompilerBindingResult =>
    ({ nodes: [], edges: [], sourceFiles: relatives.length, resolvedBindings: 0, state, reason,
      coverage: coverage(false) });
  if (!relatives.length) return { ...empty('not-applicable', null), coverage: coverage(true) };
  if (relatives.length > budget.maxFiles || sourceBytes > budget.maxSourceBytes) {
    return empty('bounded-out', 'TypeScript compiler lens requires ' + relatives.length
      + ' files/' + sourceBytes + ' bytes but this producer budget allows '
      + budget.maxFiles + ' files/' + budget.maxSourceBytes
      + ' bytes; no compiler-wide negative or exhaustive assertion is established');
  }

  const native = new Map<string, GraphNode[]>();
  const callSites = new Map<string, GraphNode>();
  const propBindings = new Map<string, GraphNode>();
  const initialBindings = new Map<string, GraphNode>();
  const jsxSpreads = new Map<string, GraphNode>();
  const localBindings = new Map<string, GraphNode>();
  type FactRange = { start: number; end: number; fact: GraphNode; context: boolean };
  const factRanges = new Map<string, FactRange[]>();
  const addRange = (file: string, fact: GraphNode, value: unknown, context: boolean) => {
    const range = value && typeof value === 'object' ? value as { start?: unknown; end?: unknown } : null;
    if (!range || typeof range.start !== 'number' || typeof range.end !== 'number' || range.end <= range.start) return;
    const list = factRanges.get(file) ?? [];
    list.push({ start: range.start, end: range.end, fact, context }); factRanges.set(file, list);
  };
  const containsCallable = (value: unknown): boolean => {
    const pending: unknown[] = [value];
    while (pending.length) {
      const item = pending.pop();
      if (!item || typeof item !== 'object') continue;
      const part = item as { kind?: unknown; children?: unknown };
      if (typeof part.kind === 'string' && ['ArrowFunction', 'FunctionExpression', 'FunctionDeclaration', 'MethodDeclaration'].includes(part.kind)) return true;
      if (Array.isArray(part.children)) pending.push(...part.children);
    }
    return false;
  };
  // The lexical body of a nested callback belongs to that callable. Keep
  // initializer references outside it without attributing the body's names
  // to the binding that merely contains the callback.
  const addScopedRanges = (file: string, fact: GraphNode, value: unknown, context: boolean) => {
    if (!containsCallable(value)) { addRange(file, fact, value, context); return; }
    const pending: unknown[] = [value];
    while (pending.length) {
      const part = pending.pop() as { kind?: unknown; children?: unknown } | undefined;
      if (!part || typeof part !== 'object') continue;
      if (typeof part.kind === 'string' && ['ArrowFunction', 'FunctionExpression', 'FunctionDeclaration', 'MethodDeclaration'].includes(part.kind)) continue;
      if (containsCallable(part)) { if (Array.isArray(part.children)) pending.push(...part.children); }
      else addRange(file, fact, part, context);
    }
  };
  for (const node of input.nodes) {
    if (node.sourceId.startsWith('repo:') && node.value && typeof node.value === 'object' && !Array.isArray(node.value)) {
      const file = node.sourceId.slice(5);
      const value = node.value as { identifierOffset?: unknown; sourceOffset?: unknown; sourceEnd?: unknown; iterationStart?: unknown; iterationEnd?: unknown; iterationStructure?: unknown; expressionStructure?: unknown; predicateStructure?: unknown; controlContext?: unknown };
      if (node.kind === 'source-binding' && typeof value.identifierOffset === 'number') {
        localBindings.set([file, value.identifierOffset].join('\0'), node);
        addScopedRanges(file, node, value.expressionStructure ?? { start: value.sourceOffset, end: value.sourceEnd }, false);
        addScopedRanges(file, node, value.iterationStructure ?? { start: value.iterationStart, end: value.iterationEnd }, false);
      } else if (node.kind === 'source-effect' || node.kind === 'source-condition') {
        const expression = node.kind === 'source-effect' ? value.expressionStructure : value.predicateStructure;
        if (node.kind !== 'source-effect' || !containsCallable(expression)) addRange(file, node, expression, false);
        if (Array.isArray(value.controlContext)) for (const context of value.controlContext) {
          if (context && typeof context === 'object') {
            const item = context as { expressionStart?: unknown; expressionEnd?: unknown };
            addRange(file, node, { start: item.expressionStart, end: item.expressionEnd }, true);
          }
        }
      }
    }
    if (node.kind === 'jsx-prop-spread' && node.sourceId.startsWith('repo:') && node.value && typeof node.value === 'object') {
      const offset = (node.value as { sourceOffset?: unknown }).sourceOffset;
      if (typeof offset === 'number') jsxSpreads.set([node.sourceId.slice(5), offset].join('\0'), node);
    }
    if (node.kind === 'state-binding' && node.field === 'initial-value' && node.name && node.sourceId.startsWith('repo:')) {
      const file = node.sourceId.slice(5), line = graphNodeLine(node, file);
      if (line !== null) initialBindings.set([file, line, node.name].join('\0'), node);
    }
    if (node.kind === 'component-prop-binding' && node.name && node.sourceId.startsWith('repo:')) {
      const file = node.sourceId.slice(5), line = graphNodeLine(node, file);
      if (line !== null) propBindings.set([file, line, node.name].join('\0'), node);
    }
    if (node.kind === 'call-reference' && node.sourceId.startsWith('repo:') && node.value && typeof node.value === 'object') {
      const value = node.value as { language?: string; sourceOffset?: number; sourceEnd?: number; functionId?: string };
      if (value.language === 'typescript' && typeof value.sourceOffset === 'number' && typeof value.sourceEnd === 'number' && value.functionId)
        callSites.set([node.sourceId.slice(5), value.sourceOffset, value.sourceEnd].join('\0'), node);
    }
    if (!DECLARATION_KINDS.has(node.kind) || !node.name || !node.sourceId.startsWith('repo:')) continue;
    const file = node.sourceId.slice(5);
    const line = graphNodeLine(node, file);
    if (line === null) continue;
    const key = [file, node.name, line].join('\0');
    const bucket = native.get(key) ?? [];
    bucket.push(node);
    native.set(key, bucket);
  }

  try {
    const tracked = new Set(relatives);
    const options = { ...input.options, noEmit: true };
    // TypeScript resolves implicit @types directories from the compiler host's
    // current directory. DI may be launched from a different checkout or by a
    // worker, so use the repository being analyzed rather than the process cwd.
    const host = ts.createCompilerHost(options);
    host.getCurrentDirectory = () => path.resolve(input.root);
    const program = ts.createProgram(relatives.map(relative => path.join(input.root, relative)), options, host);
    const checker = program.getTypeChecker();
    const resultNodes = new Map<string, GraphNode>();
    const resultEdges: GraphEdge[] = [];
    // Join the call occurrence to its enclosing source effect by exact AST
    // span and owner. This keeps the occurrence's signature attached to the
    // same conditional effect, rather than treating them as unrelated facts.
    for (const effect of input.nodes) {
      if (effect.kind !== 'source-effect' || !effect.sourceId.startsWith('repo:') || !effect.value || typeof effect.value !== 'object') continue;
      const value = effect.value as { kind?: unknown; functionId?: unknown; expressionStructure?: unknown };
      if (value.kind !== 'call' || typeof value.functionId !== 'string') continue;
      const root = value.expressionStructure as { kind?: unknown; start?: unknown; end?: unknown; children?: Array<{ kind?: unknown; start?: unknown; end?: unknown }> } | undefined;
      const call = root?.kind === 'CallExpression' ? root : root?.kind === 'AwaitExpression'
        ? root.children?.find(child => child.kind === 'CallExpression') : undefined;
      if (typeof call?.start !== 'number' || typeof call.end !== 'number') continue;
      const site = callSites.get([effect.sourceId.slice(5), call.start, call.end].join('\0'));
      if (!site || (site.value as { functionId?: unknown } | undefined)?.functionId !== value.functionId) continue;
      resultEdges.push(resolution({ from: effect.id, to: site.id, kind: 'contains-source-call',
        strategy: 'exact-source-call-span.v1', status: 'resolved', confidence: 1,
        evidence: [effect.locator, site.locator], evidenceIds: [...(effect.evidenceIds ?? []), ...(site.evidenceIds ?? [])],
        layer: 'structural', checkpoint: false }));
    }
    const formalParameter = (parameter: ts.ParameterDeclaration, index: number, callable: GraphNode): GraphNode | null => {
      const source = parameter.getSourceFile();
      const file = relativeFile(input.root, source.fileName);
      if (!file || !tracked.has(file)) return null;
      const offset = parameter.getStart(source);
      const line = source.getLineAndCharacterOfPosition(offset).line + 1;
      const name = parameter.name.getText(source);
      const duplicate = ts.isFunctionLike(parameter.parent)
        && parameter.parent.parameters.filter(item => item.name.getText(source) === name).length > 1;
      const item = observation({ identity: [callable.id, 'parameter', name, ...(duplicate ? [index] : [])], sourceId: `repo:${file}`,
        kind: 'parameter', locator: `${file}:${line}:parameter-offset-${offset}`, name, field: 'parameter',
        raw: parameter.getText(source), value: { functionId: callable.id, index, sourceOffset: offset, producer: TYPESCRIPT_COMPILER_LENS },
        layer: 'structural', checkpoint: false });
      if (resultNodes.has(item.id)) return item;
      resultNodes.set(item.id, item);
      resultEdges.push(resolution({ from: callable.id, to: item.id, kind: 'has-parameter',
        strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved',
        evidence: [item.locator], layer: 'structural', checkpoint: false }));
      return item;
    };
    const componentCalls = new Map<string, GraphNode[]>();
    const componentBindings = new Map<string, GraphNode[]>();
    const componentKey = (declaration: ts.Declaration, prop: string): string | null => {
      const fn = ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
        ? declaration.initializer : declaration;
      if (!ts.isFunctionDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
      const location = declarationLocation(input.root, fn, tracked);
      return location ? [location.file, location.name, location.line, prop].join('\0') : null;
    };
    const addComponent = (map: Map<string, GraphNode[]>, key: string, item: GraphNode) => {
      const group = map.get(key) ?? []; group.push(item); map.set(key, group);
    };
    let resolvedBindings = 0;
    for (const file of relatives) {
      if (resolvedBindings >= budget.maxBindings) break;
      visitedFiles += 1;
      const source = program.getSourceFile(path.join(input.root, file));
      const owner = input.fileNodes.get(file);
      if (!source || !owner || program.getSyntacticDiagnostics(source).length > 0) continue;
      const identifiers: ts.Identifier[] = [];
      const visit = (node: ts.Node): void => {
        if (resolvedBindings >= budget.maxBindings) return;
        if (ts.isIdentifier(node)) identifiers.push(node);
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          if (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression)) {
            const site = ts.isCallExpression(node) ? callSites.get([file, node.getStart(source), node.getEnd()].join('\0')) : undefined;
            // Resolve an immutable local target through the compiler's actual
            // binding, so fetch(urlVariable) receives the same graph treatment
            // as an inline literal or template without guessing by name.
            if (site && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch'
              && node.arguments[0] && ts.isIdentifier(node.arguments[0])) {
              const fetchSymbol = checker.getSymbolAtLocation(node.expression);
              const locallyDefinedFetch = fetchSymbol?.declarations?.some(declaration => {
                const location = relativeFile(input.root, declaration.getSourceFile().fileName);
                return location !== null && tracked.has(location);
              }) ?? false;
              const binding = checker.getSymbolAtLocation(node.arguments[0])?.valueDeclaration;
              if (!locallyDefinedFetch && binding && ts.isVariableDeclaration(binding) && ts.isVariableDeclarationList(binding.parent)
                && (binding.parent.flags & ts.NodeFlags.Const) !== 0 && binding.getSourceFile() === source && binding.initializer) {
                const target = templateTarget(binding.initializer, source);
                const callerId = (site.value as { functionId?: string } | undefined)?.functionId;
                if (target && callerId) {
                  let method = 'GET';
                  const init = node.arguments[1];
                  if (init && !ts.isObjectLiteralExpression(init)) method = 'UNKNOWN';
                  else if (init && ts.isObjectLiteralExpression(init)) {
                    for (const property of init.properties) {
                      if (ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name))) method = 'UNKNOWN';
                      else if (property.name && property.name.getText(source).replace(/^['"]|['"]$/gu, '') === 'method') {
                        method = ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
                          ? property.initializer.text.toUpperCase() : 'UNKNOWN';
                      }
                    }
                  }
                  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                  const declarationLine = source.getLineAndCharacterOfPosition(binding.getStart(source)).line + 1;
                  const locator = `${file}:${line}:fetch-offset-${node.getStart(source)}`;
                  const call = observation({ sourceId: `repo:${file}`, kind: 'http-call', locator, name: `${method} ${target.text}`,
                    field: 'http', value: { method, url: target.text, dynamic: target.dynamic, targetBinding: `${file}:${declarationLine}`,
                      producer: TYPESCRIPT_COMPILER_LENS }, layer: 'representation', checkpoint: false });
                  resultNodes.set(call.id, call);
                  resultEdges.push(resolution({ from: callerId, to: call.id, kind: 'invokes', strategy: 'typescript-checker-fetch-binding.v1',
                    status: 'resolved', confidence: 1, evidence: [site.locator, `${file}:${declarationLine}`, locator], layer: 'representation', checkpoint: false }));
                  resolvedBindings += 1;
                }
              }
            }
            const referenced = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name : node.expression);
            const calleeSymbol = referenced && (referenced.flags & ts.SymbolFlags.Alias)
              ? checker.getAliasedSymbol(referenced) : referenced;
            if (site && ts.isIdentifier(node.expression)) {
              const binding = calleeSymbol?.valueDeclaration;
              if (binding && ts.isBindingElement(binding) && !binding.initializer
                  && ts.isObjectBindingPattern(binding.parent) && ts.isParameter(binding.parent.parent)) {
                const parameter = binding.parent.parent, component = parameter.parent;
                const prop = binding.propertyName && ts.isIdentifier(binding.propertyName) ? binding.propertyName.text
                  : ts.isIdentifier(binding.name) ? binding.name.text : null;
                const key = prop && componentKey(component, prop);
                if (key) addComponent(componentCalls, key, site);
              }
            }

            if (site && ts.isIdentifier(node.expression)) {
              const parameter = calleeSymbol?.declarations?.find(ts.isParameter);
              if (parameter && ts.isFunctionLike(parameter.parent)) {
                const parent = parameter.parent as ts.SignatureDeclaration;
                const location = declarationLocation(input.root, parent, tracked);
                const callable = location ? native.get([location.file, location.name, location.line].join('\0')) ?? [] : [];
                const parameters = parent.parameters.filter(p => !(ts.isIdentifier(p.name) && p.name.text === 'this'));
                const index = parameters.indexOf(parameter);
                if (callable.length === 1 && index >= 0) {
                  const formal = formalParameter(parameter, index, callable[0]!);
                  if (formal) resultEdges.push(resolution({ from: site.id, to: formal.id, kind: 'resolves_to',
                    strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved',
                    evidence: [site.locator, formal.locator], layer: 'structural', checkpoint: false }));
                }
              }
            }
            const signature = checker.getResolvedSignature(node);
            const declaration = signature?.declaration;
            const found = declaration ? declarationLocation(input.root, declaration, tracked) : null;
            // Preserve the installed dependency's declared signature and its
            // documentation as external evidence, not as tracked source or
            // proof of a runtime implementation. The declaration is shared
            // by every call site that the checker binds to that signature.
            if (site && declaration && !found && !ts.isJSDocSignature(declaration)) {
              const declaredSource = declaration.getSourceFile();
              const normalized = declaredSource.fileName.split(path.sep).join('/');
              const marker = '/node_modules/';
              const at = normalized.indexOf(marker);
              if (at >= 0 && declaredSource.isDeclarationFile) {
                // Preserve nested package/version paths so two installed
                // copies of the same dependency cannot collapse to one node.
                const relative = relativeFile(input.root, declaredSource.fileName);
                const dependencyPath = relative?.includes('node_modules/') ? relative : normalized.slice(at + 1);
                const position = declaration.getStart(declaredSource);
                const line = declaredSource.getLineAndCharacterOfPosition(position).line + 1;
                const locator = `dependency:${dependencyPath}:${line}`;
                const description = ts.displayPartsToString(signature?.getDocumentationComment(checker) ?? []);
                const declaredName = 'name' in declaration && declaration.name ? declaration.name.getText(declaredSource) : null;
                const external = observation({ identity: ['dependency-signature', dependencyPath, position],
                  sourceId: 'repository', kind: 'external-signature', locator,
                  name: declaredName ?? calleeSymbol?.getName() ?? node.expression.getText(source), field: 'declaration',
                  raw: declaration.getText(declaredSource),
                  value: { declarationPath: dependencyPath, declarationOffset: position, description,
                    producer: TYPESCRIPT_COMPILER_LENS, sourceOnly: true, runtimeTargetEstablished: false },
                  layer: 'structural', checkpoint: false });
                resultNodes.set(external.id, external);
                resultEdges.push(resolution({ from: site.id, to: external.id, kind: 'has-declared-signature',
                  strategy: TYPESCRIPT_COMPILER_LENS, status: 'resolved', confidence: 1,
                  evidence: [site.locator, locator, 'TypeScript resolved the declared signature; the runtime target is not established'],
                  layer: 'structural', checkpoint: false }));
                resolvedBindings += 1;
              }
            }
            if (found) {
              const targets = native.get([found.file, found.name, found.line].join('\0')) ?? [];
              if (targets.length === 1) {
                const previousEdgeCount = resultEdges.length;
                const target = targets[0]!;
                const start = source.getLineAndCharacterOfPosition(node.expression.getStart(source));
                const locator = `${file}:${start.line + 1}:${start.character + 1}`;
                // Preserve existing DI structural identities: do not introduce a
                // same-name call-reference node that can displace a declaration
                // in general natural-language and parity query selection.
                const proof = [locator, `${file}:${start.line + 1}`, `${found.file}:${found.line}`, 'TypeScript TypeChecker resolved static signature; runtime dispatch not established'];
                if (found.file !== file) resultEdges.push(resolution({
                  from: owner.id, to: target.id, kind: 'references-symbol',
                  strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved',
                  evidence: proof, layer: 'structural', checkpoint: false,
                }));
                const callable = declaration && ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))
                  ? Boolean(declaration.body) : ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration));
                // A signature can come from a parameter or mutable variable's
                // type. It does not identify that value's runtime target.
                const directBinding = Boolean(declaration && calleeSymbol?.declarations?.some(item => item === declaration
                  || (ts.isVariableDeclaration(item) && ts.isVariableDeclarationList(item.parent)
                    && (item.parent.flags & ts.NodeFlags.Const) !== 0 && item.initializer === declaration)));
                const callerId = (site?.value as { functionId?: string } | undefined)?.functionId;
                if (site && callerId && callable && directBinding && declaration && !ts.isJSDocSignature(declaration) && ts.isCallExpression(node)) {
                  resultEdges.push(resolution({ from: site.id, to: target.id, kind: 'resolves_to',
                    strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved', evidence: proof,
                    layer: 'structural', checkpoint: false }));
                  resultEdges.push(resolution({ from: callerId, to: target.id, kind: 'calls',
                    strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved', evidence: proof,
                    layer: 'structural', checkpoint: false }));
                  const parameters = declaration.parameters.filter(p => !(ts.isIdentifier(p.name) && p.name.text === 'this'));
                  for (const [index, argument] of node.arguments.entries()) {
                    const parameter = parameters[index];
                    if (!parameter || ts.isSpreadElement(argument) || parameter.dotDotDotToken) break;
                    const formal = formalParameter(parameter, index, target);
                    if (!formal) continue;
                    const offset = argument.getStart(source);
                    const line = source.getLineAndCharacterOfPosition(offset).line + 1;
                    const actual = observation({ identity: [site.id, 'argument', index], sourceId: `repo:${file}`,
                      kind: 'argument', locator: `${file}:${line}:argument-offset-${offset}`,
                      name: `Argument ${index + 1}`, field: 'argument', raw: argument.getText(source),
                      value: { callSiteId: site.id, index, sourceOffset: offset, producer: TYPESCRIPT_COMPILER_LENS }, layer: 'structural', checkpoint: false });
                    resultNodes.set(actual.id, actual);
                    const evidence = [site.locator, actual.locator, formal.locator];
                    resultEdges.push(resolution({ from: site.id, to: actual.id, kind: 'has-argument',
                      strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved', evidence,
                      layer: 'structural', checkpoint: false }));
                    resultEdges.push(resolution({ from: actual.id, to: formal.id, kind: 'argument-for',
                      strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved', evidence,
                      layer: 'structural', checkpoint: false }));
                    if (ts.isIdentifier(argument)) {
                      const symbol = checker.getSymbolAtLocation(argument);
                      const binding = symbol?.valueDeclaration;
                      const bindingFile = binding && relativeFile(input.root, binding.getSourceFile().fileName);
                      const bindingLine = binding && binding.getSourceFile().getLineAndCharacterOfPosition(binding.getStart()).line + 1;
                      const matches = bindingFile && bindingLine ? native.get([bindingFile, argument.text, bindingLine].join('\0')) ?? [] : [];
                      if (matches.length === 1) resultEdges.push(resolution({ from: actual.id, to: matches[0]!.id,
                        kind: 'references-symbol', strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved',
                        evidence: [actual.locator, matches[0]!.locator], layer: 'structural', checkpoint: false }));
                    }
                  }
                }
                if (resultEdges.length > previousEdgeCount) resolvedBindings += 1;
              }
            }
          }
        }
        if (ts.isIdentifier(node) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
          const symbol = checker.getSymbolAtLocation(node);
          const declaration = symbol?.valueDeclaration;
          if (declaration && ts.isVariableDeclaration(declaration)) {
            const declarationSource = declaration.getSourceFile();
            const declarationFile = relativeFile(input.root, declarationSource.fileName);
            const declarationLine = declarationSource.getLineAndCharacterOfPosition(declaration.getStart(declarationSource)).line + 1;
            const state = declarationFile ? initialBindings.get([declarationFile, declarationLine, node.text].join('\0')) : undefined;
            if (state) {
              let ownerNode: ts.Node | undefined = node.parent;
              while (ownerNode && ownerNode !== source && !ts.isFunctionDeclaration(ownerNode)
                && !ts.isMethodDeclaration(ownerNode) && !ts.isArrowFunction(ownerNode) && !ts.isFunctionExpression(ownerNode)) ownerNode = ownerNode.parent;
              const location = ownerNode && ownerNode !== source ? declarationLocation(input.root, ownerNode as ts.SignatureDeclaration, tracked) : null;
              const owners = location ? native.get([location.file, location.name, location.line].join('\0')) ?? [] : [];
              const assignment = ts.isBinaryExpression(node.parent) && node.parent.left === node
                && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
              if (owners.length === 1 && !assignment) resultEdges.push(resolution({ from: owners[0]!.id, to: state.id,
                kind: 'reads', strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved',
                evidence: [`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`, state.locator], layer: 'structural', checkpoint: false }));
            }
          }
        }
        if (ts.isJsxSpreadAttribute(node)) {
          const spread = jsxSpreads.get([file, node.getStart(source)].join('\0'));
          let expression: ts.Expression = node.expression;
          while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)
              || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) expression = expression.expression;
          if (spread && ts.isIdentifier(expression)) {
            const symbol = checker.getSymbolAtLocation(expression), declaration = symbol?.valueDeclaration;
            if (declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
                && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer && ts.isCallExpression(declaration.initializer)
                && declaration.getSourceFile() === source) {
              const site = callSites.get([file, declaration.initializer.getStart(source), declaration.initializer.getEnd()].join('\0'));
              if (site) resultEdges.push(resolution({ from: spread.id, to: site.id, kind: 'potential-value-from',
                strategy: 'typescript-jsx-spread-binding', confidence: null, status: 'candidate',
                evidence: [spread.locator, site.locator, 'TypeScript binds the spread receiver to this const call result; the property value and rendering context may change.'],
                layer: 'representation', checkpoint: false }));
            }
          }
        }
        if (ts.isJsxAttribute(node) && /^on[A-Z]/u.test(node.name.getText(source))) {
          const opening = node.parent.parent;
          if (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) {
            const tag = opening.tagName.getText(source), prop = node.name.getText(source);
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            const binding = propBindings.get([file, line, `${tag}.${prop}`].join('\0'));
            const symbol = checker.getSymbolAtLocation(opening.tagName);
            const target = symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
            const declaration = target?.valueDeclaration;
            const key = declaration && componentKey(declaration, prop);
            if (binding && key) addComponent(componentBindings, key, binding);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      // Bind syntactic identifier occurrences through the compiler's own
      // symbol resolution. Control-expression references retain their exact
      // occurrence locations; they are not assertions of runtime execution.
      const ranges = (factRanges.get(file) ?? []).sort((a, b) => a.start - b.start || a.end - b.end);
      const active: FactRange[] = [];
      const links = new Map<string, { from: GraphNode; to: GraphNode; context: boolean; locations: Set<string> }>();
      let nextRange = 0;
      for (const identifier of identifiers.sort((a, b) => a.getStart(source) - b.getStart(source))) {
        const position = identifier.getStart(source);
        while (nextRange < ranges.length && ranges[nextRange]!.start <= position) active.push(ranges[nextRange++]!);
        for (let i = active.length - 1; i >= 0; i--) if (active[i]!.end <= position) active.splice(i, 1);
        if (!active.length || ((ts.isVariableDeclaration(identifier.parent) || ts.isBindingElement(identifier.parent)) && identifier.parent.name === identifier)) continue;
        const symbol = checker.getSymbolAtLocation(identifier);
        const declaration = symbol?.valueDeclaration;
        if (!declaration || (!ts.isVariableDeclaration(declaration) && !ts.isBindingElement(declaration)) || !ts.isIdentifier(declaration.name)) continue;
        const declarationSource = declaration.getSourceFile();
        const declarationFile = relativeFile(input.root, declarationSource.fileName);
        const target = declarationFile ? localBindings.get([declarationFile, declaration.name.getStart(declarationSource)].join('\0')) : undefined;
        if (!target) continue;
        const location = source.getLineAndCharacterOfPosition(position);
        for (const range of active) {
          if (range.fact.id === target.id) continue;
          const key = [range.fact.id, target.id, range.context ? 'control' : 'expression'].join('\0');
          const link = links.get(key) ?? { from: range.fact, to: target, context: range.context, locations: new Set<string>() };
          link.locations.add(`${file}:${location.line + 1}:${location.character + 1}`); links.set(key, link);
        }
      }
      for (const link of links.values()) {
        if (resolvedBindings >= budget.maxBindings) break;
        resultEdges.push(resolution({ from: link.from.id, to: link.to.id,
          kind: 'references-binding', strategy: link.context ? 'typescript-checker-control-binding' : 'typescript-checker-expression-binding',
          confidence: 1, status: 'resolved', evidence: [...link.locations, link.to.locator],
          evidenceIds: [...(link.from.evidenceIds ?? []), ...(link.to.evidenceIds ?? [])], layer: 'structural', checkpoint: false }));
        resolvedBindings += 1;
      }
    }
    for (const [key, sites] of componentCalls) for (const site of sites) for (const binding of componentBindings.get(key) ?? []) {
      resultEdges.push(resolution({ from: site.id, to: binding.id, kind: 'potentially-provided-by',
        strategy: 'typescript-component-prop', confidence: null, status: 'candidate',
        evidence: [site.locator, binding.locator, 'TypeScript resolves the component and prop; the active component instance is not established.'],
        layer: 'structural', checkpoint: false }));
    }
    const saturated = resolvedBindings >= budget.maxBindings;
    return { nodes: [...resultNodes.values()], edges: resultEdges, sourceFiles: relatives.length, resolvedBindings,
      state: saturated ? 'bounded-out' : 'completed',
      reason: saturated ? 'Binding budget ' + budget.maxBindings + ' reached after '
        + visitedFiles + '/' + relatives.length
        + ' files; retained positive source facts are not exhaustive' : null,
      coverage: coverage(!saturated && visitedFiles === relatives.length) };
  } catch (error) {
    return empty('unavailable', error instanceof Error ? 'TypeScript compiler lens unavailable' : 'Unknown compiler lens failure');
  }
}
