import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { observation, resolution } from '../model.js';
import type { Observation } from '../../types.js';

interface SqlStatement { text: string; start: number; }

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function splitStatements(text: string): SqlStatement[] {
  const output: SqlStatement[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let dollar: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1] ?? '';
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (!quote && !dollar && ch === '-' && next === '-') { lineComment = true; i += 1; continue; }
    if (!quote && !dollar && ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (!quote && ch === '$') {
      const match = /^\$[A-Za-z0-9_]*\$/u.exec(text.slice(i));
      if (match) {
        if (!dollar) { dollar = match[0]; i += match[0].length - 1; continue; }
        if (dollar === match[0]) { dollar = null; i += match[0].length - 1; continue; }
      }
    }
    if (dollar) continue;
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && next === "'") { i += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === ';') {
      const statement = text.slice(start, i + 1).trim();
      if (statement) output.push({ text: statement, start });
      start = i + 1;
    }
  }
  const trailing = text.slice(start).trim();
  if (trailing) output.push({ text: trailing, start });
  return output;
}

function canonicalSqlName(value: string): string {
  return value.replace(/"/g, '').trim().replace(/\s+/g, '').toLowerCase();
}

function shortSqlName(value: string): string {
  const canonical = canonicalSqlName(value);
  return canonical.split('.').at(-1) ?? canonical;
}

function firstMatch(statement: string, pattern: RegExp): string | null {
  const match = pattern.exec(statement);
  return match?.[1] ? canonicalSqlName(match[1]) : null;
}

function addReference(input: {
  context: AnalyzeContext;
  observations: Observation[];
  resolutions: ReturnType<typeof resolution>[];
  owner: Observation;
  statement: SqlStatement;
  target: string;
  operation: 'reads' | 'writes';
  at: number;
}): void {
  const qualifiedName = canonicalSqlName(input.target);
  if (!qualifiedName) return;
  const line = lineAt(input.context.text, input.statement.start + input.at);
  const ref = observation({
    sourceId: input.context.source.id,
    kind: 'sql-reference',
    locator: `${input.context.locatorBase}:${line}:sql-reference`,
    name: qualifiedName,
    field: 'sql-reference',
    value: { qualifiedName, shortName: shortSqlName(qualifiedName), operation: input.operation },
    layer: 'representation',
    checkpoint: false,
    identity: [input.context.source.id, 'sql-reference', input.owner.id, input.operation, qualifiedName],
  });
  input.observations.push(ref);
  input.resolutions.push(resolution({
    from: input.owner.id,
    to: ref.id,
    kind: input.operation,
    strategy: 'sql-syntax',
    confidence: 1,
    status: 'resolved',
    evidence: [`${input.context.locatorBase}:${line}`],
    layer: 'representation',
    checkpoint: false,
  }));
}

export function analyzeSql(context: AnalyzeContext): AnalyzeResult {
  const observations: Observation[] = [];
  const resolutions = [] as ReturnType<typeof resolution>[];

  for (const statement of splitStatements(context.text)) {
    const line = lineAt(context.text, statement.start);
    const table = firstMatch(statement.text, /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([\w".]+)/iu);
    if (table) observations.push(observation({
      sourceId: context.source.id,
      kind: 'sql-table',
      locator: `${context.locatorBase}:${line}:table`,
      name: table,
      field: 'sql',
      value: { qualifiedName: table, shortName: shortSqlName(table) },
      layer: 'structural',
      checkpoint: false,
      identity: [context.source.id, 'sql-table', table],
    }));

    const routineMatch = /\bcreate\s+(?:or\s+replace\s+)?(function|procedure)\s+([\w".]+)\s*\(([^)]*)\)/iu.exec(statement.text);
    if (routineMatch?.[2]) {
      const qualifiedName = canonicalSqlName(routineMatch[2]);
      const routine = routineMatch[1]!.toLowerCase();
      const signature = routineMatch[3]!.replace(/--[^\n]*/gu, '').replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
      const owner = observation({
        sourceId: context.source.id,
        kind: 'sql-function',
        locator: `${context.locatorBase}:${line}:${routine}`,
        name: qualifiedName,
        field: 'sql',
        value: { qualifiedName, shortName: shortSqlName(qualifiedName), routine, signature },
        layer: 'structural',
        checkpoint: false,
        identity: [context.source.id, 'sql-function', qualifiedName, signature],
      });
      observations.push(owner);
      const referencePatterns: Array<{ operation: 'reads' | 'writes'; regex: RegExp }> = [
        { operation: 'writes', regex: /\binsert\s+into\s+([\w".]+)/giu },
        { operation: 'writes', regex: /\bupdate\s+([\w".]+)/giu },
        { operation: 'writes', regex: /\bdelete\s+from\s+([\w".]+)/giu },
        { operation: 'reads', regex: /\bfrom\s+([\w".]+)/giu },
        { operation: 'reads', regex: /\bjoin\s+([\w".]+)/giu },
      ];
      const seen = new Set<string>();
      for (const { operation, regex } of referencePatterns) {
        for (const match of statement.text.matchAll(regex)) {
          const target = match[1];
          if (!target) continue;
          const key = `${operation}:${canonicalSqlName(target)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          addReference({ context, observations, resolutions, owner, statement, target, operation, at: match.index ?? 0 });
        }
      }
    }

    const trigger = firstMatch(statement.text, /\bcreate\s+(?:or\s+replace\s+)?trigger\s+([\w".]+)/iu);
    if (trigger) observations.push(observation({ sourceId: context.source.id, kind: 'sql-trigger', locator: `${context.locatorBase}:${line}:trigger`, name: trigger, field: 'sql', value: { name: trigger }, layer: 'structural', checkpoint: false, identity: [context.source.id, 'sql-trigger', trigger] }));

    const policyMatch = /\bcreate\s+policy\s+([\w".]+)[\s\S]*?\bon\s+([\w".]+)/iu.exec(statement.text);
    if (policyMatch?.[1]) {
      const policy = canonicalSqlName(policyMatch[1]);
      const target = policyMatch[2] ? canonicalSqlName(policyMatch[2]) : null;
      observations.push(observation({ sourceId: context.source.id, kind: 'sql-policy', locator: `${context.locatorBase}:${line}:policy`, name: policy, field: 'sql', value: { name: policy, target }, layer: 'structural', checkpoint: false, identity: [context.source.id, 'sql-policy', target, policy] }));
    }

    const index = firstMatch(statement.text, /\bcreate\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([\w".]+)/iu);
    if (index) observations.push(observation({ sourceId: context.source.id, kind: 'sql-index', locator: `${context.locatorBase}:${line}:index`, name: index, field: 'sql', value: { name: index }, layer: 'structural', checkpoint: false, identity: [context.source.id, 'sql-index', index] }));

    const privilege = /\b(grant|revoke)\b[\s\S]*?\bon\s+(?:table\s+|function\s+|schema\s+)?([\w".]+)/iu.exec(statement.text);
    if (privilege?.[2]) {
      const target = canonicalSqlName(privilege[2]);
      observations.push(observation({
        sourceId: context.source.id,
        kind: 'sql-privilege',
        locator: `${context.locatorBase}:${line}:privilege`,
        name: target,
        field: 'sql',
        value: { operation: privilege[1]!.toLowerCase(), target },
        layer: 'representation',
        checkpoint: false,
        identity: [context.source.id, 'sql-privilege', privilege[1]!.toLowerCase(), target],
      }));
    }
  }

  return { observations, resolutions };
}
