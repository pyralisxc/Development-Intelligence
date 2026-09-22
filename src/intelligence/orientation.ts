import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { SOURCE_ANALYSIS_SUPPORT } from './analyzers/index.js';
import { deriveMotifs } from './motifs.js';

export type SourceScope =
  | 'implementation'
  | 'test'
  | 'documentation'
  | 'structured-data-or-configuration'
  | 'serialized-asset'
  | 'generated-or-tooling'
  | 'dependency-metadata'
  | 'unknown';

export type SourceOwnership = 'repository' | 'configured-external-source' | 'unknown';
export type AnalyzerDepth = 'behavioral' | 'structural' | 'serialized' | 'format' | 'unknown';

interface ClaimState {
  type?: string;
  status: 'supported' | 'contradicted' | 'unproven' | 'indeterminate';
  statement: string;
}

interface RelationshipOrientation {
  id: string;
  kind: string;
  status: GraphEdge['status'];
  from: string | null;
  to: string | null;
  evidence: string[];
}

function locatorPath(locator: string): string | null {
  const value = locator.trim();
  if (!value) return null;
  const withoutLine = value.replace(/:\d+(?::.*)?$/u, '');
  const withoutFragment = withoutLine.split('#', 1)[0] ?? withoutLine;
  return withoutFragment || null;
}

function extensionFor(path: string | null): string | null {
  if (!path) return null;
  const lower = path.toLowerCase();
  const extensions = SOURCE_ANALYSIS_SUPPORT
    .flatMap(item => [...item.extensions])
    .sort((a, b) => b.length - a.length);
  return extensions.find(extension => lower.endsWith(extension)) ?? null;
}

function sourceOwnership(graph: IntelligenceGraph, node: GraphNode | undefined): SourceOwnership {
  if (!node) return 'unknown';
  const source = graph.sources.find(item => item.id === node.sourceId);
  if (source?.kind === 'repository' || node.sourceId.startsWith('repo:')) return 'repository';
  return source ? 'configured-external-source' : 'unknown';
}

function sourceScope(path: string | null, node: GraphNode | undefined): SourceScope {
  if (!path || !node) return 'unknown';
  const normalized = path.replace(/\\/gu, '/').toLowerCase();
  if (/(^|\/)(tests?|__tests__)(\/|$)/u.test(normalized) || /\.(?:test|spec)\.[^/]+$/u.test(normalized)) return 'test';
  if (/(^|\/)(docs?|documentation)(\/|$)/u.test(normalized)
    || /(^|\/)(readme|changelog|agents)(?:\.[^/]*)?$/u.test(normalized)
    || /\.(?:md|mdx)$/u.test(normalized)) return 'documentation';
  if (/(^|\/)(node_modules|vendor)(\/|$)/u.test(normalized)
    || /(^|\/)(?:package-lock|packages-lock)\.json$/u.test(normalized)) return 'dependency-metadata';
  if (/(^|\/)(dist|build|generated|obj|bin)(\/|$)/u.test(normalized) || /\.g\.cs$/u.test(normalized)) return 'generated-or-tooling';
  if (['unity-object', 'unity-asset-guid'].includes(node.kind)
    || /\.(?:meta|unity|prefab|asset|mat|anim|controller|mixer)$/u.test(normalized)) return 'serialized-asset';
  if (/\.(?:json|asmdef|asmref|inputactions|ya?ml|toml|ini)$/u.test(normalized)
    || /(^|\/)(?:tsconfig|manifest|package)\.json$/u.test(normalized)) return 'structured-data-or-configuration';
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs|cs|java|py|css|sql|html|htm)$/u.test(normalized)) return 'implementation';
  return 'unknown';
}

function analyzerDepth(technology: string): AnalyzerDepth {
  if (technology === 'TypeScript/JavaScript') return 'behavioral';
  if (technology === 'Unity serialized assets') return 'serialized';
  if (technology === 'structured text' || technology === 'Unity structured configuration') return 'format';
  if (technology === 'C#' || technology === 'Java' || technology === 'Python' || technology === 'CSS' || technology === 'SQL') return 'structural';
  return 'unknown';
}

function analyzerLimitations(technology: string | null, depth: AnalyzerDepth): string[] {
  if (!technology) return ['No registered analyzer precision profile applies to the selected source path.'];
  if (technology === 'C#' || technology === 'Java' || technology === 'Python') {
    return [
      'General cross-file call binding and runtime execution order are not proven by this analyzer profile.',
      'Reflection, dependency injection behavior, and dynamically selected implementations require additional evidence.',
    ];
  }
  if (technology === 'Unity serialized assets') {
    return [
      'Serialized relationships do not by themselves prove runtime execution order or dynamically created objects.',
      'Unresolved GUID targets require tracked target metadata or additional runtime/source evidence.',
    ];
  }
  if (technology === 'CSS') return ['Source-to-selector usage is not inferred by this analyzer profile.'];
  if (technology === 'SQL') return ['Routine read/write references are conservative; dynamically constructed queries and provider behavior may remain unobserved.'];
  if (depth === 'format') return ['Format structure and textual statements do not by themselves prove runtime behavior or product meaning.'];
  if (depth === 'behavioral') return ['Runtime-only behavior, reflection, generated code, and dynamically computed targets may remain unobserved.'];
  return ['The registered analyzer does not claim complete runtime behavior.'];
}

function relationshipOrientation(edge: GraphEdge): RelationshipOrientation {
  return {
    id: edge.id,
    kind: edge.kind,
    status: edge.status,
    from: edge.from,
    to: edge.to,
    evidence: edge.evidence.slice(0, 3),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function projectOrientation(
  graph: IntelligenceGraph,
  selected: GraphNode | undefined,
  candidates: readonly GraphNode[],
  ambiguous: boolean,
  claims: readonly ClaimState[],
): Record<string, unknown> {
  const path = selected ? locatorPath(selected.locator) : null;
  const extension = extensionFor(path);
  const profile = extension
    ? SOURCE_ANALYSIS_SUPPORT.find(item => item.extensions.includes(extension as never))
    : undefined;
  const technology = profile?.technology ?? null;
  const depth = technology ? analyzerDepth(technology) : 'unknown';
  const incident = selected
    ? graph.edges.filter(edge => edge.from === selected.id || edge.to === selected.id)
    : [];
  const resolved = incident.filter(edge => edge.status === 'resolved');
  const possible = incident.filter(edge => edge.status === 'candidate').map(relationshipOrientation);
  const unresolved = incident.filter(edge => edge.status === 'unresolved').map(relationshipOrientation);
  const supportedClaims = claims.filter(item => item.status === 'supported' && item.type !== 'hypothesis-ruled-out').map(item => item.statement);
  const ruledOutClaims = claims.filter(item => item.status === 'supported' && item.type === 'hypothesis-ruled-out').map(item => item.statement);
  const missingClaims = claims.filter(item => item.status === 'contradicted' && item.type !== 'hypothesis-ruled-out').map(item => item.statement);
  const unknownClaims = claims.filter(item => item.status === 'unproven' || item.status === 'indeterminate').map(item => item.statement);
  const derived = selected ? deriveMotifs(graph, selected) : [];

  const disambiguatingEvidence: string[] = [];
  if (ambiguous) disambiguatingEvidence.push('Use an exact stable graph entity ID or a more specific subject to select one observed entity.');
  if (!selected && candidates.length === 0) disambiguatingEvidence.push('Provide a source path, symbol identity, or other repository evidence that identifies the intended subject.');
  if (depth === 'structural') disambiguatingEvidence.push('Add deterministic cross-file relationship evidence or a bounded runtime observation before asserting execution behavior.');
  if (depth === 'serialized') disambiguatingEvidence.push('Resolve serialized GUID targets or provide runtime/scene evidence before asserting runtime behavior.');
  if (possible.length) disambiguatingEvidence.push('Strengthen candidate relationships with deterministic binding evidence before using them as proof.');
  if (unresolved.length) disambiguatingEvidence.push('Resolve the reported relationship targets or supply the missing source/runtime evidence identified by those edges.');
  for (const item of derived) disambiguatingEvidence.push(...item.disambiguatingEvidence);
  if (graph.coverage && (graph.coverage.partialFiles || graph.coverage.failedFiles || graph.coverage.skippedFiles || graph.coverage.unsupportedFiles)) {
    disambiguatingEvidence.push('Complete relevant partial, skipped, failed, or unsupported source coverage before making repository-wide absence claims.');
  }

  return {
    subject: selected
      ? { id: selected.id, name: selected.name ?? selected.id, kind: selected.kind, layer: selected.layer ?? 'structural' }
      : null,
    source: {
      path,
      ownership: sourceOwnership(graph, selected),
      scope: sourceScope(path, selected),
    },
    analyzer: {
      technology,
      extension,
      depth,
      precision: profile?.precision ?? null,
      limitations: analyzerLimitations(technology, depth),
    },
    certainty: {
      known: unique([
        ...(selected ? [`${selected.name ?? selected.id} is directly observed as a ${selected.kind} in the selected revision.`] : []),
        ...(resolved.length ? [`${resolved.length} incident relationship(s) are deterministically resolved for the selected entity.`] : []),
        ...supportedClaims,
      ]),
      derived,
      possible,
      unresolved,
      missing: unique(missingClaims),
      ruledOut: unique(ruledOutClaims),
      unknown: unique(unknownClaims),
      disambiguatingEvidence: unique(disambiguatingEvidence),
    },
    motifSummary: {
      total: derived.length,
      kinds: derived.map(item => item.kind),
    },
    relationshipSummary: {
      resolved: resolved.length,
      candidate: possible.length,
      unresolved: unresolved.length,
      resolvedKinds: unique(resolved.map(edge => edge.kind)),
    },
    policy: {
      projection: 'assessment-only',
      persisted: false,
      acceptedCheckpointAffected: false,
      derivedClaimsMaySatisfyProof: false,
      note: 'Orientation explains the selected revision without promoting derived interpretation into accepted semantic topology.',
    },
  };
}
