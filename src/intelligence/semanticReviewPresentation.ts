/**
 * Read-only presentation of a semantic review result. The full value is the
 * canonical existing result; this module must not mutate it, change semantic
 * identities, promotion decisions, reviews, or persistence.
 *
 * The compact view is intentionally NOT a new evidence authority or a paging
 * mechanism. Only existing exact-revision full reads can recover the entire
 * candidate population; the caller that selects one candidate owns that
 * interface separately.
 */
export type SemanticReviewPresentationDetail = 'summary' | 'full';

interface SemanticReviewPresentationInput {
  detail: SemanticReviewPresentationDetail;
}

type ObjectRecord = Record<string, any>;

function record(value: unknown): ObjectRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectRecord : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compactCandidate(candidate: ObjectRecord): ObjectRecord {
  const provenance = record(candidate.provenance);
  const autonomous = record(candidate.autonomousAssessment);
  const autonomousProvenance = record(autonomous.provenance);
  const { provenance: ignoredAutonomousProvenance, ...autonomousWithoutProvenance } = autonomous;
  const {
    provenance: ignoredProvenance,
    autonomousAssessment: ignoredAutonomous,
    aiProposalPacket: ignoredAiPacket,
    ...retained
  } = candidate;
  const nodeIds = list(provenance.nodeIds);
  const edgeIds = list(provenance.edgeIds);
  const evidenceIds = list(provenance.evidenceIds);
  return {
    ...retained,
    provenance: {
      origin: provenance.origin ?? null,
      producer: provenance.producer ?? null,
      revision: provenance.revision ?? null,
      evidenceFamilies: list(provenance.evidenceFamilies),
    },
    provenanceProjection: {
      nodeIdsTotal: nodeIds.length,
      edgeIdsTotal: edgeIds.length,
      evidenceIdsTotal: evidenceIds.length,
      nodeIdsReturned: 0,
      edgeIdsReturned: 0,
      evidenceIdsReturned: 0,
      detailsOmitted: true,
      autonomousProvenanceDuplicateOmitted: Object.keys(autonomousProvenance).length > 0,
      aiProposalPacketOmitted: Object.prototype.hasOwnProperty.call(candidate, 'aiProposalPacket'),
      note: 'These IDs are source-derived evidence links, not proof of observed execution. This summary omits the full ID lists; no candidate provenance pagination is available.',
    },
    autonomousAssessment: autonomousWithoutProvenance,
  };
}

function compactDerivedMeaning(value: ObjectRecord): ObjectRecord {
  const sourceIds = list(value.sourceIds);
  const evidenceIds = list(value.evidenceIds);
  return {
    candidateId: value.candidateId,
    meaningId: value.meaningId,
    revision: value.revision,
    disposition: value.disposition,
    evidenceProjection: {
      sourceIdsTotal: sourceIds.length,
      evidenceIdsTotal: evidenceIds.length,
      detailsOmitted: true,
    },
  };
}

/**
 * Pure display projection; full mode preserves object identity and every
 * original field. Summary mode retains candidate/revision identity, review and
 * continuity judgments, gate state, coverage and uncertainty, while omitting
 * duplicate and unbounded provenance lists. It does not imply that omitted
 * IDs can be enumerated by get_evidence without first obtaining full detail.
 */
export function projectSemanticReviewPresentation<T extends ObjectRecord>(
  surface: T,
  options: SemanticReviewPresentationInput,
): T | ObjectRecord {
  if (options.detail === 'full') return surface;
  if (options.detail !== 'summary') throw new Error('semantic review detail must be summary or full');
  const candidates = list(surface.candidates).map(item => compactCandidate(record(item)));
  const originalDerived = list(surface.derivedMeanings);
  const derivedMeanings = originalDerived.map(item => compactDerivedMeaning(record(item)));
  const capacity = record(surface.capacity);
  return {
    ...surface,
    candidates,
    derivedMeanings,
    presentation: {
      detail: 'summary',
      revision: surface.revision,
      graphId: surface.graphId,
      returnedCandidateCount: candidates.length,
      eligibleCandidateCount: capacity.eligibleCandidateCount ?? null,
      candidatePopulationTruncated: capacity.truncated ?? null,
      returnedDerivedMeaningCount: derivedMeanings.length,
      detailsOmitted: true,
      recovery: {
        tool: 'semantic_review_surface',
        detail: 'full',
        exactRevision: surface.revision,
        requestedLimit: capacity.requestedLimit ?? null,
        note: 'A full read with the same exact revision and sufficient candidate limit can recover omitted provenance. No per-candidate recovery or pagination is provided by this projection; the calling interface must supply any exact candidate selection separately.',
      },
      note: 'Review judgments remain non-authoritative unless the separately maintained authority state establishes otherwise. Counts describe source-backed candidates and returned entries, not exhaustive code understanding.',
    },
  };
}
