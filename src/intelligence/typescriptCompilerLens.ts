import path from 'node:path';
import ts from 'typescript';
import type { GraphNode, GraphEdge } from '../types.js';
import { resolution } from './model.js';

/**
 * Optional, bounded compiler-symbol lens over the existing graph.
 * Compiler signatures establish static declaration identity, NOT runtime dispatch.
 * No independent symbol authority or persisted TypeScript program is created.
 */
export const TYPESCRIPT_COMPILER_LENS = 'typescript-checker-symbol.v1';
// Versioned native-compiler capacity defaults. These are resource budgets,
// not scientific limits on meaning. The same defaults apply to full and
// incremental canonical graph builds; local isolated producer probes may use
// explicitly supplied, validated budgets without changing hosted authority.
export const TYPESCRIPT_COMPILER_MAX_FILES = 4096;
export const TYPESCRIPT_COMPILER_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const TYPESCRIPT_COMPILER_MAX_BINDINGS = 12000;
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
  for (const [name, value, maximum] of [
    ['maxFiles', budget.maxFiles, 20000],
    ['maxSourceBytes', budget.maxSourceBytes, 256 * 1024 * 1024],
    ['maxBindings', budget.maxBindings, 200000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
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
  for (const node of input.nodes) {
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
    const program = ts.createProgram(relatives.map(relative => path.join(input.root, relative)), {
      ...input.options, noEmit: true,
    });
    const checker = program.getTypeChecker();
    const resultNodes: GraphNode[] = [];
    const resultEdges: GraphEdge[] = [];
    let resolvedBindings = 0;
    for (const file of relatives) {
      if (resolvedBindings >= budget.maxBindings) break;
      visitedFiles += 1;
      const source = program.getSourceFile(path.join(input.root, file));
      const owner = input.fileNodes.get(file);
      if (!source || !owner || program.getSyntacticDiagnostics(source).length > 0) continue;
      const visit = (node: ts.Node): void => {
        if (resolvedBindings >= budget.maxBindings) return;
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          if (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression)) {
            const signature = checker.getResolvedSignature(node);
            const declaration = signature?.declaration;
            const found = declaration ? declarationLocation(input.root, declaration, tracked) : null;
            if (found && found.file !== file) {
              const targets = native.get([found.file, found.name, found.line].join('\0')) ?? [];
              if (targets.length === 1) {
                const target = targets[0]!;
                const start = source.getLineAndCharacterOfPosition(node.expression.getStart(source));
                const locator = `${file}:${start.line + 1}:${start.character + 1}`;
                // Preserve existing DI structural identities: do not introduce a
                // same-name call-reference node that can displace a declaration
                // in general natural-language and parity query selection.
                resultEdges.push(resolution({
                  from: owner.id, to: target.id, kind: 'references-symbol',
                  strategy: TYPESCRIPT_COMPILER_LENS, confidence: 1, status: 'resolved',
                  evidence: [locator, `${found.file}:${found.line}`, 'TypeScript TypeChecker resolved static signature; runtime dispatch not established'],
                  layer: 'structural', checkpoint: false,
                }));
                resolvedBindings += 1;
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    const saturated = resolvedBindings >= budget.maxBindings;
    return { nodes: resultNodes, edges: resultEdges, sourceFiles: relatives.length, resolvedBindings,
      state: saturated ? 'bounded-out' : 'completed',
      reason: saturated ? 'Binding budget ' + budget.maxBindings + ' reached after '
        + visitedFiles + '/' + relatives.length
        + ' files; retained positive source facts are not exhaustive' : null,
      coverage: coverage(!saturated && visitedFiles === relatives.length) };
  } catch (error) {
    return empty('unavailable', error instanceof Error ? 'TypeScript compiler lens unavailable' : 'Unknown compiler lens failure');
  }
}
