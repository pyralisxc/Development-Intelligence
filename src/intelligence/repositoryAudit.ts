import type { GraphEdge, GraphNode, GraphCoverageStatus, IntelligenceGraph } from '../types.js';
import { auditGraph } from './assessment.js';
import { currentGraph, repositoryGraphs, type GraphCurrentness } from './service.js';
import { nodeArea } from './query.js';

type AuditRelationshipStatus = 'candidate' | 'unresolved';

interface RepositoryAuditOptions {
  currentness?: GraphCurrentness | null;
  acceptedPresent?: boolean | null;
  limit?: number;
}

function compactCoverage(graph: IntelligenceGraph): Record<string, unknown> | null {
  const coverage = graph.coverage;
  if (!coverage) return null;
  const { files: _files, ...summary } = coverage;
  return summary;
}

function groupFindings(graph: IntelligenceGraph, limit: number) {
  const findings = auditGraph(graph);
  const groups = new Map<string, { category: string; ruleId: string; count: number; findingIds: string[]; affectedIds: Set<string> }>();
  for (const item of findings) {
    const key = `${item.category}\0${item.ruleId}`;
    const group = groups.get(key) ?? { category: item.category, ruleId: item.ruleId, count: 0, findingIds: [], affectedIds: new Set<string>() };
    group.count += 1;
    if (group.findingIds.length < 3) group.findingIds.push(item.id);
    for (const id of item.affectedIds) if (group.affectedIds.size < 20) group.affectedIds.add(id);
    groups.set(key, group);
  }
  return {
    total: findings.length,
    groups: [...groups.values()]
      .map(group => ({ ...group, affectedIds: [...group.affectedIds].sort() }))
      .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId))
      .slice(0, limit),
    samples: findings.slice(0, Math.min(limit, 20)),
  };
}

function relationshipConcentrations(graph: IntelligenceGraph, limit: number) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const groups = new Map<string, {
    status: AuditRelationshipStatus;
    kind: string;
    count: number;
    edgeIds: string[];
    evidenceIds: Set<string>;
    areas: Map<string, number>;
    samples: Array<{ id: string; from: string | null; to: string | null; evidence: string[] }>;
  }>();
  for (const edge of graph.edges) {
    if (edge.status !== 'candidate' && edge.status !== 'unresolved') continue;
    const key = `${edge.status}\0${edge.kind}`;
    const group = groups.get(key) ?? {
      status: edge.status,
      kind: edge.kind,
      count: 0,
      edgeIds: [],
      evidenceIds: new Set<string>(),
      areas: new Map<string, number>(),
      samples: [],
    };
    group.count += 1;
    if (group.edgeIds.length < 20) group.edgeIds.push(edge.id);
    for (const id of edge.evidenceIds ?? []) if (group.evidenceIds.size < 30) group.evidenceIds.add(id);
    if (group.samples.length < 3) group.samples.push({ id: edge.id, from: edge.from, to: edge.to, evidence: edge.evidence.slice(0, 2) });
    const endpointNodes = [edge.from, edge.to]
      .map(id => id ? nodes.get(id) : undefined)
      .filter((node): node is GraphNode => Boolean(node));
    for (const node of endpointNodes) {
      const area = nodeArea(node);
      group.areas.set(area, (group.areas.get(area) ?? 0) + 1);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(group => ({
      status: group.status,
      kind: group.kind,
      count: group.count,
      edgeIds: group.edgeIds,
      evidenceIds: [...group.evidenceIds].sort(),
      areas: [...group.areas.entries()]
        .map(([area, count]) => ({ area, count }))
        .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area))
        .slice(0, 5),
      samples: group.samples,
      nextEvidence: group.status === 'unresolved'
        ? 'Resolve target identity or supply the missing source/runtime/provider evidence before using these relationships as proof.'
        : 'Strengthen deterministic binding evidence before promoting these candidate relationships into proof.',
    }))
    .sort((a, b) => {
      const statusOrder = (value: AuditRelationshipStatus) => value === 'unresolved' ? 0 : 1;
      return statusOrder(a.status) - statusOrder(b.status) || b.count - a.count || a.kind.localeCompare(b.kind);
    })
    .slice(0, limit);
}

function coverageBlockers(graph: IntelligenceGraph, limit: number) {
  const files = graph.coverage?.files ?? [];
  const groups = new Map<GraphCoverageStatus, { status: GraphCoverageStatus; count: number; paths: string[]; reasons: Set<string> }>();
  for (const file of files) {
    if (file.status === 'complete') continue;
    const group = groups.get(file.status) ?? { status: file.status, count: 0, paths: [], reasons: new Set<string>() };
    group.count += 1;
    if (group.paths.length < 10) group.paths.push(file.path);
    if (file.reason && group.reasons.size < 10) group.reasons.add(file.reason);
    groups.set(file.status, group);
  }
  const order: Record<GraphCoverageStatus, number> = { failed: 0, partial: 1, skipped: 2, unsupported: 3, complete: 4 };
  return [...groups.values()]
    .map(group => ({
      status: group.status,
      count: group.count,
      samplePaths: group.paths.sort(),
      reasons: [...group.reasons].sort(),
      nextEvidence: 'Inspect or support these source paths before making repository-wide absence claims that depend on them.',
    }))
    .sort((a, b) => order[a.status] - order[b.status] || b.count - a.count)
    .slice(0, limit);
}

function staleDimensions(currentness: GraphCurrentness | null | undefined): string[] {
  if (!currentness) return [];
  return [
    ['acceptedSemanticCurrent', currentness.acceptedSemanticCurrent],
    ['sourceCurrent', currentness.sourceCurrent],
    ['topologyCurrent', currentness.topologyCurrent],
    ['evidenceCurrent', currentness.evidenceCurrent],
    ['analyzerCurrent', currentness.analyzerCurrent],
    ['schemaSupported', currentness.schemaSupported],
    ['integrityCurrent', currentness.integrityCurrent],
  ].filter(([, value]) => value === false).map(([name]) => String(name));
}

export function synthesizeRepositoryAudit(graph: IntelligenceGraph, options: RepositoryAuditOptions = {}): Record<string, unknown> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const findings = groupFindings(graph, limit);
  const relationships = relationshipConcentrations(graph, limit);
  const blockers = coverageBlockers(graph, limit);
  const stale = staleDimensions(options.currentness);
  const targets: Array<Record<string, unknown>> = [];

  if (options.acceptedPresent === true && stale.length) targets.push({
    kind: 'currentness',
    basis: 'observed',
    count: stale.length,
    summary: `Accepted/current graph dimensions are not current: ${stale.join(', ')}.`,
    evidence: { dimensions: stale, checkpointError: options.currentness?.checkpointError ?? null },
    nextEvidence: 'Reconcile the accepted checkpoint/current analyzer state for the exact candidate before treating accepted semantics as current.',
  });

  for (const blocker of blockers) targets.push({
    kind: 'coverage',
    basis: 'observed',
    count: blocker.count,
    summary: `${blocker.count} tracked source path(s) are ${blocker.status}.`,
    evidence: { status: blocker.status, paths: blocker.samplePaths, reasons: blocker.reasons },
    nextEvidence: blocker.nextEvidence,
  });

  for (const group of relationships) targets.push({
    kind: 'relationship',
    basis: 'observed',
    count: group.count,
    summary: `${group.count} ${group.kind} relationship(s) remain ${group.status}.`,
    evidence: { status: group.status, kind: group.kind, edgeIds: group.edgeIds, evidenceIds: group.evidenceIds, areas: group.areas, samples: group.samples },
    nextEvidence: group.nextEvidence,
  });

  for (const group of findings.groups.filter((item: any) => item.category === 'conflict' || item.category === 'realization')) targets.push({
    kind: 'finding',
    basis: 'deterministic-projection',
    count: group.count,
    summary: `${group.count} ${group.ruleId} finding(s) require investigation.`,
    evidence: { category: group.category, ruleId: group.ruleId, findingIds: group.findingIds, affectedIds: group.affectedIds },
    nextEvidence: group.category === 'realization'
      ? 'Verify whether realization is required by caller-owned expectations; if it is, establish a resolved realization relationship.'
      : 'Inspect the conflicting observed values and their source evidence before selecting or accepting one value.',
  });

  return {
    project: graph.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    role: graph.role,
    analyzerVersion: graph.analyzerVersion,
    acceptedCheckpoint: {
      present: options.acceptedPresent ?? null,
      current: options.acceptedPresent === true ? options.currentness?.acceptedSemanticCurrent ?? null : null,
    },
    currentness: options.currentness ?? null,
    coverage: compactCoverage(graph),
    findingSummary: { total: findings.total, groups: findings.groups },
    findings: findings.samples,
    relationshipConcentrations: relationships,
    coverageBlockers: blockers,
    investigationTargets: targets.slice(0, limit),
    policy: {
      projection: 'audit-only',
      persisted: false,
      modifiesRepository: false,
      createsWorkItems: false,
      ranking: 'Currentness, coverage, unresolved relationships, candidate relationships, then deterministic conflict/realization findings; counts break ties before lexical identity.',
      note: 'Repository audits synthesize revision-bound technical evidence. They do not assign product intent, authorize changes, or create durable project-management truth.',
    },
  };
}

export async function repositoryAudit(input: { project: string; ref?: string; graphId?: string; limit?: number }): Promise<Record<string, unknown>> {
  if (input.graphId) {
    const graph = await currentGraph(input.project, input.ref, input.graphId);
    return synthesizeRepositoryAudit(graph, { currentness: null, acceptedPresent: null, limit: input.limit });
  }
  const repository = await repositoryGraphs(input.project, input.ref);
  return synthesizeRepositoryAudit(repository.working, {
    currentness: repository.currentness,
    acceptedPresent: Boolean(repository.accepted),
    limit: input.limit,
  });
}
