import type { RelationshipStatus } from '../types.js';
import { stableHash } from '../util/hash.js';
import { graphContext } from './service.js';
import { buildPortfolioLinks, namespacePortfolioId, portfolioBlastRadius, portfolioSharedDependencies, portfolioTechnicalCorrelations, type PortfolioParticipant, type PortfolioTraceHop, type PortfolioTraceNode, type PortfolioUnavailable } from './portfolioEvidence.js';

export interface PortfolioParticipantInput { key?: string; project: string; ref?: string; graphId?: string; }
const keyFor = (input: PortfolioParticipantInput) => input.key?.trim() || input.project.trim();

function compactCoverage(graph: PortfolioParticipant['graph']): Record<string, unknown> | null {
  if (!graph.coverage) return null;
  const { files: _files, ...summary } = graph.coverage;
  return summary;
}

export function synthesizePortfolio(participants: PortfolioParticipant[], unavailable: PortfolioUnavailable[] = [], limit = 50): Record<string, unknown> {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit || 50)));
  const links = buildPortfolioLinks(participants);
  const shared = portfolioSharedDependencies(participants);
  const correlations = portfolioTechnicalCorrelations(participants);
  const radius = portfolioBlastRadius(links);
  const identities = participants.map(item => `${item.key}|${item.project}|${item.graph.repositoryRevision ?? 'unknown'}|${item.graph.graphId}|${item.graph.analyzerVersion}`).sort();
  const missing = unavailable.map(item => `unavailable|${item.key}|${item.project}|${item.ref ?? ''}|${item.graphId ?? ''}`).sort();
  const portfolioId = `portfolio-${stableHash([...identities, ...missing]).slice(0, 16)}`;
  const investigationTargets = [
    ...unavailable.map(item => ({ kind: 'unavailable-participant', basis: 'availability', summary: `${item.key} is unavailable to this portfolio investigation.`, participant: item, nextEvidence: 'Restore repository/revision access or remove the participant before drawing portfolio-wide absence conclusions.' })),
    ...links.filter(item => item.status === 'candidate').map(item => ({ kind: 'candidate-cross-repository-link', basis: 'candidate-evidence', summary: `${item.kind} for ${item.identifier} is correlated but not uniquely proven.`, linkId: item.id, nextEvidence: 'Provide a deterministic producer/reference identifier before promoting this relationship to resolved.' })),
    ...shared.map(item => ({ kind: 'shared-dependency', basis: 'observed-manifests', summary: `${item.identifier} is declared by ${item.participants.length} portfolio participants.`, identifier: item.identifier, participants: item.participants, nextEvidence: 'Inspect version/range divergence and consumers when changing this dependency.' })),
    ...radius.map(item => ({ kind: 'cross-repository-blast-radius', basis: item.basis, summary: `${item.target.nodeId} has ${item.consumerParticipants.length} observed cross-repository consumer participant(s).`, target: item.target, consumerParticipants: item.consumerParticipants, linkIds: item.linkIds, nextEvidence: 'Inspect the owning entity and listed consumer links before changing the target contract.' })),
  ].slice(0, bounded);
  return {
    portfolioId,
    participants: participants.map(item => ({ key: item.key, project: item.project, graphId: item.graph.graphId, revision: item.graph.repositoryRevision, analyzerVersion: item.graph.analyzerVersion, coverage: compactCoverage(item.graph), counts: { nodes: item.graph.nodes.length, edges: item.graph.edges.length, evidence: item.graph.evidence.length } })).sort((a, b) => a.key.localeCompare(b.key)),
    unavailableParticipants: unavailable.slice().sort((a, b) => a.key.localeCompare(b.key)),
    crossRepositoryLinks: links.slice(0, bounded), crossRepositoryLinkTotal: links.length,
    sharedDependencies: shared.slice(0, bounded), sharedDependencyTotal: shared.length,
    technicalCorrelations: correlations.slice(0, bounded), technicalCorrelationTotal: correlations.length,
    blastRadius: radius.slice(0, bounded),
    audit: { investigationTargets, sharedDependencyCount: shared.length, likelyBlastRadiusCount: radius.length, unavailableParticipantCount: unavailable.length },
    truncated: links.length > bounded || shared.length > bounded || correlations.length > bounded,
    policy: { persisted: false, acceptedCheckpointAffected: false, modifiesRepositories: false, participantAuthorityPreserved: true, identityNamespace: '<participant-key>::<original-node-id>', note: 'Portfolio intelligence is an ephemeral derived investigation. Repository graphs remain authoritative only for their own exact revisions.' },
  };
}

async function resolveParticipants(inputs: PortfolioParticipantInput[]): Promise<{ resolved: PortfolioParticipant[]; unavailable: PortfolioUnavailable[] }> {
  if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 12) throw new Error('participants must contain 2-12 repositories/revisions');
  const keys = new Set<string>();
  const results = await Promise.all(inputs.map(async input => {
    if (!input?.project?.trim()) throw new Error('each portfolio participant requires project');
    if (input.ref && input.graphId) throw new Error(`${input.project}: use either ref or graphId, not both`);
    const key = keyFor(input);
    if (!key || keys.has(key)) throw new Error(!key ? 'portfolio participant key must be non-empty' : `duplicate portfolio participant key: ${key}`);
    keys.add(key);
    try {
      const context = await graphContext(input.project, { ...(input.ref ? { ref: input.ref } : {}), ...(input.graphId ? { graphId: input.graphId } : {}) });
      return { ok: true as const, value: { key, project: input.project, graph: context.graph } satisfies PortfolioParticipant };
    } catch (error) {
      return { ok: false as const, value: { key, project: input.project, ...(input.ref ? { ref: input.ref } : {}), ...(input.graphId ? { graphId: input.graphId } : {}), error: error instanceof Error ? error.message : String(error) } satisfies PortfolioUnavailable };
    }
  }));
  return { resolved: results.filter(item => item.ok).map(item => item.value).sort((a, b) => a.key.localeCompare(b.key)), unavailable: results.filter(item => !item.ok).map(item => item.value).sort((a, b) => a.key.localeCompare(b.key)) };
}

export function tracePortfolioGraphs(participants: PortfolioParticipant[], unavailable: PortfolioUnavailable[], input: { start: string; direction?: 'inbound' | 'outbound' | 'both'; depth?: number; statuses?: RelationshipStatus[]; limit?: number }): Record<string, unknown> {
  const direction = input.direction ?? 'both';
  const depth = Math.max(1, Math.min(4, Math.floor(input.depth ?? 2)));
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
  const statuses = new Set<RelationshipStatus>(input.statuses?.length ? input.statuses : ['resolved']);
  const nodes = new Map<string, PortfolioTraceNode>();
  for (const participant of participants) for (const node of participant.graph.nodes) nodes.set(namespacePortfolioId(participant.key, node.id), { participant: participant.key, project: participant.project, nodeId: namespacePortfolioId(participant.key, node.id), originalNodeId: node.id, kind: node.kind, layer: node.layer ?? 'structural', name: node.name ?? null, locator: node.locator });
  if (!nodes.has(input.start)) throw new Error(`portfolio trace start node not found: ${input.start}`);
  const outgoing = new Map<string, PortfolioTraceHop[]>(), incoming = new Map<string, PortfolioTraceHop[]>();
  const add = (hop: PortfolioTraceHop) => { const out = outgoing.get(hop.from) ?? []; out.push(hop); outgoing.set(hop.from, out); const inn = incoming.get(hop.to) ?? []; inn.push(hop); incoming.set(hop.to, inn); };
  for (const participant of participants) for (const edge of participant.graph.edges) {
    if (!edge.from || !edge.to || !statuses.has(edge.status)) continue;
    const from = namespacePortfolioId(participant.key, edge.from), to = namespacePortfolioId(participant.key, edge.to);
    if (nodes.has(from) && nodes.has(to)) add({ id: namespacePortfolioId(participant.key, edge.id), scope: 'repository', participant: participant.key, project: participant.project, originalEdgeId: edge.id, from, to, kind: edge.kind, status: edge.status, strategy: edge.strategy, evidence: edge.evidence, evidenceIds: edge.evidenceIds ?? [] });
  }
  for (const link of buildPortfolioLinks(participants)) if (statuses.has(link.status) && nodes.has(link.from.nodeId) && nodes.has(link.to.nodeId)) add({ id: link.id, scope: 'cross-repository', from: link.from.nodeId, to: link.to.nodeId, kind: link.kind, status: link.status, strategy: link.strategy, identifier: link.identifier, provenance: { from: link.from, to: link.to, note: link.note ?? null } });
  const visited = new Map<string, number>([[input.start, 0]]), queue = [input.start], selected = new Map<string, PortfolioTraceHop>();
  while (queue.length && selected.size < limit) {
    const current = queue.shift()!, currentDepth = visited.get(current) ?? 0;
    if (currentDepth >= depth) continue;
    const candidates: Array<{ hop: PortfolioTraceHop; next: string }> = [];
    if (direction !== 'inbound') for (const hop of outgoing.get(current) ?? []) candidates.push({ hop, next: hop.to });
    if (direction !== 'outbound') for (const hop of incoming.get(current) ?? []) candidates.push({ hop, next: hop.from });
    for (const candidate of candidates) { if (selected.size >= limit) break; selected.set(candidate.hop.id, candidate.hop); if (!visited.has(candidate.next)) { visited.set(candidate.next, currentDepth + 1); queue.push(candidate.next); } }
  }
  const summary = synthesizePortfolio(participants, unavailable, Math.min(limit, 200)) as any, hops = [...selected.values()];
  return { portfolioId: summary.portfolioId, participants: summary.participants, unavailableParticipants: summary.unavailableParticipants, start: input.start, direction, depth, statuses: [...statuses], nodes: [...visited.keys()].map(id => nodes.get(id)!).filter(Boolean), hops, crossRepositoryHopCount: hops.filter(item => item.scope === 'cross-repository').length, truncated: selected.size >= limit, policy: summary.policy };
}

export async function inspectPortfolio(input: { participants: PortfolioParticipantInput[]; limit?: number }): Promise<Record<string, unknown>> { const { resolved, unavailable } = await resolveParticipants(input.participants); return synthesizePortfolio(resolved, unavailable, input.limit); }
export async function tracePortfolio(input: { participants: PortfolioParticipantInput[]; start: string; direction?: 'inbound' | 'outbound' | 'both'; depth?: number; statuses?: RelationshipStatus[]; limit?: number }): Promise<Record<string, unknown>> { const { resolved, unavailable } = await resolveParticipants(input.participants); return tracePortfolioGraphs(resolved, unavailable, input); }
