import type { IntelligenceGraph } from '../types.js';
import { indexedIncidentEdges, indexedRecords } from './localGraphIndex.js';

/** A revision-bound view of graph records selected by an operation. It owns no facts. */
export function investigationSelection(graph: IntelligenceGraph, operation: string, input: {
  nodeIds?: Iterable<string>; edgeIds?: Iterable<string>; contextNodeIds?: Iterable<string>; contextEdgeIds?: Iterable<string>; page?: unknown; scope?: unknown;
} = {}) {
  const focusNodes = new Set(input.nodeIds ?? []);
  const focusEdges = new Set(input.edgeIds ?? []);
  const allEdges = new Set([...focusEdges, ...(input.contextEdgeIds ?? [])]);
  const edges = indexedRecords(graph, 'edges', allEdges) ?? graph.edges.filter(edge => allEdges.has(edge.id));
  const nodes = new Set([...focusNodes, ...(input.contextNodeIds ?? [])]);
  for (const edge of edges) { if (edge.from) nodes.add(edge.from); if (edge.to) nodes.add(edge.to); }
  const records = indexedRecords(graph, 'nodes', nodes) ?? graph.nodes.filter(node => nodes.has(node.id));
  const evidenceIds = new Set([...records.flatMap(node => node.evidenceIds ?? []), ...edges.flatMap(edge => edge.evidenceIds ?? [])]);
  const evidence = indexedRecords(graph, 'evidence', evidenceIds) ?? graph.evidence.filter(item => evidenceIds.has(item.id));
  return {
    operation,
    graph: { project: graph.project, graphId: graph.graphId, revision: graph.repositoryRevision,
      sourceState: graph.sourceState ?? null, sourceFingerprint: graph.sourceFingerprint, analyzerVersion: graph.analyzerVersion },
    focusNodeIds: records.filter(node => focusNodes.has(node.id)).map(node => node.id),
    focusEdgeIds: edges.filter(edge => focusEdges.has(edge.id)).map(edge => edge.id),
    nodes: records, edges, evidence,
    coverage: graph.coverage ?? null, relationshipCoverage: graph.relationshipCoverage ?? [],
    ...(input.page ? { page: input.page } : {}), ...(input.scope ? { scope: input.scope } : {}),
  };
}

/** Collect actual graph identities from an operation's observed records, never its requested expectations. */
export function observedGraphIds(graph: IntelligenceGraph, value: unknown, indexes?: { nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> }): { nodeIds: string[]; edgeIds: string[] } {
  const nodeIndex = indexes?.nodeIds ?? new Set(graph.nodes.map(node => node.id)), edgeIndex = indexes?.edgeIds ?? new Set(graph.edges.map(edge => edge.id));
  const nodes = new Set<string>(), edges = new Set<string>();
  function visit(item: unknown): void {
    if (typeof item === 'string') { if (nodeIndex.has(item)) nodes.add(item); if (edgeIndex.has(item)) edges.add(item); }
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (key !== 'expectation' && key !== 'contract' && key !== 'families' && key !== 'contributions') visit(child);
    }
  }
  visit(value);
  return { nodeIds: [...nodes], edgeIds: [...edges] };
}

export function questionSelection(graph: IntelligenceGraph, result: any) {
  const grouped = Array.isArray(result.connectedGroups);
  const subjects = grouped ? result.connectedGroups.flatMap((group: any) => group.subjects ?? []) : result.subjects ?? [];
  const links = grouped ? result.connectedGroups.flatMap((group: any) => group.links ?? [])
    : (result.navigation?.relationships ?? []).map((item: any) => item.edge);
  const comparison = result.comparison?.items ?? [];
  const callEdgeIds = (result.sourceFamilies ?? []).flatMap((family: any) => (family.sourceCalls ?? [])
    .flatMap((call: any) => [call.occurrenceEdgeId, call.bindingEdgeId]))
    .filter((id: unknown): id is string => typeof id === 'string');
  const focus = {
    nodeIds: [...subjects.map((node: any) => node.id), ...comparison.map((item: any) => item.node?.id)].filter((id: unknown): id is string => typeof id === 'string'),
    edgeIds: [...links.map((edge: any) => edge?.id), ...comparison.flatMap((item: any) => item.relationshipIds ?? []), ...callEdgeIds].filter((id: unknown): id is string => typeof id === 'string'),
  };
  // The graph follows the displayed paths and their relevant source context.
  // Other family facts remain available in result.sourceFamilies; adding all
  // of them to the visual selection can obscure the path with unrelated code.
  const contextNodeIds: string[] = (result.sourceFamilies ?? []).flatMap((family: any) => {
    const focused = new Set((family.focusedFacts ?? []).map((fact: any) => fact.id));
    const facts = (family.facts ?? []).filter((fact: any) => focused.has(fact.id)
      || fact.matchedKind || (fact.matchedLines ?? []).length
      || (fact.externalDeclarations ?? []).some((declaration: any) => (declaration.matchedGroups ?? []).length));
    return [family.subjectId, ...facts.flatMap((fact: any) => [fact.id,
      ...(fact.requirements ?? []).map((requirement: any) => requirement.conditionNodeId),
      ...(fact.externalDeclarations ?? []).map((declaration: any) => declaration.id)])];
  })
    .filter((id: unknown): id is string => typeof id === 'string');
  for (const node of result.bindingGraph?.nodes ?? []) if (typeof node.id === 'string') contextNodeIds.push(node.id);
  const selectedNodes = new Set([...focus.nodeIds, ...contextNodeIds]);
  const factEdges = (indexedIncidentEdges(graph, selectedNodes, 'outbound') ?? graph.edges).filter(edge => edge.from && edge.to && selectedNodes.has(edge.from) && selectedNodes.has(edge.to)
    && ['has-condition', 'has-effect', 'has-source-binding', 'references-binding', 'contains-source-call', 'has-declared-signature', 'has-source-control', 'requires-condition', 'calls-site'].includes(edge.kind));
  return investigationSelection(graph, 'question', { ...focus, contextNodeIds,
    contextEdgeIds: [...factEdges.map(edge => edge.id), ...(result.bindingGraph?.edges ?? []).map((edge: any) => edge.id)], page: result.page, scope: result.scope });
}

/** Select only the records on the requested page and on the appropriate side. */
export function comparisonSelection(graph: IntelligenceGraph, detail: any, side: 'base' | 'head', page?: unknown) {
  const delta = detail?.semantic ?? detail;
  const nodeIds: string[] = [], edgeIds: string[] = [];
  for (const kind of ['nodes', 'edges'] as const) for (const [change, values] of Object.entries(delta?.[kind] ?? {})) {
    if (!Array.isArray(values)) continue;
    if (side === 'base' && ['added', 'analysisAdded', 'ambiguousAdded'].includes(change)) continue;
    if (side === 'head' && ['removed', 'analysisRemoved', 'ambiguousRemoved'].includes(change)) continue;
    for (const value of values) {
      const record = value?.before && value?.after ? (side === 'base' ? value.before : value.after) : value;
      if (typeof record?.id === 'string') (kind === 'nodes' ? nodeIds : edgeIds).push(record.id);
    }
  }
  return investigationSelection(graph, 'comparison-' + side, { nodeIds, edgeIds, page });
}
