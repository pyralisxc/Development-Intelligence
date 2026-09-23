import type { GraphNode, IntelligenceGraph, RelationshipStatus } from '../types.js';
import { stableHash } from '../util/hash.js';

export type PortfolioParticipant = { key: string; project: string; graph: IntelligenceGraph };
export type PortfolioUnavailable = { key: string; project: string; ref?: string; graphId?: string; error: string };
export type PortfolioEndpoint = { participant: string; project: string; nodeId: string; locator: string; requested?: string };
export type PortfolioLink = { id: string; kind: string; status: 'resolved' | 'candidate'; strategy: string; identifier: string; from: PortfolioEndpoint; to: PortfolioEndpoint; note?: string };
export type PortfolioTraceNode = { participant: string; project: string; nodeId: string; originalNodeId: string; kind: string; layer: string; name: string | null; locator: string };
export type PortfolioTraceHop = { id: string; scope: 'repository' | 'cross-repository'; from: string; to: string; kind: string; status: RelationshipStatus; strategy: string; participant?: string; project?: string; originalEdgeId?: string; identifier?: string; evidence?: string[]; evidenceIds?: string[]; provenance?: { from: PortfolioEndpoint; to: PortfolioEndpoint; note: string | null } };

type Evidence = { key: string; project: string; nodeId: string; locator: string; identifier: string; family: string };
type Dependency = Evidence & { dependencyType: string; requested: string };

export const namespacePortfolioId = (key: string, id: string) => `${key}::${id}`;
const repoPath = (node: GraphNode) => node.sourceId.startsWith('repo:') ? node.sourceId.slice(5) : null;
const isPackageJson = (path: string | null) => Boolean(path && (path === 'package.json' || path.endsWith('/package.json')));
const isDependencyManifest = (path: string | null) => isPackageJson(path) || path === 'Packages/manifest.json';
const textValue = (node: GraphNode): string | null => typeof node.value === 'string' && node.value.trim() ? node.value.trim() : typeof node.name === 'string' && node.name.trim() ? node.name.trim() : null;
const endpoint = (item: Evidence, requested?: string): PortfolioEndpoint => ({ participant: item.key, project: item.project, nodeId: namespacePortfolioId(item.key, item.nodeId), locator: item.locator, ...(requested ? { requested } : {}) });

function packageOwners(participants: PortfolioParticipant[]): Evidence[] {
  const out: Evidence[] = [];
  for (const participant of participants) for (const node of participant.graph.nodes) {
    if (node.kind !== 'structured-value' || node.field !== 'name' || !isPackageJson(repoPath(node))) continue;
    const identifier = textValue(node);
    if (identifier) out.push({ key: participant.key, project: participant.project, nodeId: node.id, locator: node.locator, identifier, family: 'package' });
  }
  return out;
}

function packageDependencies(participants: PortfolioParticipant[]): Dependency[] {
  const out: Dependency[] = [];
  const pattern = /^(dependencies|devDependencies|peerDependencies|optionalDependencies)\.(.+)$/u;
  for (const participant of participants) for (const node of participant.graph.nodes) {
    if (node.kind !== 'structured-value' || !node.field || !isDependencyManifest(repoPath(node))) continue;
    const match = pattern.exec(node.field);
    const requested = typeof node.value === 'string' ? node.value.trim() : '';
    if (match && requested) out.push({ key: participant.key, project: participant.project, nodeId: node.id, locator: node.locator, identifier: match[2]!, family: 'package', dependencyType: match[1]!, requested });
  }
  return out;
}

function pathIdentity(node: GraphNode): string | null {
  if (node.kind === 'api' || node.kind === 'route') return textValue(node);
  if (node.kind === 'http-call') {
    const value = node.value && typeof node.value === 'object' ? node.value as Record<string, unknown> : null;
    const url = typeof value?.url === 'string' ? value.url.trim() : '';
    return url.startsWith('/') ? (url.split('?')[0] ?? url) : null;
  }
  if (node.kind === 'route-reference' || node.kind === 'navigation-call') {
    const value = textValue(node);
    return value?.startsWith('/') ? (value.split('?')[0] ?? value) : null;
  }
  return null;
}

function technicalOwners(participants: PortfolioParticipant[]): Evidence[] {
  const out: Evidence[] = [];
  for (const participant of participants) for (const node of participant.graph.nodes) {
    if (node.layer !== 'semantic') continue;
    const family = ['api', 'route', 'provider', 'mcp', 'tool'].includes(node.kind) ? node.kind : null;
    const identifier = family === 'api' || family === 'route' ? pathIdentity(node) : family ? textValue(node) : null;
    if (family && identifier) out.push({ key: participant.key, project: participant.project, nodeId: node.id, locator: node.locator, identifier, family });
  }
  return out;
}

function technicalReferences(participants: PortfolioParticipant[]): Evidence[] {
  const out: Evidence[] = [];
  for (const participant of participants) for (const node of participant.graph.nodes) {
    if (!['http-call', 'route-reference', 'navigation-call'].includes(node.kind)) continue;
    const identifier = pathIdentity(node);
    if (!identifier) continue;
    out.push({ key: participant.key, project: participant.project, nodeId: node.id, locator: node.locator, identifier, family: identifier.startsWith('/api/') || node.kind === 'http-call' ? 'api' : 'route' });
  }
  return out;
}

export function buildPortfolioLinks(participants: PortfolioParticipant[]): PortfolioLink[] {
  const links: PortfolioLink[] = [];
  const packages = packageOwners(participants);
  for (const dependency of packageDependencies(participants)) {
    const owners = packages.filter(owner => owner.identifier === dependency.identifier && owner.key !== dependency.key);
    if (!owners.length) continue;
    const status: PortfolioLink['status'] = owners.length === 1 ? 'resolved' : 'candidate';
    for (const owner of owners) links.push({ id: stableHash(['portfolio', 'package', dependency.key, dependency.nodeId, owner.key, owner.nodeId]), kind: 'depends-on-package', status, strategy: status === 'resolved' ? 'exact-package-identity' : 'ambiguous-package-owner', identifier: dependency.identifier, from: endpoint(dependency, dependency.requested), to: endpoint(owner) });
  }
  const owners = technicalOwners(participants);
  for (const reference of technicalReferences(participants)) {
    const matches = owners.filter(owner => owner.family === reference.family && owner.identifier === reference.identifier && owner.key !== reference.key);
    if (!matches.length) continue;
    const status: PortfolioLink['status'] = matches.length === 1 ? 'resolved' : 'candidate';
    for (const owner of matches) links.push({ id: stableHash(['portfolio', reference.family, reference.key, reference.nodeId, owner.key, owner.nodeId]), kind: `references-${reference.family}`, status, strategy: status === 'resolved' ? 'exact-typed-identifier' : 'ambiguous-typed-owner', identifier: reference.identifier, from: endpoint(reference), to: endpoint(owner) });
  }
  const groups = new Map<string, Evidence[]>();
  for (const owner of owners) {
    const groupKey = `${owner.family}\u0000${owner.identifier}`;
    const bucket = groups.get(groupKey) ?? [];
    bucket.push(owner);
    groups.set(groupKey, bucket);
  }
  for (const group of groups.values()) for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
    const left = group[i]!, right = group[j]!;
    if (left.key === right.key) continue;
    links.push({ id: stableHash(['portfolio', 'correlation', left.family, left.key, left.nodeId, right.key, right.nodeId]), kind: `correlates-${left.family}`, status: 'candidate', strategy: 'exact-typed-identifier-correlation', identifier: left.identifier, from: endpoint(left), to: endpoint(right), note: 'Exact typed identity correlation across repositories; this does not prove dependency direction.' });
  }
  return links.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export function portfolioSharedDependencies(participants: PortfolioParticipant[]) {
  const groups = new Map<string, Dependency[]>();
  for (const dependency of packageDependencies(participants)) {
    const bucket = groups.get(dependency.identifier) ?? [];
    bucket.push(dependency);
    groups.set(dependency.identifier, bucket);
  }
  return [...groups.entries()].map(([identifier, evidence]) => ({ identifier, participants: [...new Set(evidence.map(item => item.key))].sort(), requests: evidence.map(item => ({ participant: item.key, project: item.project, dependencyType: item.dependencyType, requested: item.requested, nodeId: namespacePortfolioId(item.key, item.nodeId), locator: item.locator })).sort((a, b) => a.participant.localeCompare(b.participant) || a.locator.localeCompare(b.locator)) })).filter(item => item.participants.length > 1).sort((a, b) => b.participants.length - a.participants.length || a.identifier.localeCompare(b.identifier));
}

export function portfolioTechnicalCorrelations(participants: PortfolioParticipant[]) {
  const groups = new Map<string, Evidence[]>();
  for (const owner of technicalOwners(participants)) {
    const groupKey = `${owner.family}\u0000${owner.identifier}`;
    const bucket = groups.get(groupKey) ?? [];
    bucket.push(owner);
    groups.set(groupKey, bucket);
  }
  return [...groups.values()].map(evidence => ({ family: evidence[0]!.family, identifier: evidence[0]!.identifier, participants: [...new Set(evidence.map(item => item.key))].sort(), status: 'candidate' as const, reason: 'The same typed technical identifier is observed in multiple repositories. This is correlation evidence, not proof of a dependency.', evidence: evidence.map(item => ({ participant: item.key, project: item.project, nodeId: namespacePortfolioId(item.key, item.nodeId), locator: item.locator })) })).filter(item => item.participants.length > 1).sort((a, b) => b.participants.length - a.participants.length || a.family.localeCompare(b.family) || a.identifier.localeCompare(b.identifier));
}

export function portfolioBlastRadius(links: PortfolioLink[]) {
  const groups = new Map<string, { target: PortfolioEndpoint; consumers: Set<string>; kinds: Set<string>; ids: string[] }>();
  for (const link of links) {
    if (link.status !== 'resolved') continue;
    const bucket = groups.get(link.to.nodeId) ?? { target: link.to, consumers: new Set<string>(), kinds: new Set<string>(), ids: [] };
    bucket.consumers.add(link.from.participant); bucket.kinds.add(link.kind); bucket.ids.push(link.id); groups.set(link.to.nodeId, bucket);
  }
  return [...groups.values()].map(item => ({ target: item.target, consumerParticipants: [...item.consumers].sort(), relationshipKinds: [...item.kinds].sort(), linkIds: item.ids.sort(), basis: 'resolved-cross-repository-links' as const, note: 'Derived from resolved cross-repository evidence; not an impact severity score.' })).sort((a, b) => b.consumerParticipants.length - a.consumerParticipants.length || a.target.nodeId.localeCompare(b.target.nodeId));
}
