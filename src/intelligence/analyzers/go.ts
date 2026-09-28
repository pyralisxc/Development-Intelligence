import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { observation, resolution } from '../model.js';
import { stableHash } from '../../util/hash.js';
import type { Observation, Resolution } from '../../types.js';

interface ImportBinding {
  module: string;
  local: string;
  alias: string | null;
}

function maskNonCode(text: string): string {
  let out = '';
  let state: 'code' | 'line-comment' | 'block-comment' | 'double' | 'single' | 'raw' = 'code';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    const next = text[index + 1] ?? '';
    if (state === 'line-comment') {
      if (ch === '\n') { state = 'code'; out += '\n'; } else out += ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { out += '  '; index += 1; state = 'code'; }
      else out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'double' || state === 'single') {
      if (ch === '\n') { out += '\n'; escaped = false; continue; }
      out += ' ';
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if ((state === 'double' && ch === '"') || (state === 'single' && ch === "'")) state = 'code';
      continue;
    }
    if (state === 'raw') {
      out += ch === '\n' ? '\n' : ' ';
      if (ch === '`') state = 'code';
      continue;
    }
    if (ch === '/' && next === '/') { out += '  '; index += 1; state = 'line-comment'; continue; }
    if (ch === '/' && next === '*') { out += '  '; index += 1; state = 'block-comment'; continue; }
    if (ch === '"') { out += ' '; state = 'double'; continue; }
    if (ch === "'") { out += ' '; state = 'single'; continue; }
    if (ch === '`') { out += ' '; state = 'raw'; continue; }
    out += ch;
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

function receiverType(value: string | undefined): string | null {
  if (!value) return null;
  const tokens = value.trim().split(/\s+/u).filter(Boolean);
  const raw = tokens.at(-1) ?? '';
  const cleaned = raw
    .replace(/^\*+/u, '')
    .replace(/\[[^\]]*\]$/u, '')
    .split('.')
    .at(-1)
    ?.trim() ?? '';
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(cleaned) ? cleaned : null;
}

function importBindings(text: string): Array<ImportBinding & { offset: number }> {
  const output: Array<ImportBinding & { offset: number }> = [];
  const add = (alias: string | undefined, module: string, offset: number) => {
    const leaf = module.split('/').filter(Boolean).at(-1) ?? module;
    output.push({ module, alias: alias ?? null, local: alias ?? leaf, offset });
  };

  const block = /^\s*import\s*\(([\s\S]*?)^\s*\)/gmu;
  for (const match of text.matchAll(block)) {
    const body = match[1] ?? '';
    const base = (match.index ?? 0) + match[0]!.indexOf(body);
    const line = /^\s*(?:(\.|_|[A-Za-z_][A-Za-z0-9_]*)\s+)?["`]([^"`]+)["`]\s*(?:\/\/.*)?$/gmu;
    for (const item of body.matchAll(line)) add(item[1], item[2]!, base + (item.index ?? 0));
  }

  const single = /^\s*import\s+(?:(\.|_|[A-Za-z_][A-Za-z0-9_]*)\s+)?["`]([^"`]+)["`]\s*(?:\/\/.*)?$/gmu;
  for (const match of text.matchAll(single)) add(match[1], match[2]!, match.index ?? 0);
  return output;
}

function bracesBalanced(code: string): boolean {
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

export function analyzeGo(context: AnalyzeContext): AnalyzeResult {
  const code = maskNonCode(context.text);
  const starts = lineStarts(context.text);
  const observations: Observation[] = [];
  const resolutions: Resolution[] = [];
  const packageMatch = /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\b/mu.exec(code);
  if (!packageMatch) {
    return { observations, resolutions, coverage: { status: 'partial', reason: 'Go source has no observable package declaration' } };
  }

  const packageName = packageMatch[1]!;
  const packageLine = lineAt(starts, packageMatch.index);
  const packageNode = observation({
    id: `symbol:${context.locatorBase}#package:${packageName}`,
    sourceId: context.source.id,
    kind: 'package',
    locator: `${context.locatorBase}:${packageLine}`,
    name: packageName,
    field: 'identifier',
    value: { language: 'go', qualifiedName: packageName },
    tags: ['go', 'structural-parser'],
    layer: 'structural',
    checkpoint: false,
  });
  observations.push(packageNode);

  const identities = new Map<string, number>();
  const addDeclaration = (kind: string, name: string, offset: number, qualifiedName: string, extra: Record<string, unknown> = {}) => {
    const base = `symbol:${context.locatorBase}#${kind}:${qualifiedName}`;
    const ordinal = (identities.get(base) ?? 0) + 1;
    identities.set(base, ordinal);
    const node = observation({
      id: ordinal === 1 ? base : `${base}~${ordinal}`,
      sourceId: context.source.id,
      kind,
      locator: `${context.locatorBase}:${lineAt(starts, offset)}`,
      name,
      field: 'identifier',
      value: { language: 'go', qualifiedName, ...extra },
      tags: ['go', 'structural-parser'],
      layer: 'structural',
      checkpoint: false,
    });
    observations.push(node);
    resolutions.push(resolution({
      from: packageNode.id,
      to: node.id,
      kind: 'contains',
      strategy: 'syntax',
      confidence: 1,
      status: 'resolved',
      evidence: [node.locator],
      layer: 'structural',
      checkpoint: false,
    }));
    return node;
  };

  const typePattern = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:\[[^\]\n]+\]\s*)?(struct|interface)?\b/gmu;
  const seenTypes = new Set<string>();
  for (const match of code.matchAll(typePattern)) {
    const name = match[1]!;
    if (seenTypes.has(name)) continue;
    seenTypes.add(name);
    const syntax = match[2] ?? 'type';
    addDeclaration(syntax === 'struct' ? 'struct' : syntax === 'interface' ? 'interface' : 'type', name, match.index ?? 0, `${packageName}.${name}`);
  }
  const namedTypePattern = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?!\()[^\n]+$/gmu;
  for (const match of code.matchAll(namedTypePattern)) {
    const name = match[1]!;
    if (seenTypes.has(name)) continue;
    seenTypes.add(name);
    addDeclaration('type', name, match.index ?? 0, `${packageName}.${name}`);
  }

  const funcPattern = /^\s*func\s+(?:\(([^)\n]+)\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]\n]+\]\s*)?\(([^)\n]*)\)/gmu;
  for (const match of code.matchAll(funcPattern)) {
    const recv = receiverType(match[1]);
    const name = match[2]!;
    const params = (match[3] ?? '').trim();
    const kind = recv ? 'method' : 'function';
    const qualifiedName = recv ? `${packageName}.${recv}.${name}` : `${packageName}.${name}`;
    addDeclaration(kind, name, match.index ?? 0, qualifiedName, {
      ...(recv ? { receiverType: recv } : {}),
      parameterText: params,
    });
  }

  const importIds = new Map<string, number>();
  for (const binding of importBindings(context.text)) {
    const base = `import:${context.locatorBase}#go:${binding.module}:${binding.local}`;
    const ordinal = (importIds.get(base) ?? 0) + 1;
    importIds.set(base, ordinal);
    observations.push(observation({
      id: ordinal === 1 ? base : `${base}~${ordinal}`,
      sourceId: context.source.id,
      kind: 'import-binding',
      locator: `${context.locatorBase}:${lineAt(starts, binding.offset)}`,
      name: binding.local,
      field: 'import',
      value: {
        language: 'go',
        module: binding.module,
        imported: '*',
        local: binding.local,
        mode: 'module',
        ...(binding.alias ? { alias: binding.alias } : {}),
      },
      tags: ['go', 'structural-parser', 'import'],
      layer: 'structural',
      checkpoint: false,
    }));
  }

  return {
    observations,
    resolutions,
    coverage: bracesBalanced(code)
      ? { status: 'complete' }
      : { status: 'partial', reason: 'Go structural parser observed unbalanced braces after masking comments and literals' },
  };
}
