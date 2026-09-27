import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { stableHash } from '../util/hash.js';
import { deriveMotifs, type DerivedMotifKind } from './motifs.js';

export type SemanticCandidateKind = 'feature' | 'capability' | 'surface' | 'domain';
export type SemanticProposalOrigin = 'intrinsic-derivation' | 'ai-model' | 'human' | 'repository-declaration' | 'imported-assertion';
export type SemanticEvidenceFamily = 'structure' | 'relationship' | 'documentation' | 'interface' | 'state' | 'api' | 'persistence' | 'motif';

export interface SemanticCandidate {
  id: string;
  scope: string;
  proposal: {
    name: string;
    description: string;
    kind: SemanticCandidateKind;
    alternatives: string[];
  };
  authority: {
    state: 'proposed';
    accepted: false;
    reviewed: false;
    proofEligible: false;
    persisted: false;
    requiresExplicitReview: true;
  };
  provenance: {
    origin: 'intrinsic-derivation';
    producer: 'semantic-bootstrap.v1';
    revision: string | null;
    evidenceFamilies: SemanticEvidenceFamily[];
    nodeIds: string[];
    edgeIds: string[];
    evidenceIds: string[];
  };
  support: {
    scopeRole: 'functional-container' | 'direct';
    scopeDepth: number;
    evidenceFamilyCount: number;
    fileCount: number;
    nodeCount: number;
    resolvedEdgeCount: number;
    motifKinds: DerivedMotifKind[];
  };
  evidencePacket: {
    representativeNodes: Array<{ id: string; kind: string; name: string | null; locator: string; layer: string }>;
    representativeEdges: Array<{ id: string; kind: string; from: string | null; to: string | null; status: string }>;
  };
}

export interface SemanticBootstrapProjection {
  version: 1;
  revision: string | null;
  zeroMetadata: boolean;
  observedSemanticCount: number;
  declaredSemanticCount: number;
  candidates: SemanticCandidate[];
  policy: {
    stage: 'T1-derived-candidates';
    persisted: false;
    acceptedGraphAffected: false;
    productIntentInferred: false;
    modelOutputAcceptedAutomatically: false;
    explicitReviewRequiredForAcceptance: true;
  };
}

interface CandidateGroup {
  scope: string;
  token: string;
  scopeRole: 'functional-container' | 'direct';
  nodes: GraphNode[];
  files: Set<string>;
  edges: GraphEdge[];
}

const ROOT_SEGMENTS = new Set(['src', 'source', 'sources', 'lib', 'app', 'apps', 'packages', 'package', 'assets', 'scripts', 'server', 'client', 'frontend', 'backend', 'code']);
const SUPPORT_SEGMENTS = new Set(['components', 'hooks', 'utils', 'utilities', 'helpers', 'shared', 'common', 'internal']);
const CONTAINER_SEGMENTS = new Set(['features', 'feature', 'modules', 'module', 'domains', 'domain', 'services', 'service', 'screens', 'screen', 'pages', 'page', 'routes', 'route', 'api']);
const GENERIC_FILE_STEMS = new Set(['index', 'main', 'mod', 'module', 'app', 'application', 'program', 'startup']);
const TEST_OR_DOC_PATH = /(^|\/)(?:tests?|__tests__|fixtures?|docs?|examples?)(?:\/|$)/iu;

function sourceFile(locator: string): string | null {
  const clean = locator.replace(/^repo:/u, '').split('#', 1)[0] ?? locator;
  const match = /^(.*?)(?::\d+(?::.*)?)?$/u.exec(clean);
  const path = (match?.[1] ?? clean).replace(/^\.\//u, '').replace(/\\/gu, '/');
  return path.includes('/') || /\.[A-Za-z0-9]+$/u.test(path) ? path : null;
}

function stem(value: string): string {
  return value.replace(/\.[^.]+$/u, '');
}

function title(value: string): string {
  const technical = new Map([
    ['api', 'API'],
    ['ui', 'UI'],
    ['ux', 'UX'],
    ['oauth', 'OAuth'],
    ['sql', 'SQL'],
    ['mcp', 'MCP'],
  ]);
  return value
    .split(/[-_.\s]+/u)
    .filter(Boolean)
    .map(part => technical.get(part.toLowerCase()) ?? (part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function scopeForPath(path: string): { scope: string; token: string; scopeRole: 'functional-container' | 'direct' } | null {
  if (TEST_OR_DOC_PATH.test(path)) return null;
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return null;
  const file = parts[parts.length - 1]!;
  const directories = parts.slice(0, -1);
  let start = 0;
  while (start < directories.length && ROOT_SEGMENTS.has(directories[start]!.toLowerCase())) start += 1;
  while (start < directories.length - 1 && SUPPORT_SEGMENTS.has(directories[start]!.toLowerCase())) start += 1;

  const marker = directories.findIndex((part, index) =>
    index >= start - 1
    && CONTAINER_SEGMENTS.has(part.toLowerCase())
    && Boolean(directories[index + 1]),
  );
  const meaningfulIndex = marker >= 0 ? marker + 1 : start;

  if (meaningfulIndex < directories.length) {
    return {
      scope: directories.slice(0, meaningfulIndex + 1).join('/'),
      token: directories[meaningfulIndex]!,
      scopeRole: marker >= 0 ? 'functional-container' : 'direct',
    };
  }

  const fileStem = stem(file);
  if (!fileStem || GENERIC_FILE_STEMS.has(fileStem.toLowerCase())) return null;
  const prefix = directories.join('/');
  return { scope: prefix ? `${prefix}/${file}` : file, token: fileStem, scopeRole: 'direct' };
}

function nodeSearchText(node: GraphNode): string {
  return [node.kind, node.name ?? '', node.locator, node.raw].join(' ').toLowerCase();
}

function familyEvidence(group: CandidateGroup, graph: IntelligenceGraph): { families: SemanticEvidenceFamily[]; motifs: DerivedMotifKind[] } {
  const families = new Set<SemanticEvidenceFamily>();
  if (group.files.size > 0) families.add('structure');
  const resolvedEdges = group.edges.filter(edge => edge.status === 'resolved');
  if (resolvedEdges.length > 0) families.add('relationship');
  if (group.nodes.some(node => node.kind === 'document-statement')) families.add('documentation');

  const text = group.nodes.map(nodeSearchText).join('\n');
  if (group.nodes.some(node => /(?:ui-element|component-prop|navigation-call|html-element|css-class-reference|route)/u.test(node.kind))) families.add('interface');
  if (group.nodes.some(node => /state/u.test(node.kind)) || resolvedEdges.some(edge => /^(?:state-write|reads|writes)$/u.test(edge.kind))) families.add('state');
  if (group.nodes.some(node => /(?:api|http-call|rpc)/u.test(node.kind)) || /\b(?:api|endpoint|route|request|response)\b/u.test(text)) families.add('api');
  if (group.nodes.some(node => /(?:sql-|database|storage|persistence)/u.test(node.kind)) || /\b(?:database|storage|persist|supabase|postgres|redis|sql)\b/u.test(text)) families.add('persistence');

  const motifKinds = new Set<DerivedMotifKind>();
  // Motif projection is comparatively expensive because it performs graph-neighborhood
  // lookups. Only invoke it when the entity identity can satisfy one of the current
  // deterministic motif predicates; do not run motif detection speculatively across
  // every node in every semantic candidate group.
  const motifIdentityHint = /(?:bootstrap|composition root|lifetime scope|service registration|service installer|startup|state machine|adapter|bridge|relay|translator|mapper|pipeline|workflow|processing chain|repository|store|persistence|storage|database|\bdao\b)/iu;
  const motifSubjects = group.nodes
    .filter(node =>
      (node.layer ?? 'structural') === 'structural'
      && ['file', 'class', 'function', 'declaration'].includes(node.kind)
      && motifIdentityHint.test([node.name ?? '', node.locator].join(' '))
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 6);
  for (const node of motifSubjects) {
    for (const motif of deriveMotifs(graph, node)) motifKinds.add(motif.kind);
  }
  if (motifKinds.size > 0) families.add('motif');
  return { families: [...families].sort(), motifs: [...motifKinds].sort() };
}

function candidateKind(families: readonly SemanticEvidenceFamily[]): SemanticCandidateKind {
  if (families.includes('interface') && !families.includes('persistence')) return 'surface';
  if (families.includes('api') || families.includes('persistence') || families.includes('motif') || families.includes('state')) return 'capability';
  return 'feature';
}

function addUnique<T>(target: T[], value: T): void {
  if (!target.includes(value)) target.push(value);
}

export function bootstrapSemanticCandidates(graph: IntelligenceGraph, options: { limit?: number } = {}): SemanticBootstrapProjection {
  const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
  const groups = new Map<string, CandidateGroup>();
  const nodeScope = new Map<string, string>();

  for (const node of graph.nodes) {
    if ((node.layer ?? 'structural') === 'semantic') continue;
    const file = sourceFile(node.locator);
    if (!file) continue;
    const scoped = scopeForPath(file);
    if (!scoped) continue;
    const current = groups.get(scoped.scope) ?? {
      scope: scoped.scope,
      token: scoped.token,
      scopeRole: scoped.scopeRole,
      nodes: [],
      files: new Set<string>(),
      edges: [],
    };
    current.nodes.push(node);
    current.files.add(file);
    groups.set(scoped.scope, current);
    nodeScope.set(node.id, scoped.scope);
  }

  // Documentation is evidence, not ownership. An exact source-scope mention may
  // strengthen an already observed candidate, but documentation alone never creates
  // a candidate or changes acceptance authority.
  const documentation = graph.nodes.filter(node => node.kind === 'document-statement');
  for (const group of groups.values()) {
    for (const statement of documentation) {
      const text = [statement.name ?? '', statement.raw, JSON.stringify(statement.value ?? null)].join(' ');
      if (text.includes(group.scope)) group.nodes.push(statement);
    }
  }

  for (const edge of graph.edges) {
    if (edge.status !== 'resolved') continue;
    const scopes: string[] = [];
    if (edge.from) {
      const scope = nodeScope.get(edge.from);
      if (scope) addUnique(scopes, scope);
    }
    if (edge.to) {
      const scope = nodeScope.get(edge.to);
      if (scope) addUnique(scopes, scope);
    }
    for (const scope of scopes) groups.get(scope)?.edges.push(edge);
  }

  const candidates: SemanticCandidate[] = [];
  for (const group of groups.values()) {
    const { families, motifs } = familyEvidence(group, graph);
    const strongFamily = families.some(family => ['interface', 'api', 'persistence', 'motif', 'state'].includes(family));
    if (families.length < 2 || (group.files.size < 2 && !strongFamily)) continue;

    const kind = candidateKind(families);
    const name = title(group.token);
    const nodeIds = [...new Set(group.nodes.map(node => node.id))].sort();
    const edgeIds = [...new Set(group.edges.map(edge => edge.id))].sort();
    const evidenceIds = [...new Set([
      ...group.nodes.flatMap(node => node.evidenceIds ?? []),
      ...group.edges.flatMap(edge => edge.evidenceIds ?? []),
    ])].sort();
    const resolvedEdges = group.edges.filter(edge => edge.status === 'resolved');
    const id = `semantic-candidate:${stableHash(['semantic-bootstrap.v1', kind, name.toLowerCase(), group.scope])}`;

    candidates.push({
      id,
      scope: group.scope,
      proposal: {
        name,
        description: `Evidence-backed ${kind} candidate for ${group.scope}: ${group.files.size} source file(s) with ${families.join(', ')} evidence.`,
        kind,
        alternatives: [],
      },
      authority: {
        state: 'proposed',
        accepted: false,
        reviewed: false,
        proofEligible: false,
        persisted: false,
        requiresExplicitReview: true,
      },
      provenance: {
        origin: 'intrinsic-derivation',
        producer: 'semantic-bootstrap.v1',
        revision: graph.repositoryRevision,
        evidenceFamilies: families,
        nodeIds,
        edgeIds,
        evidenceIds,
      },
      support: {
        scopeRole: group.scopeRole,
        scopeDepth: group.scope.split('/').filter(Boolean).length,
        evidenceFamilyCount: families.length,
        fileCount: group.files.size,
        nodeCount: group.nodes.length,
        resolvedEdgeCount: resolvedEdges.length,
        motifKinds: motifs,
      },
      evidencePacket: {
        representativeNodes: group.nodes
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, 12)
          .map(node => ({
            id: node.id,
            kind: node.kind,
            name: node.name ?? null,
            locator: node.locator,
            layer: node.layer ?? 'structural',
          })),
        representativeEdges: resolvedEdges
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, 12)
          .map(edge => ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, status: edge.status })),
      },
    });
  }

  candidates.sort((a, b) => {
    const aRole = a.support.scopeRole === 'functional-container' ? 0 : 1;
    const bRole = b.support.scopeRole === 'functional-container' ? 0 : 1;
    return aRole - bRole
      || a.support.scopeDepth - b.support.scopeDepth
      || b.support.evidenceFamilyCount - a.support.evidenceFamilyCount
      || b.support.fileCount - a.support.fileCount
      || a.proposal.name.localeCompare(b.proposal.name)
      || a.scope.localeCompare(b.scope);
  });

  const semanticNodes = graph.nodes.filter(node => (node.layer ?? 'structural') === 'semantic');
  const declaredSemanticCount = semanticNodes.filter(node => node.tags?.includes('declared')).length;
  return {
    version: 1,
    revision: graph.repositoryRevision,
    zeroMetadata: declaredSemanticCount === 0,
    observedSemanticCount: semanticNodes.length,
    declaredSemanticCount,
    candidates: candidates.slice(0, limit),
    policy: {
      stage: 'T1-derived-candidates',
      persisted: false,
      acceptedGraphAffected: false,
      productIntentInferred: false,
      modelOutputAcceptedAutomatically: false,
      explicitReviewRequiredForAcceptance: true,
    },
  };
}
