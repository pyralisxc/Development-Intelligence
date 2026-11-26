import { BEHAVIOR_PATH_RELATIONS, isInteractionPoint } from './graphKnowledge.js';
import { createHash } from 'node:crypto';
import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { investigationSelection } from './investigation.js';
import { currentGraph } from './service.js';

// Interaction classifications are properties of canonical graph subjects;
// their presence does not establish runtime reachability.
const PATH_RELATIONS = BEHAVIOR_PATH_RELATIONS;

type Indexed = { graph: IntelligenceGraph; nodes: Map<string, GraphNode>; outgoing: Map<string, GraphEdge[]>; interactions: Map<string, GraphNode[]> };
// Disposable indexes follow the lifetime of their immutable graph snapshots.
const interactionIndexes = new WeakMap<IntelligenceGraph, Indexed>();
const affectedPairs = new WeakMap<IntelligenceGraph, WeakMap<IntelligenceGraph, Set<string>>>();
function value(node: GraphNode): Record<string, unknown> {
  return node.value && typeof node.value === 'object' && !Array.isArray(node.value) ? node.value as Record<string, unknown> : {};
}
function identity(node: GraphNode): string {
  const v = value(node);
  // Names and source identity survive ordinary line movement. Ambiguity is
  // retained when multiple occurrences share this identity.
  return JSON.stringify([node.sourceId, node.kind, node.name ?? '', v.tag ?? '', v.receiver ?? '', v.event ?? '', v.href ?? '', v.owner ?? '']);
}
function index(graph: IntelligenceGraph): Indexed {
  const cached = interactionIndexes.get(graph);
  if (cached) return cached;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const outgoing = new Map<string, GraphEdge[]>();
  const interactions = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) if (isInteractionPoint(node)) {
    const key = identity(node), group = interactions.get(key) ?? [];
    group.push(node); interactions.set(key, group);
  }
  for (const edge of graph.edges) {
    if (!edge.from || !PATH_RELATIONS.has(edge.kind)) continue;
    const group = outgoing.get(edge.from) ?? [];
    group.push(edge); outgoing.set(edge.from, group);
  }
  const indexed = { graph, nodes, outgoing, interactions };
  interactionIndexes.set(graph, indexed);
  return indexed;
}
function fact(node: GraphNode): string {
  const v = value(node);
  // Source-control expressions preserve actual conditions/effects. File hashes,
  // offsets and producer metadata do not describe a behavior by themselves.
  return JSON.stringify([identity(node), v.expression ?? v.predicate ?? null, node.kind === 'source-effect' || node.kind === 'source-condition' ? node.raw ?? null : null, v.events ?? null, v.initialValue ?? null]);
}
// A changed effect retains its connection to the same guard. Conditions use
// their source expression to distinguish different guards owned by
// one function without treating a changed effect as a removed relationship.
function connectionIdentity(node: GraphNode): string {
  return JSON.stringify([identity(node), node.kind === 'source-condition' ? node.raw ?? null : null]);
}
function pathOf(indexed: Indexed, root: GraphNode) {
  const visited = new Set<string>([root.id]), edgeIds = new Set<string>(), unresolved = new Set<string>(), facts = new Map<string, number>();
  const describeNode = (node: GraphNode) => ({ id: node.id, name: node.name ?? node.id, kind: node.kind, locator: node.locator,
    ...(['source-condition', 'source-effect', 'state-binding', 'interaction-handler', 'dom-interaction', 'jsx-prop-spread'].includes(node.kind) ? { raw: value(node).expression ?? node.raw ?? null } : {}),
    ...(node.kind === 'state-binding' ? { initialValue: value(node).initialValue ?? null } : {}),
    ...(node.kind === 'source-effect' ? { requiredConditions: value(node).requiredConditions ?? [] } : {}) });
  const descriptions = new Map<string, unknown>();
  const recordNode = (node: GraphNode): void => {
    const key = JSON.stringify(['node', fact(node)]);
    facts.set(key, (facts.get(key) ?? 0) + 1);
    if (!descriptions.has(key)) descriptions.set(key, { node: describeNode(node) });
  };
  recordNode(root);
  const queue = [root.id];
  for (let at = 0; at < queue.length; at++) {
    const from = queue[at]!;
    for (const edge of indexed.outgoing.get(from) ?? []) {
      edgeIds.add(edge.id);
      if (edge.status !== 'resolved') unresolved.add(edge.id);
      if (edge.status === 'unresolved' || !edge.to) continue;
      const target = indexed.nodes.get(edge.to);
      if (!target) { unresolved.add(edge.id); continue; }
      const item = JSON.stringify(['relationship', edge.kind, edge.status, connectionIdentity(indexed.nodes.get(from)!), connectionIdentity(target)]);
      facts.set(item, (facts.get(item) ?? 0) + 1);
      if (!descriptions.has(item)) descriptions.set(item, { edgeId: edge.id, kind: edge.kind, status: edge.status, from: describeNode(indexed.nodes.get(from)!), to: describeNode(target), evidence: edge.evidence, evidenceIds: edge.evidenceIds ?? [] });
      if (!visited.has(target.id)) { visited.add(target.id); recordNode(target); queue.push(target.id); }
    }
  }
  return { nodeIds: [...visited], edgeIds: [...edgeIds], unresolved: [...unresolved], facts, descriptions };
}
/** Reachability is a graph investigation, not an assertion that unconnected
 * source can never execute through external, dynamic or uncaptured entries. */
export function interactionReachability(graph: IntelligenceGraph, sampleLimit = 20, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Audit offset must be a non-negative integer');
  const indexed = index(graph);
  const roots = [...indexed.interactions.values()].flat();
  const visited = new Set(roots.map(node => node.id));
  const queue = [...visited];
  for (let at = 0; at < queue.length; at++) {
    for (const edge of indexed.outgoing.get(queue[at]!) ?? []) {
      if (edge.status !== 'resolved' || !edge.to || !indexed.nodes.has(edge.to) || visited.has(edge.to)) continue;
      visited.add(edge.to); queue.push(edge.to);
    }
  }
  const candidates = graph.nodes.filter(node => (node.kind === 'function' || node.kind === 'method') && !visited.has(node.id));
  return { interactionRoots: roots.length, reachedNodes: visited.size, unconnectedCallableCount: candidates.length, relationshipKinds: [...PATH_RELATIONS],
    candidates: candidates.slice(offset, offset + sampleLimit).map(node => ({ id: node.id, name: node.name, kind: node.kind, locator: node.locator })),
    page: { offset, limit: sampleLimit, total: candidates.length, nextOffset: offset + sampleLimit < candidates.length ? offset + sampleLimit : null },
    meaning: 'No resolved path using the listed behavior relationships from captured interaction points was found. This is a candidate for investigation, not proof of dead code; uncaptured entry points and dynamic connections can make source reachable.' };
}

/** Find affected roots over the entire graph before paging. Hashing semantic
 * endpoints avoids retaining a second full copy of edge records. */
function affectedInteractionKeys(left: Indexed, right: Indexed): Set<string> {
  const cached = affectedPairs.get(left.graph)?.get(right.graph);
  if (cached) return cached;
  const describe = (index: Indexed) => {
    const nodeHashes = new Map<string, string>();
    const signature = (edge: GraphEdge): string | null => {
      if (!edge.from || !edge.to) return null;
      const hash = (id: string): string => {
        const existing = nodeHashes.get(id);
        if (existing) return existing;
        const node = index.nodes.get(id);
        const computed = String(createHash('sha256').update(node ? fact(node) : id).digest('base64url'));
        nodeHashes.set(id, computed);
        return computed;
      };
      return `${edge.kind}\0${edge.status}\0${hash(edge.from)}\0${hash(edge.to)}`;
    };
    const signatures = new Map<string, number>();
    for (const edges of index.outgoing.values()) for (const edge of edges) {
      const key = signature(edge); if (key) signatures.set(key, (signatures.get(key) ?? 0) + 1);
    }
    return { signature, signatures };
  };
  const before = describe(left), after = describe(right), affected = new Set<string>();
  const collect = (index: Indexed, own: ReturnType<typeof describe>, other: ReturnType<typeof describe>) => {
    const reverse = new Map<string, string[]>(), seeds = new Set<string>();
    const roots = new Map<string, string>();
    for (const [key, nodes] of index.interactions) for (const node of nodes) roots.set(node.id, key);
    for (const edges of index.outgoing.values()) for (const edge of edges) {
      if (!edge.from || !edge.to) continue;
      const signature = own.signature(edge);
      if (signature && own.signatures.get(signature) !== other.signatures.get(signature)) seeds.add(edge.from);
      if (edge.status !== 'unresolved') {
        const previous = reverse.get(edge.to) ?? []; previous.push(edge.from); reverse.set(edge.to, previous);
      }
    }
    const visited = new Set(seeds), queue = [...seeds];
    for (let at = 0; at < queue.length; at++) {
      const id = queue[at]!, root = roots.get(id);
      if (root) affected.add(root);
      for (const prior of reverse.get(id) ?? []) if (!visited.has(prior)) { visited.add(prior); queue.push(prior); }
    }
  };
  collect(left, before, after); collect(right, after, before);
  for (const [key, nodes] of left.interactions) {
    const other = right.interactions.get(key);
    if (!other || nodes.length !== 1 || other.length !== 1 || fact(nodes[0]!) !== fact(other[0]!)) affected.add(key);
  }
  for (const key of right.interactions.keys()) if (!left.interactions.has(key)) affected.add(key);
  let pairs = affectedPairs.get(left.graph);
  if (!pairs) { pairs = new WeakMap(); affectedPairs.set(left.graph, pairs); }
  pairs.set(right.graph, affected);
  return affected;
}

function difference(left: Map<string, number>, right: Map<string, number>): Array<{ fact: string; occurrences: number }> {
  return [...left].flatMap(([fact, count]) => { const occurrences = count - (right.get(fact) ?? 0); return occurrences > 0 ? [{ fact, occurrences }] : []; });
}

// A source or subject may occur anywhere along an interaction path, including
// another file. Walk the same captured relationships backwards to find the
// interaction roots that can reach it; do not create a second kind of path.
function interactionKeysInScope(indexed: Indexed, needle: string): Set<string> {
  const roots = new Map<string, string>();
  for (const [key, nodes] of indexed.interactions) for (const node of nodes) roots.set(node.id, key);
  const queue: string[] = [];
  const visited = new Set<string>();
  for (const node of indexed.nodes.values()) {
    const sourceFact = node.kind === 'source-effect' || node.kind === 'source-condition' ? node.raw : null;
    if ([node.name, node.sourceId, node.locator, node.kind, sourceFact].some(value => value?.toLowerCase().includes(needle))) {
      visited.add(node.id); queue.push(node.id);
    }
  }
  const incoming = new Map<string, string[]>();
  for (const edges of indexed.outgoing.values()) for (const edge of edges) {
    if (!edge.from || !edge.to || edge.status === 'unresolved' || !indexed.nodes.has(edge.to)) continue;
    const parents = incoming.get(edge.to) ?? [];
    parents.push(edge.from); incoming.set(edge.to, parents);
  }
  const matched = new Set<string>();
  for (let at = 0; at < queue.length; at++) {
    const id = queue[at]!, key = roots.get(id);
    if (key) matched.add(key);
    for (const parent of incoming.get(id) ?? []) if (!visited.has(parent)) { visited.add(parent); queue.push(parent); }
  }
  return matched;
}

export function compareInteractionGraphs(base: IntelligenceGraph, head: IntelligenceGraph, offset = 0, limit = 20, scope?: string, detail: 'full' | 'summary' | 'facts' | 'base' | 'head' = 'full') {
  const includeFacts = detail === 'full' || detail === 'facts';
  const includeBase = detail === 'full' || detail === 'base', includeHead = detail === 'full' || detail === 'head';
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Parity offset and limit must be non-negative and positive integers');
  const left = index(base), right = index(head);
  const affected = affectedInteractionKeys(left, right);
  const needle = scope?.trim().toLowerCase() ?? '';
  const scoped = needle ? new Set([...interactionKeysInScope(left, needle), ...interactionKeysInScope(right, needle)]) : null;
  const keys = [...new Set([...left.interactions.keys(), ...right.interactions.keys()])]
    .filter(key => !scoped || scoped.has(key))
    .sort((a, b) => Number(affected.has(b)) - Number(affected.has(a)) || a.localeCompare(b));
  const items = keys.slice(offset, offset + limit).map(key => {
    const before = left.interactions.get(key) ?? [], after = right.interactions.get(key) ?? [];
    if (before.length > 1 || after.length > 1) return { status: 'ambiguous', before, after,
      ...(includeBase || includeHead ? { investigations: [includeBase && before.length ? investigationSelection(base, 'parity-base', { nodeIds: before.map(node => node.id) }) : null,
        includeHead && after.length ? investigationSelection(head, 'parity-head', { nodeIds: after.map(node => node.id) }) : null] } : {}),
      reason: 'Multiple interaction occurrences have the same source identity; correspondence is not established.' };
    if (!before.length || !after.length) {
      const present = before[0] ?? after[0]!;
      const graph = before.length ? base : head, indexed = before.length ? left : right;
      const path = pathOf(indexed, present);
      const selected = (before.length ? includeBase : includeHead) ? investigationSelection(graph, before.length ? 'parity-base' : 'parity-head', { nodeIds: path.nodeIds, edgeIds: path.edgeIds }) : null;
      return { status: before.length ? 'removed' : 'added', before: before[0] ?? null, after: after[0] ?? null,
        ...(includeBase || includeHead ? { investigations: before.length ? [selected, null] : [null, selected] } : {}),
        reason: 'This interaction was found on one side; coverage and source identity affect absence.' };
    }
    const previous = pathOf(left, before[0]!), current = pathOf(right, after[0]!);
    const removed = difference(previous.facts, current.facts), added = difference(current.facts, previous.facts);
    return { status: previous.nodeIds.length > 1 && current.nodeIds.length === 1 ? 'captured-connection-lost' : added.length || removed.length ? 'changed' : previous.unresolved.length || current.unresolved.length || previous.nodeIds.length === 1 || current.nodeIds.length === 1 ? 'incomplete-path' : 'same-captured-path', before: before[0], after: after[0],
      path: { beforeNodes: previous.nodeIds.length, afterNodes: current.nodeIds.length, addedFacts: added.length, removedFacts: removed.length, beforeUnresolved: previous.unresolved.length, afterUnresolved: current.unresolved.length },
      ...(includeFacts ? { changes: { added: added.map(item => ({ occurrences: item.occurrences, detail: current.descriptions.get(item.fact) })), removed: removed.map(item => ({ occurrences: item.occurrences, detail: previous.descriptions.get(item.fact) })) } } : {}),
      ...(includeBase || includeHead ? { investigations: [includeBase ? investigationSelection(base, 'parity-base', { nodeIds: previous.nodeIds, edgeIds: previous.edgeIds }) : null, includeHead ? investigationSelection(head, 'parity-head', { nodeIds: current.nodeIds, edgeIds: current.edgeIds }) : null] } : {}) };
  });
  return { project: head.project, base: { graphId: base.graphId, revision: base.repositoryRevision, sourceState: base.sourceState ?? null, sourceFingerprint: base.sourceFingerprint, coverage: base.coverage }, head: { graphId: head.graphId, revision: head.repositoryRevision, sourceState: head.sourceState ?? null, sourceFingerprint: head.sourceFingerprint, coverage: head.coverage },
    analyzerChanged: base.analyzerVersion !== head.analyzerVersion, scope: scope?.trim() || null, relationshipKinds: [...PATH_RELATIONS], potentiallyAffected: keys.filter(key => affected.has(key)).length, items, page: { offset, limit, total: keys.length, nextOffset: offset + limit < keys.length ? offset + limit : null },
    note: 'Compares captured source relationships and conditions. An unchanged captured path does not establish complete behavior; missing or ambiguous graph coverage remains visible.' };
}
export async function compareInteractionRevisions(input: { project: string; baseRef: string; ref: string; offset?: number | undefined; limit?: number | undefined; scope?: string | undefined; detail?: 'full' | 'summary' | 'facts' | 'base' | 'head'; baseGraphId?: string; headGraphId?: string }) {
  if (input.baseRef === input.ref) throw new Error('Choose two different revision targets');
  const [base, head] = await Promise.all([currentGraph(input.project, input.baseGraphId ? undefined : input.baseRef, input.baseGraphId), currentGraph(input.project, input.headGraphId ? undefined : input.ref, input.headGraphId)]);
  return compareInteractionGraphs(base, head, input.offset, input.limit, input.scope, input.detail);
}
