import type { IntelligenceGraph } from '../types.js';
import { bootstrapSemanticCandidates } from './semanticBootstrap.js';
import { auditSemanticCandidates } from './semanticAudit.js';
import { assessAutonomousSemanticProof, AUTONOMOUS_SEMANTIC_PROOF_RULE } from './semanticAutonomousAcceptance.js';

/**
 * Reconstruct semantic understanding from the ONE selected exact-revision
 * graph. This must not depend on a previous review, accepted meaning identity,
 * semantic lineage, or any derived semantic persistence.
 */
export function deriveCurrentSemanticTruth(graph: IntelligenceGraph) {
  const census = bootstrapSemanticCandidates(graph, { limit: 1000 });
  const audit = auditSemanticCandidates(graph, census, { limit: census.candidates.length || 1 });
  const audited = new Map(audit.items.map(item => [item.candidateId, item]));
  const provenTechnicalScopes = [] as Array<{
    id: string; scope: string; name: string; kind: 'technical-source-scope';
    completeSourceFiles: number; resolvedRelationships: number;
    evidenceFamilies: string[]; proofRule: string;
  }>;
  const interpretations = census.candidates.map(candidate => {
    const assessment = audited.get(candidate.id) ?? null;
    const proof = assessAutonomousSemanticProof(graph, candidate, assessment);
    if (proof.accepted) provenTechnicalScopes.push({
      id: 'current-technical-scope:' + candidate.scope,
      scope: candidate.scope,
      name: candidate.scope,
      kind: 'technical-source-scope',
      completeSourceFiles: proof.completeSourceFiles,
      resolvedRelationships: candidate.support.resolvedEdgeCount,
      evidenceFamilies: [...candidate.provenance.evidenceFamilies],
      proofRule: AUTONOMOUS_SEMANTIC_PROOF_RULE,
    });
    const factuality = assessment?.factuality.status ?? 'unknown';
    return {
      candidateId: candidate.id,
      scope: candidate.scope,
      name: candidate.proposal.name,
      description: candidate.proposal.description,
      proposedKind: candidate.proposal.kind,
      evidenceFamilies: [...candidate.provenance.evidenceFamilies],
      sourceFileCount: candidate.support.fileCount,
      resolvedRelationships: candidate.support.resolvedEdgeCount,
      coreness: assessment?.coreness.classification ?? 'unknown',
      factuality,
      technicalScopeProven: proof.accepted,
      sourceStatus: factuality === 'supported' ? 'source-supported-interpretation' as const : 'unproven' as const,
      proofBlockers: proof.blockers,
      requiresReviewToUseTechnicalEvidence: false as const,
      productIntentProven: false as const,
    };
  });
  provenTechnicalScopes.sort((a, b) => a.scope.localeCompare(b.scope));
  const declaredConcepts = graph.nodes
    .filter(node => node.layer === 'semantic'
      && ['domain', 'capability', 'feature', 'surface'].includes(node.kind)
      && node.tags?.includes('declared') && node.sourceId.startsWith('repo:'))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(node => ({
      id: node.id, scope: node.sourceId.slice(5), kind: node.kind,
      name: node.name ?? node.locator, locator: node.locator,
      evidenceIds: [...(node.evidenceIds ?? [])].sort(), status: 'source-declared' as const,
    }));
  const coverage = graph.coverage;
  const completeForEligibleSources = Boolean(coverage
    && coverage.eligibleFiles === coverage.completeFiles && !coverage.partialFiles
    && !coverage.skippedFiles && !coverage.failedFiles);
  return {
    version: 1 as const,
    source: 'current-graph' as const,
    revision: graph.repositoryRevision,
    graphId: graph.graphId,
    analyzerVersion: graph.analyzerVersion,
    provenTechnicalScopes,
    declaredConcepts,
    interpretations,
    counts: {
      provenTechnicalScopes: provenTechnicalScopes.length,
      sourceDeclaredConcepts: declaredConcepts.length,
      supportedInterpretations: interpretations.filter(i => i.sourceStatus === 'source-supported-interpretation').length,
      unprovenInterpretations: interpretations.filter(i => i.sourceStatus === 'unproven').length,
      candidatePopulationExhausted: census.capacity.exhausted,
      candidatePopulationTruncated: census.capacity.truncated,
    },
    exclusions: {
      completeForEligibleSources,
      trackedFiles: coverage?.trackedFiles ?? null,
      eligibleFiles: coverage?.eligibleFiles ?? null,
      partialFiles: coverage?.partialFiles ?? null,
      skippedFiles: coverage?.skippedFiles ?? null,
      failedFiles: coverage?.failedFiles ?? null,
      unsupportedFiles: coverage?.unsupportedFiles ?? null,
      excludedCandidateScopes: census.capacity.excludedScopes,
    },
    policy: {
      builtOnlyFromSelectedGraph: true as const,
      historicalAcceptanceNeverInput: true as const,
      noSemanticLedgerReadOrWrite: true as const,
      noHumanReviewRequiredForProvenTechnicalFacts: true as const,
      sourceDerivedInterpretationDoesNotProveProductIntent: true as const,
      staticSourceDoesNotProveRuntimeExecution: true as const,
      omissionOutsideCompleteScopeIsNotAbsence: true as const,
      historicalRequestsSelectTheirOwnExactGitRevision: true as const,
    },
  };
}
