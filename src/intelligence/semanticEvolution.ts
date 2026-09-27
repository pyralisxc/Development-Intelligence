import type { SemanticCandidate, SemanticEvidenceFamily } from './semanticBootstrap.js';
import {
  normalizeSemanticReviewActor,
  normalizeSemanticReviewRationale,
  normalizeSemanticReviewTimestamp,
  semanticMeaningReview,
  type SemanticMeaningReview,
  type SemanticReviewActor,
} from './semanticReview.js';

export type SemanticRealizationStatus =
  | 'preserved'
  | 'realization-changed'
  | 'renamed'
  | 'weakened'
  | 'unsupported'
  | 'ambiguous';

export interface SemanticSupportDelta {
  addedEvidenceFamilies: SemanticEvidenceFamily[];
  removedEvidenceFamilies: SemanticEvidenceFamily[];
  fileCountDelta: number;
  nodeCountDelta: number;
  resolvedEdgeCountDelta: number;
}

export interface SemanticEvolutionAssessment {
  version: 1;
  meaningId: string;
  sourceCandidateId: string;
  sourceRevision: string | null;
  targetRevision: string | null;
  status: SemanticRealizationStatus;
  reviewRequired: boolean;
  matchedCandidate: SemanticCandidate | null;
  alternatives: SemanticCandidate[];
  supportDelta: SemanticSupportDelta | null;
  reasons: string[];
  policy: {
    derivedAssessmentOnly: true;
    acceptedIdentityPreservedUnlessExplicitlyReplaced: true;
    splitMergeRequireExplicitReview: true;
    persisted: false;
    acceptedGraphAffected: false;
  };
}

export interface SemanticLifecycleResult {
  source: SemanticMeaningReview;
  successors: SemanticMeaningReview[];
}

export interface SemanticMergeResult {
  sources: SemanticMeaningReview[];
  successor: SemanticMeaningReview;
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function supportDelta(review: SemanticMeaningReview, candidate: SemanticCandidate): SemanticSupportDelta {
  const before = new Set(review.proposalProvenance.evidenceFamilies);
  const after = new Set(candidate.provenance.evidenceFamilies);
  return {
    addedEvidenceFamilies: [...after].filter(item => !before.has(item)).sort(),
    removedEvidenceFamilies: [...before].filter(item => !after.has(item)).sort(),
    fileCountDelta: candidate.support.fileCount - review.proposalSupport.fileCount,
    nodeCountDelta: candidate.support.nodeCount - review.proposalSupport.nodeCount,
    resolvedEdgeCountDelta: candidate.support.resolvedEdgeCount - review.proposalSupport.resolvedEdgeCount,
  };
}

function materiallyWeakened(review: SemanticMeaningReview, candidate: SemanticCandidate, delta: SemanticSupportDelta): boolean {
  if (delta.removedEvidenceFamilies.length >= 2) return true;
  if (review.proposalSupport.fileCount >= 4 && candidate.support.fileCount * 2 < review.proposalSupport.fileCount) return true;
  if (review.proposalSupport.resolvedEdgeCount >= 8 && candidate.support.resolvedEdgeCount * 2 < review.proposalSupport.resolvedEdgeCount) return true;
  return false;
}

function chooseTier(review: SemanticMeaningReview, candidates: SemanticCandidate[]): {
  kind: 'exact' | 'same-scope' | 'same-name' | 'none';
  matches: SemanticCandidate[];
} {
  const exact = candidates.filter(candidate => candidate.id === review.candidateId);
  if (exact.length) return { kind: 'exact', matches: exact };

  const sameScope = candidates.filter(candidate =>
    candidate.scope === review.scope
    && candidate.proposal.kind === review.proposal.kind
  );
  if (sameScope.length) return { kind: 'same-scope', matches: sameScope };

  const expectedName = normalized(review.proposal.name);
  const sameName = candidates.filter(candidate =>
    candidate.proposal.kind === review.proposal.kind
    && normalized(candidate.proposal.name) === expectedName
  );
  if (sameName.length) return { kind: 'same-name', matches: sameName };

  return { kind: 'none', matches: [] };
}

export function evaluateSemanticEvolution(
  review: SemanticMeaningReview,
  candidates: SemanticCandidate[],
  targetRevision: string | null,
): SemanticEvolutionAssessment {
  const tier = chooseTier(review, candidates);
  const base = {
    version: 1 as const,
    meaningId: review.meaningId,
    sourceCandidateId: review.candidateId,
    sourceRevision: review.proposalRevision,
    targetRevision,
    policy: {
      derivedAssessmentOnly: true as const,
      acceptedIdentityPreservedUnlessExplicitlyReplaced: true as const,
      splitMergeRequireExplicitReview: true as const,
      persisted: false as const,
      acceptedGraphAffected: false as const,
    },
  };

  if (tier.matches.length > 1) {
    return {
      ...base,
      status: 'ambiguous',
      reviewRequired: true,
      matchedCandidate: null,
      alternatives: tier.matches,
      supportDelta: null,
      reasons: [`${tier.matches.length} candidates match the strongest available semantic identity tier (${tier.kind})`],
    };
  }

  if (!tier.matches.length) {
    return {
      ...base,
      status: 'unsupported',
      reviewRequired: true,
      matchedCandidate: null,
      alternatives: [],
      supportDelta: null,
      reasons: ['No current semantic candidate matches the accepted meaning by candidate identity, scope/kind, or normalized name/kind'],
    };
  }

  const matched = tier.matches[0]!;
  const delta = supportDelta(review, matched);
  if (materiallyWeakened(review, matched, delta)) {
    return {
      ...base,
      status: 'weakened',
      reviewRequired: true,
      matchedCandidate: matched,
      alternatives: [],
      supportDelta: delta,
      reasons: [
        ...(delta.removedEvidenceFamilies.length ? [`lost evidence families: ${delta.removedEvidenceFamilies.join(', ')}`] : []),
        ...(delta.fileCountDelta < 0 ? [`physical source support changed by ${delta.fileCountDelta} file(s)`] : []),
        ...(delta.resolvedEdgeCountDelta < 0 ? [`resolved relationship support changed by ${delta.resolvedEdgeCountDelta}`] : []),
      ],
    };
  }

  if (tier.kind === 'same-scope' && normalized(matched.proposal.name) !== normalized(review.proposal.name)) {
    return {
      ...base,
      status: 'renamed',
      reviewRequired: true,
      matchedCandidate: matched,
      alternatives: [],
      supportDelta: delta,
      reasons: ['The same semantic scope/kind remains supported but its proposed name changed'],
    };
  }

  const supportChanged = delta.addedEvidenceFamilies.length > 0
    || delta.removedEvidenceFamilies.length > 0
    || delta.fileCountDelta !== 0
    || delta.nodeCountDelta !== 0
    || delta.resolvedEdgeCountDelta !== 0;

  if (tier.kind === 'same-name' || supportChanged) {
    return {
      ...base,
      status: 'realization-changed',
      reviewRequired: false,
      matchedCandidate: matched,
      alternatives: [],
      supportDelta: delta,
      reasons: [
        ...(tier.kind === 'same-name' ? ['Semantic name/kind survived while source scope changed'] : []),
        ...(supportChanged ? ['Semantic identity still matches, but implementation/evidence realization changed'] : []),
      ],
    };
  }

  return {
    ...base,
    status: 'preserved',
    reviewRequired: false,
    matchedCandidate: matched,
    alternatives: [],
    supportDelta: delta,
    reasons: ['Candidate identity and evidence realization remain materially stable'],
  };
}

function lifecycleContext(actor: SemanticReviewActor, at: string, rationale?: string | null) {
  return {
    actor: normalizeSemanticReviewActor(actor),
    at: normalizeSemanticReviewTimestamp(at),
    rationale: normalizeSemanticReviewRationale(rationale),
  };
}

function assertLifecycleSource(review: SemanticMeaningReview): void {
  if (!review.accepted) throw new Error('semantic lifecycle transition requires accepted source meaning');
  if (['superseded', 'split', 'merged'].includes(review.state)) throw new Error('semantic source meaning is already terminal');
}

export function supersedeSemanticMeaning(
  current: SemanticMeaningReview,
  successorMeaningIds: string[],
  actor: SemanticReviewActor,
  at: string,
  rationale?: string | null,
): SemanticMeaningReview {
  assertLifecycleSource(current);
  const context = lifecycleContext(actor, at, rationale);
  const successors = [...new Set(successorMeaningIds.map(id => id.trim()).filter(Boolean))].sort();
  return {
    ...current,
    state: 'superseded',
    lineage: { ...current.lineage, successorMeaningIds: successors },
    history: [...current.history, { kind: 'supersede', ...context, successorMeaningIds: successors }],
  };
}

export function replaceSemanticMeaning(
  current: SemanticMeaningReview,
  successorCandidate: SemanticCandidate,
  actor: SemanticReviewActor,
  at: string,
  rationale?: string | null,
): SemanticLifecycleResult {
  assertLifecycleSource(current);
  const context = lifecycleContext(actor, at, rationale);
  const successor = semanticMeaningReview(successorCandidate, { predecessorMeaningIds: [current.meaningId] });
  return {
    source: {
      ...current,
      state: 'superseded',
      lineage: { ...current.lineage, successorMeaningIds: [successor.meaningId] },
      history: [...current.history, { kind: 'replace', ...context, successorMeaningId: successor.meaningId }],
    },
    successors: [successor],
  };
}

export function splitSemanticMeaning(
  current: SemanticMeaningReview,
  successorCandidates: SemanticCandidate[],
  actor: SemanticReviewActor,
  at: string,
  rationale?: string | null,
): SemanticLifecycleResult {
  assertLifecycleSource(current);
  if (successorCandidates.length < 2) throw new Error('semantic split requires at least two successor candidates');
  const context = lifecycleContext(actor, at, rationale);
  const successors = successorCandidates.map(candidate => semanticMeaningReview(candidate, { predecessorMeaningIds: [current.meaningId] }));
  const successorMeaningIds = successors.map(item => item.meaningId).sort();
  return {
    source: {
      ...current,
      state: 'split',
      lineage: { ...current.lineage, successorMeaningIds },
      history: [...current.history, { kind: 'split', ...context, successorMeaningIds }],
    },
    successors,
  };
}

export function mergeSemanticMeanings(
  currents: SemanticMeaningReview[],
  successorCandidate: SemanticCandidate,
  actor: SemanticReviewActor,
  at: string,
  rationale?: string | null,
): SemanticMergeResult {
  if (currents.length < 2) throw new Error('semantic merge requires at least two source meanings');
  currents.forEach(assertLifecycleSource);
  const sourceMeaningIds = [...new Set(currents.map(item => item.meaningId))].sort();
  if (sourceMeaningIds.length !== currents.length) throw new Error('semantic merge source meanings must be unique');
  const context = lifecycleContext(actor, at, rationale);
  const successor = semanticMeaningReview(successorCandidate, { predecessorMeaningIds: sourceMeaningIds });
  return {
    sources: currents.map(current => ({
      ...current,
      state: 'merged' as const,
      lineage: { ...current.lineage, successorMeaningIds: [successor.meaningId] },
      history: [...current.history, {
        kind: 'merge' as const,
        ...context,
        successorMeaningId: successor.meaningId,
        sourceMeaningIds,
      }],
    })),
    successor,
  };
}
