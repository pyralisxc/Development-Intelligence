import { isEndpoint, isInteractionPoint } from './graphKnowledge.js';
import type { GraphEdge, GraphFamilyMembership, GraphNode, IntelligenceGraph } from '../types.js';
import ts from 'typescript';
import { TYPESCRIPT_COMPILER_LENS } from './typescriptCompilerLens.js';
import { indexedFamilyMemberships } from './localGraphIndex.js';

/** A family is an existing graph subject, not a second graph. Memberships are
 * built from source-backed relationships and retain the relationship ids that
 * explain them. Calls contribute their target but do not recursively absorb the
 * target's other callers or dependencies. Nested callback bodies are lexical
 * members of their owner, independent of whether invocation was established. */
const SUBJECTS = new Set(['function', 'method', 'constructor', 'class', 'interface', 'type',
  'feature', 'capability', 'ui-element', 'dom-interaction', 'interaction-handler', 'route', 'api', 'mcp', 'mcp-tool', 'tool-registration', 'rpc-call', 'http-call', 'sql-function']);
const OWNED = new Set(['has-parameter', 'has-condition', 'has-effect', 'has-source-binding', 'has-source-control', 'contains-source-span', 'has-source-occurrence',
  'has-argument', 'argument-for', 'spreads-properties', 'has-interaction', 'registers-interaction', 'calls-site', 'callback-argument', 'declares']);
const DIRECT = new Set(['calls', 'invokes', 'handled_by', 'registered-as', 'implemented-by',
  'exposes', 'binds_to', 'composes', 'uses-feature', 'automated-by', 'same-routine-name', 'candidate-sql-definition']);

type Builder = GraphFamilyMembership & { queued?: number };

const familyCache = new WeakMap<IntelligenceGraph, Map<string, GraphFamilyMembership[]>>();

/** Derive navigation memberships from the graph; never persist a second copy of graph knowledge. */
export function graphFamilyMemberships(graph: IntelligenceGraph): Map<string, GraphFamilyMembership[]> {
  const cached = familyCache.get(graph);
  if (cached) return cached;
  const indexed = indexedFamilyMemberships(graph);
  if (indexed) { familyCache.set(graph, indexed); return indexed; }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const memberships = new Map<string, Map<string, Builder>>();
  const outgoing = new Map<string, GraphEdge[]>();
  const lexicalUi = (edge: GraphEdge) => edge.kind === 'contains' && Boolean(edge.from && edge.to
    && ['function', 'method', 'constructor'].includes(nodes.get(edge.from)?.kind ?? '') && nodes.get(edge.to)?.kind === 'ui-element');
  const callbackBinding = (edge: GraphEdge) => edge.kind === 'binds_to' && Boolean(edge.from && edge.to
    && nodes.get(edge.from)?.kind === 'interaction-handler' && ['function', 'method'].includes(nodes.get(edge.to)?.kind ?? ''));
  const callBinding = (edge: GraphEdge) => edge.kind === 'resolves_to' && Boolean(edge.from && edge.to
    && nodes.get(edge.from)?.kind === 'call-reference' && ['function', 'method', 'constructor'].includes(nodes.get(edge.to)?.kind ?? ''));
  const owned = (edge: GraphEdge) => OWNED.has(edge.kind) || lexicalUi(edge) || callbackBinding(edge);
  const add = (nodeId: string, familyId: string, role: string, edgeId?: string): void => {
    if (!nodes.has(nodeId) || !nodes.has(familyId)) return;
    let families = memberships.get(nodeId);
    if (!families) { families = new Map(); memberships.set(nodeId, families); }
    const item = families.get(familyId);
    if (!item) {
      families.set(familyId, { id: familyId, roles: [role], via: edgeId ? [edgeId] : [] });
      return;
    }
    if (!item.roles.includes(role)) item.roles.push(role);
    if (edgeId && !item.via.includes(edgeId)) item.via.push(edgeId);
  };
  for (const node of graph.nodes) if (SUBJECTS.has(node.kind)) add(node.id, node.id, 'subject');
  for (const edge of graph.edges) {
    if (edge.status === 'unresolved' || !edge.from || !edge.to) continue;
    // A subject's family also exposes direct callers, without walking from
    // those callers into their other workflows.
    if (edge.kind === 'calls' && SUBJECTS.has(nodes.get(edge.to)?.kind ?? '')) {
      add(edge.from, edge.to, 'caller', edge.id);
      if (edge.status === 'candidate') add(edge.from, edge.to, 'candidate', edge.id);
    }
    if (!owned(edge) && !DIRECT.has(edge.kind) && !callBinding(edge)) continue;
    const items = outgoing.get(edge.from) ?? [];
    items.push(edge); outgoing.set(edge.from, items);
  }
  const components: Array<{ node: string; family: string; callback: boolean }> = [];
  const queueComponent = (node: string, family: string, callback: boolean): void => {
    const item = memberships.get(node)?.get(family);
    const state = callback ? 2 : 1;
    if (!item || ((item.queued ?? 0) & state)) return;
    item.queued = (item.queued ?? 0) | state;
    components.push({ node, family, callback });
  };
  const roleOf = (edge: GraphEdge): string => edge.status === 'candidate' ? 'candidate'
    : edge.kind === 'same-routine-name' ? 'same-name'
      : edge.kind === 'calls' || edge.kind === 'invokes' || callBinding(edge) ? 'dependency'
        : edge.kind === 'callback-argument' || callbackBinding(edge) ? 'callback' : owned(edge) ? 'component' : 'related';
  for (const anchor of graph.nodes) {
    if (!SUBJECTS.has(anchor.kind)) continue;
    for (const edge of outgoing.get(anchor.id) ?? []) {
      if (!edge.to) continue;
      add(edge.to, anchor.id, roleOf(edge), edge.id);
      if (edge.status === 'candidate' && (edge.kind === 'calls' || edge.kind === 'invokes' || callBinding(edge))) add(edge.to, anchor.id, 'dependency', edge.id);
      if (edge.status === 'candidate' && callbackBinding(edge)) add(edge.to, anchor.id, 'callback', edge.id);
      if (owned(edge) || edge.kind === 'handled_by') queueComponent(edge.to, anchor.id, edge.kind === 'callback-argument' || edge.kind === 'handled_by' || callbackBinding(edge));
    }
  }
  // Literal callbacks are lexically part of their caller. Follow their own
  // components and direct dependencies, but never transitively expand a shared
  // helper into every family's unrelated workflows.
  for (let index = 0; index < components.length; index += 1) {
    const current = components[index]!;
    for (const edge of outgoing.get(current.node) ?? []) {
      if (!edge.to || (!current.callback && !owned(edge) && !callBinding(edge))) continue;
      add(edge.to, current.family, roleOf(edge), edge.id);
      if (edge.status === 'candidate' && (edge.kind === 'calls' || edge.kind === 'invokes' || callBinding(edge))) add(edge.to, current.family, 'dependency', edge.id);
      if (edge.status === 'candidate' && callbackBinding(edge)) add(edge.to, current.family, 'callback', edge.id);
      if (owned(edge)) queueComponent(edge.to, current.family, edge.kind === 'callback-argument' || callbackBinding(edge));
    }
  }
  const result = new Map<string, GraphFamilyMembership[]>();
  for (const [nodeId, families] of memberships) {
    const records = [...families.values()].map(({ id, roles, via }) => ({
      id, roles: roles.sort(), via: via.sort(),
    }));
    result.set(nodeId, records.sort((a, b) => a.id.localeCompare(b.id)));
    memberships.delete(nodeId);
  }
  familyCache.set(graph, result);
  return result;
}

/** Attach source-derived tags and compiler contributions to graph subjects. */
export function prepareGraphSubjects(graph: IntelligenceGraph): IntelligenceGraph {
  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) if (node.kind === 'call-reference') nodes.set(node.id, node);
  const compilerSubjects = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.status === 'resolved' && edge.kind === 'resolves_to' && edge.strategy === TYPESCRIPT_COMPILER_LENS
      && edge.from && edge.to && nodes.get(edge.from)?.kind === 'call-reference') compilerSubjects.add(edge.to);
  }
  const result: GraphNode[] = graph.nodes.map(original => {
    const isInteraction = isInteractionPoint(original);
    const endpoint = isEndpoint(original);
    const hasOldFamilies = Object.hasOwn(original, 'families');
    const needsTags = (isInteraction && !original.tags?.includes('interaction-point'))
      || (endpoint && !original.tags?.includes('endpoint'));
    const hasCompilerContribution = original.contributions?.some(item => item.producer === 'typescript-checker');
    if (!hasOldFamilies && !needsTags && !hasCompilerContribution && !compilerSubjects.has(original.id)
      && (!original.tags || original.tags.length > 0) && (!original.contributions || original.contributions.length > 0)) return original;
    const { families: _old, contributions: _oldContributions, ...base } = original as GraphNode & { families?: unknown };
    const tags = new Set(original.tags ?? []);
    if (isInteraction) tags.add('interaction-point');
    if (endpoint) tags.add('endpoint');
    const contributions = (original.contributions ?? []).filter(item => item.producer !== 'typescript-checker');
    if (compilerSubjects.has(original.id)) contributions.push({ producer: 'typescript-checker', version: ts.version,
      symbol: original.name ?? original.id, locator: original.locator });
    return { ...base, ...(tags.size ? { tags: [...tags] } : {}), ...(contributions.length ? { contributions } : {}) };
  });
  return { ...graph, nodes: result };
}
