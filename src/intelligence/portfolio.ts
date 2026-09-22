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

function sharedDependencyGroups(dependencies: DependencyEvidence[]): Array<Record<string, unknown>> {
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

function sharedTechnicalIdentifiers(owners: IdentityEvidence[]): Array<Record<string, unknown>> {
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
): Array<Record<string, unknown>> {
  const links: Array<Record<string, unknown>> = [];
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
  return links.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.id).localeCompare(String(b.id)));
}

function blastRadius(links: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
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
    blastRadius: blastRadius(links).slice(0, boundedLimit),
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

export async function inspectPortfolio(input: { participants: PortfolioParticipantInput[]; limit?: number }): Promise<Record<string, unknown>> {
  if (!Array.isArray(input.participants) || input.participants.length < 2 || input.participants.length > 12) throw new Error('participants must contain 2-12 repositories/revisions');
  const keys = new Set<string>();
  const resolved: ResolvedParticipant[] = [];
  const unavailable: UnavailableParticipant[] = [];

  await Promise.all(input.participants.map(async participant => {
    if (!participant || typeof participant.project !== 'string' || !participant.project.trim()) throw new Error('each portfolio participant requires project');
    if (participant.ref && participant.graphId) throw new Error(`${participant.project}: use either ref or graphId, not both`);
    const key = participantKey(participant);
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

  return synthesizePortfolio(resolved, unavailable, input.limit);
}
