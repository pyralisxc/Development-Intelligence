import type { IntelligenceGraph } from '../types.js';

function duplicateIds(values: Array<{ id: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id);
    seen.add(value.id);
  }
  return [...duplicates].sort();
}

export function assertGraphIntegrity(graph: IntelligenceGraph): void {
  const duplicateNodes = duplicateIds(graph.nodes);
  if (duplicateNodes.length) throw new Error(`Graph contains duplicate node ids: ${duplicateNodes.slice(0, 12).join(', ')}`);

  const duplicateEdges = duplicateIds(graph.edges);
  if (duplicateEdges.length) throw new Error(`Graph contains duplicate edge ids: ${duplicateEdges.slice(0, 12).join(', ')}`);

  const duplicateEvidence = duplicateIds(graph.evidence);
  if (duplicateEvidence.length) throw new Error(`Graph contains duplicate evidence ids: ${duplicateEvidence.slice(0, 12).join(', ')}`);

  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const evidenceIds = new Set(graph.evidence.map(item => item.id));

  for (const node of graph.nodes) {
    for (const evidenceId of node.evidenceIds ?? []) {
      if (!evidenceIds.has(evidenceId)) throw new Error(`Graph node ${node.id} references missing evidence ${evidenceId}`);
    }
  }

  for (const edge of graph.edges) {
    if (edge.status === 'resolved' && (!edge.from || !edge.to)) {
      throw new Error(`Resolved graph edge ${edge.id} must have both endpoints`);
    }
    if (edge.from && !nodeIds.has(edge.from)) throw new Error(`Graph edge ${edge.id} references missing from-node ${edge.from}`);
    if (edge.to && !nodeIds.has(edge.to)) throw new Error(`Graph edge ${edge.id} references missing to-node ${edge.to}`);
    for (const evidenceId of edge.evidenceIds ?? []) {
      if (!evidenceIds.has(evidenceId)) throw new Error(`Graph edge ${edge.id} references missing evidence ${evidenceId}`);
    }
  }
}
