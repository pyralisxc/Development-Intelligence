import { bootstrapSemanticCandidates, type SemanticCandidate, type SemanticCandidateKind } from './semanticBootstrap.js';
import {
  loadSemanticAuthority,
  persistSemanticChangeVerification,
  persistSemanticReview,
  persistSemanticReviews,
  semanticChangeVerificationsAtRevision,
  semanticReviewsAtRevision,
  type SemanticAuthorityLedger,
  type SemanticAuthorityLoad,
} from './semanticAuthorityStore.js';
import {
  evaluateSemanticEvolution,
  mergeSemanticMeanings,
  replaceSemanticMeaning,
  splitSemanticMeaning,
} from './semanticEvolution.js';
import {
  applySemanticReviewAction,
  normalizeSemanticReviewActor,
  normalizeSemanticReviewRationale,
  normalizeSemanticReviewTimestamp,
  semanticMeaningReview,
  type SemanticChangeVerificationRecord,
  type SemanticMeaningReview,
  type SemanticReviewAction,
  type SemanticReviewActor,
} from './semanticReview.js';
import { graphContext } from './service.js';
import { resolveProjectRevision } from '../source/git.js';
import { buildSemanticPromotionGate } from './semanticPromotion.js';

export type SemanticReviewCommand =
  | {
      kind: 'amend';
      proposal: Partial<SemanticCandidate['proposal']>;
      rationale?: string | null;
    }
  | {
      kind: 'accept' | 'reject';
      rationale?: string | null;
    }
  | {
      kind: 'verify';
      evidenceIds: string[];
      rationale?: string | null;
    };

export interface SemanticAiProposalDraft {
  model: {
    id: string;
    provider?: string;
  };
  proposal: SemanticCandidate['proposal'];
  rationale: string;
}

export interface ReviewSemanticAiProposalInput extends SemanticReviewSurfaceInput {
  candidateId: string;
  draft: SemanticAiProposalDraft;
  expectedEtag?: string | null;
}

export type SemanticLineageCommand =
  | {
      kind: 'replace';
      sourceMeaningId: string;
      successorCandidateId: string;
      rationale?: string | null;
    }
  | {
      kind: 'split';
      sourceMeaningId: string;
      successorCandidateIds: string[];
      rationale?: string | null;
    }
  | {
      kind: 'merge';
      sourceMeaningIds: string[];
      successorCandidateId: string;
      rationale?: string | null;
    };

export interface SemanticReviewSurfaceInput {
  project: string;
  ref?: string;
  graphId?: string;
  limit?: number;
}

export interface ReviewSemanticMeaningInput extends SemanticReviewSurfaceInput {
  candidateId: string;
  command: SemanticReviewCommand;
  actor: SemanticReviewActor;
  at: string;
  expectedEtag?: string | null;
}

export interface ReviewSemanticLineageInput extends SemanticReviewSurfaceInput {
  command: SemanticLineageCommand;
  actor: SemanticReviewActor;
  at: string;
  expectedEtag?: string | null;
}

const CANDIDATE_KINDS = new Set<SemanticCandidateKind>(['feature', 'capability', 'surface', 'domain']);


export type SemanticReviewContinuity =
  | {
      state: 'new';
      meaningId: null;
      sourceRevision: null;
      sourceMeaningIds: [];
      reason: string;
    }
  | {
      state: 'inherited';
      meaningId: string;
      sourceRevision: string | null;
      sourceMeaningIds: [string];
      reason: string;
    }
  | {
      state: 'ambiguous';
      meaningId: null;
      sourceRevision: null;
      sourceMeaningIds: string[];
      reason: string;
    };

export function acceptedMeaningsForContinuity(
  ledger: SemanticAuthorityLedger | null,
  targetRevision: string | null,
): SemanticMeaningReview[] {
  const latest = new Map<string, { storedAt: string; review: SemanticMeaningReview }>();
  for (const record of ledger?.records ?? []) {
    if (record.revision === targetRevision) continue;
    const current = latest.get(record.meaningId);
    if (!current || current.storedAt.localeCompare(record.storedAt) < 0) {
      latest.set(record.meaningId, { storedAt: record.storedAt, review: record.review });
    }
  }
  return [...latest.values()]
    .map(item => item.review)
    .filter(review => review.accepted && !['superseded', 'split', 'merged'].includes(review.state))
    .sort((a, b) => a.meaningId.localeCompare(b.meaningId));
}

export function semanticReviewContinuity(
  candidate: SemanticCandidate,
  candidates: SemanticCandidate[],
  acceptedMeanings: SemanticMeaningReview[],
): SemanticReviewContinuity {
  const targetRevision = candidate.provenance.revision;
  const assessments = acceptedMeanings.map(review => ({
    review,
    evolution: evaluateSemanticEvolution(review, candidates, targetRevision),
  }));
  const ambiguous = assessments.filter(item =>
    item.evolution.status === 'ambiguous'
    && item.evolution.alternatives.some(alternative => alternative.id === candidate.id)
  );
  const direct = assessments.filter(item => item.evolution.matchedCandidate?.id === candidate.id);
  const sourceMeaningIds = [...new Set([...ambiguous, ...direct].map(item => item.review.meaningId))].sort();

  if (ambiguous.length > 0 || sourceMeaningIds.length > 1) {
    return {
      state: 'ambiguous',
      meaningId: null,
      sourceRevision: null,
      sourceMeaningIds,
      reason: ambiguous.length > 0
        ? 'The candidate participates in an ambiguous accepted-meaning evolution; explicit split/merge/replacement lineage is required.'
        : 'Multiple accepted meanings map to this candidate; explicit merge/replacement lineage is required.',
    };
  }

  if (direct.length === 1) {
    const source = direct[0]!.review;
    return {
      state: 'inherited',
      meaningId: source.meaningId,
      sourceRevision: source.proposalRevision,
      sourceMeaningIds: [source.meaningId],
      reason: 'Exactly one accepted meaning from another revision maps unambiguously to this candidate, so its stable semantic identity is preserved.',
    };
  }

  return {
    state: 'new',
    meaningId: null,
    sourceRevision: null,
    sourceMeaningIds: [],
    reason: 'No accepted meaning from another revision maps to this candidate; a new semantic identity will be proposed.',
  };
}

export function initialSemanticReview(
  candidate: SemanticCandidate,
  candidates: SemanticCandidate[],
  acceptedMeanings: SemanticMeaningReview[],
): SemanticMeaningReview {
  const continuity = semanticReviewContinuity(candidate, candidates, acceptedMeanings);
  if (continuity.state === 'ambiguous') {
    throw new Error(`Semantic candidate ${candidate.id} has ambiguous accepted-meaning continuity; explicit lineage review is required before semantic authority can change`);
  }
  return semanticMeaningReview(candidate, continuity.state === 'inherited' ? { meaningId: continuity.meaningId } : {});
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function optionalRationale(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('semantic review rationale must be a string or null');
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function parseSemanticReviewCommand(value: unknown): SemanticReviewCommand {
  const input = record(value, 'semantic review command');
  const kind = input.kind;
  const rationale = optionalRationale(input.rationale);

  if (kind === 'accept' || kind === 'reject') {
    return { kind, ...(rationale === undefined ? {} : { rationale }) };
  }

  if (kind === 'verify') {
    if (!Array.isArray(input.evidenceIds)) throw new Error('semantic verification requires evidenceIds');
    const evidenceIds = [...new Set(input.evidenceIds.map((item, index) => nonEmptyString(item, `evidenceIds[${index}]`)))].sort();
    if (!evidenceIds.length) throw new Error('semantic verification requires at least one evidence id');
    return { kind, evidenceIds, ...(rationale === undefined ? {} : { rationale }) };
  }

  if (kind === 'amend') {
    const proposalInput = record(input.proposal, 'semantic amendment proposal');
    const proposal: Partial<SemanticCandidate['proposal']> = {};
    if ('name' in proposalInput) proposal.name = nonEmptyString(proposalInput.name, 'proposal.name');
    if ('description' in proposalInput) proposal.description = nonEmptyString(proposalInput.description, 'proposal.description');
    if ('kind' in proposalInput) {
      if (typeof proposalInput.kind !== 'string' || !CANDIDATE_KINDS.has(proposalInput.kind as SemanticCandidateKind)) {
        throw new Error('proposal.kind must be one of feature, capability, surface, domain');
      }
      proposal.kind = proposalInput.kind as SemanticCandidateKind;
    }
    if ('alternatives' in proposalInput) {
      if (!Array.isArray(proposalInput.alternatives)) throw new Error('proposal.alternatives must be an array');
      proposal.alternatives = [...new Set(proposalInput.alternatives.map((item, index) => nonEmptyString(item, `proposal.alternatives[${index}]`)))];
    }
    if ('grouping' in proposalInput) {
      if (!Array.isArray(proposalInput.grouping)) throw new Error('proposal.grouping must be an array');
      proposal.grouping = [...new Set(proposalInput.grouping.map((item, index) => nonEmptyString(item, `proposal.grouping[${index}]`)))];
    }
    if (!Object.keys(proposal).length) throw new Error('semantic amendment must change at least one proposal field');
    return { kind, proposal, ...(rationale === undefined ? {} : { rationale }) };
  }

  throw new Error('semantic review command kind must be amend, accept, reject, or verify');
}

function boundedUniqueStrings(value: unknown, label: string, minimum: number, maximum = 32): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const items = [...new Set(value.map((item, index) => nonEmptyString(item, `${label}[${index}]`)))].sort();
  if (items.length < minimum) throw new Error(`${label} requires at least ${minimum} unique value${minimum === 1 ? '' : 's'}`);
  if (items.length > maximum) throw new Error(`${label} exceeds the bounded limit of ${maximum}`);
  return items;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const text = nonEmptyString(value, label);
  if (text.length > maximum) throw new Error(`${label} exceeds the bounded limit of ${maximum} characters`);
  return text;
}

function boundedProposalList(value: unknown, label: string, maximumItems = 20): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const items = [...new Set(value.map((item, index) => boundedText(item, `${label}[${index}]`, 240)))];
  if (items.length > maximumItems) throw new Error(`${label} exceeds the bounded limit of ${maximumItems} items`);
  return items;
}

export function parseSemanticAiProposal(value: unknown): SemanticAiProposalDraft {
  const input = record(value, 'semantic AI proposal');
  const modelInput = record(input.model, 'semantic AI proposal model');
  const proposalInput = record(input.proposal, 'semantic AI proposal content');
  const kind = proposalInput.kind;
  if (typeof kind !== 'string' || !CANDIDATE_KINDS.has(kind as SemanticCandidateKind)) {
    throw new Error('proposal.kind must be one of feature, capability, surface, domain');
  }
  const provider = modelInput.provider === undefined ? undefined : boundedText(modelInput.provider, 'model.provider', 100);
  const grouping = boundedProposalList(proposalInput.grouping, 'proposal.grouping');
  return {
    model: {
      id: boundedText(modelInput.id, 'model.id', 200),
      ...(provider ? { provider } : {}),
    },
    proposal: {
      name: boundedText(proposalInput.name, 'proposal.name', 200),
      description: boundedText(proposalInput.description, 'proposal.description', 4000),
      kind: kind as SemanticCandidateKind,
      alternatives: boundedProposalList(proposalInput.alternatives, 'proposal.alternatives'),
      ...(grouping.length ? { grouping } : {}),
    },
    rationale: boundedText(input.rationale, 'rationale', 4000),
  };
}

export function semanticAiProposalPacket(candidate: SemanticCandidate) {
  return {
    version: 1 as const,
    candidateId: candidate.id,
    revision: candidate.provenance.revision,
    scope: candidate.scope,
    intrinsicProposal: {
      ...candidate.proposal,
      alternatives: [...candidate.proposal.alternatives],
      ...(candidate.proposal.grouping ? { grouping: [...candidate.proposal.grouping] } : {}),
    },
    support: {
      ...candidate.support,
      motifKinds: [...candidate.support.motifKinds],
    },
    evidence: {
      representativeNodes: candidate.evidencePacket.representativeNodes.map(item => ({ ...item })),
      representativeEdges: candidate.evidencePacket.representativeEdges.map(item => ({ ...item })),
      evidenceFamilies: [...candidate.provenance.evidenceFamilies],
      evidenceIds: candidate.provenance.evidenceIds.slice(0, 32),
    },
    outputContract: {
      fields: ['name', 'description', 'kind', 'alternatives', 'grouping', 'rationale'],
      allowedKinds: [...CANDIDATE_KINDS].sort(),
      alternativesMaximum: 20,
      groupingMaximum: 20,
    },
    policy: {
      boundedEvidencePacket: true,
      productIntentMustNotBeInvented: true,
      modelOutputAcceptedAutomatically: false,
      importedProposalRemainsEditable: true,
      explicitHumanReviewRequiredForAcceptance: true,
      persistedAsAcceptedAuthority: false,
    },
  };
}

export function semanticAiProposalReview(
  candidate: SemanticCandidate,
  candidates: SemanticCandidate[],
  acceptedMeanings: SemanticMeaningReview[],
  draft: SemanticAiProposalDraft,
): { continuity: SemanticReviewContinuity; review: SemanticMeaningReview } {
  const continuity = semanticReviewContinuity(candidate, candidates, acceptedMeanings);
  if (continuity.state === 'ambiguous') {
    throw new Error(`Semantic candidate ${candidate.id} has ambiguous accepted-meaning continuity; explicit lineage review is required before importing an AI proposal`);
  }
  const producer = draft.model.provider ? `${draft.model.provider}/${draft.model.id}` : draft.model.id;
  const proposedCandidate: SemanticCandidate = {
    ...candidate,
    proposal: {
      ...draft.proposal,
      alternatives: [...draft.proposal.alternatives],
      ...(draft.proposal.grouping ? { grouping: [...draft.proposal.grouping] } : {}),
    },
    provenance: {
      ...candidate.provenance,
      origin: 'ai-model',
      producer,
      rationale: draft.rationale,
      sourceCandidateId: candidate.id,
      evidenceFamilies: [...candidate.provenance.evidenceFamilies],
      nodeIds: [...candidate.provenance.nodeIds],
      edgeIds: [...candidate.provenance.edgeIds],
      evidenceIds: [...candidate.provenance.evidenceIds],
    },
  };
  const review = semanticMeaningReview(
    proposedCandidate,
    continuity.state === 'inherited' ? { meaningId: continuity.meaningId } : {},
  );
  return { continuity, review };
}

export function parseSemanticLineageCommand(value: unknown): SemanticLineageCommand {
  const input = record(value, 'semantic lineage command');
  const rationale = optionalRationale(input.rationale);
  if (input.kind === 'replace') {
    return {
      kind: 'replace',
      sourceMeaningId: nonEmptyString(input.sourceMeaningId, 'sourceMeaningId'),
      successorCandidateId: nonEmptyString(input.successorCandidateId, 'successorCandidateId'),
      ...(rationale === undefined ? {} : { rationale }),
    };
  }
  if (input.kind === 'split') {
    return {
      kind: 'split',
      sourceMeaningId: nonEmptyString(input.sourceMeaningId, 'sourceMeaningId'),
      successorCandidateIds: boundedUniqueStrings(input.successorCandidateIds, 'successorCandidateIds', 2),
      ...(rationale === undefined ? {} : { rationale }),
    };
  }
  if (input.kind === 'merge') {
    return {
      kind: 'merge',
      sourceMeaningIds: boundedUniqueStrings(input.sourceMeaningIds, 'sourceMeaningIds', 2),
      successorCandidateId: nonEmptyString(input.successorCandidateId, 'successorCandidateId'),
      ...(rationale === undefined ? {} : { rationale }),
    };
  }
  throw new Error('semantic lineage command kind must be replace, split, or merge');
}

export function semanticReviewAction(
  command: SemanticReviewCommand,
  actor: SemanticReviewActor,
  at: string,
): SemanticReviewAction {
  if (command.kind === 'amend') return { kind: 'amend', actor, at, proposal: command.proposal, ...(command.rationale === undefined ? {} : { rationale: command.rationale }) };
  if (command.kind === 'verify') return { kind: 'verify', actor, at, evidenceIds: command.evidenceIds, ...(command.rationale === undefined ? {} : { rationale: command.rationale }) };
  return { kind: command.kind, actor, at, ...(command.rationale === undefined ? {} : { rationale: command.rationale }) };
}

export function semanticLineageTransaction(
  command: SemanticLineageCommand,
  candidates: SemanticCandidate[],
  acceptedMeanings: SemanticMeaningReview[],
  actor: SemanticReviewActor,
  at: string,
): {
  kind: SemanticLineageCommand['kind'];
  sourceMeaningIds: string[];
  successorMeaningIds: string[];
  reviews: SemanticMeaningReview[];
} {
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const acceptedByMeaning = new Map(acceptedMeanings.map(review => [review.meaningId, review]));
  const candidate = (candidateId: string): SemanticCandidate => {
    const found = candidateById.get(candidateId);
    if (!found) throw new Error(`Semantic lineage successor candidate ${candidateId} is not present in the selected revision`);
    return found;
  };
  const source = (meaningId: string): SemanticMeaningReview => {
    const found = acceptedByMeaning.get(meaningId);
    if (!found) throw new Error(`Semantic lineage source meaning ${meaningId} is not an active accepted meaning from an earlier revision`);
    return found;
  };

  if (command.kind === 'replace') {
    const result = replaceSemanticMeaning(source(command.sourceMeaningId), candidate(command.successorCandidateId), actor, at, command.rationale);
    return {
      kind: command.kind,
      sourceMeaningIds: [result.source.meaningId],
      successorMeaningIds: result.successors.map(item => item.meaningId),
      reviews: [result.source, ...result.successors],
    };
  }
  if (command.kind === 'split') {
    const result = splitSemanticMeaning(
      source(command.sourceMeaningId),
      command.successorCandidateIds.map(candidate),
      actor,
      at,
      command.rationale,
    );
    return {
      kind: command.kind,
      sourceMeaningIds: [result.source.meaningId],
      successorMeaningIds: result.successors.map(item => item.meaningId).sort(),
      reviews: [result.source, ...result.successors],
    };
  }
  const result = mergeSemanticMeanings(
    command.sourceMeaningIds.map(source),
    candidate(command.successorCandidateId),
    actor,
    at,
    command.rationale,
  );
  return {
    kind: command.kind,
    sourceMeaningIds: result.sources.map(item => item.meaningId).sort(),
    successorMeaningIds: [result.successor.meaningId],
    reviews: [...result.sources, result.successor],
  };
}

function authoritySummary(authority: SemanticAuthorityLoad) {
  return {
    state: authority.state,
    durable: authority.durable,
    etag: authority.etag,
    generation: authority.ledger?.generation ?? 0,
    updatedAt: authority.ledger?.updatedAt ?? null,
    recordCount: authority.ledger?.records.length ?? 0,
    ...(authority.error ? { error: authority.error } : {}),
  };
}

export async function semanticReviewSurface(input: SemanticReviewSurfaceInput) {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 25), 1000));
  const { graph } = await graphContext(input.project, {
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.graphId ? { graphId: input.graphId } : {}),
  });
  const bootstrap = bootstrapSemanticCandidates(graph, { limit });
  const fullBootstrap = limit === 1000 ? bootstrap : bootstrapSemanticCandidates(graph, { limit: 1000 });
  const authority = await loadSemanticAuthority(input.project);
  const reviews = semanticReviewsAtRevision(authority.ledger, graph.repositoryRevision);
  const reviewsByCandidate = new Map(reviews.map(review => [review.candidateId, review]));
  const acceptedMeanings = acceptedMeaningsForContinuity(authority.ledger, graph.repositoryRevision);
  const defaultRevision = await resolveProjectRevision(input.project);
  const targetIsCurrentAcceptedAuthority = defaultRevision.sha === graph.repositoryRevision
    && reviews.some(review => review.accepted)
    && acceptedMeanings.length === 0;
  const promotionAudit = targetIsCurrentAcceptedAuthority
    ? null
    : buildSemanticPromotionGate({
        baseMeanings: acceptedMeanings,
        previewCandidates: fullBootstrap.candidates,
        previewReviews: reviews,
        changeVerifications: semanticChangeVerificationsAtRevision(authority.ledger, graph.repositoryRevision),
        baseRevision: defaultRevision.sha === graph.repositoryRevision ? null : defaultRevision.sha,
        previewRevision: graph.repositoryRevision,
      });

  return {
    version: 1,
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    zeroMetadata: bootstrap.zeroMetadata,
    observedSemanticCount: bootstrap.observedSemanticCount,
    declaredSemanticCount: bootstrap.declaredSemanticCount,
    candidates: bootstrap.candidates.map(candidate => ({
      ...candidate,
      review: reviewsByCandidate.get(candidate.id) ?? null,
      continuity: semanticReviewContinuity(candidate, fullBootstrap.candidates, acceptedMeanings),
      aiProposalPacket: semanticAiProposalPacket(candidate),
    })),
    capacity: bootstrap.capacity,
    promotionAudit,
    promotionAuditBasis: {
      currentDefaultRevision: defaultRevision.sha,
      targetRevision: graph.repositoryRevision,
      targetIsCurrentAcceptedAuthority,
      candidateUniverseEligible: fullBootstrap.capacity.eligibleCandidateCount,
      candidateUniverseExhausted: fullBootstrap.capacity.exhausted,
    },
    authority: authoritySummary(authority),
    policy: {
      stage: 'T2-review-surface',
      candidatesRemainNonAuthoritativeUntilReviewed: true,
      acceptanceImpliesVerification: false,
      writesRequireExplicitActorAndReviewAction: true,
      mcpSurfaceReadOnly: true,
      ownerWriteSurfaceSeparate: true,
      persistedAuthorityOwnedByDI: true,
      stableMeaningIdentityInheritedAcrossRevisions: true,
      ambiguousContinuityRequiresExplicitLineage: true,
      aiProposalProviderNeutral: true,
      aiProposalRequiresOwnerImport: true,
      modelOutputAcceptedAutomatically: false,
      promotionAuditItemized: true,
      promotionAuditDesiredOutcomeInferred: false,
      promotionGateVerificationCanBeDelegated: true,
      acceptedGraphAffected: false,
    },
  };
}

export async function verifySemanticPromotionChange(input: SemanticReviewSurfaceInput & {
  auditRef: string;
  evidenceIds: string[];
  actor: SemanticReviewActor;
  at: string;
  rationale?: string | null;
  expectedEtag?: string | null;
}): Promise<{
  state: 'stored' | 'conflict' | 'not-configured';
  project: string;
  graphId: string;
  revision: string | null;
  auditRef: string;
  changeId: string;
  generation: number;
  etag: string | null;
  verification: SemanticChangeVerificationRecord;
  item: Record<string, unknown> | null;
}> {
  const surface = await semanticReviewSurface(input) as any;
  const item = surface.promotionAudit?.items?.find((candidate: any) => candidate.auditRef === input.auditRef);
  if (!item) throw new Error(`Semantic promotion audit item ${input.auditRef} is not present for the selected revision`);
  const evidenceIds = [...new Set(input.evidenceIds.map(value => value.trim()).filter(Boolean))].sort();
  if (!evidenceIds.length) throw new Error('Semantic change verification requires at least one explicit evidence id');
  const actor = normalizeSemanticReviewActor(input.actor);
  if (!['human', 'ai-model'].includes(actor.kind)) throw new Error('Semantic change verification actor must be human or ai-model');
  const verification: SemanticChangeVerificationRecord = {
    version: 1,
    changeId: item.changeId,
    auditRef: item.auditRef,
    targetRevision: surface.revision,
    actor,
    at: normalizeSemanticReviewTimestamp(input.at),
    evidenceIds,
    rationale: normalizeSemanticReviewRationale(input.rationale),
  };
  const authority = await loadSemanticAuthority(input.project);
  if (authority.state === 'invalid') throw new Error(authority.error ?? 'Semantic authority ledger is invalid');
  const expectedEtag = input.expectedEtag === undefined ? authority.etag : input.expectedEtag;
  const written = await persistSemanticChangeVerification(input.project, verification, expectedEtag);
  let updatedItem: Record<string, unknown> | null = null;
  if (written.state === 'stored') {
    const refreshed = await semanticReviewSurface(input) as any;
    updatedItem = refreshed.promotionAudit?.items?.find((candidate: any) => candidate.auditRef === input.auditRef) ?? null;
  }
  return {
    state: written.state,
    project: input.project,
    graphId: surface.graphId,
    revision: surface.revision,
    auditRef: item.auditRef,
    changeId: item.changeId,
    generation: written.ledger?.generation ?? authority.ledger?.generation ?? 0,
    etag: written.etag,
    verification,
    item: updatedItem,
  };
}

export async function reviewSemanticAiProposal(input: ReviewSemanticAiProposalInput): Promise<{
  state: 'stored' | 'conflict' | 'not-configured';
  project: string;
  graphId: string;
  revision: string | null;
  candidateId: string;
  meaningId: string;
  etag: string | null;
  generation: number;
  continuity: SemanticReviewContinuity;
  review: SemanticMeaningReview;
  packet: ReturnType<typeof semanticAiProposalPacket>;
}> {
  const { graph } = await graphContext(input.project, {
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.graphId ? { graphId: input.graphId } : {}),
  });
  const authority = await loadSemanticAuthority(input.project);
  if (authority.state === 'invalid') throw new Error(authority.error ?? 'Semantic authority ledger is invalid');
  const bootstrap = bootstrapSemanticCandidates(graph, { limit: 1000 });
  const candidate = bootstrap.candidates.find(item => item.id === input.candidateId);
  if (!candidate) throw new Error(`Semantic candidate ${input.candidateId} is not present in the selected revision`);
  const existing = semanticReviewsAtRevision(authority.ledger, graph.repositoryRevision)
    .find(review => review.candidateId === candidate.id);
  if (existing) throw new Error(`Semantic candidate ${candidate.id} already has a review at the selected revision; amend or review that authority record instead of overwriting it with an AI proposal`);
  const acceptedMeanings = acceptedMeaningsForContinuity(authority.ledger, graph.repositoryRevision);
  const proposed = semanticAiProposalReview(candidate, bootstrap.candidates, acceptedMeanings, input.draft);
  const expectedEtag = input.expectedEtag === undefined ? authority.etag : input.expectedEtag;
  const written = await persistSemanticReview(input.project, proposed.review, expectedEtag);
  const persisted = semanticReviewsAtRevision(written.ledger, graph.repositoryRevision)
    .find(review => review.candidateId === candidate.id) ?? proposed.review;
  return {
    state: written.state,
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    candidateId: candidate.id,
    meaningId: persisted.meaningId,
    etag: written.etag,
    generation: written.ledger?.generation ?? authority.ledger?.generation ?? 0,
    continuity: proposed.continuity,
    review: persisted,
    packet: semanticAiProposalPacket(candidate),
  };
}

export async function reviewSemanticMeaning(input: ReviewSemanticMeaningInput): Promise<{
  state: 'stored' | 'conflict' | 'not-configured';
  project: string;
  graphId: string;
  revision: string | null;
  candidateId: string;
  meaningId: string;
  etag: string | null;
  generation: number;
  continuity: SemanticReviewContinuity;
  review: SemanticMeaningReview;
}> {
  const { graph } = await graphContext(input.project, {
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.graphId ? { graphId: input.graphId } : {}),
  });
  const authority = await loadSemanticAuthority(input.project);
  if (authority.state === 'invalid') throw new Error(authority.error ?? 'Semantic authority ledger is invalid');

  const bootstrap = bootstrapSemanticCandidates(graph, { limit: 1000 });
  const candidate = bootstrap.candidates.find(item => item.id === input.candidateId);
  if (!candidate) throw new Error(`Semantic candidate ${input.candidateId} is not present in the selected revision`);

  const existing = semanticReviewsAtRevision(authority.ledger, graph.repositoryRevision)
    .find(review => review.candidateId === candidate.id);
  const acceptedMeanings = acceptedMeaningsForContinuity(authority.ledger, graph.repositoryRevision);
  const continuity = semanticReviewContinuity(candidate, bootstrap.candidates, acceptedMeanings);
  if (continuity.state === 'ambiguous') {
    throw new Error(`Semantic candidate ${candidate.id} has ambiguous accepted-meaning continuity; explicit lineage review is required before semantic authority can change`);
  }
  if (existing && continuity.state === 'inherited' && existing.meaningId !== continuity.meaningId) {
    throw new Error(`Existing semantic review for ${candidate.id} does not preserve accepted meaning identity ${continuity.meaningId}; explicit semantic authority migration is required`);
  }
  const current = existing ?? initialSemanticReview(candidate, bootstrap.candidates, acceptedMeanings);
  const next = applySemanticReviewAction(current, semanticReviewAction(input.command, input.actor, input.at));
  const expectedEtag = input.expectedEtag === undefined ? authority.etag : input.expectedEtag;
  const written = await persistSemanticReview(input.project, next, expectedEtag);
  const persisted = semanticReviewsAtRevision(written.ledger, graph.repositoryRevision)
    .find(review => review.candidateId === candidate.id) ?? next;

  return {
    state: written.state,
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    candidateId: candidate.id,
    meaningId: persisted.meaningId,
    etag: written.etag,
    generation: written.ledger?.generation ?? authority.ledger?.generation ?? 0,
    continuity,
    review: persisted,
  };
}

export async function reviewSemanticLineage(input: ReviewSemanticLineageInput): Promise<{
  state: 'stored' | 'conflict' | 'not-configured';
  project: string;
  graphId: string;
  revision: string | null;
  operation: SemanticLineageCommand['kind'];
  sourceMeaningIds: string[];
  successorMeaningIds: string[];
  etag: string | null;
  generation: number;
  reviews: SemanticMeaningReview[];
}> {
  const { graph } = await graphContext(input.project, {
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.graphId ? { graphId: input.graphId } : {}),
  });
  const authority = await loadSemanticAuthority(input.project);
  if (authority.state === 'invalid') throw new Error(authority.error ?? 'Semantic authority ledger is invalid');

  const bootstrap = bootstrapSemanticCandidates(graph, { limit: 1000 });
  const acceptedMeanings = acceptedMeaningsForContinuity(authority.ledger, graph.repositoryRevision);
  const transaction = semanticLineageTransaction(input.command, bootstrap.candidates, acceptedMeanings, input.actor, input.at);
  const currentReviews = semanticReviewsAtRevision(authority.ledger, graph.repositoryRevision);
  const currentCandidateIds = new Set(currentReviews.map(review => review.candidateId));
  for (const review of transaction.reviews) {
    if (review.proposalRevision === graph.repositoryRevision && currentCandidateIds.has(review.candidateId)) {
      throw new Error(`Semantic lineage successor candidate ${review.candidateId} already has a review at the selected revision`);
    }
  }

  const expectedEtag = input.expectedEtag === undefined ? authority.etag : input.expectedEtag;
  const written = await persistSemanticReviews(input.project, transaction.reviews, expectedEtag);
  const persistedReviews = written.state === 'stored'
    ? transaction.reviews.map(review =>
        written.ledger?.records.find(record =>
          record.meaningId === review.meaningId
          && record.candidateId === review.candidateId
          && record.revision === review.proposalRevision
        )?.review ?? review
      )
    : transaction.reviews;

  return {
    state: written.state,
    project: input.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    operation: transaction.kind,
    sourceMeaningIds: transaction.sourceMeaningIds,
    successorMeaningIds: transaction.successorMeaningIds,
    etag: written.etag,
    generation: written.ledger?.generation ?? authority.ledger?.generation ?? 0,
    reviews: persistedReviews,
  };
}

