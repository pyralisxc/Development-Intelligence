import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveProjectRevision, withResolvedProjectCheckout } from '../source/git.js';
import { runChecked } from '../util/process.js';
import { graphContext } from './service.js';
import { locatorFileAndLine } from './query.js';
import { isRepositoryAnalysisIgnoredPath } from './repository.js';

const MAX_FILE_BYTES = Number(process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? Number.MAX_SAFE_INTEGER);

export type FilePatternMode = 'regex' | 'literal' | 'prefix' | 'glob';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^{}()|[\]\\]/gu, '\\$&');
}

function globMatcher(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escapeRegex(char);
  }
  return new RegExp(source + '$', 'i');
}

function fileMatcher(pattern: string | undefined, mode: FilePatternMode): RegExp | null {
  if (!pattern) return null;
  try {
    if (mode === 'literal') return new RegExp('^' + escapeRegex(pattern) + '$', 'i');
    if (mode === 'prefix') return new RegExp('^' + escapeRegex(pattern), 'i');
    if (mode === 'glob') return globMatcher(pattern);
    return new RegExp(pattern, 'i');
  } catch (error) {
    if (mode === 'regex') {
      throw new Error(`filePattern is an invalid regular expression. Use filePatternMode "literal", "prefix", or "glob" when regex syntax is not intended: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
}

async function trackedTextFiles(root: string): Promise<string[]> {
  const result = await runChecked('git', ['-C', root, 'ls-files', '-z']);
  return result.stdout.split('\0').filter(Boolean).filter(file => !isRepositoryAnalysisIgnoredPath(file));
}

export async function searchCode(input: {
  project: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  pattern: string;
  filePattern?: string | undefined;
  filePatternMode?: FilePatternMode | undefined;
  regex?: boolean | undefined;
  context?: number | undefined;
  limit?: number | undefined;
  /** Internal exact-revision syntax check; observes AST shape, not provider/binding identity. */
  syntacticCall?: { callee: string; firstArgumentIdentifier: string } | undefined;
}): Promise<Record<string, unknown>> {
  if (!input.pattern) throw new Error('pattern must be a non-empty string');
  if (input.ref && input.graphId) throw new Error('Use either ref or graphId, not both');
  const revision = input.graphId
    ? (await graphContext(input.project, { graphId: input.graphId })).revision
    : await resolveProjectRevision(input.project, input.ref);
  return await withResolvedProjectCheckout(revision, async checkout => {
    const files = await trackedTextFiles(checkout.root);
    const matcher = input.regex ? new RegExp(input.pattern, 'i') : null;
    const pathMatcher = fileMatcher(input.filePattern, input.filePatternMode ?? 'regex');
    const context = input.context ?? 2;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(context) || context < 0 || !Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Source context must be non-negative and limit must be a positive integer');
    const matches: Array<Record<string, unknown>> = [];
    let total = 0;
    let oversized = 0, unreadable = 0, binary = 0, nonRegular = 0, unsupportedSyntax = 0;
    for (const relative of files) {
      if (pathMatcher && !pathMatcher.test(relative)) continue;
      const absolute = path.join(checkout.root, relative);
      let stat;
      try { stat = await fs.lstat(absolute); } catch { unreadable += 1; continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) { nonRegular += 1; continue; }
      if (stat.size > MAX_FILE_BYTES) { oversized += 1; continue; }
      let text: string;
      try { text = await fs.readFile(absolute, 'utf8'); } catch { unreadable += 1; continue; }
      if (text.includes('\0')) { binary += 1; continue; }
      const lines: string[] = text.split(/\r?\n/u);
      // Use the entire exact-revision file: reparsing a matching line alone
      // would mistake multiline comments/template strings for executable calls.
      // The result establishes syntactic presence only, never provider binding
      // or execution. Unsupported syntax/file types fail closed.
      let syntacticCallLines: Set<number> | null = null;
      if (input.syntacticCall) {
        if (!/\.(?:[cm]?[jt]s|tsx|jsx)$/iu.test(relative)) { unsupportedSyntax += 1; continue; }
        const kind = /\.(?:tsx|jsx)$/iu.test(relative) ? ts.ScriptKind.TSX
          : /\.(?:[cm]?js)$/iu.test(relative) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
        const parsed = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, kind) as
          ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
        if (parsed.parseDiagnostics?.length) { unsupportedSyntax += 1; continue; }
        syntacticCallLines = new Set<number>();
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node)
            && node.expression.getText(parsed).replace(/\s+/gu, '') === input.syntacticCall!.callee
            && node.arguments[0] && ts.isIdentifier(node.arguments[0]!)
            && (node.arguments[0] as ts.Identifier).text === input.syntacticCall!.firstArgumentIdentifier) {
            syntacticCallLines!.add(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
          }
          ts.forEachChild(node, visit);
        };
        visit(parsed);
      }
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const hit = syntacticCallLines ? syntacticCallLines.has(index + 1)
          : matcher ? matcher.test(line) : line.toLowerCase().includes(input.pattern.toLowerCase());
        if (!hit) continue;
        total += 1;
        if (matches.length >= limit) continue;
        matches.push({
          file: relative,
          line: index + 1,
          text: line,
          before: lines.slice(Math.max(0, index - context), index),
          after: lines.slice(index + 1, index + 1 + context),
        });
      }
    }
    return { project: input.project, graphId: input.graphId ?? null, ref: checkout.ref, revision: checkout.sha, matches, total,
      returned: matches.length, limit, truncated: total > matches.length,
      omittedFiles: { oversized, unreadable, binary, nonRegular, unsupportedSyntax },
      ...(input.syntacticCall ? { sourceValidationScope: 'whole-file-ast-call-and-first-operand-syntax-only' } : {}),
    };
  });
}

export async function getCodeSnippet(input: {
  project: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  node?: string | undefined;
  context?: number | undefined;
}): Promise<Record<string, unknown>> {
  const context = await graphContext(input.project, { ...(input.ref ? { ref: input.ref } : {}), ...(input.graphId ? { graphId: input.graphId } : {}) });
  const graph = context.graph;
  const query = input.node?.trim();
  if (!query) throw new Error('node must be a non-empty graph node id/name/query');
  const needle = query.toLowerCase();
  const exactId = graph.nodes.find(item => item.id === query);
  let candidates = exactId ? [exactId] : graph.nodes.filter(item => item.name?.toLowerCase() === needle);
  if (!candidates.length) candidates = graph.nodes.filter(item => `${item.name ?? ''} ${item.locator}`.toLowerCase().includes(needle));
  if (!candidates.length) throw new Error(`Graph node not found: ${input.node}`);
  if (!exactId && candidates.length > 1) {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: true,
      query,
      candidates: candidates.map(item => ({ id: item.id, kind: item.kind, layer: item.layer ?? 'structural', name: item.name ?? null, locator: item.locator })),
      instruction: 'Retry get_code_snippet with an exact node id.',
    };
  }
  const node = exactId ?? candidates[0]!;
  const locator = locatorFileAndLine(node.locator);
  const readSnippet = async (checkout: { root: string; sha: string | null }) => {
    const absolute = path.resolve(checkout.root, locator.file);
    const root = path.resolve(checkout.root);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('Graph node locator escapes repository root');
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Graph node source is not a regular file: ${locator.file}`);
    const source = await fs.readFile(absolute, 'utf8');
    if (graph.sourceState) {
      const expected = graph.coverage?.files.find(file => file.path === locator.file)?.contentSha256;
      if (!expected || createHash('sha256').update(source).digest('hex') !== expected)
        throw new Error(`Working source no longer matches the graph: ${locator.file}. Rebuild the working graph to inspect current source.`);
    }
    const lines: string[] = source.split(/\r?\n/u);
    const radius = input.context ?? 8;
    if (!Number.isSafeInteger(radius) || radius < 0) throw new Error('Source context must be a non-negative integer');
    const center = locator.line ? locator.line - 1 : 0;
    const start = Math.max(0, center - radius);
    const end = Math.min(lines.length, center + radius + 1);
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: checkout.sha,
      ...(graph.sourceState ? { sourceState: graph.sourceState } : {}),
      ambiguous: false,
      node,
      file: locator.file,
      startLine: start + 1,
      endLine: end,
      lines: lines.slice(start, end).map((text, index) => ({ line: start + index + 1, text })),
    };
  };
  if (graph.sourceState) {
    let root: string;
    try { root = fileURLToPath(context.revision.repository); }
    catch { throw new Error('Working graph source requires a local repository binding'); }
    return await readSnippet({ root, sha: null });
  }
  return await withResolvedProjectCheckout(context.revision, readSnippet);
}
