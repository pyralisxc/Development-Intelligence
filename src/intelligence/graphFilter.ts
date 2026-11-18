import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import type { GraphNode, IntelligenceGraph } from '../types.js';
import { availableRelationshipContracts } from './graphKnowledge.js';

const nlp = winkNLP(model);
const its = nlp.its;

export interface GraphFilterInput {
  text: string;
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

function interpret(text: string): { tokens: LanguageToken[]; terms: string[]; termGroups: string[][]; negated: boolean } {
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
    const stem = escaped.endsWith('e') ? escaped.slice(0, -1) : escaped;
    pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${escaped}|${escaped}s|${escaped}ed|${stem}ed|${escaped}ing|${stem}ing)(?=$|[^\\p{L}\\p{N}_])`, 'u');
    patterns.set(term, pattern);
  }
  return pattern.test(value);
  };
}

function containsName(question: string, name: string): boolean {
  const haystack = question.toLowerCase();
  const needle = name.toLowerCase();
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

const SUBJECT_KINDS = new Set(['function', 'method', 'constructor', 'class', 'interface', 'type', 'declaration', 'file', 'route', 'api', 'feature', 'capability', 'surface', 'provider', 'mcp-tool', 'tool-registration', 'rpc-call', 'http-call', 'sql-function', 'sql-procedure', 'call-reference']);

/** Language proposes terms and exact names; selection and navigation operate
 * exclusively on the graph's existing nodes and relationships. */
export function filterGraph(graph: IntelligenceGraph, input: GraphFilterInput): Record<string, unknown> {
  const includesTerm = termMatcher();
  const language = interpret(input.text);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const kinds = new Set(input.nodeKinds ?? []);
  let relationshipKinds = new Set(input.relationshipKinds ?? []);
  const statuses = new Set(input.statuses ?? []);
  let direction = input.direction ?? 'both';
  let eligible = graph.nodes.filter(node => kinds.size ? kinds.has(node.kind) : SUBJECT_KINDS.has(node.kind));
  let subjects: GraphNode[] = [];
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
    const named = eligible.filter(node => node.name
      && (/[.:#_]/u.test(node.name) || /[a-z][A-Z]/u.test(node.name))
      && containsName(input.text, node.name));
    if (named.length) {
      const longest = named.reduce((length, node) => Math.max(length, node.name!.length), 0);
      const exact = named.filter(node => node.name!.length === longest);
      // A declaration and its call occurrences are distinct subjects. Prefer
      // the declaration when present; otherwise navigate every matching site.
      const declarations = exact.filter(node => node.kind !== 'call-reference');
      subjects = declarations.length ? declarations : exact;
      selection = 'exact-name';
    } else if (language.terms.length) {
      const terms = language.terms.map(words);
      const factTerms = new Map<string, Set<string>>();
      const sourceFamilies = new Set<string>();
      for (const fact of graph.nodes) {
        if (fact.kind !== 'source-condition' && fact.kind !== 'source-effect') continue;
        const value = fact.value as { functionId?: unknown } | null;
        if (!value || typeof value.functionId !== 'string') continue;
        sourceFamilies.add(value.functionId);
        const factText = words(fact.raw ?? '');
        const matching = terms.filter(term => includesTerm(factText, term));
        if (!matching.length) continue;
        const group = factTerms.get(value.functionId) ?? new Set<string>();
        for (const term of matching) group.add(term);
        factTerms.set(value.functionId, group);
      }
      const scored: Array<{ node: GraphNode; score: number; groups: number; described: boolean }> = [];
      for (const node of eligible) {
        // Source occurrences are good exact subjects, but letting every call
        // site compete with its owner swamps broad feature searches.
        if (node.kind === 'call-reference' && !kinds.size) continue;
        const name = words(node.name ?? '');
        const locator = words(node.locator);
        const raw = words(node.raw ?? '');
        const descriptionValue = node.value && typeof node.value === 'object'
          ? (node.value as { description?: unknown }).description : undefined;
        const description = typeof descriptionValue === 'string' ? words(descriptionValue) : '';
        let score = 0;
        let groups = 0;
        for (const group of language.termGroups) {
          if (group.some(term => includesTerm(name, words(term)) || includesTerm(locator, words(term))
            || includesTerm(raw, words(term)) || factTerms.get(node.id)?.has(words(term)))) groups += 1;
        }
        for (const term of terms) {
          if (includesTerm(name, term)) score += 4;
          if (includesTerm(locator, term)) score += 2;
          if (includesTerm(raw, term)) score += 1;
          if (factTerms.get(node.id)?.has(term)) score += 3;
        }
        // In a noun phrase the final meaningful noun generally names the
        // subject; earlier words refine it. Prefer that name over incidental
        // matches inside a large source expression.
        const head = language.termGroups.at(-1) ?? [];
        if (head.some(term => includesTerm(name, words(term)))) score += 6;
        const described = Boolean(description && language.termGroups.every(group => group.some(term => includesTerm(description, words(term)))));
        if (score) scored.push({ node, groups, described, score: score
          + (['function', 'method', 'constructor'].includes(node.kind) ? 4 : 0)
          + (sourceFamilies.has(node.id) ? 2 : 0) });
      }
      scored.sort((a, b) => Number(b.described) - Number(a.described) || b.score - a.score || a.node.id.localeCompare(b.node.id));
      const minimum = Math.min(2, language.termGroups.length);
      const intersected = scored.filter(item => item.groups >= minimum);
      subjects = (intersected.length ? intersected : scored).map(item => item.node);
      selection = 'terms';
    } else if (input.scope) {
      subjects = eligible;
      selection = 'scope';
    }
  }
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
  const subjectIds = new Set(subjects.map(node => node.id));
  const adjacentIds = new Set(subjectIds);
  const factsBySubject = new Map<string, string[]>();
  const summaryBySubject = new Map<string, string>();
  const depth = Math.max(1, Math.floor(input.depth ?? 1));
  let frontier = new Set(subjectIds);
  const traversed = new Set<string>();
  let depthReached = 0;
  for (let hop = 0; hop < depth && frontier.size; hop += 1) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
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
    if (edge.kind === 'has-condition' || edge.kind === 'has-effect') {
      const facts = factsBySubject.get(edge.from) ?? [];
      facts.push(edge.to); factsBySubject.set(edge.from, facts);
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
    && (depth > 1 || (node.families ?? []).some(family => subjectIds.has(family.id) && family.roles.includes('callback'))))];
  for (const subject of familyOwners) {
    include(subject);
    for (const id of factsBySubject.get(subject.id) ?? []) include(byId.get(id));
  }
  for (const node of graph.nodes) if (adjacentIds.has(node.id)) include(node);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Graph page size must be a positive integer');
  const subjectPage = subjects.slice(offset, offset + limit);
  // Return the prebuilt family for each selected subject. Membership records
  // refer to existing nodes/edges and never reinterpret a dependency as a call.
  const familySubjects = selection === 'exact-name' || selection === 'scope' ? subjects : subjectPage;
  const requestedFamilies = new Set(familySubjects.map(item => item.id));
  const familyMembers = new Map<string, Array<{ id: string; kind: string; name: string | null; locator: string; roles: string[]; via: string[] }>>();
  if (requestedFamilies.size) for (const node of graph.nodes) for (const membership of node.families ?? []) {
    if (!requestedFamilies.has(membership.id) || membership.id === node.id) continue;
    const items = familyMembers.get(membership.id) ?? [];
    items.push({ id: node.id, kind: node.kind, name: node.name ?? null, locator: node.locator,
      roles: membership.roles, via: membership.via });
    familyMembers.set(membership.id, items);
  }
  const families = familySubjects.map(subject => {
    const members = familyMembers.get(subject.id) ?? [];
    const priority = (roles: string[]) => roles.includes('callback') ? 0 : roles.includes('dependency') ? 1 : roles.includes('caller') ? 2 : roles.includes('related') ? 3 : 4;
    members.sort((a, b) => priority(a.roles) - priority(b.roles) || a.locator.localeCompare(b.locator) || a.id.localeCompare(b.id));
    return { id: subject.id, name: subject.name ?? subject.id, kind: subject.kind,
      locator: subject.locator, total: members.length, members: members.slice(offset, offset + limit),
      nextOffset: offset + limit < members.length ? offset + limit : null };
  });
  const negativeTerms = [...new Set(language.tokens.filter(token => token.negated)
    .flatMap(token => [token.text.toLowerCase(), token.lemma]).filter(term => term.length > 1))];
  const effectVocabulary = new Set(['call', 'return', 'write', 'throw']);
  const requestedEffects = [...new Set(language.tokens.map(token => token.lemma).filter(term => effectVocabulary.has(term)))];
  const sourceFamilies = familyOwners.slice(offset, offset + limit).flatMap(subject => {
    const facts = (factsBySubject.get(subject.id) ?? []).map(id => byId.get(id)).filter((node): node is GraphNode => Boolean(node));
    if (!facts.length) return [];
    facts.sort((a, b) => Number((a.value as any)?.sourceOffset ?? 0) - Number((b.value as any)?.sourceOffset ?? 0) || a.id.localeCompare(b.id));
    const conditions = new Map(facts.filter(node => node.kind === 'source-condition')
      .map(node => [String((node.value as any)?.id ?? ''), node]));
    const projected = facts.map(node => {
      const value = node.value as { kind?: unknown; controlContext?: unknown[]; requirementsComplete?: boolean; requiredConditions?: Array<{ conditionId: string; expectedTruth: boolean }> } | null;
      const effectKind = typeof value?.kind === 'string' ? value.kind : null;
      return { id: node.id, kind: node.kind, effectKind,
        locator: node.locator, sourceId: node.sourceId, evidenceIds: node.evidenceIds ?? [], expression: node.raw,
        controlContext: value?.controlContext ?? [], requirementsComplete: value?.requirementsComplete ?? true,
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
    const focusedFacts = selectedFacts.filter(fact => fact.matchedNegativeTerms.length
      || (fact.effectKind && requestedEffects.some(effect => fact.effectKind!.split('-').includes(effect))));
    return [{ subjectId: subject.id, subjectName: subject.name ?? subject.id,
      coverage: summaryBySubject.has(subject.id) ? byId.get(summaryBySubject.get(subject.id)!)?.value ?? null : null,
      focusedFacts, facts: selectedFacts }];
  });
  const directEdges = edges.filter(edge => traversed.has(edge.id));
  // Source occurrences are distinct even when they share a callee; present
  // them in source order before bound declaration relationships.
  directEdges.sort((a, b) => {
    if (a.kind === 'calls-site' && b.kind !== 'calls-site') return -1;
    if (a.kind !== 'calls-site' && b.kind === 'calls-site') return 1;
    if (a.kind !== 'calls-site') return 0;
    const left = a.to ? byId.get(a.to) : undefined;
    const right = b.to ? byId.get(b.to) : undefined;
    const fileOrder = (left?.sourceId ?? '').localeCompare(right?.sourceId ?? '');
    return fileOrder || Number((left?.value as any)?.sourceOffset ?? 0) - Number((right?.value as any)?.sourceOffset ?? 0);
  });
  const navigation = { operation: operationToken?.lemma ?? null, direction,
    relationshipKinds: [...relationshipKinds], polarity: language.negated ? 'negative' : 'positive',
    total: directEdges.length,
    relationships: directEdges.slice(offset, offset + limit).map(edge => ({ edge,
      from: edge.from ? byId.get(edge.from) ?? null : null,
      to: edge.to ? byId.get(edge.to) ?? null : null })) };
  let comparison: Record<string, unknown> | null = null;
  let comparisonTotal = 0;
  if (language.negated && operationToken && !relationshipKinds.size) {
    comparison = { state: 'relationship-required', reason: 'Select a relationship kind for the negative filter.' };
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
            for (const edge of graph.edges) {
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
  return {
    question: input.text,
    interpretation: { engine: 'wink-nlp', tokens: language.tokens, terms: language.terms, termGroups: language.termGroups,
      negated: language.negated, negativeTerms, requestedEffects, selection },
    navigation, comparison,
    subjectTotal: subjects.length,
    subjects: subjectPage,
    families,
    sourceFamilies,
    sourceFamilyTotal: familyOwners.filter(subject => factsBySubject.has(subject.id)).length,
    nodeTotal: allNodes.length,
    nodes: allNodes.slice(offset, offset + limit),
    edgeTotal: edges.length,
    edges: edges.slice(offset, offset + limit),
    page: { offset, limit, nextOffset: offset + limit < Math.max(subjects.length, familyOwners.length, allNodes.length, edges.length, comparisonTotal) ? offset + limit : null },
    scope: { direction, depth, depthReached, furtherNodesPossible: frontier.size > 0, includesEdgesAmongNeighbors: direction === 'both',
      nodeKinds: [...kinds], relationshipKinds: [...relationshipKinds], statuses: [...statuses],
      conditionContains: input.conditionContains ?? null, conditionTruth: input.conditionTruth ?? null,
      effectKinds: input.effectKinds ?? [] },
    coverage: graph.coverage ? { completeFiles: graph.coverage.completeFiles, partialFiles: graph.coverage.partialFiles,
      failedFiles: graph.coverage.failedFiles, skippedFiles: graph.coverage.skippedFiles,
      producerCoverage: graph.producerCoverage ?? [] } : null,
  };
}
