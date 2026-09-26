import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveProjectRevision, withResolvedProjectCheckout } from '../source/git.js';
import { runChecked } from '../util/process.js';
import { graphContext } from './service.js';
import { locatorFileAndLine } from './query.js';
import { GRAPH_DIRECTORY } from './repository.js';

const MAX_FILE_BYTES = Number(process.env.DEVINT_GRAPH_MAX_FILE_BYTES ?? 1_000_000);

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
  return result.stdout.split('\0').filter(Boolean).filter(file => !file.startsWith(`${GRAPH_DIRECTORY}/`));
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
    const context = Math.min(Math.max(input.context ?? 2, 0), 20);
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const matches: Array<Record<string, unknown>> = [];
    for (const relative of files) {
      if (pathMatcher && !pathMatcher.test(relative)) continue;
      const absolute = path.join(checkout.root, relative);
      let stat;
      try { stat = await fs.lstat(absolute); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) continue;
      let text: string;
      try { text = await fs.readFile(absolute, 'utf8'); } catch { continue; }
      if (text.includes('\0')) continue;
      const lines: string[] = text.split(/\r?\n/u);
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index]!;
        const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(input.pattern.toLowerCase());
        if (!hit) continue;
        matches.push({
          file: relative,
          line: index + 1,
          text: line,
          before: lines.slice(Math.max(0, index - context), index),
          after: lines.slice(index + 1, index + 1 + context),
        });
      }
      if (matches.length >= limit) break;
    }
    return { project: input.project, graphId: input.graphId ?? null, ref: checkout.ref, revision: checkout.sha, matches, total: matches.length };
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
  if (!candidates.length) candidates = graph.nodes.filter(item => `${item.name ?? ''} ${item.locator}`.toLowerCase().includes(needle)).slice(0, 25);
  if (!candidates.length) throw new Error(`Graph node not found: ${input.node}`);
  if (!exactId && candidates.length > 1) {
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: graph.repositoryRevision,
      ambiguous: true,
      query,
      candidates: candidates.slice(0, 12).map(item => ({ id: item.id, kind: item.kind, layer: item.layer ?? 'structural', name: item.name ?? null, locator: item.locator })),
      instruction: 'Retry get_code_snippet with an exact node id.',
    };
  }
  const node = exactId ?? candidates[0]!;
  const locator = locatorFileAndLine(node.locator);
  return await withResolvedProjectCheckout(context.revision, async checkout => {
    const absolute = path.resolve(checkout.root, locator.file);
    const root = path.resolve(checkout.root);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('Graph node locator escapes repository root');
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Graph node source is not a regular file: ${locator.file}`);
    const lines: string[] = String(await fs.readFile(absolute, 'utf8')).split(/\r?\n/u);
    const radius = Math.min(Math.max(input.context ?? 8, 0), 100);
    const center = locator.line ? locator.line - 1 : 0;
    const start = Math.max(0, center - radius);
    const end = Math.min(lines.length, center + radius + 1);
    return {
      project: input.project,
      graphId: graph.graphId,
      revision: checkout.sha,
      ambiguous: false,
      node,
      file: locator.file,
      startLine: start + 1,
      endLine: end,
      lines: lines.slice(start, end).map((text, index) => ({ line: start + index + 1, text })),
    };
  });
}
