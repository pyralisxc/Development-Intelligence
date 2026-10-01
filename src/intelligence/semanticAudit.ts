import type { IntelligenceGraph } from '../types.js';
import type { SemanticBootstrapProjection, SemanticCandidate } from './semanticBootstrap.js';

export type SemanticCoreClassification = 'core-candidate' | 'supporting-candidate';
export type SemanticFactualityStatus = 'supported' | 'needs-review';

export interface SemanticCandidateAudit {
  candidateId: string;
  scope: string;
  proposal: SemanticCandidate['proposal'];
  authority: SemanticCandidate['authority'];
  factuality: {
    status: SemanticFactualityStatus;
    reasons: string[];
    missingNodeIds: string[];
    missingEdgeIds: string[];
  };
  coreness: {
    classification: SemanticCoreClassification;
    reasons: string[];
    facets: {
      functionalContainer: boolean;
      multiFile: boolean;
      broadFileSupport: boolean;
      evidenceDiverse: boolean;
      relationshipRich: boolean;
      behavioralEvidence: string[];
      architecturalMotif: boolean;
    };
  };
}

export interface SemanticAuditProjection {
  version: 1;
  revision: string | null;
  candidateUniverse: {
    eligible: number;
    returned: number;
    exhausted: boolean;
    truncated: boolean;
    groupedScopes: number;
    rejectedScopes: number;
  };
  counts: {
    audited: number;
    factualitySupported: number;
    factualityNeedsReview: number;
    coreCandidates: number;
    supportingCandidates: number;
  };
  items: SemanticCandidateAudit[];
  policy: {
    derivedAssessmentOnly: true;
    authorityUnaffected: true;
    verificationUnaffected: true;
    acceptedGraphAffected: false;
    subjectiveGlobalScore: false;
    productIntentInferred: false;
  };
}

const BEHAVIOR_FAMILIES = new Set(['interface', 'state', 'api', 'persistence', 'motif']);

function auditCandidate(
  candidate: SemanticCandidate,
  observedNodeIds: ReadonlySet<string>,
  observedEdgeIds: ReadonlySet<string>,
): SemanticCandidateAudit {
  const missingNodeIds = candidate.provenance.nodeIds.filter(id => !observedNodeIds.has(id));
  const missingEdgeIds = candidate.provenance.edgeIds.filter(id => !observedEdgeIds.has(id));
  const factualityReasons: string[] = [];

  if (candidate.support.evidenceFamilyCount < 2) factualityReasons.push('fewer than two independent evidence families');
  if (!candidate.provenance.nodeIds.length) factualityReasons.push('no source-backed node provenance');
  if (missingNodeIds.length) factualityReasons.push(`${missingNodeIds.length} provenance node(s) are absent from this graph revision`);
  if (missingEdgeIds.length) factualityReasons.push(`${missingEdgeIds.length} provenance edge(s) are absent from this graph revision`);
  if (candidate.support.fileCount < 1) factualityReasons.push('no physical source-file support');
  if (candidate.authority.accepted || candidate.authority.persisted || candidate.authority.proofEligible) {
    factualityReasons.push('derived proposal unexpectedly crossed its authority boundary');
  }

  const behavioralEvidence = candidate.provenance.evidenceFamilies.filter(family => BEHAVIOR_FAMILIES.has(family));
  const facets = {
    functionalContainer: candidate.support.scopeRole === 'functional-container',
    multiFile: candidate.support.fileCount >= 2,
    broadFileSupport: candidate.support.fileCount >= 5,
    evidenceDiverse: candidate.support.evidenceFamilyCount >= 3,
    relationshipRich: candidate.support.resolvedEdgeCount >= 8,
    behavioralEvidence,
    architecturalMotif: candidate.support.motifKinds.length > 0,
  };

  const factualityStatus: SemanticFactualityStatus = factualityReasons.length ? 'needs-review' : 'supported';
  const coreCandidate = factualityStatus === 'supported'
    && facets.multiFile
    && facets.evidenceDiverse
    && (
      facets.broadFileSupport
      || facets.relationshipRich
      || facets.behavioralEvidence.length >= 2
      || facets.architecturalMotif
    );

  const coreReasons: string[] = [];
  if (facets.functionalContainer) coreReasons.push('functional source container');
  if (facets.broadFileSupport) coreReasons.push(`${candidate.support.fileCount} physical source files`);
  else if (facets.multiFile) coreReasons.push(`${candidate.support.fileCount} physical source files`);
  if (facets.evidenceDiverse) coreReasons.push(`${candidate.support.evidenceFamilyCount} evidence families`);
  if (facets.relationshipRich) coreReasons.push(`${candidate.support.resolvedEdgeCount} resolved relationships`);
  if (facets.behavioralEvidence.length) coreReasons.push(`behavioral evidence: ${facets.behavioralEvidence.join(', ')}`);
  if (facets.architecturalMotif) coreReasons.push(`motifs: ${candidate.support.motifKinds.join(', ')}`);
  if (!coreCandidate && factualityStatus === 'supported') {
    coreReasons.push('supported semantic meaning, but current evidence does not satisfy the explicit core-candidate rule');
  }

  return {
    candidateId: candidate.id,
    scope: candidate.scope,
    proposal: candidate.proposal,
    authority: candidate.authority,
    factuality: {
      status: factualityStatus,
      reasons: factualityReasons,
      missingNodeIds,
      missingEdgeIds,
    },
    coreness: {
      classification: coreCandidate ? 'core-candidate' : 'supporting-candidate',
      reasons: coreReasons,
      facets,
    },
  };
}

export function auditSemanticCandidates(
  graph: IntelligenceGraph,
  bootstrap: SemanticBootstrapProjection,
  options: { limit?: number } = {},
): SemanticAuditProjection {
  const limit = Math.max(1, Math.min(options.limit ?? 24, 200));
  const candidateById = new Map(bootstrap.candidates.map(candidate => [candidate.id, candidate]));
  const wantedNodeIds = new Set<string>();
  const wantedEdgeIds = new Set<string>();
  for (const candidate of bootstrap.candidates) {
    for (const id of candidate.provenance.nodeIds) wantedNodeIds.add(id);
    for (const id of candidate.provenance.edgeIds) wantedEdgeIds.add(id);
  }
  const observedNodeIds = new Set<string>();
  for (const node of graph.nodes) if (wantedNodeIds.has(node.id)) observedNodeIds.add(node.id);
  const observedEdgeIds = new Set<string>();
  for (const edge of graph.edges) if (wantedEdgeIds.has(edge.id)) observedEdgeIds.add(edge.id);

  const audited = bootstrap.candidates.map(candidate => auditCandidate(candidate, observedNodeIds, observedEdgeIds));
  audited.sort((a, b) => {
    const aCore = a.coreness.classification === 'core-candidate' ? 0 : 1;
    const bCore = b.coreness.classification === 'core-candidate' ? 0 : 1;
    const aSupported = a.factuality.status === 'supported' ? 0 : 1;
    const bSupported = b.factuality.status === 'supported' ? 0 : 1;
    const aCandidate = candidateById.get(a.candidateId)!;
    const bCandidate = candidateById.get(b.candidateId)!;
    return aSupported - bSupported
      || aCore - bCore
      || Number(b.coreness.facets.functionalContainer) - Number(a.coreness.facets.functionalContainer)
      || bCandidate.support.evidenceFamilyCount - aCandidate.support.evidenceFamilyCount
      || bCandidate.support.fileCount - aCandidate.support.fileCount
      || bCandidate.support.resolvedEdgeCount - aCandidate.support.resolvedEdgeCount
      || a.scope.localeCompare(b.scope);
  });

  const coreCandidates = audited.filter(item => item.coreness.classification === 'core-candidate').length;
  const factualitySupported = audited.filter(item => item.factuality.status === 'supported').length;
  return {
    version: 1,
    revision: graph.repositoryRevision,
    candidateUniverse: {
      eligible: bootstrap.capacity.eligibleCandidateCount,
      returned: bootstrap.candidates.length,
      exhausted: bootstrap.capacity.exhausted,
      truncated: bootstrap.capacity.truncated,
      groupedScopes: bootstrap.capacity.groupedScopeCount,
      rejectedScopes: bootstrap.capacity.rejectedScopeCount,
    },
    counts: {
      audited: audited.length,
      factualitySupported,
      factualityNeedsReview: audited.length - factualitySupported,
      coreCandidates,
      supportingCandidates: audited.length - coreCandidates,
    },
    items: audited.slice(0, limit),
    policy: {
      derivedAssessmentOnly: true,
      authorityUnaffected: true,
      verificationUnaffected: true,
      acceptedGraphAffected: false,
      subjectiveGlobalScore: false,
      productIntentInferred: false,
    },
  };
}
