import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { observation, resolution } from '../model.js';
import type { Observation, Resolution } from '../../types.js';

interface Span {
  start: number;
  end: number;
  kind: 'impl' | 'trait';
  owner: string;
}

interface UseBinding {
  module: string;
  imported: string;
  local: string;
  mode: 'module' | 'symbol' | 'namespace';
  offset: number;
}

function maskNonCode(text: string): string {
  let out = '';
  let index = 0;
  let blockDepth = 0;
  let state: 'code' | 'line-comment' | 'block-comment' | 'string' = 'code';
  let escaped = false;
  let rawHashes: string | null = null;

  while (index < text.length) {
    const ch = text[index]!;
    const next = text[index + 1] ?? '';

    if (rawHashes !== null) {
      const closing = `"${rawHashes}`;
      if (text.startsWith(closing, index)) {
        out += ' '.repeat(closing.length);
        index += closing.length;
        rawHashes = null;
      } else {
        out += ch === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (state === 'line-comment') {
      if (ch === '\n') { out += '\n'; state = 'code'; }
      else out += ' ';
      index += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '/' && next === '*') {
        blockDepth += 1;
        out += '  ';
        index += 2;
      } else if (ch === '*' && next === '/') {
        blockDepth -= 1;
        out += '  ';
        index += 2;
        if (blockDepth === 0) state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (state === 'string') {
      out += ch === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') state = 'code';
      index += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      out += '  ';
      index += 2;
      state = 'line-comment';
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      index += 2;
      state = 'block-comment';
      blockDepth = 1;
      continue;
    }

    const raw = /^(?:br|r)(#*)"/u.exec(text.slice(index));
    if (raw) {
      const token = raw[0]!;
      rawHashes = raw[1] ?? '';
      out += ' '.repeat(token.length);
      index += token.length;
      continue;
    }

    if ((ch === 'b' && next === '"') || ch === '"') {
      const width = ch === 'b' ? 2 : 1;
      out += ' '.repeat(width);
      index += width;
      state = 'string';
      continue;
    }

    // Rust lifetimes also use apostrophes. Only mask a bounded character
    // literal when a closing quote is visible before whitespace/newline.
    if (ch === "'") {
      const rest = text.slice(index);
      const charMatch = /^'(?:\\.|[^'\\\n])'/u.exec(rest);
      if (charMatch) {
        out += ' '.repeat(charMatch[0].length);
        index += charMatch[0].length;
        continue;
      }
    }

    out += ch;
    index += 1;
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function matchingBrace(code: string, open: number): number | null {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    else if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return null;
    }
  }
  return null;
}

function balancedBraces(code: string): boolean {
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function ownerFromImplHeader(header: string): string | null {
  const beforeWhere = header.split(/\bwhere\b/u, 1)[0] ?? header;
  const afterFor = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(beforeWhere)?.[1];
  if (afterFor) return afterFor;
  const identifiers = beforeWhere.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [];
  const filtered = identifiers.filter(value => !['impl', 'const', 'unsafe', 'default'].includes(value));
  return filtered.at(-1) ?? null;
}

function declarationSpans(code: string): Span[] {
  const spans: Span[] = [];
  const patterns: Array<{ kind: Span['kind']; regex: RegExp; owner: (match: RegExpExecArray) => string | null }> = [
    {
      kind: 'impl',
      regex: /\bimpl\b([^{};]*?)\{/gu,
      owner: match => ownerFromImplHeader(match[1] ?? ''),
    },
    {
      kind: 'trait',
      regex: /\btrait\s+([A-Za-z_][A-Za-z0-9_]*)[^{};]*?\{/gu,
      owner: match => match[1] ?? null,
    },
  ];
  for (const item of patterns) {
    for (const match of code.matchAll(item.regex)) {
      const start = match.index ?? 0;
      const open = start + match[0]!.lastIndexOf('{');
      const end = matchingBrace(code, open);
      const owner = item.owner(match);
      if (end !== null && owner) spans.push({ start: open, end, kind: item.kind, owner });
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

function containingSpan(spans: Span[], offset: number): Span | null {
  const matches = spans.filter(span => span.start < offset && offset < span.end);
  return matches.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] ?? null;
}

function parseUse(statement: string, offset: number): UseBinding[] {
  let value = statement.replace(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+/u, '').replace(/;\s*$/u, '').trim();
  if (!value) return [];

  if (value.includes('{')) {
    const prefix = value.slice(0, value.indexOf('{')).replace(/::$/u, '').trim();
    return prefix ? [{ module: prefix, imported: '*', local: '*', mode: 'namespace', offset }] : [];
  }

  const aliasParts = value.split(/\s+as\s+/u);
  value = aliasParts[0]!.trim();
  const alias = aliasParts[1]?.trim() || null;
  if (value.endsWith('::*')) {
    const module = value.slice(0, -3);
    return [{ module, imported: '*', local: alias ?? '*', mode: 'namespace', offset }];
  }

  const parts = value.split('::').filter(Boolean);
  if (parts.length <= 1) return [{ module: value, imported: '*', local: alias ?? value, mode: 'module', offset }];
  const imported = parts.at(-1)!;
  return [{
    module: parts.slice(0, -1).join('::'),
    imported,
    local: alias ?? imported,
    mode: 'symbol',
    offset,
  }];
}

export function analyzeRust(context: AnalyzeContext): AnalyzeResult {
  const code = maskNonCode(context.text);
  const starts = lineStarts(context.text);
  const spans = declarationSpans(code);
  const observations: Observation[] = [];
  const resolutions: Resolution[] = [];
  const identities = new Map<string, number>();

  const addDeclaration = (
    kind: string,
    name: string,
    offset: number,
    qualifiedName: string,
    extra: Record<string, unknown> = {},
  ): Observation => {
    const baseId = `symbol:${context.locatorBase}#${kind}:${qualifiedName}`;
    const ordinal = (identities.get(baseId) ?? 0) + 1;
    identities.set(baseId, ordinal);
    const node = observation({
      id: ordinal === 1 ? baseId : `${baseId}~${ordinal}`,
      sourceId: context.source.id,
      kind,
      locator: `${context.locatorBase}:${lineAt(starts, offset)}`,
      name,
      field: 'identifier',
      value: { language: 'rust', qualifiedName, ...extra },
      tags: ['rust', 'structural-parser'],
      layer: 'structural',
      checkpoint: false,
    });
    observations.push(node);
    return node;
  };

  const typePatterns: Array<[string, RegExp]> = [
    ['struct', /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/gu],
    ['enum', /\benum\s+([A-Za-z_][A-Za-z0-9_]*)/gu],
    ['trait', /\btrait\s+([A-Za-z_][A-Za-z0-9_]*)/gu],
    ['type', /\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^;={]*>)?\s*=/gu],
    ['module', /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:;|\{)/gu],
  ];
  for (const [kind, regex] of typePatterns) {
    for (const match of code.matchAll(regex)) {
      const name = match[1]!;
      addDeclaration(kind, name, match.index ?? 0, name);
    }
  }

  const fnPattern = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^\n{(]*>)?\s*\(/gmu;
  for (const match of code.matchAll(fnPattern)) {
    const name = match[1]!;
    const offset = match.index ?? 0;
    const span = containingSpan(spans, offset);
    const kind = span ? 'method' : 'function';
    const owner = span?.owner ?? null;
    addDeclaration(kind, name, offset, owner ? `${owner}::${name}` : name, {
      ...(owner ? { ownerType: owner, ownerKind: span!.kind } : {}),
    });
  }

  const importIds = new Map<string, number>();
  const usePattern = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?use\s+[^;]+;/gmu;
  for (const match of code.matchAll(usePattern)) {
    for (const binding of parseUse(match[0]!, match.index ?? 0)) {
      const baseId = `import:${context.locatorBase}#rust:${binding.module}:${binding.local}`;
      const ordinal = (importIds.get(baseId) ?? 0) + 1;
      importIds.set(baseId, ordinal);
      observations.push(observation({
        id: ordinal === 1 ? baseId : `${baseId}~${ordinal}`,
        sourceId: context.source.id,
        kind: 'import-binding',
        locator: `${context.locatorBase}:${lineAt(starts, binding.offset)}`,
        name: binding.local === '*' ? binding.module : binding.local,
        field: 'import',
        value: {
          language: 'rust',
          module: binding.module,
          imported: binding.imported,
          local: binding.local,
          mode: binding.mode,
        },
        tags: ['rust', 'structural-parser', 'import'],
        layer: 'structural',
        checkpoint: false,
      }));
    }
  }

  return {
    observations,
    resolutions,
    coverage: balancedBraces(code)
      ? { status: 'complete' }
      : { status: 'partial', reason: 'Rust structural parser observed unbalanced braces after masking comments and literals' },
  };
}
