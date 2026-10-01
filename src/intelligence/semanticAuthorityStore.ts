import { stableHash } from '../util/hash.js';
import {
  canonicalDerivedStorageInfo,
  readCanonicalDerivedObjectVersioned,
  writeCanonicalDerivedObjectConditional,
} from './canonicalStore.js';
import { workingToAcceptedGraph } from './checkpoint.js';
import { loadCanonicalGraph, makeCanonicalGraphRecord, saveCanonicalGraph } from './canonicalStore.js';
import type { SemanticChangeVerificationRecord, SemanticMeaningReview, SemanticReviewActor } from './semanticReview.js';
import type { SemanticPromotionEnrollmentState, SemanticPromotionGate } from './semanticPromotion.js';

const AUTHORITY_PATH = 'semantic/authority-v1.json';
const MAX_AUTHORITY_BYTES = 16 * 1024 * 1024;
const MAX_AUTHORITY_RECORDS = 10_000;

export interface SemanticPromotionEnrollmentRecord {
  version: 1;
  state: SemanticPromotionEnrollmentState;
  baselineRevision: string | null;
  enrolledAt: string;
  updatedAt: string;
  actor: SemanticReviewActor;
  rationale: string | null;
}

export interface StoredSemanticAuthorityRecord {
  recordId: string;
  meaningId: string;
  revision: string | null;
  candidateId: string;
  storedAt: string;
  review: SemanticMeaningReview;
}

export interface SemanticAuthorityLedger {
  formatVersion: 1;
  project: string;
  generation: number;
  updatedAt: string;
  records: StoredSemanticAuthorityRecord[];
  changeVerifications?: SemanticChangeVerificationRecord[];
  enrollment?: SemanticPromotionEnrollmentRecord;
}

export interface SemanticAuthorityLoad {
  state: 'hit' | 'miss' | 'not-configured' | 'invalid';
  durable: boolean;
  etag: string | null;
  ledger: SemanticAuthorityLedger | null;
  error?: string;
}

export interface SemanticAuthorityWrite {
  state: 'stored' | 'conflict' | 'not-configured';
  etag: string | null;
  ledger: SemanticAuthorityLedger | null;
}

function exactRevision(value: string | null): boolean {
  return value === null || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
}

function recordId(review: SemanticMeaningReview): string {
  return `semantic-review:${stableHash([
    review.meaningId,
    review.proposalRevision ?? 'unknown-revision',
    review.candidateId,
  ])}`;
}

function persistedReview(review: SemanticMeaningReview): SemanticMeaningReview {
  return {
    ...review,
    proposal: {
      ...review.proposal,
      alternatives: [...review.proposal.alternatives],
      ...(review.proposal.grouping ? { grouping: [...review.proposal.grouping] } : {}),
    },
    proposalProvenance: {
      ...review.proposalProvenance,
      evidenceFamilies: [...review.proposalProvenance.evidenceFamilies],
      nodeIds: [...review.proposalProvenance.nodeIds],
      edgeIds: [...review.proposalProvenance.edgeIds],
      evidenceIds: [...review.proposalProvenance.evidenceIds],
    },
    proposalSupport: { ...review.proposalSupport, motifKinds: [...review.proposalSupport.motifKinds] },
    lineage: {
      predecessorMeaningIds: [...review.lineage.predecessorMeaningIds],
      successorMeaningIds: [...review.lineage.successorMeaningIds],
    },
    history: review.history.map(event => ({ ...event } as typeof event)),
    acceptance: review.acceptance ? { ...review.acceptance, actor: { ...review.acceptance.actor } } : null,
    verification: review.verification
      ? { ...review.verification, actor: { ...review.verification.actor }, evidenceIds: [...review.verification.evidenceIds] }
      : null,
    policy: { ...review.policy, persisted: true },
  };
}

function validateReview(review: SemanticMeaningReview): void {
  if (review.version !== 1 || !review.meaningId || !review.candidateId || !review.scope) throw new Error('Semantic authority review identity is malformed');
  if (!exactRevision(review.proposalRevision)) throw new Error('Semantic authority review revision must be an exact Git object id or null');
  if (!review.policy?.stableMeaningIdentityDistinctFromCandidateIdentity) throw new Error('Semantic authority review is missing stable identity policy');
  if (review.accepted && !review.acceptance) throw new Error('Accepted semantic review is missing its acceptance record');
  if (review.verification && review.verification.evidenceIds.length < 1) throw new Error('Semantic verification must retain explicit evidence ids');
}

function validateChangeVerification(value: SemanticChangeVerificationRecord): void {
  if (value.version !== 1 || !value.changeId || !/^SEM-[0-9A-F]{8}$/u.test(value.auditRef)) {
    throw new Error('Semantic change verification identity is malformed');
  }
  if (!exactRevision(value.targetRevision) || value.targetRevision === null) {
    throw new Error('Semantic change verification target revision must be an exact Git object id');
  }
  if (!value.actor?.id?.trim() || !['human', 'ai-model'].includes(value.actor.kind)) {
    throw new Error('Semantic change verification actor must be human or ai-model');
  }
  if (!value.at || Number.isNaN(Date.parse(value.at))) throw new Error('Semantic change verification timestamp is invalid');
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length < 1 || value.evidenceIds.some(id => !id.trim())) {
    throw new Error('Semantic change verification requires explicit evidence ids');
  }
}

function copyEnrollment(value: SemanticPromotionEnrollmentRecord): SemanticPromotionEnrollmentRecord {
  return { ...value, actor: { ...value.actor } };
}

function validateEnrollment(value: SemanticPromotionEnrollmentRecord): void {
  if (value.version !== 1 || !['not-enrolled', 'advisory', 'enforced'].includes(value.state)) {
    throw new Error('Semantic promotion enrollment state is invalid');
  }
  if (!exactRevision(value.baselineRevision)) throw new Error('Semantic promotion enrollment baseline revision is invalid');
  if (value.state === 'enforced' && value.baselineRevision === null) {
    throw new Error('Enforced semantic promotion requires an exact baseline revision');
  }
  if (!value.actor?.id?.trim() || value.actor.kind !== 'human') {
    throw new Error('Semantic promotion enrollment requires an explicit human actor');
  }
  if (!value.enrolledAt || Number.isNaN(Date.parse(value.enrolledAt)) || !value.updatedAt || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error('Semantic promotion enrollment timestamp is invalid');
  }
}

function validateLedger(value: unknown, expectedProject: string): SemanticAuthorityLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Semantic authority ledger must be an object');
  const ledger = value as SemanticAuthorityLedger;
  if (ledger.formatVersion !== 1 || ledger.project !== expectedProject) throw new Error('Semantic authority ledger identity is invalid');
  if (!Number.isInteger(ledger.generation) || ledger.generation < 0) throw new Error('Semantic authority ledger generation is invalid');
  if (!Array.isArray(ledger.records) || ledger.records.length > MAX_AUTHORITY_RECORDS) throw new Error('Semantic authority ledger record set is invalid');
  const ids = new Set<string>();
  for (const item of ledger.records) {
    if (!item || typeof item !== 'object' || !item.recordId || !item.meaningId || !item.candidateId) throw new Error('Semantic authority record identity is malformed');
    if (ids.has(item.recordId)) throw new Error('Semantic authority ledger contains duplicate record ids');
    ids.add(item.recordId);
    if (item.meaningId !== item.review.meaningId || item.candidateId !== item.review.candidateId || item.revision !== item.review.proposalRevision) {
      throw new Error('Semantic authority record does not match embedded review identity');
    }
    validateReview(item.review);
  }
  const changeVerifications = Array.isArray((ledger as any).changeVerifications)
    ? (ledger as any).changeVerifications as SemanticChangeVerificationRecord[]
    : [];
  if (changeVerifications.length > MAX_AUTHORITY_RECORDS) throw new Error('Semantic change verification set exceeds the bounded record limit');
  const changeIds = new Set<string>();
  for (const verification of changeVerifications) {
    validateChangeVerification(verification);
    if (changeIds.has(verification.changeId)) throw new Error('Semantic authority ledger contains duplicate semantic change verifications');
    changeIds.add(verification.changeId);
  }
  const enrollment = (ledger as any).enrollment as SemanticPromotionEnrollmentRecord | undefined;
  if (enrollment !== undefined) validateEnrollment(enrollment);
  return {
    ...ledger,
    changeVerifications,
    ...(enrollment ? { enrollment: copyEnrollment(enrollment) } : {}),
  };
}

export async function loadSemanticAuthority(project: string): Promise<SemanticAuthorityLoad> {
  const storage = canonicalDerivedStorageInfo();
  if (!storage.durable) return { state: 'not-configured', durable: false, etag: null, ledger: null };
  try {
    const stored = await readCanonicalDerivedObjectVersioned(project, AUTHORITY_PATH, MAX_AUTHORITY_BYTES);
    if (!stored) return { state: 'miss', durable: true, etag: null, ledger: null };
    const parsed = JSON.parse(new TextDecoder().decode(stored.body));
    return { state: 'hit', durable: true, etag: stored.etag, ledger: validateLedger(parsed, project) };
  } catch (error) {
    return {
      state: 'invalid',
      durable: true,
      etag: null,
      ledger: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function persistSemanticReviews(
  project: string,
  reviews: SemanticMeaningReview[],
  expectedEtag: string | null,
): Promise<SemanticAuthorityWrite> {
  if (!Array.isArray(reviews) || !reviews.length) throw new Error('Semantic authority transaction requires at least one review');
  reviews.forEach(validateReview);
  const current = await loadSemanticAuthority(project);
  if (current.state === 'not-configured') return { state: 'not-configured', etag: null, ledger: null };
  if (current.state === 'invalid') throw new Error(current.error ?? 'Semantic authority ledger is invalid');
  if (current.etag !== expectedEtag) return { state: 'conflict', etag: current.etag, ledger: current.ledger };

  const now = new Date().toISOString();
  const nextRecords = reviews.map(review => {
    const nextReview = persistedReview(review);
    return {
      recordId: recordId(nextReview),
      meaningId: nextReview.meaningId,
      revision: nextReview.proposalRevision,
      candidateId: nextReview.candidateId,
      storedAt: now,
      review: nextReview,
    } satisfies StoredSemanticAuthorityRecord;
  });
  const incomingIds = new Set<string>();
  for (const record of nextRecords) {
    if (incomingIds.has(record.recordId)) throw new Error('Semantic authority transaction contains duplicate review identities');
    incomingIds.add(record.recordId);
  }
  const records = [
    ...(current.ledger?.records ?? []).filter(item => !incomingIds.has(item.recordId)),
    ...nextRecords,
  ].sort((a, b) =>
    a.meaningId.localeCompare(b.meaningId)
    || String(a.revision).localeCompare(String(b.revision))
    || a.candidateId.localeCompare(b.candidateId)
  );
  if (records.length > MAX_AUTHORITY_RECORDS) throw new Error('Semantic authority ledger exceeds the bounded record limit');

  const ledger: SemanticAuthorityLedger = {
    formatVersion: 1,
    project,
    generation: (current.ledger?.generation ?? 0) + 1,
    updatedAt: now,
    records,
    changeVerifications: [...(current.ledger?.changeVerifications ?? [])],
    ...(current.ledger?.enrollment ? { enrollment: copyEnrollment(current.ledger.enrollment) } : {}),
  };
  const body = JSON.stringify(ledger);
  if (Buffer.byteLength(body, 'utf8') > MAX_AUTHORITY_BYTES) throw new Error('Semantic authority ledger exceeds the bounded storage size');
  const written = await writeCanonicalDerivedObjectConditional(project, AUTHORITY_PATH, body, 'application/json', expectedEtag);
  return { state: written.state, etag: written.etag, ledger: written.state === 'stored' ? ledger : current.ledger };
}

export async function persistSemanticChangeVerification(
  project: string,
  verification: SemanticChangeVerificationRecord,
  expectedEtag: string | null,
): Promise<SemanticAuthorityWrite> {
  validateChangeVerification(verification);
  const current = await loadSemanticAuthority(project);
  if (current.state === 'not-configured') return { state: 'not-configured', etag: null, ledger: null };
  if (current.state === 'invalid') throw new Error(current.error ?? 'Semantic authority ledger is invalid');
  if (current.etag !== expectedEtag) return { state: 'conflict', etag: current.etag, ledger: current.ledger };

  const now = new Date().toISOString();
  const changeVerifications = [
    ...(current.ledger?.changeVerifications ?? []).filter(item => item.changeId !== verification.changeId),
    {
      ...verification,
      actor: { ...verification.actor },
      evidenceIds: [...new Set(verification.evidenceIds)].sort(),
    },
  ].sort((a, b) => a.changeId.localeCompare(b.changeId));
  const ledger: SemanticAuthorityLedger = {
    formatVersion: 1,
    project,
    generation: (current.ledger?.generation ?? 0) + 1,
    updatedAt: now,
    records: [...(current.ledger?.records ?? [])],
    changeVerifications,
    ...(current.ledger?.enrollment ? { enrollment: copyEnrollment(current.ledger.enrollment) } : {}),
  };
  const body = JSON.stringify(ledger);
  if (Buffer.byteLength(body, 'utf8') > MAX_AUTHORITY_BYTES) throw new Error('Semantic authority ledger exceeds the bounded storage size');
  const written = await writeCanonicalDerivedObjectConditional(project, AUTHORITY_PATH, body, 'application/json', expectedEtag);
  return { state: written.state, etag: written.etag, ledger: written.state === 'stored' ? ledger : current.ledger };
}

export function semanticChangeVerificationsAtRevision(
  ledger: SemanticAuthorityLedger | null,
  revision: string | null,
): SemanticChangeVerificationRecord[] {
  return (ledger?.changeVerifications ?? [])
    .filter(item => item.targetRevision === revision)
    .map(item => ({ ...item, actor: { ...item.actor }, evidenceIds: [...item.evidenceIds] }));
}

export function semanticPromotionEnrollmentState(
  ledger: SemanticAuthorityLedger | null,
): SemanticPromotionEnrollmentState {
  return ledger?.enrollment?.state ?? 'not-enrolled';
}

export async function persistSemanticPromotionEnrollment(
  project: string,
  input: {
    state: SemanticPromotionEnrollmentState;
    baselineRevision: string | null;
    actor: SemanticReviewActor;
    at: string;
    rationale?: string | null;
  },
  expectedEtag: string | null,
): Promise<SemanticAuthorityWrite> {
  const current = await loadSemanticAuthority(project);
  if (current.state === 'not-configured') return { state: 'not-configured', etag: null, ledger: null };
  if (current.state === 'invalid') throw new Error(current.error ?? 'Semantic authority ledger is invalid');
  if (current.etag !== expectedEtag) return { state: 'conflict', etag: current.etag, ledger: current.ledger };

  const enrollment: SemanticPromotionEnrollmentRecord = {
    version: 1,
    state: input.state,
    baselineRevision: input.state === 'not-enrolled' ? null : input.baselineRevision,
    enrolledAt: current.ledger?.enrollment?.enrolledAt ?? input.at,
    updatedAt: input.at,
    actor: { ...input.actor },
    rationale: input.rationale?.trim() || null,
  };
  validateEnrollment(enrollment);

  const ledger: SemanticAuthorityLedger = {
    formatVersion: 1,
    project,
    generation: (current.ledger?.generation ?? 0) + 1,
    updatedAt: input.at,
    records: [...(current.ledger?.records ?? [])],
    changeVerifications: [...(current.ledger?.changeVerifications ?? [])],
    enrollment,
  };
  const body = JSON.stringify(ledger);
  if (Buffer.byteLength(body, 'utf8') > MAX_AUTHORITY_BYTES) throw new Error('Semantic authority ledger exceeds the bounded storage size');
  const written = await writeCanonicalDerivedObjectConditional(project, AUTHORITY_PATH, body, 'application/json', expectedEtag);
  return { state: written.state, etag: written.etag, ledger: written.state === 'stored' ? ledger : current.ledger };
}

export async function persistSemanticReview(
  project: string,
  review: SemanticMeaningReview,
  expectedEtag: string | null,
): Promise<SemanticAuthorityWrite> {
  return persistSemanticReviews(project, [review], expectedEtag);
}

export function semanticReviewsAtRevision(
  ledger: SemanticAuthorityLedger | null,
  revision: string | null,
): SemanticMeaningReview[] {
  return (ledger?.records ?? [])
    .filter(record => record.revision === revision)
    .map(record => record.review);
}

function currentAcceptedAuthorityRecords(ledger: SemanticAuthorityLedger | null): StoredSemanticAuthorityRecord[] {
  const latestAccepted = new Map<string, StoredSemanticAuthorityRecord>();
  for (const record of ledger?.records ?? []) {
    const review = record.review;
    if (!review.accepted || ['superseded', 'split', 'merged'].includes(review.state)) continue;
    const current = latestAccepted.get(record.meaningId);
    if (!current || current.storedAt.localeCompare(record.storedAt) < 0) latestAccepted.set(record.meaningId, record);
  }
  return [...latestAccepted.values()]
    .map(record => ({
      ...record,
      review: {
        ...persistedReview(record.review),
        history: [],
        lineage: { predecessorMeaningIds: [], successorMeaningIds: [] },
      },
    }))
    .sort((a, b) => a.meaningId.localeCompare(b.meaningId));
}

export async function compactSemanticAuthorityToCurrentAccepted(
  project: string,
  options: { promotedRevision?: string } = {},
): Promise<SemanticAuthorityWrite> {
  const current = await loadSemanticAuthority(project);
  if (current.state === 'not-configured') return { state: 'not-configured', etag: null, ledger: null };
  if (current.state === 'invalid') throw new Error(current.error ?? 'Semantic authority ledger is invalid');
  if (current.state === 'miss' || !current.ledger) return { state: 'stored', etag: current.etag, ledger: current.ledger };

  const records = currentAcceptedAuthorityRecords(current.ledger);
  const now = new Date().toISOString();
  const enrollment = current.ledger.enrollment
    ? {
        ...copyEnrollment(current.ledger.enrollment),
        ...(current.ledger.enrollment.state === 'enforced' && options.promotedRevision
          ? { baselineRevision: options.promotedRevision, updatedAt: now }
          : {}),
      }
    : undefined;
  const ledger: SemanticAuthorityLedger = {
    formatVersion: 1,
    project,
    generation: current.ledger.generation + 1,
    updatedAt: now,
    records,
    changeVerifications: [],
    ...(enrollment ? { enrollment } : {}),
  };
  const body = JSON.stringify(ledger);
  if (Buffer.byteLength(body, 'utf8') > MAX_AUTHORITY_BYTES) throw new Error('Semantic authority ledger exceeds the bounded storage size');
  const written = await writeCanonicalDerivedObjectConditional(project, AUTHORITY_PATH, body, 'application/json', current.etag);
  return {
    state: written.state,
    etag: written.etag,
    ledger: written.state === 'stored' ? ledger : current.ledger,
  };
}

export function latestAcceptedMeanings(ledger: SemanticAuthorityLedger | null): SemanticMeaningReview[] {
  const latest = new Map<string, StoredSemanticAuthorityRecord>();
  for (const record of ledger?.records ?? []) {
    const current = latest.get(record.meaningId);
    if (!current || current.storedAt.localeCompare(record.storedAt) < 0) latest.set(record.meaningId, record);
  }
  return [...latest.values()]
    .map(record => record.review)
    .filter(review => review.accepted && !['superseded', 'split', 'merged'].includes(review.state))
    .sort((a, b) => a.meaningId.localeCompare(b.meaningId));
}

export async function promoteCanonicalAcceptedGraph(input: {
  project: string;
  repository: string;
  revision: string;
  gate: SemanticPromotionGate;
}): Promise<{ state: 'stored' | 'not-configured' | 'error'; error?: string }> {
  if (
    input.gate.enrollmentState !== 'enforced'
    || input.gate.gateStatus !== 'ready'
    || !input.gate.readyForMainSemanticPromotion
    || input.gate.blockingPendingCount !== 0
  ) {
    throw new Error('Semantic promotion gate is not enforced and ready for Main');
  }
  if (input.gate.previewRevision !== input.revision) {
    throw new Error('Semantic promotion gate revision does not match the canonical candidate revision');
  }
  const loaded = await loadCanonicalGraph({ project: input.project, repository: input.repository, revision: input.revision });
  if (!loaded.record) {
    if (loaded.diagnostics.loadState === 'not-configured') return { state: 'not-configured' };
    return { state: 'error', error: loaded.diagnostics.error ?? 'Canonical candidate graph is unavailable for semantic acceptance' };
  }
  const accepted = workingToAcceptedGraph({ graph: loaded.record.working, repository: input.repository });
  const currentness = {
    acceptedSemanticCurrent: true,
    sourceCurrent: true,
    topologyCurrent: true,
    evidenceCurrent: true,
    analyzerCurrent: true,
    schemaSupported: true,
    integrityCurrent: true,
    checkpointError: null,
  };
  const next = makeCanonicalGraphRecord({
    project: input.project,
    repository: input.repository,
    revision: input.revision,
    working: loaded.record.working,
    accepted,
    currentness,
    queryArtifacts: loaded.record.queryArtifacts ?? null,
  });
  const saved = await saveCanonicalGraph(next);
  if (saved.saveState === 'not-configured') return { state: 'not-configured' };
  if (saved.saveState !== 'stored') return { state: 'error', ...(saved.error ? { error: saved.error } : {}) };

  // Main promotion is the retention boundary: temporary Preview review/lineage history
  // has served its purpose. Keep only the latest active accepted meaning records.
  // Exact historical understanding remains reconstructable from Git revisions.
  const compacted = await compactSemanticAuthorityToCurrentAccepted(input.project, { promotedRevision: input.revision });
  if (compacted.state === 'conflict') {
    // A concurrent review won the authority CAS after graph promotion. Do not delete
    // that newer state; the next successful promotion/maintenance pass can compact it.
    return { state: 'stored' };
  }
  return { state: 'stored' };
}
