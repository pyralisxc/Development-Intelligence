import type { IntelligenceGraph } from '../types.js';
import { AUTONOMOUS_SEMANTIC_PROOF_RULE, assessAutonomousSemanticProof } from './semanticAutonomousAcceptance.js';
import type { SemanticCandidate } from './semanticBootstrap.js';
import type { SemanticCandidateAudit } from './semanticAudit.js';
import { evaluateSemanticEvolution, type SemanticSupportDelta } from './semanticEvolution.js';
import type { SemanticMeaningReview } from './semanticReview.js';

/** Current source realization of an accepted meaning, never a rewrite of acceptance history. */
export interface SemanticCurrentEvidence {
  version: 1;
  meaningId: string;
  candidateId: string;
  acceptedRevision: string | null;
  inspectedRevision: string | null;
  graphId: string;
  analyzerVersion: string;
  acceptedRecordRetained: true;
  origin: 'machine-technical-scope' | 'other-accepted-meaning';
  sourceStatus: 'supported' | 'unsupported' | 'ambiguous';
  trend: 'strengthened' | 'preserved' | 'mixed' | 'weakened' | 'unsupported' | 'ambiguous';
  currentlyProvenTechnicalScope: boolean | null;
  proofRule: string | null;
  matchedCandidateId: string | null;
  delta: SemanticSupportDelta | null;
  reasons: string[];
  policy: {
    acceptanceHistoryUnaffected: true;
    automaticTechnicalProofRevalidation: true;
    productIntentNotInferred: true;
    runtimeBehaviorNotInferred: true;
    doesNotEnrollOrBlockRelease: true;
  };
}

export function assessSemanticCurrentEvidence(
  graph: IntelligenceGraph,
  meaning: SemanticMeaningReview,
  candidates: SemanticCandidate[],
  audits: ReadonlyMap<string, SemanticCandidateAudit>,
): SemanticCurrentEvidence {
  const machine = meaning.acceptance?.actor.kind === 'intrinsic-derivation'
    && meaning.acceptance.actor.id === AUTONOMOUS_SEMANTIC_PROOF_RULE
    && meaning.proposal.kind === 'domain'
    && meaning.proposal.name === meaning.scope;
  const origin = machine ? 'machine-technical-scope' : 'other-accepted-meaning';
  const evolution = evaluateSemanticEvolution(meaning, candidates, graph.repositoryRevision);
  const current = evolution.matchedCandidate;
  const audit = current ? audits.get(current.id) ?? null : null;
  const sourceSupported = Boolean(current && audit?.factuality.status === 'supported');
  const technicalProof = machine
    ? current ? assessAutonomousSemanticProof(graph, current, audit) : null
    : null;
  const currentlyProvenTechnicalScope = machine ? Boolean(technicalProof?.accepted) : null;
  const evidenceSupported = sourceSupported && (!machine || currentlyProvenTechnicalScope === true);
  const delta = evolution.supportDelta;
  const positive = Boolean(delta && (delta.addedEvidenceFamilies.length > 0
    || delta.fileCountDelta > 0 || delta.nodeCountDelta > 0 || delta.resolvedEdgeCountDelta > 0));
  const negative = Boolean(delta && (delta.removedEvidenceFamilies.length > 0
    || delta.fileCountDelta < 0 || delta.nodeCountDelta < 0 || delta.resolvedEdgeCountDelta < 0));
  const sourceStatus = evolution.status === 'ambiguous' ? 'ambiguous'
    : evidenceSupported ? 'supported' : 'unsupported';
  const trend = evolution.status === 'ambiguous' ? 'ambiguous'
    : !evidenceSupported ? 'unsupported'
      : evolution.status === 'weakened' || (negative && !positive) ? 'weakened'
        : negative && positive ? 'mixed'
          : positive ? 'strengthened' : 'preserved';
  const reasons = [
    ...evolution.reasons,
    ...(current && !audit ? ['Current candidate source audit is unavailable'] : []),
    ...(audit && audit.factuality.status !== 'supported'
      ? ['Current candidate factuality is ' + audit.factuality.status] : []),
    ...(machine && !current ? ['Previously accepted technical source scope has no unambiguous current candidate'] : []),
    ...(technicalProof && !technicalProof.accepted
      ? technicalProof.blockers.map(blocker => 'Current technical source proof failed: ' + blocker) : []),
    ...(!machine && evidenceSupported
      ? ['Current source evidence supports the candidate, not independently proven product intent'] : []),
  ];
  return {
    version: 1,
    meaningId: meaning.meaningId,
    candidateId: meaning.candidateId,
    acceptedRevision: meaning.proposalRevision,
    inspectedRevision: graph.repositoryRevision,
    graphId: graph.graphId,
    analyzerVersion: graph.analyzerVersion,
    acceptedRecordRetained: true,
    origin,
    sourceStatus,
    trend,
    currentlyProvenTechnicalScope,
    proofRule: machine ? AUTONOMOUS_SEMANTIC_PROOF_RULE : null,
    matchedCandidateId: current?.id ?? null,
    delta,
    reasons,
    policy: {
      acceptanceHistoryUnaffected: true,
      automaticTechnicalProofRevalidation: true,
      productIntentNotInferred: true,
      runtimeBehaviorNotInferred: true,
      doesNotEnrollOrBlockRelease: true,
    },
  };
}
