import { isEndpoint, isInteractionPoint } from './graphKnowledge.js';
import type { GraphEdge, GraphFamilyMembership, GraphNode, IntelligenceGraph } from '../types.js';
import ts from 'typescript';
import { TYPESCRIPT_COMPILER_LENS } from './typescriptCompilerLens.js';

/** A family is an existing graph subject, not a second graph. Memberships are
 * built from source-backed relationships and retain the relationship ids that
 * explain them. Calls contribute their target but do not recursively absorb the
 * target's other callers or dependencies. Nested callback bodies are lexical
 * members of their owner, independent of whether invocation was established. */
const SUBJECTS = new Set(['function', 'method', 'constructor', 'class', 'interface', 'type',
  'feature', 'capability', 'ui-element', 'dom-interaction', 'route', 'api', 'mcp', 'mcp-tool', 'tool-registration', 'rpc-call', 'http-call', 'sql-function']);
const OWNED = new Set(['has-parameter', 'has-condition', 'has-effect', 'has-source-control', 'contains-source-span', 'has-source-occurrence',
  'has-argument', 'argument-for', 'spreads-properties', 'has-interaction', 'registers-interaction', 'calls-site', 'callback-argument', 'declares']);
const DIRECT = new Set(['calls', 'invokes', 'handled_by', 'registered-as', 'implemented-by',
  'exposes', 'binds_to', 'composes', 'uses-feature', 'automated-by', 'same-routine-name', 'candidate-sql-definition']);

type Builder = { roles: Set<string>; via: Set<string> };

const familyCache = new WeakMap<IntelligenceGraph, Map<string, GraphFamilyMembership[]>>();

/** Derive navigation memberships from the graph; never persist a second copy of graph knowledge. */
export function graphFamilyMemberships(graph: IntelligenceGraph): Map<string, GraphFamilyMembership[]> {
  const cached = familyCache.get(graph);
  if (cached) return cached;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const memberships = new Map<string, Map<string, Builder>>();
  const outgoing = new Map<string, GraphEdge[]>();
  const add = (nodeId: string, familyId: string, role: string, edgeId?: string): boolean => {
    if (!nodes.has(nodeId) || !nodes.has(familyId)) return false;
    let families = memberships.get(nodeId);
    if (!families) { families = new Map(); memberships.set(nodeId, families); }
    let item = families.get(familyId);
    const created = !item;
    if (!item) { item = { roles: new Set(), via: new Set() }; families.set(familyId, item); }
    item.roles.add(role);
    if (edgeId) item.via.add(edgeId);
    return created;
  };
  for (const node of graph.nodes) if (SUBJECTS.has(node.kind)) add(node.id, node.id, 'subject');
  for (const edge of graph.edges) {
    if ((edge.status !== 'resolved' && !(edge.status === 'candidate' && edge.kind === 'candidate-sql-definition')) || !edge.from || !edge.to) continue;
    // A subject's family also exposes direct callers, without walking from
    // those callers into their other workflows.
    if (edge.kind === 'calls' && SUBJECTS.has(nodes.get(edge.to)?.kind ?? ''))
      add(edge.from, edge.to, 'caller', edge.id);
    if (!OWNED.has(edge.kind) && !DIRECT.has(edge.kind)) continue;
    const items = outgoing.get(edge.from) ?? [];
    items.push(edge); outgoing.set(edge.from, items);
  }
  const components: Array<{ node: string; family: string; callback: boolean }> = [];
  const queued = new Set<string>();
  const queueComponent = (node: string, family: string, callback: boolean): void => {
    const key = `${node}\0${family}\0${callback}`;
    if (!queued.has(key)) { queued.add(key); components.push({ node, family, callback }); }
  };
  const roleOf = (edge: GraphEdge): string => edge.status === 'candidate' ? 'candidate'
    : edge.kind === 'same-routine-name' ? 'same-name'
      : edge.kind === 'calls' || edge.kind === 'invokes' ? 'dependency'
        : edge.kind === 'callback-argument' ? 'callback' : OWNED.has(edge.kind) ? 'component' : 'related';
  for (const anchor of graph.nodes) {
    if (!SUBJECTS.has(anchor.kind)) continue;
    for (const edge of outgoing.get(anchor.id) ?? []) {
      if (!edge.to) continue;
      add(edge.to, anchor.id, roleOf(edge), edge.id);
      if (OWNED.has(edge.kind) || edge.kind === 'handled_by') queueComponent(edge.to, anchor.id, edge.kind === 'callback-argument' || edge.kind === 'handled_by');
    }
  }
  // Literal callbacks are lexically part of their caller. Follow their own
  // components and direct dependencies, but never transitively expand a shared
  // helper into every family's unrelated workflows.
  for (let index = 0; index < components.length; index += 1) {
    const current = components[index]!;
    for (const edge of outgoing.get(current.node) ?? []) {
      if (!edge.to || (!current.callback && !OWNED.has(edge.kind))) continue;
      add(edge.to, current.family, roleOf(edge), edge.id);
      if (OWNED.has(edge.kind)) queueComponent(edge.to, current.family, edge.kind === 'callback-argument');
    }
  }
  const result = new Map<string, GraphFamilyMembership[]>();
  for (const [nodeId, families] of memberships) {
    result.set(nodeId, [...families].map(([id, item]) => ({ id,
      roles: [...item.roles].sort(), via: [...item.via].sort() })).sort((a, b) => a.id.localeCompare(b.id)));
  }
  familyCache.set(graph, result);
  return result;
}

/** Attach source-derived tags and compiler contributions to graph subjects. */
export function prepareGraphSubjects(graph: IntelligenceGraph): IntelligenceGraph {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const compilerSubjects = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.status === 'resolved' && edge.kind === 'resolves_to' && edge.strategy === TYPESCRIPT_COMPILER_LENS
      && edge.from && edge.to && nodes.get(edge.from)?.kind === 'call-reference') compilerSubjects.add(edge.to);
  }
  const result: GraphNode[] = graph.nodes.map(original => {
    const { families: _old, contributions: _oldContributions, ...base } = original as GraphNode & { families?: unknown };
    const tags = new Set(original.tags ?? []);
    if (isInteractionPoint(original)) tags.add('interaction-point');
    if (isEndpoint(original)) tags.add('endpoint');
    const contributions = (original.contributions ?? []).filter(item => item.producer !== 'typescript-checker');
    if (compilerSubjects.has(original.id)) contributions.push({ producer: 'typescript-checker', version: ts.version,
      symbol: original.name ?? original.id, locator: original.locator });
    return { ...base, ...(tags.size ? { tags: [...tags] } : {}), ...(contributions.length ? { contributions } : {}) };
  });
  return { ...graph, nodes: result };
}
