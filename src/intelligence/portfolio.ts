import type { GraphNode, IntelligenceGraph } from '../types.js';
import { stableHash } from '../util/hash.js';
import { graphContext } from './service.js';

export interface PortfolioParticipantInput {
  key?: string;
  project: string;
  ref?: string;
  graphId?: string;
}

interface ResolvedParticipant {
  key: string;
  project: string;
  graph: IntelligenceGraph;
}

interface UnavailableParticipant {
  key: string;
  project: string;
  ref?: string;
  graphId?: string;
  error: string;
}

interface IdentityEvidence {
  key: string;
  project: string;
  nodeId: string;
  namespacedNodeId: string;
  locator: string;
  identifier: string;
  family: string;
}

interface DependencyEvidence extends IdentityEvidence {
  dependencyType: string;
  requested: string;
}

interface PortfolioEndpoint {
  participant: string;
  project: string;
  nodeId: string;
  locator: string;
  requested?: string;
}

interface PortfolioLink {
  id: string;
  kind: string;
  status: 'resolved' | 'candidate';
  strategy: string;
  identifier: string;
  from: PortfolioEndpoint;
  to: PortfolioEndpoint;
  note?: string;
}

interface SharedDependencyGroup {
  identifier: string;
  participants: string[];
  requests: Array<{
    participant: string;
    project: string;
    dependencyType: string;
    requested: string;
    nodeId: string;
    locator: string;
  }>;
}

interface TechnicalCorrelation {
  family: string;
  identifier: string;
  participants: string[];
  status: 'candidate';
  reason: string;
  evidence: Array<{ participant: string; project: string; nodeId: string; locator: string }>;
}

interface PortfolioBlastRadius {
  target: PortfolioEndpoint;
  consumerParticipants: string[];
  relationshipKinds: string[];
  linkIds: string[];
  basis: 'resolved-cross-repository-links';
  note: string;
}

function participantKey(input: PortfolioParticipantInput): string {
  const key = input.key?.trim() || input.project.trim();
  if (!key) throw new Error('portfolio participant key must be non-empty');
  return key;
}

function namespaceId(key: string, id: string): string {
  return `${key}::${id}`;
}

function sourcePath(node: GraphNode): string | null {
  return node.sourceId.startsWith('repo:') ? node.sourceId.slice('repo:'.length) : null;
}

function isPackageJson(path: string | null): boolean {
  return Boolean(path && (path === 'package.json' || path.endsWith('/package.json')));
}

function isDependencyManifest(path: string | null): boolean {
  return isPackageJson(path) || path === 'Packages/manifest.json';
}

function stringValue(node: GraphNode): string | null {
  if (typeof node.value === 'string' && node.value.trim()) return node.value.trim();
  if (typeof node.name === 'string' && node.name.trim()) return node.name.trim();
  return null;
}

function compactCoverage(graph: IntelligenceGraph): Record<string, unknown> | null {
  if (!graph.coverage) return null;
  const { files: _files, ...summary } = graph.coverage;
  return summary;
}

function packageOwners(participants: ResolvedParticipant[]): IdentityEvidence[] {
  const values: IdentityEvidence[] = [];
  for (const participant of participants) for (const node of participant.graph.nodes) {
    const path = sourcePath(node);
    if (node.kind !== 'structured-value' || node.field !== 'name' || !isPackageJson(path)) continue;
    const identifier = stringValue(node);
    if (!identifier) continue;
    values.push({
      key: participant.key,
      project: participant.project,
      nodeId: node.id,
      namespacedNodeId: namespaceId(participant.key, node.id),
      locator: node.locator,
      identifier,
      family: 'package',
    });
  }
  return values;
}

function packageDependencies(participants: ResolvedParticipant[]): DependencyEvidence[] {
  const values: DependencyEvidence[] = [];
  const pattern = /^(dependencies|devDependencies|peerDependencies|optionalDependencies)\.(.+)$/u;
  for (const participant of participants) for (const node of participant.graph.nodes) {
    const path = sourcePath(node);
    if (node.kind !== 'structured-value' || !isDependencyManifest(path) || !node.field) continue;
    const match = pattern.exec(node.field);
    if (!match) continue;
    const requested = typeof node.value === 'string' ? node.value.trim() : String(node.value ?? '');
    if (!requested) continue;
    values.push({
      key: participant.key,
      project: participant.project,
      nodeId: node.id,
      namespacedNodeId: namespaceId(participant.key, node.id),
      locator: node.locator,
      identifier: match[2]!,
      family: 'package',
      dependencyType: match[1]!,
      requested,
    });
  }
  return values;
}

function normalizedApiIdentifier(node: GraphNode): string | null {
  if (node.kind === 'api') return stringValue(node);
  if (node.kind === 'http-call') {
    const value = node.value && typeof node.value === 'object' ? node.value as Record<string, unknown> : null;
    const url = typeof value?.url === 'string' ? value.url.trim() : '';
    if (!url || !url.startsWith('/')) return null;
    return url.split('?')[0] ?? url;
  }
  if (node.kind === 'route-reference' || node.kind === 'navigation-call') {
    const value = stringValue(node);
    if (!value || !value.startsWith('/api/')) return null;
    return value.split('?')[0] ?? value;
  }
  return null;
}

function technicalOwners(participants: ResolvedParticipant[]): IdentityEvidence[] {
  const ownerKinds = new Set(['api', 'route', 'provider', 'mcp', 'tool']);
  const values: IdentityEvidence[] = [];
  for (const participant of participants) for (const node of participant.graph.nodes) {
    if (node.layer !== 'semantic' || !ownerKinds.has(node.kind)) continue;
    const identifier = node.kind === 'api' ? normalizedApiIdentifier(node) : stringValue(node);
    if (!identifier) continue;
    values.push({
      key: participant.key,
      project: participant.project,
      nodeId: node.id,
      namespacedNodeId: namespaceId(participant.key, node.id),
      locator: node.locator,
      identifier,
      family: node.kind,
    });
  }
  return values;
}

function technicalReferences(participants: ResolvedParticipant[]): IdentityEvidence[] {
  const values: IdentityEvidence[] = [];
  for (const participant of participants) for (const node of participant.graph.nodes) {
    let family: string | null = null;
    let identifier: string | null = null;
    if (node.kind === 'http-call' || node.kind === 'route-reference' || node.kind === 'navigation-call') {
      family = 'api';
      identifier = normalizedApiIdentifier(node);
    }
    if (!family || !identifier) continue;
    values.push({
      key: participant.key,
      project: participant.project,
      nodeId: node.id,
      namespacedNodeId: namespaceId(participant.key, node.id),
      locator: node.locator,
      identifier,
      family,
    });
  }
  return values;
}

function sharedDependencyGroups(dependencies: DependencyEvidence[]): SharedDependencyGroup[] {
  const grouped = new Map<string, DependencyEvidence[]>();
  for (const dependency of dependencies) {
    const bucket = grouped.get(dependency.identifier) ?? [];
    bucket.push(dependency);
    grouped.set(dependency.identifier, bucket);
  }
  return [...grouped.entries()]
    .map(([identifier, evidence]) => ({
      identifier,
      participants: [...new Set(evidence.map(item => item.key))].sort(),
      requests: evidence.map(item => ({
        participant: item.key,
        project: item.project,
        dependencyType: item.dependencyType,
        requested: item.requested,
        nodeId: item.namespacedNodeId,
        locator: item.locator,
      })).sort((a, b) => a.participant.localeCompare(b.participant) || a.locator.localeCompare(b.locator)),
    }))
    .filter(item => item.participants.length > 1)
    .sort((a, b) => b.participants.length - a.participants.length || String(a.identifier).localeCompare(String(b.identifier)));
}

function sharedTechnicalIdentifiers(owners: IdentityEvidence[]): TechnicalCorrelation[] {
  const grouped = new Map<string, IdentityEvidence[]>();
  for (const owner of owners) {
    const groupKey = `${owner.family}\u0000${owner.identifier}`;
    const bucket = grouped.get(groupKey) ?? [];
    bucket.push(owner);
    grouped.set(groupKey, bucket);
  }
  return [...grouped.values()]
    .map(evidence => ({
      family: evidence[0]!.family,
      identifier: evidence[0]!.identifier,
      participants: [...new Set(evidence.map(item => item.key))].sort(),
      status: 'candidate',
      reason: 'The same typed technical identifier is observed in multiple repositories. This is correlation evidence, not proof of a dependency.',
      evidence: evidence.map(item => ({ participant: item.key, project: item.project, nodeId: item.namespacedNodeId, locator: item.locator })),
    }))
    .filter(item => item.participants.length > 1)
    .sort((a, b) => b.participants.length - a.participants.length || String(a.family).localeCompare(String(b.family)) || String(a.identifier).localeCompare(String(b.identifier)));
}

function resolvedLinks(
  dependencies: DependencyEvidence[],
  packageIdentityOwners: IdentityEvidence[],
  references: IdentityEvidence[],
  technicalIdentityOwners: IdentityEvidence[],
): PortfolioLink[] {
  const links: PortfolioLink[] = [];
  const packageByName = new Map<string, IdentityEvidence[]>();
  for (const owner of packageIdentityOwners) {
    const bucket = packageByName.get(owner.identifier) ?? [];
    bucket.push(owner);
    packageByName.set(owner.identifier, bucket);
  }
  for (const dependency of dependencies) {
    const candidates = (packageByName.get(dependency.identifier) ?? []).filter(owner => owner.key !== dependency.key);
    if (!candidates.length) continue;
    const status = candidates.length === 1 ? 'resolved' : 'candidate';
    for (const owner of candidates) links.push({
      id: stableHash(['portfolio-link', 'package', dependency.namespacedNodeId, owner.namespacedNodeId]),
      kind: 'depends-on-package',
      status,
      strategy: status === 'resolved' ? 'exact-package-identity' : 'ambiguous-package-owner',
      identifier: dependency.identifier,
      from: { participant: dependency.key, project: dependency.project, nodeId: dependency.namespacedNodeId, locator: dependency.locator, requested: dependency.requested },
      to: { participant: owner.key, project: owner.project, nodeId: owner.namespacedNodeId, locator: owner.locator },
    });
  }

  const technicalByKey = new Map<string, IdentityEvidence[]>();
  for (const owner of technicalIdentityOwners) {
    const key = `${owner.family}\u0000${owner.identifier}`;
    const bucket = technicalByKey.get(key) ?? [];
    bucket.push(owner);
    technicalByKey.set(key, bucket);
  }
  for (const reference of references) {
    const candidates = (technicalByKey.get(`${reference.family}\u0000${reference.identifier}`) ?? []).filter(owner => owner.key !== reference.key);
    if (!candidates.length) continue;
    const status = candidates.length === 1 ? 'resolved' : 'candidate';
    for (const owner of candidates) links.push({
      id: stableHash(['portfolio-link', reference.family, reference.namespacedNodeId, owner.namespacedNodeId]),
      kind: `references-${reference.family}`,
      status,
      strategy: status === 'resolved' ? 'exact-typed-identifier' : 'ambiguous-typed-owner',
      identifier: reference.identifier,
      from: { participant: reference.key, project: reference.project, nodeId: reference.namespacedNodeId, locator: reference.locator },
      to: { participant: owner.key, project: owner.project, nodeId: owner.namespacedNodeId, locator: owner.locator },
    });
  }
  const groupedTechnical = new Map<string, IdentityEvidence[]>();
  for (const owner of technicalIdentityOwners) {
    const key = `${owner.family}\u0000${owner.identifier}`;
    const bucket = groupedTechnical.get(key) ?? [];
    bucket.push(owner);
    groupedTechnical.set(key, bucket);
  }
  for (const owners of groupedTechnical.values()) {
    const distinct = owners.filter((owner, index) => owners.findIndex(candidate => candidate.key === owner.key && candidate.nodeId === owner.nodeId) === index);
    for (let leftIndex = 0; leftIndex < distinct.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < distinct.length; rightIndex += 1) {
      const left = distinct[leftIndex]!;
      const right = distinct[rightIndex]!;
      if (left.key === right.key) continue;
      links.push({
        id: stableHash(['portfolio-link', 'technical-correlation', left.family, left.namespacedNodeId, right.namespacedNodeId]),
        kind: `correlates-${left.family}`,
        status: 'candidate',
        strategy: 'exact-typed-identifier-correlation',
        identifier: left.identifier,
        from: { participant: left.key, project: left.project, nodeId: left.namespacedNodeId, locator: left.locator },
        to: { participant: right.key, project: right.project, nodeId: right.namespacedNodeId, locator: right.locator },
        note: 'Exact typed identity correlation across repositories; this does not prove a dependency direction.',
      });
    }
  }
  return links.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.id).localeCompare(String(b.id)));
}

function blastRadius(links: PortfolioLink[]): PortfolioBlastRadius[] {
  const grouped = new Map<string, { target: Record<string, unknown>; consumers: Set<string>; linkIds: string[]; kinds: Set<string> }>();
  for (const link of links) {
    if (link.status !== 'resolved') continue;
    const to = link.to as Record<string, unknown>;
    const from = link.from as Record<string, unknown>;
    const key = `${String(to.participant)}::${String(to.nodeId)}`;
    const bucket = grouped.get(key) ?? { target: to, consumers: new Set<string>(), linkIds: [], kinds: new Set<string>() };
    bucket.consumers.add(String(from.participant));
    bucket.linkIds.push(String(link.id));
    bucket.kinds.add(String(link.kind));
    grouped.set(key, bucket);
  }
  return [...grouped.values()]
    .map(item => ({
      target: item.target,
      consumerParticipants: [...item.consumers].sort(),
      relationshipKinds: [...item.kinds].sort(),
      linkIds: item.linkIds.sort(),
      basis: 'resolved-cross-repository-links',
      note: 'This is a likely technical blast-radius surface derived from resolved cross-repository evidence, not an impact severity score.',
    }))
    .sort((a, b) => b.consumerParticipants.length - a.consumerParticipants.length || String((a.target as any).nodeId).localeCompare(String((b.target as any).nodeId)));
}

export function synthesizePortfolio(
  participants: ResolvedParticipant[],
  unavailable: UnavailableParticipant[] = [],
  limit = 50,
): Record<string, unknown> {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit || 50)));
  const packageIdentityOwners = packageOwners(participants);
  const dependencies = packageDependencies(participants);
  const technicalIdentityOwners = technicalOwners(participants);
  const references = technicalReferences(participants);
  const links = resolvedLinks(dependencies, packageIdentityOwners, references, technicalIdentityOwners);
  const sharedDependencies = sharedDependencyGroups(dependencies);
  const technicalCorrelations = sharedTechnicalIdentifiers(technicalIdentityOwners);
  const exactIdentities = participants
    .map(item => `${item.key}|${item.project}|${item.graph.repositoryRevision ?? 'unknown'}|${item.graph.graphId}|${item.graph.analyzerVersion}`)
    .sort();
  const portfolioId = `portfolio-${stableHash([...exactIdentities, ...unavailable.map(item => `unavailable|${item.key}|${item.project}`).sort()]).slice(0, 16)}`;

  const radius = blastRadius(links);
  const investigationTargets = [
    ...unavailable.map(item => ({
      kind: 'unavailable-participant',
      basis: 'availability',
      summary: `${item.key} is unavailable to this portfolio investigation.`,
      participant: item,
      nextEvidence: 'Restore repository/revision access or remove the participant before drawing portfolio-wide absence conclusions.',
    })),
    ...links.filter(link => link.status === 'candidate').map(link => ({
      kind: 'candidate-cross-repository-link',
      basis: 'candidate-evidence',
      summary: `${String(link.kind)} for ${String(link.identifier)} is correlated but not uniquely proven.`,
      linkId: link.id,
      nextEvidence: 'Provide a deterministic producer/reference identifier or remove the ambiguous owner before promoting this relationship to resolved.',
    })),
    ...sharedDependencies.map(item => ({
      kind: 'shared-dependency',
      basis: 'observed-manifests',
      summary: `${String(item.identifier)} is declared by ${item.participants.length} portfolio participants.`,
      identifier: item.identifier,
      participants: item.participants,
      nextEvidence: 'Inspect version/range divergence and affected consumers when changing or upgrading this dependency.',
    })),
    ...radius.map(item => ({
      kind: 'cross-repository-blast-radius',
      basis: 'resolved-cross-repository-links',
      summary: `${String((item.target as any).nodeId)} has ${item.consumerParticipants.length} observed cross-repository consumer participant(s).`,
      target: item.target,
      consumerParticipants: item.consumerParticipants,
      linkIds: item.linkIds,
      nextEvidence: 'Inspect the owning entity and listed consumer links before changing the target contract.',
    })),
  ].slice(0, boundedLimit);

  return {
    portfolioId,
    participants: participants.map(item => ({
      key: item.key,
      project: item.project,
      graphId: item.graph.graphId,
      revision: item.graph.repositoryRevision,
      analyzerVersion: item.graph.analyzerVersion,
      coverage: compactCoverage(item.graph),
      counts: { nodes: item.graph.nodes.length, edges: item.graph.edges.length, evidence: item.graph.evidence.length },
    })).sort((a, b) => a.key.localeCompare(b.key)),
    unavailableParticipants: unavailable.slice().sort((a, b) => a.key.localeCompare(b.key)),
    crossRepositoryLinks: links.slice(0, boundedLimit),
    crossRepositoryLinkTotal: links.length,
    sharedDependencies: sharedDependencies.slice(0, boundedLimit),
    sharedDependencyTotal: sharedDependencies.length,
    technicalCorrelations: technicalCorrelations.slice(0, boundedLimit),
    technicalCorrelationTotal: technicalCorrelations.length,
    blastRadius: radius.slice(0, boundedLimit),
    audit: { investigationTargets, sharedDependencyCount: sharedDependencies.length, likelyBlastRadiusCount: radius.length, unavailableParticipantCount: unavailable.length },
    truncated: links.length > boundedLimit || sharedDependencies.length > boundedLimit || technicalCorrelations.length > boundedLimit,
    policy: {
      persisted: false,
      acceptedCheckpointAffected: false,
      modifiesRepositories: false,
      participantAuthorityPreserved: true,
      identityNamespace: '<participant-key>::<original-node-id>',
      note: 'Portfolio intelligence is an ephemeral derived investigation. Repository graphs remain authoritative only for their own exact revisions.',
    },
  };
}

async function resolvePortfolioParticipants(inputs: PortfolioParticipantInput[]): Promise<{ resolved: ResolvedParticipant[]; unavailable: UnavailableParticipant[] }> {
  if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 12) throw new Error('participants must contain 2-12 repositories/revisions');
  const keys = new Set<string>();
  const resolved: ResolvedParticipant[] = [];
  const unavailable: UnavailableParticipant[] = [];
  await Promise.all(inputs.map(async participant => {
    if (!participant || typeof participant.project !== 'string' || !participant.project.trim()) throw new Error('each portfolio participant requires project');
    if (participant.ref && participant.graphId) throw new Error(`${participant.project}: use either ref or graphId, not both`);
    const key = participantKey(participant);
    if (key.includes('::')) throw new Error(`portfolio participant key may not contain "::": ${key}`);
    if (keys.has(key)) throw new Error(`duplicate portfolio participant key: ${key}`);
    keys.add(key);
    try {
      const context = await graphContext(participant.project, {
        ...(participant.ref ? { ref: participant.ref } : {}),
        ...(participant.graphId ? { graphId: participant.graphId } : {}),
      });
      resolved.push({ key, project: participant.project, graph: context.graph });
    } catch (error) {
      unavailable.push({
        key,
        project: participant.project,
        ...(participant.ref ? { ref: participant.ref } : {}),
        ...(participant.graphId ? { graphId: participant.graphId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
  return { resolved, unavailable };
}

export function tracePortfolioGraphs(
  participants: ResolvedParticipant[],
  unavailable: UnavailableParticipant[],
  input: { start: string; direction?: 'inbound' | 'outbound' | 'both'; depth?: number; statuses?: Array<'resolved' | 'candidate' | 'unresolved'>; limit?: number },
): Record<string, unknown> {
  const direction = input.direction ?? 'both';
  const depth = Math.max(1, Math.min(4, Math.floor(input.depth ?? 2)));
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
  const statuses = new Set(input.statuses?.length ? input.statuses : ['resolved']);
  const nodes = new Map<string, Record<string, unknown>>();
  for (const participant of participants) for (const node of participant.graph.nodes) nodes.set(namespaceId(participant.key, node.id), {
    participant: participant.key,
    project: participant.project,
    nodeId: namespaceId(participant.key, node.id),
    originalNodeId: node.id,
    kind: node.kind,
    layer: node.layer ?? 'structural',
    name: node.name ?? null,
    locator: node.locator,
  });
  if (!nodes.has(input.start)) throw new Error(`portfolio trace start node not found: ${input.start}`);

  const outgoing = new Map<string, Array<Record<string, unknown>>>();
  const incoming = new Map<string, Array<Record<string, unknown>>>();
  const addHop = (from: string, to: string, hop: Record<string, unknown>) => {
    const out = outgoing.get(from) ?? [];
    out.push(hop);
    outgoing.set(from, out);
    const inn = incoming.get(to) ?? [];
    inn.push(hop);
    incoming.set(to, inn);
  };

  for (const participant of participants) for (const edge of participant.graph.edges) {
    if (!edge.from || !edge.to || !statuses.has(edge.status)) continue;
    const from = namespaceId(participant.key, edge.from);
    const to = namespaceId(participant.key, edge.to);
    if (!nodes.has(from) || !nodes.has(to)) continue;
    addHop(from, to, {
      id: namespaceId(participant.key, edge.id),
      scope: 'repository',
      participant: participant.key,
      project: participant.project,
      originalEdgeId: edge.id,
      from,
      to,
      kind: edge.kind,
      status: edge.status,
      strategy: edge.strategy,
      evidence: edge.evidence,
      evidenceIds: edge.evidenceIds ?? [],
    });
  }

  const packageIdentityOwners = packageOwners(participants);
  const dependencies = packageDependencies(participants);
  const technicalIdentityOwners = technicalOwners(participants);
  const references = technicalReferences(participants);
  const crossLinks = resolvedLinks(dependencies, packageIdentityOwners, references, technicalIdentityOwners);
  for (const link of crossLinks) {
    const status = String(link.status) as 'resolved' | 'candidate' | 'unresolved';
    if (!statuses.has(status)) continue;
    const from = String((link.from as any).nodeId);
    const to = String((link.to as any).nodeId);
    if (!nodes.has(from) || !nodes.has(to)) continue;
    addHop(from, to, {
      id: link.id,
      scope: 'cross-repository',
      from,
      to,
      kind: link.kind,
      status: link.status,
      strategy: link.strategy,
      identifier: link.identifier,
      provenance: { from: link.from, to: link.to, note: link.note ?? null },
    });
  }

  const visited = new Map<string, number>([[input.start, 0]]);
  const queue: string[] = [input.start];
  const selectedHops = new Map<string, Record<string, unknown>>();
  while (queue.length && selectedHops.size < limit) {
    const current = queue.shift()!;
    const currentDepth = visited.get(current) ?? 0;
    if (currentDepth >= depth) continue;
    const candidates: Array<{ hop: Record<string, unknown>; next: string }> = [];
    if (direction === 'outbound' || direction === 'both') for (const hop of outgoing.get(current) ?? []) candidates.push({ hop, next: String(hop.to) });
    if (direction === 'inbound' || direction === 'both') for (const hop of incoming.get(current) ?? []) candidates.push({ hop, next: String(hop.from) });
    for (const candidate of candidates) {
      if (selectedHops.size >= limit) break;
      selectedHops.set(String(candidate.hop.id), candidate.hop);
      if (!visited.has(candidate.next)) {
        visited.set(candidate.next, currentDepth + 1);
        queue.push(candidate.next);
      }
    }
  }

  const participantSummary = synthesizePortfolio(participants, unavailable, Math.min(limit, 200)) as any;
  const selectedNodes = [...visited.keys()].map(id => nodes.get(id)!).filter(Boolean);
  const hops = [...selectedHops.values()];
  return {
    portfolioId: participantSummary.portfolioId,
    participants: participantSummary.participants,
    unavailableParticipants: participantSummary.unavailableParticipants,
    start: input.start,
    direction,
    depth,
    statuses: [...statuses],
    nodes: selectedNodes,
    hops,
    crossRepositoryHopCount: hops.filter(hop => hop.scope === 'cross-repository').length,
    truncated: selectedHops.size >= limit,
    policy: participantSummary.policy,
  };
}

export async function inspectPortfolio(input: { participants: PortfolioParticipantInput[]; limit?: number }): Promise<Record<string, unknown>> {
  const { resolved, unavailable } = await resolvePortfolioParticipants(input.participants);
  return synthesizePortfolio(resolved, unavailable, input.limit);
}

export async function tracePortfolio(input: { participants: PortfolioParticipantInput[]; start: string; direction?: 'inbound' | 'outbound' | 'both'; depth?: number; statuses?: Array<'resolved' | 'candidate' | 'unresolved'>; limit?: number }): Promise<Record<string, unknown>> {
  const { resolved, unavailable } = await resolvePortfolioParticipants(input.participants);
  return tracePortfolioGraphs(resolved, unavailable, input);
}
