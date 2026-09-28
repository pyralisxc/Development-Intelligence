import { bootstrapSemanticCandidates, type SemanticCandidate, type SemanticCandidateKind } from './semanticBootstrap.js';
import {
  loadSemanticAuthority,
  persistSemanticReview,
  semanticReviewsAtRevision,
  type SemanticAuthorityLoad,
} from './semanticAuthorityStore.js';
import {
  applySemanticReviewAction,
  semanticMeaningReview,
  type SemanticMeaningReview,
  type SemanticReviewAction,
  type SemanticReviewActor,
} from './semanticReview.js';
import { graphContext } from './service.js';

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

const CANDIDATE_KINDS = new Set<SemanticCandidateKind>(['feature', 'capability', 'surface', 'domain']);

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
    if (!Object.keys(proposal).length) throw new Error('semantic amendment must change at least one proposal field');
    return { kind, proposal, ...(rationale === undefined ? {} : { rationale }) };
  }

  throw new Error('semantic review command kind must be amend, accept, reject, or verify');
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
  const authority = await loadSemanticAuthority(input.project);
  const reviews = semanticReviewsAtRevision(authority.ledger, graph.repositoryRevision);
  const reviewsByCandidate = new Map(reviews.map(review => [review.candidateId, review]));

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
    })),
    capacity: bootstrap.capacity,
    authority: authoritySummary(authority),
    policy: {
      stage: 'T2-review-surface',
      candidatesRemainNonAuthoritativeUntilReviewed: true,
      acceptanceImpliesVerification: false,
      writesRequireExplicitActorAndReviewAction: true,
      mcpSurfaceReadOnly: true,
      ownerWriteSurfaceSeparate: true,
      persistedAuthorityOwnedByDI: true,
      acceptedGraphAffected: false,
    },
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
  const current = existing ?? semanticMeaningReview(candidate);
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
    review: persisted,
  };
}
