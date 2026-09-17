import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import type { Observation } from '../../types.js';
import { observation, redactSensitiveValue } from '../model.js';

function withoutComments(text: string): { text: string; unterminated: boolean } {
  let output = '';
  let cursor = 0;
  let unterminated = false;
  while (cursor < text.length) {
    if (text[cursor] === '/' && text[cursor + 1] === '*') {
      const end = text.indexOf('*/', cursor + 2);
      if (end < 0) {
        output += text.slice(cursor).replace(/[^\r\n]/g, ' ');
        unterminated = true;
        break;
      }
      output += text.slice(cursor, end + 2).replace(/[^\r\n]/g, ' ');
      cursor = end + 2;
      continue;
    }
    output += text[cursor];
    cursor += 1;
  }
  return { text: output, unterminated };
}

function matchingBrace(text: string, open: number, end: number): number {
  let depth = 1;
  let quote: string | null = null;
  let escaped = false;
  for (let index = open + 1; index < end; index += 1) {
    const char = text[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function topLevelBlocks(text: string, start: number, end: number): Array<{ header: string; headerOffset: number; bodyStart: number; bodyEnd: number }> {
  const blocks = [];
  let statementStart = start;
  let quote: string | null = null;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < end; index += 1) {
    const char = text[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === ';' && parentheses === 0 && brackets === 0) statementStart = index + 1;
    else if (char === '{' && parentheses === 0 && brackets === 0) {
      const close = matchingBrace(text, index, end);
      if (close < 0) break;
      const rawHeader = text.slice(statementStart, index);
      const leading = rawHeader.search(/\S/u);
      const headerOffset = leading < 0 ? statementStart : statementStart + leading;
      const header = rawHeader.trim();
      if (header) blocks.push({ header, headerOffset, bodyStart: index + 1, bodyEnd: close });
      index = close;
      statementStart = close + 1;
    }
  }
  return blocks;
}

function splitSelectors(header: string): string[] {
  const output: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let quote: string | null = null;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index]!;
    if (quote) { if (char === quote && header[index - 1] !== '\\') quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === ',' && parentheses === 0 && brackets === 0) { output.push(header.slice(start, index).trim()); start = index + 1; }
  }
  output.push(header.slice(start).trim());
  return output.filter(Boolean);
}

function declarations(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of body.matchAll(/(?:^|;)\s*([a-zA-Z_-][\w-]*)\s*:\s*([^;{}]+)/g)) {
    const field = match[1]!;
    result[field] = String(redactSensitiveValue(field, match[2]!.trim()).value);
  }
  return result;
}

function hasBalancedBraces(text: string): boolean {
  let balance = 0;
  let quote: string | null = null;
  let escaped = false;
  for (const char of text) {
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') balance += 1;
    else if (char === '}') balance -= 1;
    if (balance < 0) return false;
  }
  return balance === 0 && quote === null;
}

export function analyzeCss(context: AnalyzeContext): AnalyzeResult {
  const observations: Observation[] = [];
  const stripped = withoutComments(context.text);
  let malformed = stripped.unterminated;

  const visit = (start: number, end: number, ancestors: string[]) => {
    const blocks = topLevelBlocks(stripped.text, start, end);
    for (const block of blocks) {
      const locator = `${context.locatorBase}:css:${block.headerOffset}`;
      const body = stripped.text.slice(block.bodyStart, block.bodyEnd);
      if (block.header.startsWith('@')) {
        const match = /^@([\w-]+)\s*(.*)$/s.exec(block.header);
        const name = match?.[1] ?? block.header.slice(1);
        const params = match?.[2]?.trim() ?? '';
        observations.push(observation({
          sourceId: context.source.id,
          kind: 'css-at-rule',
          locator,
          name: `@${name}${params ? ` ${params}` : ''}`,
          field: 'at-rule',
          value: { name, params, ancestors, declarations: declarations(body) },
        }));
        visit(block.bodyStart, block.bodyEnd, [...ancestors, `@${name}${params ? ` ${params}` : ''}`]);
      } else {
        const values = declarations(body);
        for (const selector of splitSelectors(block.header)) {
          observations.push(observation({
            sourceId: context.source.id,
            kind: 'css-selector',
            locator: `${locator}:${selector}`,
            name: selector,
            field: 'selector',
            value: { selector, declarations: values, atRules: ancestors },
          }));
        }
      }
    }
  };

  visit(0, stripped.text.length, []);
  for (const match of stripped.text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const redacted = redactSensitiveValue(match[1]!, match[2]!.trim());
    observations.push(observation({
      sourceId: context.source.id,
      kind: 'css-custom-property',
      locator: `${context.locatorBase}:css:${match.index}`,
      name: match[1]!,
      field: 'custom-property',
      value: redacted.value,
      ...(redacted.raw ? { raw: redacted.raw } : {}),
    }));
  }

  if (!hasBalancedBraces(stripped.text)) malformed = true;
  return {
    observations,
    resolutions: [],
    ...(malformed ? { coverage: { status: 'partial' as const, reason: 'CSS contains unbalanced braces or an unterminated comment' } } : {}),
  };
}
