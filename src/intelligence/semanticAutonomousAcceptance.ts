import type { IntelligenceGraph } from '../types.js';
import type { SemanticCandidate } from './semanticBootstrap.js';
import type { SemanticCandidateAudit } from './semanticAudit.js';

/** A versioned source-only proof rule. This does not infer product purpose or runtime behavior. */
export const AUTONOMOUS_SEMANTIC_PROOF_RULE = 'intrinsic-technical-scope.v1';

export interface AutonomousSemanticProof {
  rule: typeof AUTONOMOUS_SEMANTIC_PROOF_RULE;
  accepted: boolean;
  blockers: string[];
  completeSourceFiles: number;
}

/**
 * Accept only mechanically named, multi-file technical areas with complete source
 * coverage and substantial resolved structure. Behavioral family labels only
 * select candidate areas; they do not prove a claimed product capability.
 * "Supported" in the candidate audit is necessary, not sufficient.
 */
export function assessAutonomousSemanticProof(
  graph: IntelligenceGraph,
  candidate: SemanticCandidate,
  audit: SemanticCandidateAudit | null,
): AutonomousSemanticProof {
  const blockers: string[] = [];
  if (!graph.repositoryRevision || candidate.provenance.revision !== graph.repositoryRevision) blockers.push('revision-mismatch');
  if (candidate.provenance.origin !== 'intrinsic-derivation' || candidate.provenance.producer !== 'semantic-bootstrap.v1') {
    blockers.push('not-intrinsic-source-derivation');
  }
  if (candidate.proposal.kind !== 'capability' || audit?.coreness.classification !== 'core-candidate') {
    blockers.push('semantic-kind-or-core-not-proven');
  }
  if (audit?.candidateId !== candidate.id || audit.factuality.status !== 'supported') {
    blockers.push('source-factuality-not-established');
  }
  const expectedName = candidate.scope.split('/').pop()?.replace(/\.[^.]+$/u, '').replace(/[^a-z0-9]+/giu, '').toLowerCase();
  const actualName = candidate.proposal.name.replace(/[^a-z0-9]+/giu, '').toLowerCase();
  if (!expectedName || actualName !== expectedName || candidate.proposal.alternatives.length > 0) {
    blockers.push('proposed-meaning-not-mechanically-bound-to-scope');
  }
  const expectedDescription = `Evidence-backed ${candidate.proposal.kind} candidate for ${candidate.scope}: ${candidate.support.fileCount} source file(s) with ${candidate.provenance.evidenceFamilies.join(', ')} evidence.`;
  if (candidate.proposal.description !== expectedDescription) blockers.push('non-source-derived-description');
  const families = new Set(candidate.provenance.evidenceFamilies);
  const behavioral = ['api', 'interface', 'state', 'persistence', 'motif'].filter(value => families.has(value as never));
  if (!families.has('structure') || !families.has('relationship')
    || behavioral.length < 2 || candidate.support.evidenceFamilyCount < 4
    || candidate.support.fileCount < 5 || candidate.support.resolvedEdgeCount < 8
    || candidate.provenance.nodeIds.length === 0 || candidate.provenance.edgeIds.length === 0) {
    blockers.push('independent-structural-and-behavioral-proof-insufficient');
  }
  const pathPrefix = `${candidate.scope}/`;
  const sourceFiles = graph.coverage?.files.filter(item =>
    item.path === candidate.scope || item.path.startsWith(pathPrefix)) ?? [];
  if (sourceFiles.length < candidate.support.fileCount || sourceFiles.some(item => item.status !== 'complete')) {
    blockers.push('candidate-scope-coverage-incomplete');
  }
  const nodes = new Set(candidate.provenance.nodeIds);
  if (graph.explicitValueConflicts.some(conflict => nodes.has(conflict.entityId))) {
    blockers.push('conflicting-source-evidence');
  }
  return {
    rule: AUTONOMOUS_SEMANTIC_PROOF_RULE,
    accepted: blockers.length === 0,
    blockers,
    completeSourceFiles: sourceFiles.filter(item => item.status === 'complete').length,
  };
}
