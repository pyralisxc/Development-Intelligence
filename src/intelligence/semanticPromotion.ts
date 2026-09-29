import type { SemanticCandidate, SemanticCandidateKind } from './semanticBootstrap.js';
import { stableHash } from '../util/hash.js';
import { evaluateSemanticEvolution, type SemanticEvolutionAssessment, type SemanticRealizationStatus } from './semanticEvolution.js';
import { semanticMeaningReview, type SemanticMeaningReview } from './semanticReview.js';

export type SemanticPromotionApprovalBasis = 'ai-verified' | 'human-accepted' | 'human-verified';
export type SemanticPromotionChangeKind = 'added' | Exclude<SemanticRealizationStatus, 'preserved'>;

export interface SemanticPromotionMeaningSnapshot {
  revision: string | null;
  meaningId: string | null;
  candidateId: string | null;
  scope: string;
  name: string;
  description: string;
  kind: SemanticCandidateKind;
  evidenceFamilies: string[];
  evidenceIds: string[];
}

export interface SemanticPromotionReviewItem {
  auditRef: string;
  ordinal: number;
  changeId: string;
  changeKind: SemanticPromotionChangeKind;
  meaningId: string;
  candidateId: string | null;
  scope: string;
  name: string;
  sourceRevision: string | null;
  targetRevision: string | null;
  reviewRequired: true;
  approvalRequired: true;
  approvalBases: SemanticPromotionApprovalBasis[];
  approved: boolean;
  summary: string;
  before: SemanticPromotionMeaningSnapshot | null;
  after: SemanticPromotionMeaningSnapshot | null;
  alternatives: SemanticPromotionMeaningSnapshot[];
  reasons: string[];
  evolution: SemanticEvolutionAssessment | null;
}

export interface SemanticPromotionGate {
  version: 1;
  baseRevision: string | null;
  previewRevision: string | null;
  semanticDeltaCount: number;
  approvedCount: number;
  pendingCount: number;
  readyForMainSemanticPromotion: boolean;
  items: SemanticPromotionReviewItem[];
  policy: {
    boundary: 'preview-to-main';
    stableMeaningsOmitted: true;
    previousRevisionApprovalDoesNotApprovePreviewDelta: true;
    acceptedIsNotVerified: true;
    approvalAlternatives: readonly ['human-accepted'];
    verificationDoesNotApprovePromotion: true;
    itemizedAuditManifest: true;
    stableAuditReferences: true;
    desiredOutcomeInferred: false;
    persisted: false;
    acceptedGraphAffected: false;
  };
}

function reviewApprovalBases(
  review: SemanticMeaningReview | undefined,
  targetRevision: string | null,
): SemanticPromotionApprovalBasis[] {
  if (!review || review.proposalRevision !== targetRevision) return [];
  const bases: SemanticPromotionApprovalBasis[] = [];
  if (review.accepted && review.acceptance?.actor.kind === 'human') bases.push('human-accepted');
  if (review.verification?.actor.kind === 'human') bases.push('human-verified');
  if (review.verification?.actor.kind === 'ai-model') bases.push('ai-verified');
  return bases;
}

function changeId(kind: SemanticPromotionChangeKind, meaningId: string, targetRevision: string | null): string {
  return `${targetRevision ?? 'unknown'}:${kind}:${meaningId}`;
}

function auditRef(value: string): string {
  return `SEM-${stableHash(['semantic-promotion-audit.v1', value]).slice(0, 8).toUpperCase()}`;
}

function reviewSnapshot(review: SemanticMeaningReview): SemanticPromotionMeaningSnapshot {
  return {
    revision: review.proposalRevision,
    meaningId: review.meaningId,
    candidateId: review.candidateId,
    scope: review.scope,
    name: review.proposal.name,
    description: review.proposal.description,
    kind: review.proposal.kind,
    evidenceFamilies: [...review.proposalProvenance.evidenceFamilies],
    evidenceIds: [...review.proposalProvenance.evidenceIds],
  };
}

function candidateSnapshot(candidate: SemanticCandidate, meaningId: string | null): SemanticPromotionMeaningSnapshot {
  return {
    revision: candidate.provenance.revision,
    meaningId,
    candidateId: candidate.id,
    scope: candidate.scope,
    name: candidate.proposal.name,
    description: candidate.proposal.description,
    kind: candidate.proposal.kind,
    evidenceFamilies: [...candidate.provenance.evidenceFamilies],
    evidenceIds: [...candidate.provenance.evidenceIds],
  };
}

function changeSummary(
  kind: SemanticPromotionChangeKind,
  before: SemanticPromotionMeaningSnapshot | null,
  after: SemanticPromotionMeaningSnapshot | null,
): string {
  if (kind === 'added' && after) return `Current evidence introduces ${after.kind} "${after.name}" at ${after.scope}.`;
  if (kind === 'unsupported' && before) return `Current evidence no longer supports ${before.kind} "${before.name}" at ${before.scope}.`;
  if (before && after) return `Current evidence classifies "${before.name}" → "${after.name}" as ${kind}.`;
  return `Current evidence classifies this semantic change as ${kind}.`;
}

function previewReviewForMeaning(
  reviews: SemanticMeaningReview[],
  meaningId: string,
  candidateId: string | null,
): SemanticMeaningReview | undefined {
  return reviews.find(review =>
    review.meaningId === meaningId
    && (candidateId === null || review.candidateId === candidateId)
  );
}

export function buildSemanticPromotionGate(input: {
  baseMeanings: SemanticMeaningReview[];
  previewCandidates: SemanticCandidate[];
  previewReviews?: SemanticMeaningReview[];
  baseRevision: string | null;
  previewRevision: string | null;
}): SemanticPromotionGate {
  const previewReviews = input.previewReviews ?? [];
  const drafts: Array<Omit<SemanticPromotionReviewItem, 'auditRef' | 'ordinal'>> = [];
  const consumedCandidateIds = new Set<string>();

  for (const base of input.baseMeanings) {
    if (!base.accepted) continue;
    const evolution = evaluateSemanticEvolution(base, input.previewCandidates, input.previewRevision);
    if (evolution.matchedCandidate) consumedCandidateIds.add(evolution.matchedCandidate.id);
    for (const alternative of evolution.alternatives) consumedCandidateIds.add(alternative.id);
    if (evolution.status === 'preserved') continue;

    const candidate = evolution.matchedCandidate;
    const review = previewReviewForMeaning(previewReviews, base.meaningId, candidate?.id ?? null);
    const approvalBases = reviewApprovalBases(review, input.previewRevision);
    const approved = approvalBases.includes('human-accepted');
    drafts.push({
      changeId: changeId(evolution.status, base.meaningId, input.previewRevision),
      changeKind: evolution.status,
      meaningId: base.meaningId,
      candidateId: candidate?.id ?? null,
      scope: candidate?.scope ?? base.scope,
      name: candidate?.proposal.name ?? base.proposal.name,
      sourceRevision: base.proposalRevision,
      targetRevision: input.previewRevision,
      reviewRequired: true,
      approvalRequired: true,
      approvalBases,
      approved,
      summary: changeSummary(
        evolution.status,
        reviewSnapshot(base),
        candidate ? candidateSnapshot(candidate, base.meaningId) : null,
      ),
      before: reviewSnapshot(base),
      after: candidate ? candidateSnapshot(candidate, base.meaningId) : null,
      alternatives: evolution.alternatives.map(alternative => candidateSnapshot(alternative, null)),
      reasons: evolution.reasons,
      evolution,
    });
  }

  for (const candidate of input.previewCandidates) {
    if (consumedCandidateIds.has(candidate.id)) continue;
    const existingReview = previewReviews.find(review =>
      review.candidateId === candidate.id
      && review.proposalRevision === input.previewRevision
    );
    const review = existingReview ?? semanticMeaningReview(candidate);
    const approvalBases = reviewApprovalBases(existingReview, input.previewRevision);
    const approved = approvalBases.includes('human-accepted');
    drafts.push({
      changeId: changeId('added', review.meaningId, input.previewRevision),
      changeKind: 'added',
      meaningId: review.meaningId,
      candidateId: candidate.id,
      scope: candidate.scope,
      name: candidate.proposal.name,
      sourceRevision: input.baseRevision,
      targetRevision: input.previewRevision,
      reviewRequired: true,
      approvalRequired: true,
      approvalBases,
      approved,
      summary: changeSummary('added', null, candidateSnapshot(candidate, review.meaningId)),
      before: null,
      after: candidateSnapshot(candidate, review.meaningId),
      alternatives: [],
      reasons: ['New evidence-qualified semantic candidate exists on Preview but was not matched to an accepted Main meaning'],
      evolution: null,
    });
  }

  drafts.sort((a, b) =>
    a.changeKind.localeCompare(b.changeKind)
    || a.name.localeCompare(b.name)
    || a.meaningId.localeCompare(b.meaningId)
  );
  const items: SemanticPromotionReviewItem[] = drafts.map((item, index) => ({
    ...item,
    ordinal: index + 1,
    auditRef: auditRef(item.changeId),
  }));

  const approvedCount = items.filter(item => item.approved).length;
  return {
    version: 1,
    baseRevision: input.baseRevision,
    previewRevision: input.previewRevision,
    semanticDeltaCount: items.length,
    approvedCount,
    pendingCount: items.length - approvedCount,
    readyForMainSemanticPromotion: items.length === approvedCount,
    items,
    policy: {
      boundary: 'preview-to-main',
      stableMeaningsOmitted: true,
      previousRevisionApprovalDoesNotApprovePreviewDelta: true,
      acceptedIsNotVerified: true,
      approvalAlternatives: ['human-accepted'],
      verificationDoesNotApprovePromotion: true,
      itemizedAuditManifest: true,
      stableAuditReferences: true,
      desiredOutcomeInferred: false,
      persisted: false,
      acceptedGraphAffected: false,
    },
  };
}
