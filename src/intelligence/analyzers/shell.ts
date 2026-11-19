import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';
import powershell from 'tree-sitter-powershell/bindings/node/index.js';
import bash from 'tree-sitter-bash';
import type { AnalyzeContext, AnalyzeResult } from '../model.js';
import { observation, resolution } from '../model.js';
import type { Observation, Resolution } from '../../types.js';

// Tree-sitter parses source as data: no script or project command is executed.
// Parser instances are created only for languages present in the source.
const require = createRequire(import.meta.url);
const parsers = new Map<string, Parser>();
const versions: Record<string, string> = { powershell: '0.26.6', bash: '0.25.1' };
function parserFor(language: 'powershell' | 'bash'): Parser {
  const cached = parsers.get(language);
  if (cached) return cached;
  const TreeSitter = require('tree-sitter') as typeof Parser;
  const grammar = language === 'powershell' ? powershell : bash;
  const parser = new TreeSitter();
  parser.setLanguage(grammar);
  parsers.set(language, parser);
  return parser;
}

/** Extract language-native structure and written call occurrences, not execution or target bindings. */
export function analyzeShell(context: AnalyzeContext, language: 'powershell' | 'bash'): AnalyzeResult {
  const tree = parserFor(language).parse(context.text);
  const observations: Observation[] = [];
  const resolutions: Resolution[] = [];
  const fileId = `file:${context.locatorBase}`;
  const ordinals = new Map<string, number>();
  let errors = 0;
  const work: Array<{ node: Parser.SyntaxNode; owner: string }> = [{ node: tree.rootNode, owner: fileId }];
  while (work.length) {
    const { node, owner } = work.pop()!;
    if (node.isError || node.isMissing) errors++;
    let childOwner = owner;
    const isFunction = language === 'powershell' ? node.type === 'function_statement' : node.type === 'function_definition';
    if (isFunction) {
      const nameNode = language === 'powershell' ? node.namedChildren.find(child => child.type === 'function_name') : node.childForFieldName('name');
      const name = nameNode?.text.trim() ?? '';
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(name)) {
        const base = `symbol:${context.locatorBase}#${language}:function:${name}`;
        const ordinal = (ordinals.get(base) ?? 0) + 1; ordinals.set(base, ordinal);
        const id = ordinal === 1 ? base : `${base}~${ordinal}`;
        const locator = `${context.locatorBase}:${node.startPosition.row + 1}`;
        observations.push(observation({ id, sourceId: context.source.id, kind: 'function', locator, name,
          field: 'identifier', value: name, tags: [language, 'tree-sitter'], layer: 'structural', checkpoint: false,
          contributions: [{ producer: `tree-sitter-${language}`, version: versions[language]!, symbol: name, locator }] }));
        resolutions.push(resolution({ from: owner, to: id, kind: 'contains', strategy: 'tree-sitter-syntax', confidence: 1,
          status: 'resolved', evidence: [locator], layer: 'structural', checkpoint: false }));
        childOwner = id;
      }
    }
    if (node.type === 'command') {
      const nameNode = node.childForFieldName(language === 'powershell' ? 'command_name' : 'name');
      const sourceName = nameNode?.text.trim() ?? '';
      const isStatic = /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(sourceName);
      const name = isStatic ? sourceName : '<dynamic command>';
      const locator = `${context.locatorBase}:${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
      const occurrence = observation({ id: `shell-call:${context.locatorBase}:${node.startIndex}`, sourceId: context.source.id,
        kind: 'call-reference', locator, name, field: 'call',
        value: { language, name, binding: isStatic ? 'unresolved' : 'dynamic' },
        tags: [language, 'tree-sitter', 'written-command'], layer: 'structural', checkpoint: false,
        contributions: [{ producer: `tree-sitter-${language}`, version: versions[language]!, symbol: name, locator }] });
      observations.push(occurrence);
      resolutions.push(resolution({ from: owner, to: occurrence.id, kind: 'calls-site', strategy: 'tree-sitter-command-syntax',
        confidence: 1, status: 'resolved', evidence: [locator, 'Written command occurrence; target binding and execution are not established'],
        layer: 'structural', checkpoint: false }));
    }
    // Record variable names as written occurrences, never values or bindings.
    // This keeps parameters and data references navigable without pretending
    // that dynamic shell scoping or a particular runtime value was resolved.
    if ((language === 'powershell' && node.type === 'variable')
      || (language === 'bash' && node.type === 'variable_name')) {
      const written = node.text.trim();
      const match = language === 'powershell' ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(written)
        : /^([A-Za-z_][A-Za-z0-9_]*)$/u.exec(written);
      if (match) {
        const name = match[1]!;
        const locator = `${context.locatorBase}:${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
        const occurrence = observation({ id: `shell-variable:${context.locatorBase}:${node.startIndex}`,
          sourceId: context.source.id, kind: 'variable-reference', locator, name, field: 'variable',
          value: { language, name, binding: 'unresolved' }, tags: [language, 'tree-sitter', 'written-variable'],
          layer: 'structural', checkpoint: false,
          contributions: [{ producer: `tree-sitter-${language}`, version: versions[language]!, symbol: name, locator }] });
        observations.push(occurrence);
        resolutions.push(resolution({ from: owner, to: occurrence.id, kind: 'has-source-occurrence',
          strategy: 'tree-sitter-variable-syntax', confidence: 1, status: 'resolved',
          evidence: [locator, 'Written variable occurrence; binding, value and execution are not established'],
          layer: 'structural', checkpoint: false }));
      }
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i--) work.push({ node: node.namedChildren[i]!, owner: childOwner });
  }
  return { observations, resolutions, coverage: errors || tree.rootNode.hasError
    ? { status: 'partial', reason: `${language} parser reported ${errors} syntax error or missing node(s)` }
    : { status: 'complete' } };
}
