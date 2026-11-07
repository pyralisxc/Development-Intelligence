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
// Wider source-only compiler analysis is permitted when the real file/byte budgets fit.
// The binding budget remains independent, so incomplete precision is disclosed.
const MAX_FILES = 1600;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_BINDINGS = 3000;
const DECLARATION_KINDS = new Set(['function', 'method', 'declaration', 'constructor']);

export interface CompilerBindingResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sourceFiles: number;
  resolvedBindings: number;
  state: 'completed' | 'not-applicable' | 'bounded-out' | 'unavailable';
  reason: string | null;
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
}): CompilerBindingResult {
  const relatives = [...input.sourceTexts.keys()].sort();
  const empty = (state: CompilerBindingResult['state'], reason: string | null): CompilerBindingResult =>
    ({ nodes: [], edges: [], sourceFiles: relatives.length, resolvedBindings: 0, state, reason });
  if (!relatives.length) return empty('not-applicable', null);
  if (relatives.length > MAX_FILES
    || [...input.sourceTexts.values()].reduce((sum, content) => sum + Buffer.byteLength(content, 'utf8'), 0) > MAX_SOURCE_BYTES) {
    return empty('bounded-out', 'TypeScript compiler lens exceeded its bounded source-file or byte limit');
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
      if (resolvedBindings >= MAX_BINDINGS) break;
      const source = program.getSourceFile(path.join(input.root, file));
      const owner = input.fileNodes.get(file);
      if (!source || !owner || program.getSyntacticDiagnostics(source).length > 0) continue;
      const visit = (node: ts.Node): void => {
        if (resolvedBindings >= MAX_BINDINGS) return;
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
    return { nodes: resultNodes, edges: resultEdges, sourceFiles: relatives.length, resolvedBindings,
      state: 'completed', reason: resolvedBindings === MAX_BINDINGS ? 'Binding limit reached; compiler evidence is non-exhaustive' : null };
  } catch (error) {
    return empty('unavailable', error instanceof Error ? 'TypeScript compiler lens unavailable' : 'Unknown compiler lens failure');
  }
}
