import type { ActionHint } from './lexicalKnowledge.js';
import { graphFamilyMemberships } from './graphFamilies.js';
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import type { GraphFamilyMembership, GraphNode, IntelligenceGraph } from '../types.js';
import { availableRelationshipContracts, BEHAVIOR_PATH_RELATIONS } from './graphKnowledge.js';
import { isWrittenTestSource } from './independentSourceVerification.js';
import { SOURCE_ANALYSIS_SUPPORT } from './analyzers/index.js';
import { indexedBindingGraph, indexedIncidentEdges, indexedNodeTags, indexedRecords, indexedTextCandidates, isIndexedPlanningView, isIndexedSelectedView, openIndexedFamilyAccess } from './localGraphIndex.js';

const nlp = winkNLP(model);
const its = nlp.its;

export interface GraphFilterInput {
  text: string;
  lexicalHints?: Record<string, ActionHint[]>;
  scope?: string;
  offset?: number;
  limit?: number;
  nodeKinds?: string[];
  relationshipKinds?: string[];
  statuses?: string[];
  direction?: 'inbound' | 'outbound' | 'both';
  comparisonIds?: string[];
  comparisonScope?: string;
  comparisonKinds?: string[];
  conditionContains?: string;
  conditionTruth?: boolean;
  effectKinds?: string[];
  depth?: number;
}

interface LanguageToken {
  text: string;
  lemma: string;
  partOfSpeech: string;
  negated: boolean;
  stop: boolean;
  start: number;
  end: number;
}

export function interpretGraphLanguage(text: string): { tokens: LanguageToken[]; terms: string[]; termGroups: string[][]; negated: boolean } {
  const tokens: LanguageToken[] = [];
  let position = 0;
  nlp.readDoc(text).tokens().each((token: any) => {
    const word = token.out();
    const start = text.indexOf(word, position);
    position = start < 0 ? position : start + word.length;
    if (!/[\p{L}\p{N}_]/u.test(word)) return;
    tokens.push({ text: word, lemma: String(token.out(its.lemma)).toLowerCase(),
      partOfSpeech: String(token.out(its.pos)), negated: Boolean(token.out(its.negationFlag)),
      stop: Boolean(token.out(its.stopWordFlag)), start, end: position });
  });
  const framing = new Set(['work', 'works', 'show', 'tell', 'explain', 'find', 'give', 'know', 'happen', 'happens', 'thing', 'things']);
  const meaningful = tokens.filter(token => !token.stop && !framing.has(token.lemma)
    && !['not', 'no', 'never', 'without', 'none'].includes(token.lemma));
  const operations = new Set(['call', 'invoke', 'reference', 'import', 'depend', 'contain', 'handle', 'construct', 'trigger', 'dispatch', 'write', 'read', 'use']);
  const nouns = meaningful.filter(token => ['NOUN', 'PROPN', 'ADJ'].includes(token.partOfSpeech)
    || (token.partOfSpeech === 'VERB' && !operations.has(token.lemma)));
  const termGroups = (nouns.length ? nouns : meaningful).map(token =>
    [...new Set([token.text.toLowerCase(), token.lemma].filter(term => term.length > 1))]).filter(group => group.length);
  const terms = [...new Set(termGroups.flat())];
  return { tokens, terms, termGroups, negated: /\b(?:not|no|never|without|none|cannot|can't|doesn't|don't|isn't|aren't)\b/iu.test(text) };
}

export function ambiguousActionCandidates(tokens: LanguageToken[]): LanguageToken[] {
  return tokens.flatMap((token, index) => {
    if (token.partOfSpeech !== 'VERB' || !/[a-z](?:ed|ing)$/iu.test(token.text)
      || !['NOUN', 'PROPN'].includes(tokens[index + 1]?.partOfSpeech ?? '')) return [];
    const previous = tokens[index - 1];
    if (!previous || previous.stop || !['NOUN', 'PROPN'].includes(previous.partOfSpeech)) return [];
    const before = tokens.slice(0, index - 1), auxiliary = before.findLastIndex(item => item.partOfSpeech === 'AUX');
    return auxiliary >= 0 && before.slice(auxiliary + 1).some(item => ['NOUN', 'PROPN'].includes(item.partOfSpeech)) ? [previous] : [];
  });
}

export function requestedActionTokens(tokens: LanguageToken[], inferred = new Set<string>()): LanguageToken[] {
  const isAction = (token: LanguageToken) => token.partOfSpeech === 'VERB' || inferred.has(token.lemma);
  return tokens.filter((token, index) => {
    if (!isAction(token)) return false;
    if (!/[a-z](?:ed|ing)$/iu.test(token.text)) return true;
    const before = tokens.slice(0, index), after = tokens.slice(index + 1);
    const nounAt = after.findIndex(item => ['NOUN', 'PROPN'].includes(item.partOfSpeech));
    if (nounAt < 0 || after.slice(0, nounAt + 1).some(item => ['and', 'or'].includes(item.lemma))) return true;
    const priorVerb = before.findLastIndex(isAction);
    const hasPriorAction = priorVerb >= 0 && !before.slice(priorVerb + 1).some(item => ['and', 'or'].includes(item.lemma));
    const hasLaterAction = after.slice(nounAt + 1).some(isAction);
    return !hasPriorAction && !hasLaterAction;
  });
}

function words(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_./:#-]+/gu, ' ').toLowerCase();
}

function termMatcher(): (value: string, term: string) => boolean {
  const patterns = new Map<string, RegExp>();
  return (value, term) => {
  // Match words and ordinary inflections, not arbitrary substrings inside a
  // different identifier (for example, an icon name ending in a digit).
  let pattern = patterns.get(term);
  if (!pattern) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    // Normalize both the question form and identifier form. Wink can return
    // an incomplete lemma for gerunds (e.g. routing → rout); retaining the
    // plausible silent-e form lets it match route, routed and router too.
    const bases = new Set([escaped]);
    if (escaped.length > 5 && escaped.endsWith('ing')) {
      const base = escaped.slice(0, -3); bases.add(base); bases.add(base + 'e');
    }
    if (escaped.length > 4 && escaped.endsWith('ed')) {
      const base = escaped.slice(0, -2); bases.add(base); bases.add(base + 'e');
    }
    const variants = new Set<string>();
    for (const base of bases) {
      const stem = base.endsWith('e') ? base.slice(0, -1) : base;
      for (const form of [base, base + 's', base + 'ed', stem + 'ed', base + 'ing', stem + 'ing', stem + 'er', stem + 'ers']) variants.add(form);
    }
    pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${[...variants].join('|')})(?=$|[^\\p{L}\\p{N}_])`, 'u');
    patterns.set(term, pattern);
  }
  return pattern.test(value);
  };
}

type MatchedSourceLine = { text: string; line: number | null; groups: number; groupIndexes: number[] };
/** Match one source fact by syntax and line, without attributing nested callables to their creator. */
function matchedSourceLines(node: GraphNode, termGroups: string[][], includesTerm: (value: string, term: string) => boolean): { lines: MatchedSourceLine[]; nestedCallable: boolean } {
  const value = node.value && typeof node.value === 'object' && !Array.isArray(node.value)
    ? node.value as { nestedCallable?: boolean; sourceLine?: unknown; rawStartLine?: unknown; expressionStructure?: unknown; predicateStructure?: unknown } : null;
  const startLine = typeof value?.rawStartLine === 'number' ? value.rawStartLine : typeof value?.sourceLine === 'number' ? value.sourceLine : Number(/:(\d+)(?::|$)/u.exec(node.locator)?.[1] ?? 0);
  const raw = node.raw ?? '', rawLines = raw.split(/\r?\n/u), groupsByLine = new Map<number, Set<number>>();
  const addLineTerms = (text: string, index: number) => {
    const normalized = words(text), groups = groupsByLine.get(index) ?? new Set<number>();
    for (const [groupIndex, group] of termGroups.entries()) if (group.some(term => includesTerm(normalized, words(term)))) groups.add(groupIndex);
    if (groups.size) groupsByLine.set(index, groups);
  };
  type SyntaxPart = { kind?: unknown; start?: unknown; text?: unknown; children?: unknown };
  const syntax = (value?.expressionStructure ?? value?.predicateStructure) as SyntaxPart | undefined;
  let nestedCallable = value?.nestedCallable === true;
  if (syntax && typeof syntax.start === 'number') {
    const starts = [0];
    for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') starts.push(i + 1);
    const lineIndex = (offset: number) => {
      let low = 0, high = starts.length;
      while (low < high) { const middle = (low + high) >>> 1; if (starts[middle]! <= offset) low = middle + 1; else high = middle; }
      return Math.max(0, low - 1);
    };
    const stack: SyntaxPart[] = [syntax];
    while (stack.length) {
      const part = stack.pop()!;
      if (typeof part.kind === 'string' && ['ArrowFunction', 'FunctionExpression', 'FunctionDeclaration', 'MethodDeclaration'].includes(part.kind)) { nestedCallable = true; continue; }
      if (Array.isArray(part.children) && part.children.length) { stack.push(...part.children as SyntaxPart[]); continue; }
      if (typeof part.text !== 'string' || typeof part.start !== 'number') continue;
      const first = lineIndex(Math.max(0, part.start - syntax.start));
      for (const [index, text] of part.text.split(/\r?\n/u).entries()) addLineTerms(text, first + index);
    }
  } else rawLines.forEach(addLineTerms);
  const lines = [...groupsByLine].sort(([left], [right]) => left - right).flatMap(([index, groups]) => {
    const text = rawLines[index];
    return text === undefined ? [] : [{ text: text.trim(), line: startLine ? startLine + index : null, groups: groups.size, groupIndexes: [...groups] }];
  });
  return { lines, nestedCallable };
}

function containsName(question: string, name: string, caseSensitive = false): boolean {
  const haystack = caseSensitive ? question : question.toLowerCase();
  const needle = caseSensitive ? name : name.toLowerCase();
  if (needle.length < 2) return false;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = haystack[index - 1] ?? '';
    const after = haystack[index + needle.length] ?? '';
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

export const GRAPH_SUBJECT_KINDS = new Set(['function', 'method', 'constructor', 'class', 'interface', 'type', 'declaration', 'file', 'route', 'api', 'feature', 'capability', 'surface', 'ui-element', 'dom-interaction', 'interaction-handler', 'provider', 'mcp-tool', 'tool-registration', 'rpc-call', 'http-call', 'sql-function', 'sql-procedure', 'call-reference', 'variable-reference', 'parameter', 'argument', 'source-binding']);

type ActionFactMatch = { subjectId: string; factId: string; line: number | null; actionGroups: number[]; objectGroups: number[]; language?: { requested: string; word: string; relation: 'literal' | 'synonym' | 'hypernym'; sense?: string | number; relatedSense?: string | number; siteId: string; declarationId: string; sourceEdgeId: string; signatureEdgeId: string } };
type SubjectSelection = { actionFacts: Map<string, ActionFactMatch[]>; subjects: GraphNode[]; excludedWeakerMatches: number; matchedTermGroups: Map<string, number>; matchedGroupIndexes: Map<string, number[]>; matchedNameGroups: Map<string, number>; fullyDescribedSubjects: Set<string>; selection: 'repository' | 'scope' | 'exact-name' | 'terms' | 'none' };
const plannedSelections = new WeakMap<IntelligenceGraph, Map<string, SubjectSelection>>();

function selectSubjects(graph: IntelligenceGraph, input: GraphFilterInput, language: ReturnType<typeof interpretGraphLanguage>, byId: Map<string, GraphNode>, familyOf: (node: GraphNode) => GraphFamilyMembership[], includesTerm: (value: string, term: string) => boolean, preferTestSources: boolean, kinds: Set<string>): SubjectSelection {
  let eligible = graph.nodes.filter(node => kinds.size ? kinds.has(node.kind) : GRAPH_SUBJECT_KINDS.has(node.kind));
  // Classifications are graph vocabulary, not question-specific dispatch.
  // If a graph classification appears in the question, treat it as a
  // constraint on subjects while retaining the remaining ordinary terms.
  const lexicalVerbs = language.tokens.filter(token => token.partOfSpeech === 'VERB'
    && !['be', 'have', 'do', 'show', 'list', 'find', 'give', 'tell'].includes(token.lemma));
  if (!kinds.size) {
    const questionWords = words(input.text);
    const tags = new Set(indexedNodeTags(graph, GRAPH_SUBJECT_KINDS) ?? eligible.flatMap(node => node.tags ?? []));
    const matchedTags = [...tags].filter(tag => {
      const parts = words(tag).split(/\s+/u).filter(part => part.length > 1);
      return parts.length > 0 && parts.every(part => includesTerm(questionWords, part))
        && (parts.length > 1 || language.terms.includes(parts[0]!));
    });
    const subjectTags = matchedTags.filter(tag => {
      const parts = words(tag).split(/\s+/u).filter(part => part.length > 1);
      const firstVerb = lexicalVerbs[0]?.start ?? Number.POSITIVE_INFINITY;
      return parts.every(part => language.tokens.some(token => token.start < firstVerb
        && includesTerm(words(token.text), part)));
    });
    if (subjectTags.length) eligible = eligible.filter(node => subjectTags.every(tag => node.tags?.includes(tag)));
  }
  let subjects: GraphNode[] = [];
  let excludedWeakerMatches = 0;
  const matchedTermGroups = new Map<string, number>();
  const matchedGroupIndexes = new Map<string, number[]>();
  const matchedNameGroups = new Map<string, number>();
  const fullyDescribedSubjects = new Set<string>();
  const actionFacts = new Map<string, ActionFactMatch[]>();
  const actionTokens = requestedActionTokens(language.tokens, new Set(Object.keys(input.lexicalHints ?? {})));
  const actionGroups = new Set(language.termGroups.flatMap((group, index) => actionTokens.some(token =>
    group.includes(token.lemma)) ? [index] : []));
  const objectGroups = new Set(language.termGroups.flatMap((group, index) => language.tokens.some(token =>
    ['NOUN', 'PROPN', 'ADJ'].includes(token.partOfSpeech) && group.includes(token.lemma)) ? [index] : []));
  let selection: 'repository' | 'scope' | 'exact-name' | 'terms' | 'none' = 'none';
  // Repository is an ordinary graph scope, not a collection of question
  // templates. More specific nouns, negation and explicit filters continue
  // through the same subject/relationship selection as every other scope.
  const repositoryTerms = new Set(['project', 'repository', 'repo', 'codebase']);
  const repositoryScope = !input.scope && !language.negated && language.terms.length > 0
    && language.terms.every(term => repositoryTerms.has(term))
    && !input.nodeKinds?.length && !input.relationshipKinds?.length && !input.statuses?.length
    && !input.direction && !input.comparisonIds?.length && !input.comparisonScope
    && !input.comparisonKinds?.length && !input.conditionContains && input.conditionTruth === undefined
    && !input.effectKinds?.length && (input.depth === undefined || input.depth === 1);
  const exactScope = input.scope ? byId.get(input.scope) : undefined;
  if (repositoryScope) {
    selection = 'repository';
  } else if (exactScope) {
    subjects = !kinds.size || kinds.has(exactScope.kind) ? [exactScope] : [];
    selection = 'scope';
  } else {
    if (input.scope) {
      const scope = input.scope.replace(/\/$/u, '');
      eligible = eligible.filter(node => node.sourceId === 'repo:' + scope
        || node.sourceId.startsWith('repo:' + scope + '/') || node.locator === scope);
    }
    // A qualified identifier or distinctive source name can identify a subject.
    // Ordinary words such as "trash" and "router" describe a broader area.
    const named = eligible.flatMap(node => {
      if (!node.name) return [];
      const qualified = node.value && typeof node.value === 'object' && !Array.isArray(node.value)
        ? (node.value as { qualifiedName?: unknown }).qualifiedName : null;
      const parts = typeof qualified === 'string' ? qualified.split('.') : [];
      const qualifiedNames = parts.length > 1 ? parts.slice(0, -1).map((_, index) => parts.slice(index).join('.')) : [];
      const names = node.kind === 'file' ? [node.name, node.name.split(/[\\/]/u).at(-1) ?? ''] : [node.name, ...qualifiedNames];
      const matched = names.filter(name => (/[.:#_]/u.test(name) || /[a-z][A-Z]/u.test(name)
        || (/^[A-Z][\p{L}\p{N}_]*$/u.test(name) && containsName(input.text, name, true)))
        && containsName(input.text, name)).sort((a, b) => b.length - a.length)[0];
      return matched ? [{ node, matched }] : [];
    });
    if (named.length) {
      const longest = named.reduce((length, item) => Math.max(length, item.matched.length), 0);
      const strongest = named.filter(item => item.matched.length === longest);
      const caseMatched = strongest.filter(item => containsName(input.text, item.matched, true));
      const exact = (caseMatched.length ? caseMatched : strongest).map(item => item.node);
      // A declaration and its call occurrences are distinct subjects. Prefer
      // the declaration when present; otherwise navigate every matching site.
      const declarations = exact.filter(node => node.kind !== 'call-reference');
      subjects = declarations.length ? declarations : exact;
      selection = 'exact-name';
    } else if (language.terms.length) {
      const terms = language.terms.map(words);
      const factTerms = new Map<string, Set<string>>();
      const bestFactMatch = new Map<string, number>();
      const sourceFamilies = new Set<string>();
      const ownerNames = new Map<string, string>();
      // Keep the strongest single source span for an owner. Combining words
      // from unrelated statements or nested callback bodies can make a large
      // function look relevant even when no connected fact carries the query.
      const considerGroups = (owner: string, groups: number[]) => {
        if (!groups.length) return;
        const ownerNode = byId.get(owner);
        let name = ownerNames.get(owner);
        if (name === undefined) {
          const lexicalOwners = ownerNode ? familyOf(ownerNode).filter(member => member.roles.includes('callback'))
            .map(member => byId.get(member.id)?.name ?? '') : [];
          name = words([ownerNode?.name ?? '', ownerNode?.kind ?? '', ...lexicalOwners].join(' '));
          ownerNames.set(owner, name);
        }
        const named = new Set(language.termGroups.flatMap((group, index) =>
          group.some(term => includesTerm(name, words(term))) ? [index] : []));
        const score = groups.filter(index => !named.has(index)).length * (language.termGroups.length + 1) + groups.length;
        if (score <= (bestFactMatch.get(owner) ?? -1)) return;
        bestFactMatch.set(owner, score);
        factTerms.set(owner, new Set(groups.flatMap(index => (language.termGroups[index] ?? []).map(words))));
      };
      const sourceCallFacts = new Map<string, { owner: string; lines: MatchedSourceLine[] }>();
      const sourceFacts = graph.nodes.filter(fact => ['source-condition', 'source-effect', 'source-binding'].includes(fact.kind));
      // The planning index stores compact selection fields. Read matching
      // source records from the retained graph before inspecting their syntax;
      // a compact index row does not contain the expression structure.
      const matchingFactIds = isIndexedPlanningView(graph) ? sourceFacts.filter(fact => {
        const text = words(fact.raw ?? ''); return terms.some(term => includesTerm(text, term));
      }).map(fact => fact.id) : [];
      const hydratedFacts = new Map((matchingFactIds.length ? indexedRecords(graph, 'nodes', matchingFactIds) ?? [] : [])
        .map(fact => [fact.id, fact]));
      for (const compactFact of sourceFacts) {
        const fact = hydratedFacts.get(compactFact.id) ?? compactFact;
        const value = fact.value as { functionId?: unknown } | null;
        if (!value || typeof value.functionId !== 'string') continue;
        sourceFamilies.add(value.functionId);
        const text = words(fact.raw ?? '');
        if (!terms.some(term => includesTerm(text, term))) continue;
        const { lines } = matchedSourceLines(fact, language.termGroups, includesTerm);
        for (const line of lines) considerGroups(value.functionId, line.groupIndexes);
        if (fact.kind === 'source-effect' && (fact.value as { kind?: unknown }).kind === 'call' && lines.length) sourceCallFacts.set(fact.id, { owner: value.functionId, lines });
        // A candidate action must occur in the callee of a written source call,
        // not merely in a string, comment or unrelated statement. Pair it with
        // another question concept on that same source line; the recorded call
        // and its owning subject remain the evidence, not the word match.
        if (fact.kind === 'source-effect' && (fact.value as { kind?: unknown }).kind === 'call' && actionGroups.size && objectGroups.size
          && lines.some(line => line.groupIndexes.some(index => actionGroups.has(index))
            && line.groupIndexes.some(index => objectGroups.has(index) && !actionGroups.has(index)))) {
          const structure = (fact.value as { expressionStructure?: unknown }).expressionStructure;
          type Part = { kind?: unknown; text?: unknown; start?: unknown; children?: unknown };
          const root = structure && typeof structure === 'object' ? structure as Part : undefined;
          const stack: Part[] = root ? [root] : [];
          const source = fact.value as { rawStartLine?: unknown; sourceLine?: unknown };
          const startLine = typeof source.rawStartLine === 'number' ? source.rawStartLine : typeof source.sourceLine === 'number' ? source.sourceLine : Number(/:(\d+)(?::|$)/u.exec(fact.locator)?.[1] ?? 0);
          const callees: Array<{ text: string; line: number | null }> = [];
          while (stack.length) {
            const part = stack.pop()!;
            if (typeof part.kind === 'string' && ['ArrowFunction', 'FunctionExpression', 'FunctionDeclaration', 'MethodDeclaration'].includes(part.kind)) continue;
            const children = Array.isArray(part.children) ? part.children as Part[] : [];
            if (part.kind === 'CallExpression' && children[0]) {
              const pending = [children[0]], names: string[] = [];
              while (pending.length) { const current = pending.pop()!; if (typeof current.text === 'string') names.push(current.text); if (Array.isArray(current.children)) pending.push(...current.children as Part[]); }
              const position = typeof children[0].start === 'number' && typeof root?.start === 'number' ? Math.max(0, children[0].start - root.start) : 0;
              const line = startLine ? startLine + (fact.raw ?? '').slice(0, position).split('\n').length - 1 : null;
              callees.push({ text: words(names.join(' ')), line });
            }
            stack.push(...children);
          }
          for (const line of lines) {
            const actions = line.groupIndexes.filter(index => actionGroups.has(index)
              && language.termGroups[index]!.some(term => callees.some(callee => callee.line === line.line && includesTerm(callee.text, words(term)))));
            const objects = line.groupIndexes.filter(index => objectGroups.has(index) && !actionGroups.has(index));
            if (!actions.length || !objects.length) continue;
            const matches = actionFacts.get(value.functionId) ?? [];
            matches.push({ subjectId: value.functionId, factId: fact.id, line: line.line, actionGroups: actions, objectGroups: objects });
            actionFacts.set(value.functionId, matches);
          }
        }
      }
      // Related language only proposes a candidate. Require an actual source
      // expression linked to that exact call, its resolved declaration, and
      // distinct object context in the expression and its lexical owner.
      const callSources = new Map<string, Array<{ factId: string; edgeId: string; owner: string; lines: MatchedSourceLine[] }>>();
      for (const edge of graph.edges) if (edge.kind === 'contains-source-call' && edge.status === 'resolved' && edge.from && edge.to) {
        const source = sourceCallFacts.get(edge.from); if (!source) continue;
        const list = callSources.get(edge.to) ?? []; list.push({ ...source, factId: edge.from, edgeId: edge.id }); callSources.set(edge.to, list);
      }
      for (const edge of graph.edges) if (edge.kind === 'has-declared-signature' && edge.status === 'resolved' && edge.from && edge.to) {
        const declaration = byId.get(edge.to);
        const description = declaration?.value && typeof declaration.value === 'object' && !Array.isArray(declaration.value)
          ? (declaration.value as { description?: unknown }).description : undefined;
        if (typeof description !== 'string') continue;
        const firstClause = words((description.trim().split(/(?<=[.!?])\s+|[,;:]/u)[0] ?? '').replace(/`[^`]*`/gu, ' '));
        for (const source of callSources.get(edge.from) ?? []) {
          const owner = byId.get(source.owner);
          const lexical = owner ? familyOf(owner).filter(member => member.roles.includes('callback')).map(member => byId.get(member.id)?.name ?? '') : [];
          const ownerWords = words([owner?.name ?? '', ...lexical].join(' '));
          const ownerObjects = [...objectGroups].filter(index => language.termGroups[index]!.some(term => includesTerm(ownerWords, words(term))));
          for (const [requested, hints] of Object.entries(input.lexicalHints ?? {})) {
            const actionIndex = language.termGroups.findIndex(group => group.includes(requested));
            if (!actionGroups.has(actionIndex)) continue;
            const hint = includesTerm(firstClause, words(requested))
              ? { word: requested, relation: 'literal' as const }
              : hints.find(item => includesTerm(firstClause, words(item.word)));
            if (!hint) continue;
            for (const line of source.lines) {
              const direct = line.groupIndexes.filter(index => objectGroups.has(index) && !actionGroups.has(index));
              const objects = [...new Set([...direct, ...ownerObjects])];
              if (!direct.length || !ownerObjects.some(index => !direct.includes(index))) continue;
              const matches = actionFacts.get(source.owner) ?? [];
              matches.push({ subjectId: source.owner, factId: source.factId, line: line.line, actionGroups: [actionIndex], objectGroups: objects,
                language: { requested, ...hint, siteId: edge.from, declarationId: edge.to, sourceEdgeId: source.edgeId, signatureEdgeId: edge.id } });
              actionFacts.set(source.owner, matches);
            }
          }
        }
      }
      // A written occurrence contributes the concepts on that occurrence;
      // unrelated sites do not become one artificial match.
      for (const edge of graph.edges) {
        if (edge.kind === 'has-declared-signature' && edge.status === 'resolved' && edge.from && edge.to) {
          const site = byId.get(edge.from), declaration = byId.get(edge.to);
          const owner = site?.value && typeof site.value === 'object' && !Array.isArray(site.value)
            ? (site.value as { functionId?: unknown }).functionId : null;
          const description = declaration?.value && typeof declaration.value === 'object' && !Array.isArray(declaration.value)
            ? (declaration.value as { description?: unknown }).description : null;
          if (typeof owner === 'string' && typeof description === 'string') {
            const text = words([site?.name ?? '', description].join(' '));
            considerGroups(owner, language.termGroups.flatMap((group, index) => group.some(term => includesTerm(text, words(term))) ? [index] : []));
          }
          continue;
        }
        if (edge.status === 'unresolved' || !edge.from || !edge.to
          || (edge.kind !== 'has-source-occurrence' && edge.kind !== 'calls-site')) continue;
        const site = byId.get(edge.to);
        if (!site?.name || (site.kind !== 'variable-reference' && site.kind !== 'call-reference')) continue;
        const value = site.value && typeof site.value === 'object' && !Array.isArray(site.value)
          ? site.value as { argumentIdentifiers?: unknown } : null;
        const identifiers = Array.isArray(value?.argumentIdentifiers) ? value.argumentIdentifiers.filter((item): item is string => typeof item === 'string') : [];
        const text = words([site.name, ...identifiers].join(' '));
        const groups = language.termGroups.flatMap((group, index) => group.some(term => includesTerm(text, words(term))) ? [index] : []);
        considerGroups(edge.from, groups);
      }
      const scored: Array<{ node: GraphNode; score: number; groups: number; nameGroups: number; described: boolean }> = [];
      const questionNameWords = words(input.text).match(/[\p{L}\p{N}_]+/gu) ?? [];
      // The full graph is already in memory in this plan; rescanning the text
      // index would add a second lookup over the same subjects. A selected view
      // may use the candidates already found by its planner.
      const lexicalCandidates = isIndexedSelectedView(graph) && !isIndexedPlanningView(graph) ? indexedTextCandidates(graph, input.text, language.terms) : null;
      for (const node of eligible) {
        if (lexicalCandidates && !lexicalCandidates.has(node.id)) continue;
        // Source occurrences are good exact subjects, but letting every call
        // site compete with its owner swamps broad feature searches.
        if ((node.kind === 'call-reference' || node.kind === 'variable-reference') && !kinds.size) continue;
        // Values remain independently selectable when named or scoped. In a
        // broad feature question, their initializer text alone should not make
        // every local value compete with the functions that own the behavior.
        if (!kinds.size && ['parameter', 'argument', 'source-binding'].includes(node.kind)
          && (!node.name || !containsName(input.text, node.name))) continue;
        const name = words(node.name ?? '');
        const nameGroups = language.termGroups.filter(group => group.some(term => includesTerm(name, words(term)))).length;
        const locator = words(node.locator);
        const raw = words(node.raw ?? '');
        const classification = words([node.kind, ...(node.tags ?? [])].join(' '));
        const descriptionValue = node.value && typeof node.value === 'object'
          ? (node.value as { description?: unknown }).description : undefined;
        const description = typeof descriptionValue === 'string' ? words(descriptionValue) : '';
        let score = 0;
        let groups = 0;
        const groupIndexes: number[] = [];
        for (const [groupIndex, group] of language.termGroups.entries()) {
          // A path is useful search context, but a word in a file name does
          // not establish that every callable in that file has that subject.
          if (group.some(term => includesTerm(name, words(term))
            || includesTerm(raw, words(term)) || includesTerm(classification, words(term)) || factTerms.get(node.id)?.has(words(term)))) { groups += 1; groupIndexes.push(groupIndex); }
        }
        // Inflected forms of one question word are alternatives, not
        // independent evidence. Score each group once per graph field so a
        // lemma plus its written form cannot outrank a different concept.
        for (const group of language.termGroups) {
          const matches = (value: string) => group.some(term => includesTerm(value, words(term)));
          if (matches(name)) score += 4;
          if (matches(locator)) score += 2;
          if (matches(raw)) score += 1;
          if (matches(classification)) score += 3;
          if (group.some(term => factTerms.get(node.id)?.has(words(term)))) score += 3;
        }
        // A consecutive sequence of a subject's actual name is a stronger
        // binding than the same words scattered through a source expression.
        const nameWords = name.match(/[\p{L}\p{N}_]+/gu) ?? [];
        let longestRun = 0;
        for (let n = 0; n < nameWords.length; n++) for (let q = 0; q < questionNameWords.length; q++) {
          let run = 0;
          while (nameWords[n + run] && nameWords[n + run] === questionNameWords[q + run]) run++;
          longestRun = Math.max(longestRun, run);
        }
        if (longestRun > 1) score += longestRun * 8;
        // In a noun phrase the final meaningful noun generally names the
        // subject; earlier words refine it. Prefer that name over incidental
        // matches inside a large source expression.
        const head = language.termGroups.at(-1) ?? [];
        if (head.some(term => includesTerm(name, words(term)))) score += 6;
        const described = Boolean(description && language.termGroups.every(group => group.some(term => includesTerm(description, words(term)))));
        if (described) fullyDescribedSubjects.add(node.id);
        if (score) { matchedTermGroups.set(node.id, groups); matchedGroupIndexes.set(node.id, groupIndexes); matchedNameGroups.set(node.id, nameGroups); scored.push({ node, groups, nameGroups, described, score: score
          + (['function', 'method', 'constructor'].includes(node.kind) ? 4 : 0)
          + (sourceFamilies.has(node.id) ? 10 : 0)
          + (familyOf(node).some(family => family.id === node.id) ? 4 : 0) }); }
      }
      scored.sort((a, b) => {
        const sourceOrder = Number(isWrittenTestSource(a.node.sourceId)) - Number(isWrittenTestSource(b.node.sourceId));
        return (preferTestSources ? -sourceOrder : sourceOrder) || Number(b.described) - Number(a.described)
          || b.nameGroups - a.nameGroups || b.groups - a.groups || b.score - a.score || a.node.id.localeCompare(b.node.id);
      });
      const minimum = Math.min(2, language.termGroups.length);
      const intersected = scored.filter(item => item.groups >= minimum);
      // A matched callback is a real lexical part of its owner. Retain an
      // otherwise weaker owner when the graph records that callback membership,
      // rather than pretending the callback's source words occur on the owner.
      const callbackOwners = new Set<string>();
      const connectedCallbacks = new Set<string>();
      const scoredById = new Map(scored.map(item => [item.node.id, item]));
      for (const item of scored) for (const membership of familyOf(item.node)) {
        if (!membership.roles.includes('callback') || membership.id === item.node.id || !scoredById.has(membership.id)) continue;
        const concepts = new Set([...(matchedGroupIndexes.get(item.node.id) ?? []), ...(matchedGroupIndexes.get(membership.id) ?? [])]);
        if (concepts.size >= minimum) { callbackOwners.add(membership.id); connectedCallbacks.add(item.node.id); }
      }
      const constrained = intersected.length > 0 || connectedCallbacks.size > 0;
      const selected = constrained ? scored.filter(item => item.groups >= minimum || callbackOwners.has(item.node.id) || connectedCallbacks.has(item.node.id)) : scored;
      excludedWeakerMatches = constrained ? scored.length - selected.length : 0;
      subjects = selected.map(item => item.node);
      selection = 'terms';
    } else if (input.scope) {
      subjects = eligible;
      selection = 'scope';
    }
  }
  return { subjects, excludedWeakerMatches, matchedTermGroups, matchedGroupIndexes, matchedNameGroups, fullyDescribedSubjects, actionFacts, selection };
}

/** Use the same subject selection for planning and graph filtering. */
export function planGraphSubjects(graph: IntelligenceGraph, input: GraphFilterInput): SubjectSelection {
  const familyIndex = openIndexedFamilyAccess(graph);
  try {
    const memberships = familyIndex ? null : graphFamilyMemberships(graph);
    const familyOf = (node: GraphNode) => familyIndex?.get(node.id) ?? memberships?.get(node.id) ?? [];
    const language = interpretGraphLanguage(input.text);
    const preferTestSources = language.tokens.some(token => ['test', 'tests', 'spec', 'specs'].includes(token.lemma))
      || Boolean(input.scope && isWrittenTestSource(input.scope));
    return selectSubjects(graph, input, language, new Map(graph.nodes.map(node => [node.id, node])), familyOf, termMatcher(), preferTestSources, new Set(input.nodeKinds ?? []));
  } finally { familyIndex?.close(); }
}

export function rememberGraphSubjects(graph: IntelligenceGraph, input: GraphFilterInput, selection: SubjectSelection): void {
  let cache = plannedSelections.get(graph);
  if (!cache) { cache = new Map(); plannedSelections.set(graph, cache); }
  cache.set(JSON.stringify(input), selection);
}

/** Language proposes terms and exact names; selection and navigation operate
 * exclusively on the graph's existing nodes and relationships. */
export function filterGraph(graph: IntelligenceGraph, input: GraphFilterInput): Record<string, unknown> {
  const familyIndex = isIndexedSelectedView(graph) ? openIndexedFamilyAccess(graph) : null;
  try {
  const memberships = familyIndex ? null : graphFamilyMemberships(graph);
  const familyOf = (node: GraphNode) => familyIndex?.get(node.id) ?? memberships?.get(node.id) ?? [];
  const includesTerm = termMatcher();
  const language = interpretGraphLanguage(input.text);
  const preferTestSources = language.tokens.some(token => ['test', 'tests', 'spec', 'specs'].includes(token.lemma))
    || Boolean(input.scope && isWrittenTestSource(input.scope));
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const kinds = new Set(input.nodeKinds ?? []);
  let relationshipKinds = new Set(input.relationshipKinds ?? []);
  const statuses = new Set(input.statuses ?? []);
  let direction = input.direction ?? 'both';
  const planned = plannedSelections.get(graph)?.get(JSON.stringify(input))
    ?? selectSubjects(graph, input, language, byId, familyOf, includesTerm, preferTestSources, kinds);
  const { subjects, excludedWeakerMatches, matchedTermGroups, matchedGroupIndexes, matchedNameGroups, fullyDescribedSubjects, actionFacts, selection } = planned;
  // Bind action words to the graph's relationship vocabulary, then use their
  // position relative to the selected subject to choose traversal direction.
  // A symbol reference is never promoted to a call by language matching.
  const subject = subjects.length === 1 ? subjects[0] : undefined;
  const sharedName = subjects[0]?.name;
  const subjectName = subject?.name ?? (sharedName && subjects.every(node => node.name === sharedName) ? sharedName : '') ?? '';
  const nameStart = subjectName ? input.text.toLowerCase().indexOf(subjectName.toLowerCase()) : -1;
  const pronoun = nameStart < 0 && input.scope ? /\b(?:it|its|itself)\b/iu.exec(input.text) : null;
  const subjectStart = nameStart >= 0 ? nameStart : pronoun?.index ?? -1;
  const subjectEnd = subjectStart < 0 ? -1 : subjectStart + (nameStart >= 0 ? subjectName.length : pronoun![0].length);
  const operationWords = new Set(['call', 'invoke', 'reference', 'import', 'depend', 'contain', 'handle', 'construct', 'trigger', 'dispatch', 'write', 'read', 'use']);
  const operationToken = language.tokens.find(token => operationWords.has(token.lemma)
    && !(subjectStart >= 0 && token.start >= subjectStart && token.end <= subjectEnd));
  if (!relationshipKinds.size && operationToken) {
    const contracts = availableRelationshipContracts(graph);
    const matching = contracts.filter(contract => {
      const parts = contract.kind.toLowerCase().split(/[-_]/u);
      if (parts.includes('by')) return false;
      // "Use" asks for the graph's general dependency and invocation
      // relationships, not a single edge spelling.
      if (operationToken.lemma === 'use' && ['reference', 'invocation'].includes(contract.family)) return true;
      const first = parts[0] ?? '';
      const lemmas = nlp.readDoc(first).tokens().out(its.lemma as any) as string[];
      return first === operationToken.lemma || lemmas.some(lemma => lemma.toLowerCase() === operationToken.lemma);
    });
    if (matching.length) relationshipKinds = new Set(matching.map(contract => contract.kind));
  }
  if (!input.direction && operationToken && subjectStart >= 0 && relationshipKinds.size) {
    const between = input.text.slice(Math.min(operationToken.end, subjectEnd), Math.max(operationToken.start, subjectStart));
    const passive = /\bby\b/iu.test(between) || /\bby\s*\??\s*$/iu.test(input.text)
      || (operationToken.start > subjectEnd && /\b(?:is|are|was|were|be|been|being)\s*$/iu.test(input.text.slice(0, subjectStart)));
    direction = operationToken.start < subjectStart ? (passive ? 'outbound' : 'inbound') : (passive ? 'inbound' : 'outbound');
  }
  // Group term-matched subjects only when the graph directly connects them.
  // Sharing a common dependency alone does not merge unrelated workflows.
  const groupedSelection = selection === 'terms' && !language.negated && !operationToken
    && !input.relationshipKinds?.length && !input.statuses?.length && !input.direction;
  const ranked = new Map(subjects.map((node, index) => [node.id, index]));
  const parents = new Map(subjects.map(node => [node.id, node.id]));
  const groupConnections: Array<{ left: string; path: typeof graph.edges }> = [];
  const root = (id: string): string => {
    let current = id;
    while (parents.get(current) !== current) current = parents.get(current)!;
    while (id !== current) { const next = parents.get(id)!; parents.set(id, current); id = next; }
    return current;
  };
  if (groupedSelection) {
    const wantedEdges = new Set(subjects.flatMap(node => familyOf(node)
      .filter(family => parents.has(family.id) && family.roles.includes('dependency')).flatMap(family => family.via)));
    const byEdgeId = new Map(graph.edges.filter(edge => wantedEdges.has(edge.id)).map(edge => [edge.id, edge]));
    const lexical = new Map<string, typeof graph.edges>();
    const addLink = (left: string, right: string, path: typeof graph.edges): void => {
      groupConnections.push({ left, path });
      const a = root(left), b = root(right);
      if (a !== b) parents.set(b, a);
    };
    for (const edge of graph.edges) {
      if (edge.status === 'unresolved' || !edge.from || !edge.to) continue;
      if (edge.status === 'resolved' && ['handled_by', 'callback-argument'].includes(edge.kind)) {
        const edges = lexical.get(edge.from) ?? [];
        edges.push(edge); lexical.set(edge.from, edges);
      }
      if (parents.has(edge.from) && parents.has(edge.to)
        && isWrittenTestSource(byId.get(edge.from)?.sourceId ?? '') === isWrittenTestSource(byId.get(edge.to)?.sourceId ?? '')
        && ['calls', 'invokes', 'handled_by', 'implemented-by', 'exposes', 'composes'].includes(edge.kind))
        addLink(edge.from, edge.to, [edge]);
    }
    // Follow source-backed handoffs through occurrence and binding nodes.
    // Candidate component-instance links remain visibly candidate; they do
    // not become calls or proven runtime paths. Stop at each matched subject
    // so shared dependencies cannot absorb unrelated callers.
    // Group only handoffs that connect selected subjects. Conditions, effects
    // and binding references remain available as path evidence; traversing all
    // such context while forming groups can join unrelated workflows through a
    // shared value or helper.
    const groupingKinds = new Set(['has-interaction', 'registers-interaction', 'spreads-properties', 'potential-value-from', 'potentially-provided-by', 'handled_by', 'binds_to', 'calls', 'calls-site', 'resolves_to', 'invokes', 'dispatches', 'triggers', 'routes-to', 'links_to', 'registered-as', 'handles-method', 'implemented-by']);
    const handoffKinds = new Set([...BEHAVIOR_PATH_RELATIONS].filter(kind => groupingKinds.has(kind)));
    for (const kind of ['contains', 'has-argument', 'argument-for', 'has-parameter', 'has-source-binding', 'references-binding', 'candidate-sql-definition']) handoffKinds.add(kind);
    const handoffs = new Map<string, typeof graph.edges>();
    for (const edge of graph.edges) {
      if (!edge.from || !edge.to || !handoffKinds.has(edge.kind) || edge.status === 'unresolved') continue;
      if (edge.kind === 'contains' && !(byId.get(edge.to)?.kind === 'ui-element'
        && ['function', 'method', 'constructor'].includes(byId.get(edge.from)?.kind ?? ''))) continue;
      const list = handoffs.get(edge.from) ?? []; list.push(edge); handoffs.set(edge.from, list);
    }
    for (const start of subjects) {
      const queue: Array<{ id: string; path: typeof graph.edges }> = [{ id: start.id, path: [] }];
      const seen = new Set([start.id]);
      for (let i = 0; i < queue.length; i++) for (const edge of handoffs.get(queue[i]!.id) ?? []) {
        if (edge.kind === 'references-binding' && !['parameter', 'argument', 'source-binding'].includes(start.kind)) continue;
        const next = edge.to!;
        if (seen.has(next)) continue;
        seen.add(next);
        const path = [...queue[i]!.path, edge];
        const target = byId.get(next);
        if (!target || isWrittenTestSource(target.sourceId) !== isWrittenTestSource(start.sourceId)) continue;
        if (parents.has(next)) { addLink(start.id, next, path); continue; }
        const site = edge.from ? byId.get(edge.from) : undefined;
        const siteOwner = site?.value && typeof site.value === 'object' && !Array.isArray(site.value)
          ? (site.value as { functionId?: unknown }).functionId : null;
        const interactionHandler = edge.kind === 'resolves_to' && site?.kind === 'call-reference'
          && typeof siteOwner === 'string' && byId.get(siteOwner)?.name === 'callback'
          && queue[i]!.path.some(item => item.kind === 'has-interaction')
          && !queue[i]!.path.some(item => item.kind === 'resolves_to' && item.to
            && ['function', 'method'].includes(byId.get(item.to)?.kind ?? '') && byId.get(item.to)?.name !== 'callback');
        if (['call-reference', 'component-prop-binding', 'interaction-handler', 'jsx-prop-spread', 'ui-element', 'parameter', 'argument', 'source-binding', 'source-effect', 'dom-interaction', 'route', 'api', 'http-call', 'rpc-call'].includes(target.kind)
            || (target.kind === 'function' && target.name === 'callback')
            || (['function', 'method'].includes(target.kind) && (interactionHandler || ['handled_by', 'handles-method'].includes(edge.kind)))) queue.push({ id: next, path });
      }
    }
    // An inline handler/callback is a lexical component of its owner. A
    // resolved call from that component can connect two matched subjects;
    // preserve the complete path rather than creating a synthetic call.
    for (const node of subjects) for (const membership of familyOf(node)) {
      if (!parents.has(membership.id) || membership.id === node.id || !membership.roles.includes('dependency')
        || isWrittenTestSource(byId.get(membership.id)?.sourceId ?? '') !== isWrittenTestSource(node.sourceId)) continue;
      for (const id of membership.via) {
        const edge = byEdgeId.get(id);
        if (!edge || edge.status !== 'resolved' || edge.to !== node.id || !edge.from || edge.from === membership.id) continue;
        const queue: Array<{ id: string; path: typeof graph.edges }> = [{ id: membership.id, path: [] }];
        const seen = new Set([membership.id]);
        for (let i = 0; i < queue.length; i += 1) {
          const item = queue[i]!;
          if (item.id === edge.from) { addLink(membership.id, node.id, [...item.path, edge]); break; }
          for (const next of lexical.get(item.id) ?? []) if (next.to && !seen.has(next.to)
            && isWrittenTestSource(byId.get(next.to)?.sourceId ?? '') === isWrittenTestSource(node.sourceId)) {
            seen.add(next.to); queue.push({ id: next.to, path: [...item.path, next] });
          }
        }
      }
    }
  }
  const groupsByRoot = new Map<string, GraphNode[]>();
  for (const node of subjects) {
    const id = root(node.id);
    const group = groupsByRoot.get(id) ?? [];
    group.push(node); groupsByRoot.set(id, group);
  }
  const edgesByComponent = new Map<string, Map<string, (typeof graph.edges)[number]>>();
  for (const connection of groupConnections) {
    const component = root(connection.left), links = edgesByComponent.get(component) ?? new Map();
    for (const edge of connection.path) links.set(edge.id, edge);
    edgesByComponent.set(component, links);
  }
  const connectedComponents = [...groupsByRoot.values()].map(nodes => {
    nodes.sort((a, b) => ranked.get(a.id)! - ranked.get(b.id)!);
    const ids = new Set(nodes.map(node => node.id));
    const links = [...(edgesByComponent.get(root(nodes[0]!.id))?.values() ?? [])];
    const connected = new Set(links.flatMap(edge => [edge.from, edge.to]).filter((id): id is string => Boolean(id)));
    const linkNodes = [...connected].filter(id => !ids.has(id)).map(id => byId.get(id)).filter((node): node is GraphNode => Boolean(node));
    return { subjects: nodes, links, linkNodes, sourceCategory: isWrittenTestSource(nodes[0]!.sourceId) ? 'test-source' : 'other-source', rank: ranked.get(nodes[0]!.id)! };
  });
  // Connected components can span many unrelated branches through a shared
  // entry point. Present the captured paths from each matched subject to its
  // next matched subjects as independently pageable investigations. Shared
  // junctions may appear in more than one path; no synthetic edge is added.
  const lexicalMatches = (group: { anchorId: string; subjects: GraphNode[]; links: IntelligenceGraph['edges'] }) => {
    const groups = new Set(matchedGroupIndexes.get(group.anchorId) ?? []);
    let callbacks = 0;
    for (const node of group.subjects) if (node.id !== group.anchorId
      && familyOf(node).some(member => member.id === group.anchorId && member.roles.includes('callback'))) {
      callbacks += 1;
      for (const index of matchedGroupIndexes.get(node.id) ?? []) groups.add(index);
    }
    const matches = group.subjects.filter(node => node.id === group.anchorId
      || familyOf(node).some(member => member.id === group.anchorId && member.roles.includes('callback')))
      .flatMap(node => actionFacts.get(node.id) ?? []);
    // Keep the actual directed route from this anchor to a matching source
    // owner. Other recorded branches stay in the group as graph context.
    const outgoing = new Map<string, typeof group.links>(), incoming = new Map<string, typeof group.links>();
    for (const edge of group.links) if (edge.from && edge.to) {
      const forward = outgoing.get(edge.from) ?? []; forward.push(edge); outgoing.set(edge.from, forward);
      const reverse = incoming.get(edge.to) ?? []; reverse.push(edge); incoming.set(edge.to, reverse);
    }
    const reachable = new Set([group.anchorId]), queue = [group.anchorId];
    for (let at = 0; at < queue.length; at++) for (const edge of outgoing.get(queue[at]!) ?? [])
      if (edge.to && !reachable.has(edge.to)) { reachable.add(edge.to); queue.push(edge.to); }
    const pathMatches = matches.filter(match => reachable.has(match.subjectId));
    const actions = new Set(pathMatches.flatMap(match => match.actionGroups));
    const objects = new Set(pathMatches.flatMap(match => match.objectGroups));
    const modifiers = [...objects].filter(index => language.tokens.some(token => token.partOfSpeech === 'ADJ'
      && language.termGroups[index]?.includes(token.lemma))).length;
    const targets = [...new Set(pathMatches.map(match => match.subjectId))];
    const backwards = new Set(targets), pending = [...targets], actionPathEdgeIds = new Set<string>();
    for (let at = 0; at < pending.length; at++) for (const edge of incoming.get(pending[at]!) ?? []) {
      if (!edge.from || !reachable.has(edge.from)) continue;
      actionPathEdgeIds.add(edge.id);
      if (!backwards.has(edge.from)) { backwards.add(edge.from); pending.push(edge.from); }
    }
    return { groups: groups.size, callbacks, actionFacts: pathMatches, actions: actions.size, objects: objects.size, modifiers,
      actionPathEdgeIds: targets.length ? [...actionPathEdgeIds] : null };
  };
  const lexicalMatchCache = new WeakMap<object, ReturnType<typeof lexicalMatches>>();
  const lexicalMatch = (group: { anchorId: string; subjects: GraphNode[]; links: IntelligenceGraph['edges'] }) => {
    let match = lexicalMatchCache.get(group);
    if (!match) { match = lexicalMatches(group); lexicalMatchCache.set(group, match); }
    return match;
  };
  const connectedGroups = connectedComponents.flatMap(component => {
    if (!component.links.length) return [{ ...component, anchorId: component.subjects[0]!.id }];
    const members = new Map(component.subjects.map(node => [node.id, node]));
    const outgoing = new Map<string, typeof graph.edges>();
    for (const edge of component.links) if (edge.from && edge.to) {
      const list = outgoing.get(edge.from) ?? []; list.push(edge); outgoing.set(edge.from, list);
    }
    const represented = new Set<string>();
    const paths: Array<typeof component & { anchorId: string }> = [];
    for (const anchor of component.subjects) {
      const queue = [anchor.id], expanded = new Set(queue), found = new Set<string>();
      const visitedEdges: typeof graph.edges = [];
      for (let at = 0; at < queue.length; at++) for (const edge of outgoing.get(queue[at]!) ?? []) {
        if (!edge.to) continue;
        visitedEdges.push(edge);
        // A matched subject can also be an intermediate step. Keep walking
        // its actual outgoing connections so a captured endpoint, handler and
        // implementation do not become separate disconnected fragments.
        if (members.has(edge.to) && edge.to !== anchor.id) found.add(edge.to);
        if (!expanded.has(edge.to)) { expanded.add(edge.to); queue.push(edge.to); }
      }
      if (!found.size) continue;
      const incoming = new Map<string, typeof graph.edges>();
      for (const edge of visitedEdges) if (edge.to) {
        const list = incoming.get(edge.to) ?? []; list.push(edge); incoming.set(edge.to, list);
      }
      const reverse = [...found], seen = new Set(reverse), selected = new Map<string, (typeof graph.edges)[number]>();
      for (let at = 0; at < reverse.length; at++) for (const edge of incoming.get(reverse[at]!) ?? []) {
        selected.set(edge.id, edge);
        if (edge.from && !seen.has(edge.from)) { seen.add(edge.from); reverse.push(edge.from); }
      }
      const links = [...selected.values()];
      const subjects = [anchor, ...[...found].filter(id => id !== anchor.id).map(id => members.get(id)!)];
      for (const node of subjects) represented.add(node.id);
      const ids = new Set(subjects.map(node => node.id));
      const connected = new Set(links.flatMap(edge => [edge.from, edge.to]).filter((id): id is string => Boolean(id)));
      const linkNodes = [...connected].filter(id => !ids.has(id)).map(id => byId.get(id)).filter((node): node is GraphNode => Boolean(node));
      paths.push({ subjects, links, linkNodes, sourceCategory: component.sourceCategory,
        rank: ranked.get(anchor.id)!, anchorId: anchor.id });
    }
    for (const node of component.subjects) if (!represented.has(node.id)) paths.push({ subjects: [node], links: [], linkNodes: [],
      sourceCategory: component.sourceCategory, rank: ranked.get(node.id)!, anchorId: node.id });
    return paths;
  }).sort((a, b) => {
    const sourceOrder = Number(a.sourceCategory === 'test-source') - Number(b.sourceCategory === 'test-source');
    // Rank the number of matched concepts before name-only matches. At equal
    // concept coverage, a captured path provides more context than an isolated
    // name; all paths remain pageable and connectivity is not proof of relevance.
    return (preferTestSources ? -sourceOrder : sourceOrder)
      || Number(fullyDescribedSubjects.has(b.anchorId)) - Number(fullyDescribedSubjects.has(a.anchorId))
      || lexicalMatch(b).actions - lexicalMatch(a).actions
      || lexicalMatch(b).modifiers - lexicalMatch(a).modifiers
      || lexicalMatch(b).objects - lexicalMatch(a).objects
      || lexicalMatch(b).groups - lexicalMatch(a).groups
      || Number(lexicalMatch(b).callbacks > 0) - Number(lexicalMatch(a).callbacks > 0)
      || Number(b.links.length > 0) - Number(a.links.length > 0)
      || (matchedNameGroups.get(b.anchorId) ?? 0) - (matchedNameGroups.get(a.anchorId) ?? 0)
      || a.rank - b.rank;
  });
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Graph page size must be a positive integer');
  const groupPage = groupedSelection ? connectedGroups.slice(offset, offset + limit) : [];
  const connectedAtRanking = new Map(groupPage.map(group => [group, group.links.length > 0]));
  // An interaction point is itself a meaningful selected subject. Continue
  // through its captured binding and inline callback occurrences even when
  // those nodes do not happen to match the question's words. Stop at named
  // callable targets: their other workflows are not part of this handoff.
  const interactionEdges = new Map<string, typeof graph.edges>();
  let interactionFrontier = new Set(groupPage.flatMap(group => group.subjects.filter(node => node.kind === 'ui-element').map(node => node.id)));
  for (const kind of ['has-interaction', 'binds_to', 'calls-site', 'resolves_to']) {
    if (!interactionFrontier.size) break;
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.kind !== kind || !edge.from || !edge.to || edge.status === 'unresolved' || !interactionFrontier.has(edge.from)) continue;
      const list = interactionEdges.get(edge.from) ?? [];
      list.push(edge); interactionEdges.set(edge.from, list); next.add(edge.to);
    }
    interactionFrontier = next;
  }
  for (const group of groupPage) {
    const existing = new Set(group.links.map(edge => edge.id));
    const members = new Set(group.subjects.map(node => node.id));
    const linkNodes = new Map(group.linkNodes.map(node => [node.id, node]));
    const queue = group.subjects.filter(node => node.kind === 'ui-element').map(node => node.id);
    const seen = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const from = byId.get(queue[i]!);
      for (const edge of interactionEdges.get(queue[i]!) ?? []) {
        const to = byId.get(edge.to!);
        if (!from || !to || isWrittenTestSource(to.sourceId) !== isWrittenTestSource(from.sourceId)) continue;
        const valid = (from.kind === 'ui-element' && edge.kind === 'has-interaction' && to.kind === 'interaction-handler')
          || (from.kind === 'interaction-handler' && edge.kind === 'binds_to' && ['function', 'method'].includes(to.kind))
          || (from.kind === 'function' && from.name === 'callback' && edge.kind === 'calls-site' && to.kind === 'call-reference')
          || (from.kind === 'call-reference' && edge.kind === 'resolves_to' && ['function', 'method', 'constructor'].includes(to.kind));
        if (!valid) continue;
        if (!existing.has(edge.id)) { existing.add(edge.id); group.links.push(edge); }
        if (!members.has(to.id)) linkNodes.set(to.id, to);
        if (!seen.has(to.id)) { seen.add(to.id); queue.push(to.id); }
      }
    }
    group.linkNodes = [...linkNodes.values()];
  }
  const subjectPage = groupedSelection ? [...new Map(groupPage.flatMap(group => group.subjects).map(node => [node.id, node])).values()] : subjects.slice(offset, offset + limit);
  const subjectIds = new Set(subjects.map(node => node.id));
  const adjacentIds = new Set(subjectIds);
  const factsBySubject = new Map<string, string[]>();
  const factRelations = new Map<string, { id: string; status: string; kind: string }>();
  const summaryBySubject = new Map<string, string>();
  const depth = Math.max(1, Math.floor(input.depth ?? 1));
  let frontier = new Set(subjectIds);
  const traversed = new Set<string>();
  let depthReached = 0;
  for (let hop = 0; hop < depth && frontier.size; hop += 1) {
    const next = new Set<string>();
    for (const edge of indexedIncidentEdges(graph, frontier, direction) ?? graph.edges) {
      if ((relationshipKinds.size && !relationshipKinds.has(edge.kind)) || (statuses.size && !statuses.has(edge.status))) continue;
      const outbound = edge.from && frontier.has(edge.from) && direction !== 'inbound';
      const inbound = edge.to && frontier.has(edge.to) && direction !== 'outbound';
      if (!outbound && !inbound) continue;
      traversed.add(edge.id);
      const targets = [outbound ? edge.to : null, inbound ? edge.from : null];
      for (const id of targets) if (id && !adjacentIds.has(id)) { adjacentIds.add(id); next.add(id); }
    }
    frontier = next;
    depthReached = hop + 1;
  }
  for (const edge of graph.edges) {
    if (!edge.from || !edge.to || !adjacentIds.has(edge.from)) continue;
    if (edge.kind === 'has-condition' || edge.kind === 'has-effect' || edge.kind === 'has-source-binding'
      || (edge.kind === 'calls-site' && byId.get(edge.to)?.kind === 'call-reference')) {
      const facts = factsBySubject.get(edge.from) ?? [];
      facts.push(edge.to); factsBySubject.set(edge.from, facts);
      factRelations.set(edge.to, { id: edge.id, status: edge.status, kind: edge.kind });
    }
    if (edge.kind === 'has-source-control') summaryBySubject.set(edge.from, edge.to);
  }
  // Keep relationships among a bidirectional neighborhood alongside the
  // traversed edges, including condition requirements between source facts.
  const edges = graph.edges.filter(edge => {
    if ((relationshipKinds.size && !relationshipKinds.has(edge.kind)) || (statuses.size && !statuses.has(edge.status))) return false;
    if (traversed.has(edge.id)) return true;
    return direction === 'both' && Boolean(edge.from && edge.to && adjacentIds.has(edge.from) && adjacentIds.has(edge.to));
  });
  const allNodes: GraphNode[] = [];
  const listed = new Set<string>();
  const include = (node: GraphNode | undefined): void => {
    if (node && !listed.has(node.id)) { listed.add(node.id); allNodes.push(node); }
  };
  const familyOwners = [...subjects, ...graph.nodes.filter(node => adjacentIds.has(node.id)
    && !subjectIds.has(node.id) && factsBySubject.has(node.id)
    && (depth > 1 || familyOf(node).some(family => subjectIds.has(family.id) && family.roles.includes('callback'))))];
  for (const subject of familyOwners) {
    include(subject);
    for (const id of factsBySubject.get(subject.id) ?? []) include(byId.get(id));
  }
  for (const node of graph.nodes) if (adjacentIds.has(node.id)) include(node);
  // Return the prebuilt family for each selected subject. Membership records
  // refer to existing nodes/edges and never reinterpret a dependency as a call.
  const familySubjects = selection === 'exact-name' || selection === 'scope' ? subjects : subjectPage;
  const requestedFamilies = new Set(familySubjects.map(item => item.id));
  const familyMembers = new Map<string, Array<{ id: string; kind: string; name: string | null; locator: string; roles: string[]; via: string[]; matchedGroups: number }>>();
  function* selectedFamilyMembers(): Iterable<{ node: GraphNode; membership: ReturnType<typeof familyOf>[number] }> {
    if (familyIndex) {
      for (const { nodeId, membership } of familyIndex.members(requestedFamilies)) {
        const node = byId.get(nodeId); if (node) yield { node, membership };
      }
    } else for (const node of graph.nodes) for (const membership of familyOf(node)) yield { node, membership };
  }
  if (requestedFamilies.size) for (const { node, membership } of selectedFamilyMembers()) {
    if (!requestedFamilies.has(membership.id) || membership.id === node.id) continue;
    const items = familyMembers.get(membership.id) ?? [];
    items.push({ id: node.id, kind: node.kind, name: node.name ?? null, locator: node.locator,
      roles: membership.roles, via: membership.via,
      matchedGroups: language.termGroups.filter(group => group.some(term => includesTerm(words(node.name ?? ''), words(term)))).length });
    familyMembers.set(membership.id, items);
  }
  const families = familySubjects.map(subject => {
    const members = familyMembers.get(subject.id) ?? [];
    const priority = (roles: string[]) => roles.includes('callback') ? 0 : roles.includes('dependency') ? 1 : roles.includes('caller') ? 2 : roles.includes('related') ? 3 : 4;
    members.sort((a, b) => priority(a.roles) - priority(b.roles) || a.locator.localeCompare(b.locator) || a.id.localeCompare(b.id));
    return { id: subject.id, name: subject.name ?? subject.id, kind: subject.kind,
      locator: subject.locator, total: members.length, members: groupedSelection ? members : members.slice(offset, offset + limit),
      nextOffset: groupedSelection ? null : offset + limit < members.length ? offset + limit : null };
  });
  const negativeTerms = [...new Set(language.tokens.filter(token => token.negated)
    .flatMap(token => [token.text.toLowerCase(), token.lemma]).filter(term => term.length > 1))];
  const effectVocabulary = new Set(['call', 'return', 'write', 'throw']);
  const requestedEffects = [...new Set(language.tokens.map(token => token.lemma).filter(term => effectVocabulary.has(term)))];
  const requestedFactKinds = ['source-condition', 'source-effect'].filter(kind => language.terms.some(term =>
    includesTerm(words(kind).replace(/^source\s+/u, ''), words(term))));
  const displayedIds = new Set(subjectPage.map(node => node.id));
  const sourceOwners = groupedSelection ? familyOwners.filter(node => displayedIds.has(node.id)
    || familyOf(node).some(family => displayedIds.has(family.id) && family.roles.includes('callback')))
    : familyOwners.slice(offset, offset + limit);
  // Preserve call occurrences and their declaration bindings as one shared
  // projection. A source position orders written occurrences, not execution;
  // branches and loops still retain their separate source-control facts.
  const sourceCallIds = new Set(sourceOwners.flatMap(owner => factsBySubject.get(owner.id) ?? []));
  const callBindings = new Map<string, typeof graph.edges>();
  const externalDeclarations = new Map<string, Array<{ id: string; locator: string; description: string; edgeId: string; matchedGroups: number[] }>>();
  for (const edge of graph.edges) {
    if (edge.kind === 'has-declared-signature' && edge.status === 'resolved' && edge.from && edge.to && sourceCallIds.has(edge.from)) {
      const declaration = byId.get(edge.to);
      const description = declaration?.value && typeof declaration.value === 'object' && !Array.isArray(declaration.value)
        ? (declaration.value as { description?: unknown }).description : null;
      if (declaration && typeof description === 'string' && description) {
        const matchedGroups = language.termGroups.flatMap((group, index) => group.some(term => includesTerm(words(description), words(term))) ? [index] : []);
        const list = externalDeclarations.get(edge.from) ?? [];
        list.push({ id: declaration.id, locator: declaration.locator, description, edgeId: edge.id, matchedGroups });
        externalDeclarations.set(edge.from, list);
      }
      continue;
    }
    if (edge.kind !== 'resolves_to' || edge.status === 'unresolved' || !edge.from || !edge.to || !sourceCallIds.has(edge.from)) continue;
    const target = byId.get(edge.to);
    if (!target || !['function', 'method', 'constructor'].includes(target.kind)) continue;
    const list = callBindings.get(edge.from) ?? [];
    list.push(edge); callBindings.set(edge.from, list);
  }
  for (const edge of graph.edges) if (edge.kind === 'contains-source-call' && edge.status === 'resolved'
    && edge.from && edge.to && sourceCallIds.has(edge.from)) {
    const declarations = externalDeclarations.get(edge.to);
    if (declarations?.length) externalDeclarations.set(edge.from, declarations);
  }
  const sourceFamilies = sourceOwners.flatMap(subject => {
    const facts = (factsBySubject.get(subject.id) ?? []).map(id => byId.get(id)).filter((node): node is GraphNode => Boolean(node));
    if (!facts.length) return [];
    facts.sort((a, b) => Number((a.value as any)?.sourceOffset ?? 0) - Number((b.value as any)?.sourceOffset ?? 0)
      || Number((a.value as any)?.sourceEnd ?? 0) - Number((b.value as any)?.sourceEnd ?? 0) || a.id.localeCompare(b.id));
    const conditions = new Map(facts.filter(node => node.kind === 'source-condition')
      .map(node => [String((node.value as any)?.id ?? ''), node]));
    const projected = facts.map(node => {
      const value = node.value as { kind?: unknown; interpretation?: unknown; nestedCallable?: boolean; sourceLine?: unknown; expressionStructure?: unknown; predicateStructure?: unknown; controlContext?: unknown[]; requirementsComplete?: boolean; requiredConditions?: Array<{ conditionId: string; expectedTruth: boolean }> } | null;
      const effectKind = typeof value?.kind === 'string' ? value.kind : null;
      const { lines, nestedCallable } = matchedSourceLines(node, language.termGroups, includesTerm);
      const best = lines.reduce((maximum, line) => Math.max(maximum, line.groups), 0);
      return { id: node.id, kind: node.kind, effectKind,
        locator: node.locator, sourceId: node.sourceId, evidenceIds: node.evidenceIds ?? [], expression: node.raw,
        relationship: factRelations.get(node.id) ?? null,
        interpretation: typeof value?.interpretation === 'string' ? value.interpretation : null,
        nestedCallable, externalDeclarations: externalDeclarations.get(node.id) ?? [],
        matchedLines: lines.filter(line => line.groups === best),
        controlContext: value?.controlContext ?? [], requirementsComplete: value?.requirementsComplete ?? true,
        matchedKind: requestedFactKinds.includes(node.kind),
        matchedTerms: language.terms.filter(term => includesTerm(words(node.raw ?? ''), words(term))),
        matchedNegativeTerms: negativeTerms.filter(term => includesTerm(words(node.raw ?? ''), words(term))),
        requirements: (value?.requiredConditions ?? []).map(requirement => ({
          conditionId: requirement.conditionId, expectedTruth: requirement.expectedTruth,
          predicate: conditions.get(requirement.conditionId)?.raw ?? null,
          conditionNodeId: conditions.get(requirement.conditionId)?.id ?? null,
          evidenceIds: conditions.get(requirement.conditionId)?.evidenceIds ?? [],
        })) };
    });
    const conditionText = input.conditionContains ? words(input.conditionContains) : '';
    const effectKinds = new Set(input.effectKinds ?? []);
    const selectedFacts = projected.filter(fact => {
      if (effectKinds.size && (!fact.effectKind || !effectKinds.has(fact.effectKind))) return false;
      if (!conditionText && input.conditionTruth === undefined) return true;
      return fact.requirements.some(requirement => (!conditionText || words(requirement.predicate ?? '').includes(conditionText))
        && (input.conditionTruth === undefined || requirement.expectedTruth === input.conditionTruth));
    });
    const focusedFacts = selectedFacts.filter(fact => fact.matchedKind || fact.matchedNegativeTerms.length
      || (fact.effectKind && requestedEffects.some(effect => fact.effectKind!.split('-').includes(effect))));
    const subjectMatchedGroups = language.termGroups.flatMap((group, index) => group.some(term => includesTerm(words(subject.name ?? ''), words(term))) ? [index] : []);
    const showCalls = !language.negated && !operationToken && (selection === 'exact-name' || selection === 'scope'
      || (selection === 'terms' && subjectMatchedGroups.length >= Math.min(2, language.termGroups.length)));
    const sourceCalls = showCalls ? facts.flatMap(node => {
      if (node.kind !== 'call-reference') return [];
      const occurrence = factRelations.get(node.id);
      if (!occurrence || occurrence.status === 'unresolved') return [];
      return (callBindings.get(node.id) ?? []).map(edge => {
        const target = byId.get(edge.to!)!;
        return { occurrenceId: node.id, name: node.name ?? node.id, locator: node.locator,
          occurrenceEdgeId: occurrence.id, occurrenceStatus: occurrence.status,
          targetId: target.id, targetName: target.name ?? target.id, targetLocator: target.locator,
          bindingEdgeId: edge.id, bindingStatus: edge.status };
      });
    }) : [];
    return [{ subjectId: subject.id, subjectName: subject.name ?? subject.id,
      subjectMatchedGroups, sourceCalls,
      coverage: summaryBySubject.has(subject.id) ? byId.get(summaryBySubject.get(subject.id)!)?.value ?? null : null,
      focusedFacts, facts: selectedFacts }];
  });
  // Keep the compiler-bound local definitions behind selected source facts as
  // a graph path, including transitive initializer references. The links say
  // what a source expression references, not what executed or what value it had.
  const roots = sourceFamilies.flatMap(family => family.facts.filter(fact => (fact.matchedLines.length > 0
    || (!language.negated && (!relationshipKinds.size || direction === 'outbound')
      && (fact.matchedKind || (fact.effectKind && requestedEffects.some(effect => fact.effectKind!.split('-').includes(effect)))))
    || fact.externalDeclarations.some(declaration => declaration.matchedGroups.length > 0))
    && (fact.kind === 'source-condition' || (fact.kind === 'source-effect'
      && ['call', 'write', 'return', 'throw'].includes(fact.effectKind ?? '')
      && (fact.effectKind !== 'call' || fact.controlContext.length > 0)))).map(fact => fact.id));
  let bindingGraph = indexedBindingGraph(graph, roots);
  if (!bindingGraph) {
    const bindingEdges = new Map<string, typeof graph.edges>();
    for (const edge of graph.edges) if (edge.status === 'resolved' && edge.from && edge.to
        && ((edge.kind === 'references-binding' && byId.get(edge.to)?.kind === 'source-binding')
          || (edge.kind === 'has-source-occurrence' && byId.get(edge.from)?.kind === 'source-binding' && byId.get(edge.to)?.kind === 'source-reference')
          || (edge.kind === 'references-symbol' && byId.get(edge.from)?.kind === 'source-reference'))) {
      const list = bindingEdges.get(edge.from) ?? []; list.push(edge); bindingEdges.set(edge.from, list);
    }
    const pending = [...new Set(roots)], visited = new Set(pending), nodes = new Map<string, GraphNode>();
    const selectedEdges = new Map<string, (typeof graph.edges)[number]>();
    for (let at = 0; at < pending.length; at++) for (const edge of bindingEdges.get(pending[at]!) ?? []) {
      const target = byId.get(edge.to!);
      if (!target) continue;
      selectedEdges.set(edge.id, edge); nodes.set(target.id, target);
      if (!visited.has(target.id)) { visited.add(target.id); pending.push(target.id); }
    }
    bindingGraph = { nodes: [...nodes.values()], edges: [...selectedEdges.values()] };
  }
  const directEdges = edges.filter(edge => traversed.has(edge.id));
  // Source occurrences are distinct even when they share a callee; present
  // them in source order before bound declaration relationships.
  directEdges.sort((a, b) => {
    // Keep all callers and callees, but do not let test fixtures bury the
    // product path when the question does not ask about tests. Apply the same
    // source preference already used for broad subject selection before paging.
    const endpoint = (edge: typeof a) => direction === 'inbound'
      || (direction === 'both' && edge.to && subjectIds.has(edge.to) && (!edge.from || !subjectIds.has(edge.from)))
      ? edge.from : edge.to;
    const leftSource = byId.get(endpoint(a) ?? '')?.sourceId ?? '';
    const rightSource = byId.get(endpoint(b) ?? '')?.sourceId ?? '';
    const sourceOrder = Number(isWrittenTestSource(leftSource)) - Number(isWrittenTestSource(rightSource));
    if (sourceOrder) return preferTestSources ? -sourceOrder : sourceOrder;
    if (a.kind === 'calls-site' && b.kind !== 'calls-site') return -1;
    if (a.kind !== 'calls-site' && b.kind === 'calls-site') return 1;
    if (a.kind !== 'calls-site') return 0;
    const left = a.to ? byId.get(a.to) : undefined;
    const right = b.to ? byId.get(b.to) : undefined;
    const fileOrder = (left?.sourceId ?? '').localeCompare(right?.sourceId ?? '');
    return fileOrder || Number((left?.value as any)?.sourceOffset ?? 0) - Number((right?.value as any)?.sourceOffset ?? 0);
  });
  const relationships = directEdges.slice(offset, offset + limit).map(edge => ({ edge,
    from: edge.from ? byId.get(edge.from) ?? null : null,
    to: edge.to ? byId.get(edge.to) ?? null : null }));
  // A page of relationship results is also a navigable path projection. It
  // references the same graph records and keeps repeated nodes/cycles visible;
  // it never substitutes source order for established relationship direction.
  const pathSteps: Array<{ edgeId: string; parentId: string; nodeId: string; depth: number; reference: boolean }> = [];
  if (subject && !language.negated) {
    const pending = [{ id: subject.id, depth: 0 }], seenNodes = new Set([subject.id]), seenEdges = new Set<string>();
    const incident = new Map<string, typeof relationships>();
    for (const item of relationships) for (const id of [direction !== 'inbound' ? item.edge.from : null, direction !== 'outbound' ? item.edge.to : null]) if (id && item.edge.status !== 'unresolved') {
      const list = incident.get(id) ?? []; list.push(item); incident.set(id, list);
    }
    for (let at = 0; at < pending.length; at++) for (const { edge } of incident.get(pending[at]!.id) ?? []) {
      if (!edge.from || !edge.to || seenEdges.has(edge.id)) continue;
      const current = pending[at]!;
      const neighbor = direction !== 'inbound' && edge.from === current.id ? edge.to
        : direction !== 'outbound' && edge.to === current.id ? edge.from : null;
      if (!neighbor) continue;
      seenEdges.add(edge.id);
      const reference = seenNodes.has(neighbor);
      pathSteps.push({ edgeId: edge.id, parentId: current.id, nodeId: neighbor, depth: current.depth + 1, reference });
      if (!reference) { seenNodes.add(neighbor); pending.push({ id: neighbor, depth: current.depth + 1 }); }
    }
  }
  const pathEdgeIds = new Set(pathSteps.map(step => step.edgeId));
  const navigation = { operation: operationToken?.lemma ?? null, direction,
    relationshipKinds: [...relationshipKinds], polarity: language.negated ? 'negative' : 'positive',
    total: directEdges.length,
    relationships,
    ...(subject && !language.negated ? { path: { rootId: subject.id, steps: pathSteps,
      remainingEdgeIds: relationships.filter(item => !pathEdgeIds.has(item.edge.id)).map(item => item.edge.id) } } : {}) };
  let comparison: Record<string, unknown> | null = null;
  let comparisonTotal = 0;
  if (language.negated && !relationshipKinds.size) {
    comparison = { state: 'relationship-required', reason: 'The negative wording was recognized, but no graph relationship was selected for comparison. Select a subject and relationship or refine the request.' };
  }
  if (language.negated && relationshipKinds.size) {
    const comparisonProvided = Boolean(input.comparisonIds?.length || input.comparisonScope || input.comparisonKinds?.length);
    if (!subject) comparison = { state: 'subject-required', reason: 'Select one graph subject for the negative relationship filter.' };
    else if (!comparisonProvided) comparison = { state: 'comparison-required', reason: 'Supply the subjects or scope to compare against.' };
    else {
      const requestedIds = new Set(input.comparisonIds ?? []);
      const comparisonKinds = new Set(input.comparisonKinds ?? []);
      const comparisonScope = input.comparisonScope?.replace(/\/$/u, '');
      const candidates = graph.nodes.filter(node => (!requestedIds.size || requestedIds.has(node.id))
        && (!comparisonKinds.size || comparisonKinds.has(node.kind))
        && (!comparisonScope || node.sourceId === 'repo:' + comparisonScope || node.sourceId.startsWith('repo:' + comparisonScope + '/')));
      const facts = new Map<string, Set<string>>();
      const factIds = new Map<string, string[]>();
      for (const edge of graph.edges) {
        if (!relationshipKinds.has(edge.kind)) continue;
        const other = direction === 'inbound' && edge.to === subject.id ? edge.from
          : direction === 'outbound' && edge.from === subject.id ? edge.to
            : direction === 'both' && edge.from === subject.id ? edge.to
              : direction === 'both' && edge.to === subject.id ? edge.from : null;
        if (!other) continue;
        const states = facts.get(other) ?? new Set<string>();
        states.add(edge.status); facts.set(other, states);
        const ids = factIds.get(other) ?? [];
        ids.push(edge.id); factIds.set(other, ids);
      }
      if (depth > 1) {
        const reach = (resolvedOnly: boolean): Map<string, string[]> => {
          const visited = new Set([subject.id]);
          const paths = new Map<string, string[]>([[subject.id, []]]);
          const reached = new Map<string, string[]>();
          let current = new Set([subject.id]);
          for (let hop = 0; hop < depth && current.size; hop += 1) {
            const next = new Set<string>();
            for (const edge of indexedIncidentEdges(graph, current, direction) ?? graph.edges) {
              if (!relationshipKinds.has(edge.kind) || (resolvedOnly && edge.status !== 'resolved') || edge.status === 'unresolved') continue;
              const steps = [direction !== 'inbound' && edge.from && current.has(edge.from) ? [edge.from, edge.to] : null,
                direction !== 'outbound' && edge.to && current.has(edge.to) ? [edge.to, edge.from] : null];
              for (const step of steps) {
                const from = step?.[0], id = step?.[1];
                if (!from || !id) continue;
                const path = [...(paths.get(from) ?? []), edge.id];
                if (!reached.has(id)) reached.set(id, path);
                if (!visited.has(id)) { visited.add(id); paths.set(id, path); next.add(id); }
              }
            }
            current = next;
          }
          return reached;
        };
        const resolvedReach = reach(true), possibleReach = reach(false);
        for (const node of candidates) {
          if (resolvedReach.has(node.id)) { facts.set(node.id, new Set(['resolved'])); factIds.set(node.id, resolvedReach.get(node.id)!); }
          else if (possibleReach.has(node.id)) { facts.set(node.id, new Set(['candidate'])); factIds.set(node.id, possibleReach.get(node.id)!); }
        }
      }
      const directions = direction === 'both' ? ['inbound', 'outbound'] : [direction];
      const isCovered = (candidateId: string): boolean => depth === 1 && [...relationshipKinds].every(kind =>
        directions.every(selected => (graph.relationshipCoverage ?? []).some(coverage =>
          coverage.complete && coverage.relationshipKind === kind && coverage.subjectId === subject.id
          && coverage.direction === selected
          && (coverage.allTargets === true || coverage.comparisonIds?.includes(candidateId)))));
      const exhaustive = candidates.length > 0 && candidates.every(node => isCovered(node.id));
      const results = candidates.map(node => {
        const states = facts.get(node.id);
        const covered = isCovered(node.id);
        return { node, relationshipIds: factIds.get(node.id) ?? [], state: states?.has('resolved') ? 'related' : states?.size ? 'candidate'
          : covered ? 'not-related' : 'unknown',
          ...(covered && !states?.size ? { coverage: (graph.relationshipCoverage ?? []).filter(item =>
            item.complete && item.subjectId === subject.id && relationshipKinds.has(item.relationshipKind)
            && directions.includes(item.direction) && (item.allTargets || item.comparisonIds?.includes(node.id))) } : {}) };
      });
      comparisonTotal = results.length;
      comparison = { state: 'evaluated', total: results.length, exhaustive,
        missingIds: [...requestedIds].filter(id => !byId.has(id)),
        counts: { related: results.filter(item => item.state === 'related').length,
          candidate: results.filter(item => item.state === 'candidate').length,
          unknown: results.filter(item => item.state === 'unknown').length,
          notRelated: results.filter(item => item.state === 'not-related').length },
        matches: results.filter(item => item.state === 'not-related').slice(offset, offset + limit),
        items: results.slice(offset, offset + limit) };
    }
  }
  const sourceExtensions = new Set(subjectPage.map(node => /\.([a-z0-9]+)$/iu.exec(node.sourceId)?.[0]?.toLowerCase()).filter((value): value is string => Boolean(value)));
  const sourceAnalysis = SOURCE_ANALYSIS_SUPPORT.filter(entry => entry.extensions.some(extension => sourceExtensions.has(extension)))
    .map(entry => ({ technology: entry.technology, precision: entry.precision, basis: 'current-engine-capability', graphAnalyzerVersion: graph.analyzerVersion }));
  return {
    question: input.text,
    sourceAnalysis,
    interpretation: { engine: 'wink-nlp', tokens: language.tokens, terms: language.terms, termGroups: language.termGroups,
      negated: language.negated, negativeTerms, requestedEffects, requestedFactKinds, selection,
      ...(selection === 'terms' && subjectPage.length ? { lexicalCoverage: {
        termGroups: language.termGroups.length,
        bestDisplayedSubject: subjectPage.reduce((best, node) => Math.max(best, matchedTermGroups.get(node.id) ?? 0), 0),
        excludedWeakerMatches,
      } } : {}) },
    navigation, comparison,
    subjectTotal: subjects.length,
    subjects: subjectPage,
    ...(groupedSelection ? { connectedGroupTotal: connectedGroups.length, connectedGroups: groupPage.map(group => ({
      anchorId: group.anchorId, subjects: group.subjects, links: group.links, linkNodes: group.linkNodes, sourceCategory: group.sourceCategory,
      ranking: { descriptionMatchesAllTerms: fullyDescribedSubjects.has(group.anchorId), matchedNameGroups: matchedNameGroups.get(group.anchorId) ?? 0,
        matchedTermGroups: matchedTermGroups.get(group.anchorId) ?? 0,
        matchedLexicalTermGroups: lexicalMatch(group).groups, actionFacts: lexicalMatch(group).actionFacts,
        actionPathEdgeIds: lexicalMatch(group).actionPathEdgeIds,
        matchedConnectedTermGroups: group.subjects.reduce((max, node) => Math.max(max, matchedTermGroups.get(node.id) ?? 0), 0),
        connected: connectedAtRanking.get(group) ?? false },
    })) } : {}),
    families,
    sourceFamilies, bindingGraph,
    sourceFamilyTotal: familyOwners.filter(subject => factsBySubject.has(subject.id)).length,
    nodeTotal: allNodes.length,
    nodes: allNodes.slice(offset, offset + limit),
    edgeTotal: edges.length,
    edges: edges.slice(offset, offset + limit),
    page: { offset, limit, nextOffset: offset + limit < (groupedSelection ? connectedGroups.length : Math.max(subjects.length, familyOwners.length, allNodes.length, edges.length, comparisonTotal)) ? offset + limit : null },
    scope: { direction, depth, depthReached, furtherNodesPossible: frontier.size > 0, includesEdgesAmongNeighbors: direction === 'both',
      nodeKinds: [...kinds], relationshipKinds: [...relationshipKinds], statuses: [...statuses],
      conditionContains: input.conditionContains ?? null, conditionTruth: input.conditionTruth ?? null,
      effectKinds: input.effectKinds ?? [] },
    coverage: graph.coverage ? { completeFiles: graph.coverage.completeFiles, partialFiles: graph.coverage.partialFiles,
      failedFiles: graph.coverage.failedFiles, skippedFiles: graph.coverage.skippedFiles,
      producerCoverage: graph.producerCoverage ?? [] } : null,
  };
  } finally { familyIndex?.close(); }
}
