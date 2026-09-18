import type { EvidenceRecord, GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { stableHash } from '../util/hash.js';
import { graphQueryContext } from './queryContext.js';
import { currentGraph } from './service.js';

export type AssessmentStatus = 'supported' | 'contradicted' | 'unproven' | 'indeterminate';
export type RealizationFacet = 'human' | 'agent' | 'transport' | 'implementation' | 'persistence' | 'provider';

export interface ProofBundle {
  ruleId: string;
  nodeIds: string[];
  edgeIds: string[];
  evidenceIds: string[];
  evidence: EvidenceRecord[];
  coverage: { completeForEligibleSources: boolean; partial: number; failed: number; skipped: number } | null;
}

export interface IntelligenceClaim {
  id: string;
  type: 'entity-exists' | 'relationship-resolved' | 'facet-observed' | 'contract-facet';
  status: AssessmentStatus;
  statement: string;
  subjectId: string | null;
  objectId?: string | null;
  proof: ProofBundle;
}

export interface AuditFinding {
  id: string;
  ruleId: string;
  category: 'coverage' | 'conflict' | 'relationship' | 'realization';
  status: 'attention' | 'resolved';
  summary: string;
  affectedIds: string[];
  proof: ProofBundle;
}

const FACET_KINDS: Record<RealizationFacet, Set<string>> = {
  human: new Set(['surface', 'ui-element', 'component-prop-handler', 'component-prop-binding']),
  agent: new Set(['mcp', 'tool']),
  transport: new Set(['api', 'route', 'http-call', 'rpc-call', 'navigation-call']),
  implementation: new Set(['feature', 'function', 'method', 'class', 'sql-function']),
  persistence: new Set(['sql-table', 'sql-reference', 'state-binding', 'state-write']),
  provider: new Set(['provider']),
};

function graphCoverage(graph: IntelligenceGraph): ProofBundle['coverage'] {
  if (!graph.coverage) return null;
  return {
    completeForEligibleSources: graph.coverage.failedFiles === 0 && graph.coverage.partialFiles === 0 && graph.coverage.skippedFiles === 0 && graph.coverage.analyzedFiles === graph.coverage.eligibleFiles,
    partial: graph.coverage.partialFiles,
    failed: graph.coverage.failedFiles,
    skipped: graph.coverage.skippedFiles,
  };
}

function proof(graph: IntelligenceGraph, ruleId: string, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): ProofBundle {
  const evidenceIds = [...new Set([...nodes.flatMap(node => node.evidenceIds ?? []), ...edges.flatMap(edge => edge.evidenceIds ?? [])])].sort();
  const selected = new Set(evidenceIds);
  return {
    ruleId,
    nodeIds: [...new Set(nodes.map(node => node.id))].sort(),
    edgeIds: [...new Set(edges.map(edge => edge.id))].sort(),
    evidenceIds,
    evidence: graph.evidence.filter(item => selected.has(item.id)),
    coverage: graphCoverage(graph),
  };
}

function claim(input: Omit<IntelligenceClaim, 'id'>): IntelligenceClaim {
  return { ...input, id: stableHash(['assessment-claim-v1', input.type, input.status, input.statement, input.subjectId, input.objectId ?? null, input.proof.ruleId, input.proof.nodeIds, input.proof.edgeIds]) };
}

function nodeText(node: GraphNode): string {
  return [node.id, node.name, node.kind, node.locator, node.raw, JSON.stringify(node.value)].filter(Boolean).join(' ').toLowerCase();
}

function candidates(graph: IntelligenceGraph, query: string): GraphNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const exact = graph.nodes.find(node => node.id === query);
  if (exact) return [exact];
  const named = graph.nodes.filter(node => node.name?.toLowerCase() === needle);
  return (named.length ? named : graph.nodes.filter(node => nodeText(node).includes(needle))).slice(0, 20);
}

function subjectFromQuestion(question: string): string {
  return question
    .replace(/\b(audit|assess|assessment|findings?|problems?|risks?|how|is|are|does|do|implemented|implementation|realized|realization|capability|proof|prove|show|inspect|what|where|the|for|of|in)\b/giu, ' ')
    .replace(/[^\p{L}\p{N}_./:@-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function resolvedNeighborhood(graph: IntelligenceGraph, seed: GraphNode, depth = 5, limit = 300): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const context = graphQueryContext(graph);
  const ids = new Set([seed.id]);
  const edgeIds = new Set<string>();
  let frontier = [seed.id];
  for (let level = 0; level < depth && frontier.length && ids.size < limit; level += 1) {
    const next: string[] = [];
    for (const id of frontier) for (const edge of context.incident(id)) {
      if (edge.status !== 'resolved') continue;
      edgeIds.add(edge.id);
      for (const neighbor of [edge.from, edge.to]) if (neighbor && !ids.has(neighbor) && ids.size < limit) { ids.add(neighbor); next.push(neighbor); }
    }
    frontier = next;
  }
  return { nodes: graph.nodes.filter(node => ids.has(node.id)), edges: graph.edges.filter(edge => edgeIds.has(edge.id)) };
}

function finding(graph: IntelligenceGraph, input: Omit<AuditFinding, 'id'>): AuditFinding {
  return { ...input, id: stableHash(['assessment-finding-v1', input.ruleId, input.category, input.affectedIds.slice().sort()]) };
}

export function auditGraph(graph: IntelligenceGraph): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const coverage = graphCoverage(graph);
  if (!coverage || !coverage.completeForEligibleSources) findings.push(finding(graph, {
    ruleId: 'coverage.incomplete', category: 'coverage', status: 'attention',
    summary: coverage ? `Coverage is incomplete (${coverage.partial} partial, ${coverage.failed} failed, ${coverage.skipped} skipped eligible sources). Negative conclusions must remain qualified.` : 'Coverage details are unavailable; negative conclusions are indeterminate.',
    affectedIds: graph.unavailableSourceIds.slice().sort(), proof: proof(graph, 'coverage.incomplete', [], []),
  }));
  for (const conflict of graph.explicitValueConflicts) findings.push(finding(graph, {
    ruleId: 'evidence.explicit-conflict', category: 'conflict', status: 'attention',
    summary: `Conflicting observed values for ${conflict.entityId}.${conflict.key}.`, affectedIds: [conflict.entityId],
    proof: proof(graph, 'evidence.explicit-conflict', graph.nodes.filter(node => node.id === conflict.entityId), []),
  }));
  for (const edge of graph.edges.filter(item => item.status !== 'resolved')) findings.push(finding(graph, {
    ruleId: `relationship.${edge.status}`, category: 'relationship', status: 'attention',
    summary: `${edge.kind} relationship remains ${edge.status}; it cannot satisfy a proof requiring resolved evidence.`,
    affectedIds: [edge.from, edge.to].filter((id): id is string => Boolean(id)),
    proof: proof(graph, `relationship.${edge.status}`, graph.nodes.filter(node => node.id === edge.from || node.id === edge.to), [edge]),
  }));
  const context = graphQueryContext(graph);
  for (const node of graph.nodes.filter(item => item.layer === 'semantic' && ['capability', 'action'].includes(item.kind))) {
    const incident = context.incident(node.id);
    if (!incident.some(edge => edge.status === 'resolved')) findings.push(finding(graph, {
      ruleId: 'realization.disconnected', category: 'realization', status: 'attention',
      summary: `${node.name ?? node.id} has no resolved realization relationship. This is an observed disconnection, not a product-level defect unless a caller contract requires realization.`,
      affectedIds: [node.id], proof: proof(graph, 'realization.disconnected', [node], incident),
    }));
  }
  return findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));
}

export function assessGraph(graph: IntelligenceGraph, question: string, requiredFacets: RealizationFacet[] = []): Record<string, unknown> {
  const lower = question.toLowerCase();
  const mode = /\b(audit|finding|problem|risk)\b/u.test(lower) ? 'audit' : /\b(realiz\w*|implement\w*|capability|work)\b/u.test(lower) ? 'realization' : 'assessment';
  const subject = subjectFromQuestion(question);
  const matches = candidates(graph, subject || question);
  const semanticCapabilities = matches.filter(node => node.layer === 'semantic' && node.kind === 'capability');
  const selected = matches.length === 1 ? matches[0] : mode === 'realization' && semanticCapabilities.length === 1 ? semanticCapabilities[0] : undefined;
  const ambiguous = matches.length > 1 && !selected;
  const claims: IntelligenceClaim[] = [];
  let realization: Record<string, unknown> | null = null;

  if (selected) {
    claims.push(claim({ type: 'entity-exists', status: 'supported', statement: `${selected.name ?? selected.id} exists in the selected graph.`, subjectId: selected.id, proof: proof(graph, 'entity.exists', [selected], []) }));
    const neighborhood = resolvedNeighborhood(graph, selected);
    const facets = Object.fromEntries(Object.entries(FACET_KINDS).map(([facet, kinds]) => {
      const nodes = neighborhood.nodes.filter(node => kinds.has(node.kind));
      return [facet, { observed: nodes.length > 0, nodeIds: nodes.map(node => node.id) }];
    })) as Record<RealizationFacet, { observed: boolean; nodeIds: string[] }>;
    for (const [facet, result] of Object.entries(facets) as Array<[RealizationFacet, { observed: boolean; nodeIds: string[] }]>) if (result.observed) {
      const nodes = neighborhood.nodes.filter(node => result.nodeIds.includes(node.id));
      claims.push(claim({ type: 'facet-observed', status: 'supported', statement: `${facet} realization is observed for ${selected.name ?? selected.id}.`, subjectId: selected.id, proof: proof(graph, `realization.facet.${facet}`, [selected, ...nodes], neighborhood.edges) }));
    }
    for (const facet of [...new Set(requiredFacets)]) {
      const observed = facets[facet].observed;
      const coverage = graphCoverage(graph);
      const status: AssessmentStatus = observed ? 'supported' : coverage?.completeForEligibleSources ? 'contradicted' : coverage ? 'unproven' : 'indeterminate';
      claims.push(claim({ type: 'contract-facet', status, statement: `${facet} realization is ${observed ? 'observed' : 'not proven'} for ${selected.name ?? selected.id}.`, subjectId: selected.id, proof: proof(graph, `contract.facet.${facet}`, [selected], neighborhood.edges) }));
    }
    realization = { root: { id: selected.id, name: selected.name ?? selected.id, kind: selected.kind }, facets, resolvedPaths: { nodes: neighborhood.nodes, edges: neighborhood.edges }, requiredFacets: [...new Set(requiredFacets)] };
  } else {
    const coverage = graphCoverage(graph);
    claims.push(claim({ type: 'entity-exists', status: ambiguous ? 'unproven' : coverage ? (coverage.completeForEligibleSources ? 'contradicted' : 'unproven') : 'indeterminate', statement: ambiguous ? `“${subject || question}” is ambiguous.` : `No entity matching “${subject || question}” was observed.`, subjectId: null, proof: proof(graph, 'entity.exists', matches, []) }));
  }

  const findings = auditGraph(graph).filter(item => mode === 'audit' || !selected || item.affectedIds.includes(selected.id));
  return {
    project: graph.project, graphId: graph.graphId, revision: graph.repositoryRevision, analyzerVersion: graph.analyzerVersion,
    question, mode, interpretedSubject: subject || null, ambiguous, candidates: matches.map(node => ({ id: node.id, name: node.name ?? node.id, kind: node.kind })),
    answerStatus: claims.some(item => item.status === 'contradicted') ? 'contradicted' : claims.some(item => item.status === 'supported') ? 'supported' : claims[0]?.status ?? 'indeterminate',
    claims, realization, findings, coverage: graphCoverage(graph),
    note: 'Assessments are deterministic projections over the selected graph. They are not persisted graph authority or product intent.',
  };
}

export async function queryIntelligence(input: { project: string; question: string; ref?: string; graphId?: string; requiredFacets?: RealizationFacet[] }): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  return assessGraph(graph, input.question, input.requiredFacets);
}
