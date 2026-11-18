import type { IntelligenceGraph } from '../types.js';

/** A revision-bound view of graph records selected by an operation. It owns no facts. */
export function investigationSelection(graph: IntelligenceGraph, operation: string, input: {
  nodeIds?: Iterable<string>; edgeIds?: Iterable<string>; contextNodeIds?: Iterable<string>; contextEdgeIds?: Iterable<string>; page?: unknown; scope?: unknown;
} = {}) {
  const focusNodes = new Set(input.nodeIds ?? []);
  const focusEdges = new Set(input.edgeIds ?? []);
  const allEdges = new Set([...focusEdges, ...(input.contextEdgeIds ?? [])]);
  const edges = graph.edges.filter(edge => allEdges.has(edge.id));
  const nodes = new Set([...focusNodes, ...(input.contextNodeIds ?? [])]);
  for (const edge of edges) { if (edge.from) nodes.add(edge.from); if (edge.to) nodes.add(edge.to); }
  const records = graph.nodes.filter(node => nodes.has(node.id));
  const evidenceIds = new Set([...records.flatMap(node => node.evidenceIds ?? []), ...edges.flatMap(edge => edge.evidenceIds ?? [])]);
  return {
    operation,
    graph: { project: graph.project, graphId: graph.graphId, revision: graph.repositoryRevision,
      sourceState: graph.sourceState ?? null, sourceFingerprint: graph.sourceFingerprint, analyzerVersion: graph.analyzerVersion },
    focusNodeIds: records.filter(node => focusNodes.has(node.id)).map(node => node.id),
    focusEdgeIds: edges.filter(edge => focusEdges.has(edge.id)).map(edge => edge.id),
    nodes: records, edges, evidence: graph.evidence.filter(item => evidenceIds.has(item.id)),
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
  const focus = {
    nodeIds: [...subjects.map((node: any) => node.id), ...comparison.map((item: any) => item.node?.id)].filter((id: unknown): id is string => typeof id === 'string'),
    edgeIds: [...links.map((edge: any) => edge?.id), ...comparison.flatMap((item: any) => item.relationshipIds ?? [])].filter((id: unknown): id is string => typeof id === 'string'),
  };
  const contextNodeIds: string[] = (result.sourceFamilies ?? []).flatMap((family: any) => [family.subjectId,
    ...(family.facts ?? []).flatMap((fact: any) => [fact.id, ...(fact.requirements ?? []).map((requirement: any) => requirement.conditionNodeId)])])
    .filter((id: unknown): id is string => typeof id === 'string');
  const selectedNodes = new Set([...focus.nodeIds, ...contextNodeIds]);
  const factEdges = graph.edges.filter(edge => edge.from && edge.to && selectedNodes.has(edge.from) && selectedNodes.has(edge.to)
    && ['has-condition', 'has-effect', 'has-source-control', 'requires-condition'].includes(edge.kind));
  return investigationSelection(graph, 'question', { ...focus, contextNodeIds,
    contextEdgeIds: factEdges.map(edge => edge.id), page: result.page, scope: result.scope });
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
