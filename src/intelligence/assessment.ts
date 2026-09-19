import type { EvidenceRecord, GraphCoverageStatus, GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { stableHash } from '../util/hash.js';
import { graphQueryContext } from './queryContext.js';
import { projectTypedReach } from './reach.js';
import { currentGraph } from './service.js';

export type AssessmentStatus = 'supported' | 'contradicted' | 'unproven' | 'indeterminate';
export type RealizationFacet = 'human' | 'agent' | 'transport' | 'implementation' | 'persistence' | 'provider';
export type ProofPurpose = 'existence' | 'realization' | 'contract' | 'audit';

export interface AssessmentCoverage {
  completeForEligibleSources: boolean;
  completeForTrackedSources: boolean;
  partial: number;
  failed: number;
  skipped: number;
  unsupported: number;
}

export interface ClaimCoverage {
  scope: 'proof' | 'repository';
  paths: string[];
  completeForClaimScope: boolean;
  supportsNegative: boolean;
  blockers: Array<{ path: string; status: GraphCoverageStatus; reason?: string }>;
}

export interface ProofBundle {
  ruleId: string;
  nodeIds: string[];
  edgeIds: string[];
  evidenceIds: string[];
  evidence: EvidenceRecord[];
  admissibility: { purpose: ProofPurpose; acceptedEdgeIds: string[]; rejectedEdgeIds: string[] };
  coverage: (AssessmentCoverage & { claimScope: ClaimCoverage }) | null;
}

export interface RealizationPath {
  facet: RealizationFacet;
  targetId: string;
  targetKind: string;
  nodeIds: string[];
  edgeIds: string[];
  relationshipKinds: string[];
}

export interface RealizationHypothesis {
  edgeId: string;
  kind: string;
  status: 'candidate';
  from: string | null;
  to: string | null;
  evidenceIds: string[];
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

const NON_REALIZATION_PROOF_KINDS = new Set([
  'contains',
  'declares',
  'imports',
  'reexports',
  'resolves_to',
  'same_observed_name',
  'same_observed_value',
  'similar_identifier',
]);

function graphCoverage(graph: IntelligenceGraph): AssessmentCoverage | null {
  if (!graph.coverage) return null;
  return {
    completeForEligibleSources: graph.coverage.failedFiles === 0 && graph.coverage.partialFiles === 0 && graph.coverage.skippedFiles === 0 && graph.coverage.analyzedFiles === graph.coverage.eligibleFiles,
    completeForTrackedSources: graph.coverage.failedFiles === 0
      && graph.coverage.partialFiles === 0
      && graph.coverage.skippedFiles === 0
      && graph.coverage.unsupportedFiles === 0
      && graph.coverage.completeFiles === graph.coverage.trackedFiles,
    partial: graph.coverage.partialFiles,
    failed: graph.coverage.failedFiles,
    skipped: graph.coverage.skippedFiles,
    unsupported: graph.coverage.unsupportedFiles,
  };
}

function locatorPath(locator: string): string {
  const match = /^(.*?):(\d+)(?::.*)?$/u.exec(locator);
  return match ? match[1]! : locator;
}

function coverageForClaim(graph: IntelligenceGraph, nodes: readonly GraphNode[], scope: ClaimCoverage['scope']): ClaimCoverage | null {
  const coverage = graph.coverage;
  if (!coverage) return null;
  const nodePaths = [...new Set(nodes.map(node => locatorPath(node.locator)).filter(Boolean))].sort();
  const files = coverage.files ?? [];
  const scopedFiles = scope === 'repository' ? files : files.filter(item => nodePaths.includes(item.path));
  const useSummaryFallback = scopedFiles.length === 0;
  const blockers = useSummaryFallback
    ? []
    : scopedFiles
      .filter(item => item.status !== 'complete')
      .map(item => ({ path: item.path, status: item.status, ...(item.reason ? { reason: item.reason } : {}) }));
  const completeForClaimScope = useSummaryFallback
    ? graphCoverage(graph)?.completeForTrackedSources === true
    : blockers.length === 0 && (scope !== 'repository' || scopedFiles.length === coverage.trackedFiles);
  const supportsNegative = scope === 'repository'
    && completeForClaimScope
    && graph.unavailableSourceIds.length === 0;
  return {
    scope,
    paths: scope === 'repository' ? files.map(item => item.path).sort() : nodePaths,
    completeForClaimScope,
    supportsNegative,
    blockers,
  };
}

function edgeAdmissible(edge: GraphEdge, purpose: ProofPurpose): boolean {
  if (purpose === 'audit') return true;
  if (edge.status !== 'resolved') return false;
  if ((purpose === 'realization' || purpose === 'contract') && NON_REALIZATION_PROOF_KINDS.has(edge.kind)) return false;
  return true;
}

function proof(
  graph: IntelligenceGraph,
  ruleId: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  purpose: ProofPurpose,
  scope: ClaimCoverage['scope'] = 'proof',
): ProofBundle {
  const acceptedEdges = edges.filter(edge => edgeAdmissible(edge, purpose));
  const rejectedEdges = edges.filter(edge => !edgeAdmissible(edge, purpose));
  const evidenceIds = [...new Set([...nodes.flatMap(node => node.evidenceIds ?? []), ...acceptedEdges.flatMap(edge => edge.evidenceIds ?? [])])].sort();
  const selected = new Set(evidenceIds);
  const coverage = graphCoverage(graph);
  const claimScope = coverageForClaim(graph, nodes, scope);
  return {
    ruleId,
    nodeIds: [...new Set(nodes.map(node => node.id))].sort(),
    edgeIds: [...new Set(acceptedEdges.map(edge => edge.id))].sort(),
    evidenceIds,
    evidence: graph.evidence.filter(item => selected.has(item.id)),
    admissibility: {
      purpose,
      acceptedEdgeIds: [...new Set(acceptedEdges.map(edge => edge.id))].sort(),
      rejectedEdgeIds: [...new Set(rejectedEdges.map(edge => edge.id))].sort(),
    },
    coverage: coverage && claimScope ? { ...coverage, claimScope } : null,
  };
}

function claim(input: Omit<IntelligenceClaim, 'id'>): IntelligenceClaim {
  return { ...input, id: stableHash(['assessment-claim-v1', input.type, input.status, input.statement, input.subjectId, input.objectId ?? null, input.proof.ruleId, input.proof.nodeIds, input.proof.edgeIds]) };
}

function nodeText(node: GraphNode): string {
  return [node.id, node.name, node.kind, node.locator, node.raw, JSON.stringify(node.value)].filter(Boolean).join(' ').toLowerCase();
}

function searchableText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_./:@]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function candidates(graph: IntelligenceGraph, query: string): GraphNode[] {
  const needle = searchableText(query);
  if (!needle) return [];
  const exact = graph.nodes.find(node => node.id === query);
  if (exact) return [exact];
  const named = graph.nodes.filter(node => node.name && searchableText(node.name) === needle);
  return (named.length ? named : graph.nodes.filter(node => searchableText(nodeText(node)).includes(needle))).slice(0, 20);
}

function subjectFromQuestion(question: string): string {
  return question
    .replace(/\b(audit|assess|findings?|problems?|risks?|how|is|are|does|do|implemented|implementation|realized|realization|capability|proof|prove|show|inspect|what|where|the|for|of|in|exists?|existence|works?|working)\b/giu, ' ')
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

function realizationTraversal(graph: IntelligenceGraph, seed: GraphNode, depth = 5, limit = 300): { nodes: GraphNode[]; edges: GraphEdge[]; paths: RealizationPath[] } {
  const context = graphQueryContext(graph);
  const edgesById = new Map(graph.edges.map(edge => [edge.id, edge]));
  const pathByNode = new Map<string, { nodeIds: string[]; edgeIds: string[] }>([[seed.id, { nodeIds: [seed.id], edgeIds: [] }]]);
  let frontier = [seed.id];
  for (let level = 0; level < depth && frontier.length && pathByNode.size < limit; level += 1) {
    const next: string[] = [];
    for (const id of frontier) for (const edge of context.incident(id)) {
      if (!edgeAdmissible(edge, 'realization') || !edge.from || !edge.to) continue;
      const neighbor = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (!neighbor || pathByNode.has(neighbor) || pathByNode.size >= limit) continue;
      const parent = pathByNode.get(id)!;
      pathByNode.set(neighbor, { nodeIds: [...parent.nodeIds, neighbor], edgeIds: [...parent.edgeIds, edge.id] });
      next.push(neighbor);
    }
    frontier = next;
  }

  const paths: RealizationPath[] = [];
  for (const [targetId, path] of pathByNode) {
    if (targetId === seed.id) continue;
    const target = context.node(targetId);
    if (!target) continue;
    for (const [facet, kinds] of Object.entries(FACET_KINDS) as Array<[RealizationFacet, Set<string>]>) {
      if (!kinds.has(target.kind)) continue;
      const edges = path.edgeIds.map(id => edgesById.get(id)).filter((edge): edge is GraphEdge => Boolean(edge));
      paths.push({
        facet,
        targetId,
        targetKind: target.kind,
        nodeIds: path.nodeIds,
        edgeIds: path.edgeIds,
        relationshipKinds: edges.map(edge => edge.kind),
      });
    }
  }

  const nodeIds = new Set<string>([seed.id]);
  const edgeIds = new Set<string>();
  for (const path of paths) {
    for (const id of path.nodeIds) nodeIds.add(id);
    for (const id of path.edgeIds) edgeIds.add(id);
  }
  return {
    nodes: graph.nodes.filter(node => nodeIds.has(node.id)),
    edges: graph.edges.filter(edge => edgeIds.has(edge.id)),
    paths: paths.sort((a, b) => a.facet.localeCompare(b.facet) || a.targetId.localeCompare(b.targetId)),
  };
}

function candidateHypotheses(graph: IntelligenceGraph, affectedIds?: ReadonlySet<string>): { total: number; items: RealizationHypothesis[]; truncated: boolean; note: string } {
  const matches = graph.edges.filter(edge => edge.status === 'candidate'
    && (!affectedIds || (edge.from ? affectedIds.has(edge.from) : false) || (edge.to ? affectedIds.has(edge.to) : false)));
  const items = matches.slice(0, 100).map(edge => ({
    edgeId: edge.id,
    kind: edge.kind,
    status: 'candidate' as const,
    from: edge.from,
    to: edge.to,
    evidenceIds: [...new Set(edge.evidenceIds ?? [])].sort(),
  }));
  return {
    total: matches.length,
    items,
    truncated: matches.length > items.length,
    note: 'Candidate relationships are hypotheses only. They may guide inspection but never satisfy realization or contract proof.',
  };
}

function finding(graph: IntelligenceGraph, input: Omit<AuditFinding, 'id'>): AuditFinding {
  return { ...input, id: stableHash(['assessment-finding-v1', input.ruleId, input.category, input.affectedIds.slice().sort()]) };
}

function answerStatus(claims: readonly IntelligenceClaim[]): AssessmentStatus {
  const contractClaims = claims.filter(item => item.type === 'contract-facet');
  const decisive = contractClaims.length ? contractClaims : claims;
  if (decisive.some(item => item.status === 'contradicted')) return 'contradicted';
  if (decisive.some(item => item.status === 'indeterminate')) return 'indeterminate';
  if (decisive.some(item => item.status === 'unproven')) return 'unproven';
  return decisive.some(item => item.status === 'supported') ? 'supported' : 'indeterminate';
}

function summarizeFindings(graph: IntelligenceGraph, findings: readonly AuditFinding[], scope: { rootId: string; resolvedDepth: number; nodeCount: number } | null): Record<string, unknown> {
  const edges = new Map(graph.edges.map(edge => [edge.id, edge]));
  const grouped = new Map<string, { category: AuditFinding['category']; ruleId: string; relationshipKind: string | null; count: number; affectedIds: Set<string>; sampleFindingIds: string[] }>();
  for (const item of findings) {
    const relationshipKind = item.proof.edgeIds.map(id => edges.get(id)?.kind).find(Boolean) ?? null;
    const key = [item.category, item.ruleId, relationshipKind ?? ''].join('\0');
    const group = grouped.get(key) ?? { category: item.category, ruleId: item.ruleId, relationshipKind, count: 0, affectedIds: new Set<string>(), sampleFindingIds: [] };
    group.count += 1;
    for (const id of item.affectedIds) group.affectedIds.add(id);
    if (group.sampleFindingIds.length < 3) group.sampleFindingIds.push(item.id);
    grouped.set(key, group);
  }
  return {
    total: findings.length,
    scope,
    groups: [...grouped.values()]
      .map(group => ({ ...group, affectedIds: [...group.affectedIds].sort() }))
      .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId) || (a.relationshipKind ?? '').localeCompare(b.relationshipKind ?? '')),
  };
}

export function auditGraph(graph: IntelligenceGraph, affectedIds?: ReadonlySet<string>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const coverage = graphCoverage(graph);
  if (!coverage || !coverage.completeForTrackedSources) findings.push(finding(graph, {
    ruleId: 'coverage.incomplete', category: 'coverage', status: 'attention',
    summary: coverage ? 'Coverage is not exhaustive across tracked sources (' + coverage.partial + ' partial, ' + coverage.failed + ' failed, ' + coverage.skipped + ' skipped, ' + coverage.unsupported + ' unsupported). Negative conclusions must remain qualified.' : 'Coverage details are unavailable; negative conclusions are indeterminate.',
    affectedIds: graph.unavailableSourceIds.slice().sort(), proof: proof(graph, 'coverage.incomplete', [], [], 'audit', 'repository'),
  }));
  for (const conflict of graph.explicitValueConflicts.filter(item => !affectedIds || affectedIds.has(item.entityId))) findings.push(finding(graph, {
    ruleId: 'evidence.explicit-conflict', category: 'conflict', status: 'attention',
    summary: `Conflicting observed values for ${conflict.entityId}.${conflict.key}.`, affectedIds: [conflict.entityId],
    proof: proof(graph, 'evidence.explicit-conflict', graph.nodes.filter(node => node.id === conflict.entityId), [], 'audit'),
  }));
  for (const edge of graph.edges.filter(item => item.status === 'unresolved' && (!affectedIds || (typeof item.from === 'string' && affectedIds.has(item.from)) || (typeof item.to === 'string' && affectedIds.has(item.to))))) findings.push(finding(graph, {
    ruleId: `relationship.${edge.status}`, category: 'relationship', status: 'attention',
    summary: `${edge.kind} relationship remains ${edge.status}; it cannot satisfy a proof requiring resolved evidence.`,
    affectedIds: [edge.from, edge.to].filter((id): id is string => Boolean(id)),
    proof: proof(graph, 'relationship.' + edge.status, graph.nodes.filter(node => node.id === edge.from || node.id === edge.to), [edge], 'audit'),
  }));
  const context = graphQueryContext(graph);
  for (const node of graph.nodes.filter(item => item.layer === 'semantic' && ['capability', 'action'].includes(item.kind) && (!affectedIds || affectedIds.has(item.id)))) {
    const incident = context.incident(node.id);
    if (!incident.some(edge => edgeAdmissible(edge, 'realization'))) findings.push(finding(graph, {
      ruleId: 'realization.disconnected', category: 'realization', status: 'attention',
      summary: `${node.name ?? node.id} has no resolved realization relationship. This is an observed disconnection, not a product-level defect unless a caller contract requires realization.`,
      affectedIds: [node.id], proof: proof(graph, 'realization.disconnected', [node], incident, 'audit'),
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
  const semanticRoots = matches.filter(node => node.layer === 'semantic' && ['capability', 'action', 'feature', 'api', 'route', 'provider', 'mcp', 'surface'].includes(node.kind));
  const selected = matches.length === 1
    ? matches[0]
    : mode === 'realization' && semanticCapabilities.length === 1
      ? semanticCapabilities[0]
      : mode === 'realization' && semanticRoots.length === 1
        ? semanticRoots[0]
        : undefined;
  const ambiguous = matches.length > 1 && !selected;
  const claims: IntelligenceClaim[] = [];
  let realization: Record<string, unknown> | null = null;
  let reach: Record<string, unknown> | null = null;

  if (selected) {
    claims.push(claim({ type: 'entity-exists', status: 'supported', statement: (selected.name ?? selected.id) + ' exists in the selected graph.', subjectId: selected.id, proof: proof(graph, 'entity.exists', [selected], [], 'existence') }));
    const traversal = realizationTraversal(graph, selected);
    const facets = Object.fromEntries((Object.keys(FACET_KINDS) as RealizationFacet[]).map(facet => {
      const paths = traversal.paths.filter(path => path.facet === facet);
      return [facet, { observed: paths.length > 0, nodeIds: [...new Set(paths.map(path => path.targetId))].sort(), paths }];
    })) as Record<RealizationFacet, { observed: boolean; nodeIds: string[]; paths: RealizationPath[] }>;
    for (const [facet, result] of Object.entries(facets) as Array<[RealizationFacet, { observed: boolean; nodeIds: string[]; paths: RealizationPath[] }]>) if (result.observed) {
      const nodeIds = new Set(result.paths.flatMap(path => path.nodeIds));
      const edgeIds = new Set(result.paths.flatMap(path => path.edgeIds));
      const nodes = graph.nodes.filter(node => nodeIds.has(node.id));
      const edges = graph.edges.filter(edge => edgeIds.has(edge.id));
      claims.push(claim({ type: 'facet-observed', status: 'supported', statement: facet + ' realization is proven for ' + (selected.name ?? selected.id) + '.', subjectId: selected.id, proof: proof(graph, 'realization.facet.' + facet, nodes, edges, 'realization') }));
    }
    for (const facet of [...new Set(requiredFacets)]) {
      const result = facets[facet];
      const nodeIds = new Set(result.paths.flatMap(path => path.nodeIds));
      nodeIds.add(selected.id);
      const edgeIds = new Set(result.paths.flatMap(path => path.edgeIds));
      const nodes = graph.nodes.filter(node => nodeIds.has(node.id));
      const edges = graph.edges.filter(edge => edgeIds.has(edge.id));
      const contractProof = proof(graph, 'contract.facet.' + facet, nodes, edges, 'contract', result.observed ? 'proof' : 'repository');
      const status: AssessmentStatus = result.observed
        ? 'supported'
        : contractProof.coverage?.claimScope.supportsNegative
          ? 'contradicted'
          : contractProof.coverage
            ? 'unproven'
            : 'indeterminate';
      claims.push(claim({ type: 'contract-facet', status, statement: facet + ' realization is ' + (result.observed ? 'proven' : 'not proven') + ' for ' + (selected.name ?? selected.id) + '.', subjectId: selected.id, proof: contractProof }));
    }
    realization = {
      root: { id: selected.id, name: selected.name ?? selected.id, kind: selected.kind },
      facets,
      paths: traversal.paths,
      resolvedPaths: { nodes: traversal.nodes, edges: traversal.edges },
      requiredFacets: [...new Set(requiredFacets)],
    };
    reach = projectTypedReach(graph, selected);
  } else {
    const existenceProof = proof(graph, 'entity.exists', matches, [], 'existence', 'repository');
    claims.push(claim({
      type: 'entity-exists',
      status: ambiguous
        ? 'unproven'
        : existenceProof.coverage?.claimScope.supportsNegative
          ? 'contradicted'
          : existenceProof.coverage
            ? 'unproven'
            : 'indeterminate',
      statement: ambiguous ? '“' + (subject || question) + '” is ambiguous.' : 'No entity matching “' + (subject || question) + '” was observed.',
      subjectId: null,
      proof: existenceProof,
    }));
  }

  const globalAudit = mode === 'audit' && (!subject || /^(?:all|global|graph|project|repository)$/u.test(searchableText(subject)));
  const auditNeighborhood = selected && mode === 'audit' ? resolvedNeighborhood(graph, selected, 2) : null;
  const findingScope = auditNeighborhood ? new Set(auditNeighborhood.nodes.map(node => node.id)) : undefined;
  const findings = globalAudit
    ? auditGraph(graph)
    : selected
      ? auditGraph(graph, mode === 'audit' ? findingScope : new Set([selected.id]))
      : auditGraph(graph, new Set()).filter(item => item.category === 'coverage');
  const findingSummary = summarizeFindings(graph, findings, selected && auditNeighborhood
    ? { rootId: selected.id, resolvedDepth: 2, nodeCount: auditNeighborhood.nodes.length }
    : null);
  const hypothesisScope = globalAudit
    ? undefined
    : auditNeighborhood
      ? findingScope
      : selected && realization
        ? new Set(((realization as any).resolvedPaths.nodes as GraphNode[]).map(node => node.id))
        : selected
          ? new Set([selected.id])
          : new Set<string>();
  const hypotheses = candidateHypotheses(graph, hypothesisScope);
  return {
    project: graph.project, graphId: graph.graphId, revision: graph.repositoryRevision, analyzerVersion: graph.analyzerVersion,
    question, mode, interpretedSubject: subject || null, ambiguous, candidates: matches.map(node => ({ id: node.id, name: node.name ?? node.id, kind: node.kind })),
    answerStatus: answerStatus(claims),
    claims, realization, reach, findings, findingSummary, hypotheses, coverage: graphCoverage(graph),
    note: 'Assessments are deterministic projections over the selected graph. Candidate relationships remain hypotheses and never satisfy proof. Typed reach reports resolved connection mechanisms and paths without assigning severity. Assessments are not persisted graph authority or product intent.',
  };
}

export async function queryIntelligence(input: { project: string; question: string; ref?: string; graphId?: string; requiredFacets?: RealizationFacet[] }): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  return assessGraph(graph, input.question, input.requiredFacets);
}
