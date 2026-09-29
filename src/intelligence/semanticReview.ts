import type { SemanticCandidate, SemanticProposalOrigin } from './semanticBootstrap.js';
import { stableHash } from '../util/hash.js';

export type SemanticReviewActorKind = SemanticProposalOrigin;
export type SemanticReviewState = 'proposed' | 'reviewed' | 'accepted' | 'rejected' | 'superseded' | 'split' | 'merged';

export interface SemanticReviewActor {
  kind: SemanticReviewActorKind;
  id: string;
}

export interface SemanticAcceptanceRecord {
  actor: SemanticReviewActor;
  at: string;
  rationale: string | null;
}

export interface SemanticVerificationRecord {
  actor: SemanticReviewActor;
  at: string;
  evidenceIds: string[];
  rationale: string | null;
}

export interface SemanticMeaningLineage {
  predecessorMeaningIds: string[];
  successorMeaningIds: string[];
}

export type SemanticReviewEvent =
  | { kind: 'amend'; actor: SemanticReviewActor; at: string; rationale: string | null; before: SemanticCandidate['proposal']; after: SemanticCandidate['proposal'] }
  | { kind: 'accept'; actor: SemanticReviewActor; at: string; rationale: string | null }
  | { kind: 'reject'; actor: SemanticReviewActor; at: string; rationale: string | null }
  | { kind: 'verify'; actor: SemanticReviewActor; at: string; rationale: string | null; evidenceIds: string[] }
  | { kind: 'supersede'; actor: SemanticReviewActor; at: string; rationale: string | null; successorMeaningIds: string[] }
  | { kind: 'split'; actor: SemanticReviewActor; at: string; rationale: string | null; successorMeaningIds: string[] }
  | { kind: 'merge'; actor: SemanticReviewActor; at: string; rationale: string | null; successorMeaningId: string; sourceMeaningIds: string[] }
  | { kind: 'replace'; actor: SemanticReviewActor; at: string; rationale: string | null; successorMeaningId: string };

export interface SemanticMeaningReview {
  version: 1;
  meaningId: string;
  candidateId: string;
  scope: string;
  proposalRevision: string | null;
  proposal: SemanticCandidate['proposal'];
  proposalProvenance: SemanticCandidate['provenance'];
  proposalSupport: SemanticCandidate['support'];
  state: SemanticReviewState;
  reviewed: boolean;
  accepted: boolean;
  acceptance: SemanticAcceptanceRecord | null;
  verification: SemanticVerificationRecord | null;
  lineage: SemanticMeaningLineage;
  history: SemanticReviewEvent[];
  policy: {
    sharedHumanAiReviewSurface: true;
    acceptanceImpliesVerification: false;
    verificationRequiresEvidence: true;
    proposalProvenancePreserved: true;
    stableMeaningIdentityDistinctFromCandidateIdentity: true;
    persisted: boolean;
    acceptedGraphAffected: false;
  };
}

export type SemanticReviewAction =
  | {
      kind: 'amend';
      actor: SemanticReviewActor;
      at: string;
      proposal: Partial<SemanticCandidate['proposal']>;
      rationale?: string | null;
    }
  | {
      kind: 'accept' | 'reject';
      actor: SemanticReviewActor;
      at: string;
      rationale?: string | null;
    }
  | {
      kind: 'verify';
      actor: SemanticReviewActor;
      at: string;
      evidenceIds: string[];
      rationale?: string | null;
    };

export function normalizeSemanticReviewActor(value: SemanticReviewActor): SemanticReviewActor {
  if (!value.id.trim()) throw new Error('semantic review actor id must be non-empty');
  return { kind: value.kind, id: value.id.trim() };
}

export function normalizeSemanticReviewTimestamp(value: string): string {
  if (!value.trim() || Number.isNaN(Date.parse(value))) throw new Error('semantic review action requires an ISO-compatible timestamp');
  return value;
}

export function normalizeSemanticReviewRationale(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cloneProposal(value: SemanticCandidate['proposal']): SemanticCandidate['proposal'] {
  return {
    ...value,
    alternatives: [...value.alternatives],
    ...(value.grouping ? { grouping: [...value.grouping] } : {}),
  };
}

function cloneSupport(value: SemanticCandidate['support']): SemanticCandidate['support'] {
  return { ...value, motifKinds: [...value.motifKinds] };
}

function initialMeaningId(candidate: SemanticCandidate): string {
  return `semantic-meaning:${stableHash([
    'semantic-meaning.v1',
    candidate.id,
    candidate.provenance.revision ?? 'unknown-revision',
  ])}`;
}

export function semanticMeaningReview(
  candidate: SemanticCandidate,
  options: { meaningId?: string; predecessorMeaningIds?: string[] } = {},
): SemanticMeaningReview {
  const meaningId = options.meaningId?.trim() || initialMeaningId(candidate);
  return {
    version: 1,
    meaningId,
    candidateId: candidate.id,
    scope: candidate.scope,
    proposalRevision: candidate.provenance.revision,
    proposal: cloneProposal(candidate.proposal),
    proposalProvenance: {
      ...candidate.provenance,
      evidenceFamilies: [...candidate.provenance.evidenceFamilies],
      nodeIds: [...candidate.provenance.nodeIds],
      edgeIds: [...candidate.provenance.edgeIds],
      evidenceIds: [...candidate.provenance.evidenceIds],
    },
    proposalSupport: cloneSupport(candidate.support),
    state: 'proposed',
    reviewed: false,
    accepted: false,
    acceptance: null,
    verification: null,
    lineage: {
      predecessorMeaningIds: [...new Set(options.predecessorMeaningIds ?? [])].sort(),
      successorMeaningIds: [],
    },
    history: [],
    policy: {
      sharedHumanAiReviewSurface: true,
      acceptanceImpliesVerification: false,
      verificationRequiresEvidence: true,
      proposalProvenancePreserved: true,
      stableMeaningIdentityDistinctFromCandidateIdentity: true,
      persisted: false,
      acceptedGraphAffected: false,
    },
  };
}

export function applySemanticReviewAction(
  current: SemanticMeaningReview,
  action: SemanticReviewAction,
): SemanticMeaningReview {
  const who = normalizeSemanticReviewActor(action.actor);
  const at = normalizeSemanticReviewTimestamp(action.at);
  const why = normalizeSemanticReviewRationale(action.rationale);

  if (['superseded', 'split', 'merged'].includes(current.state)) {
    throw new Error('terminal semantic meaning must be followed through lineage rather than reviewed in place');
  }

  if (action.kind === 'amend') {
    if (current.state === 'accepted' || current.state === 'rejected') {
      throw new Error('accepted/rejected semantic meaning must be replaced or superseded rather than silently amended');
    }
    const before = cloneProposal(current.proposal);
    const nextProposal: SemanticCandidate['proposal'] = {
      ...before,
      ...action.proposal,
      alternatives: action.proposal.alternatives
        ? [...action.proposal.alternatives]
        : [...before.alternatives],
    };
    return {
      ...current,
      proposal: nextProposal,
      state: 'reviewed',
      reviewed: true,
      history: [...current.history, { kind: 'amend', actor: who, at, rationale: why, before, after: cloneProposal(nextProposal) }],
    };
  }

  if (action.kind === 'accept') {
    if (current.state === 'rejected') throw new Error('rejected semantic meaning cannot be accepted without an explicit replacement proposal');
    return {
      ...current,
      state: 'accepted',
      reviewed: true,
      accepted: true,
      acceptance: { actor: who, at, rationale: why },
      history: [...current.history, { kind: 'accept', actor: who, at, rationale: why }],
    };
  }

  if (action.kind === 'reject') {
    if (current.state === 'accepted') throw new Error('accepted semantic meaning must be superseded rather than destructively rejected');
    return {
      ...current,
      state: 'rejected',
      reviewed: true,
      accepted: false,
      acceptance: null,
      history: [...current.history, { kind: 'reject', actor: who, at, rationale: why }],
    };
  }

  if (action.kind !== 'verify') throw new Error('unsupported semantic review action');
  const evidenceIds = [...new Set(action.evidenceIds.map((value: string) => value.trim()).filter(Boolean))].sort();
  if (!evidenceIds.length) throw new Error('semantic verification requires at least one evidence id');
  return {
    ...current,
    verification: { actor: who, at, evidenceIds, rationale: why },
    history: [...current.history, { kind: 'verify', actor: who, at, rationale: why, evidenceIds }],
  };
}
