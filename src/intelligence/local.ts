import path from 'node:path';
import { runChecked } from '../util/process.js';
import type { IntelligenceGraph } from '../types.js';
import { buildRepositoryGraph } from './repository.js';
import { checkpointAnalyzerCurrent, readCheckpoint, writeCheckpoint } from './checkpoint.js';
import { assertGraphIntegrity } from './integrity.js';
import { bootstrapSemanticCandidates } from './semanticBootstrap.js';
import { auditSemanticCandidates } from './semanticAudit.js';

async function gitValue(root: string, args: string[]): Promise<string> {
  return (await runChecked('git', ['-C', root, ...args])).stdout.trim();
}

export async function buildLocalGraph(rootInput: string, project?: string, role: 'W' | 'B' = 'W'): Promise<IntelligenceGraph> {
  const root = path.resolve(rootInput);
  const revision = await gitValue(root, ['rev-parse', 'HEAD']);
  let repository = '';
  try { repository = await gitValue(root, ['remote', 'get-url', 'origin']); } catch { repository = root; }
  const name = project?.trim() || path.basename(root);
  const graph = await buildRepositoryGraph({ project: name, repository, revision, root, role });
  assertGraphIntegrity(graph);
  return graph;
}

export async function sealLocalGraph(root: string, project?: string): Promise<{ graph: IntelligenceGraph; path: string }> {
  const graph = await buildLocalGraph(root, project, 'B');
  const target = await writeCheckpoint(path.resolve(root), graph);
  return { graph, path: target };
}

export async function checkLocalGraph(root: string, project?: string): Promise<Record<string, unknown>> {
  const graph = await buildLocalGraph(root, project, 'W');
  const checkpoint = await readCheckpoint(path.resolve(root));
  if (!checkpoint) return { current: false, acceptedSemanticCurrent: false, reason: 'missing-checkpoint', sourceFingerprint: graph.sourceFingerprint };
  const sourceCurrent = checkpoint.meta.sourceFingerprint === graph.sourceFingerprint;
  const analyzerCurrent = checkpointAnalyzerCurrent(checkpoint.meta);
  const topologyCurrent = checkpoint.meta.schemaVersion === 2 && checkpoint.meta.topologyFingerprint === graph.topologyFingerprint;
  const evidenceCurrent = checkpoint.meta.schemaVersion === 2 && checkpoint.meta.evidenceFingerprint === graph.evidenceFingerprint;
  const schemaSupported = checkpoint.meta.schemaVersion === 2;
  const integrityCurrent = checkpoint.integrity.countsValid && checkpoint.integrity.topologyValid !== false;
  const acceptedSemanticCurrent = sourceCurrent && topologyCurrent && schemaSupported && integrityCurrent;
  return {
    current: acceptedSemanticCurrent,
    acceptedSemanticCurrent,
    sourceCurrent,
    topologyCurrent,
    evidenceCurrent,
    evidenceChanged: !evidenceCurrent,
    analyzerCurrent,
    analyzerChanged: !analyzerCurrent,
    schemaSupported,
    integrityCurrent,
    expectedSourceFingerprint: graph.sourceFingerprint,
    checkpointSourceFingerprint: checkpoint.meta.sourceFingerprint,
    expectedTopologyFingerprint: graph.topologyFingerprint,
    checkpointTopologyFingerprint: checkpoint.meta.schemaVersion === 2 ? checkpoint.meta.topologyFingerprint : null,
    expectedEvidenceFingerprint: graph.evidenceFingerprint,
    checkpointEvidenceFingerprint: checkpoint.meta.schemaVersion === 2 ? checkpoint.meta.evidenceFingerprint : null,
    expectedAnalyzerVersion: graph.analyzerVersion,
    checkpointAnalyzerVersion: checkpoint.meta.schemaVersion === 2 ? checkpoint.meta.analyzerVersion : 'legacy-1',
    checkpointSummary: checkpoint.meta.summary,
  };
}


export async function analyzeLocalGraph(root: string, project?: string): Promise<Record<string, unknown>> {
  const graph = await buildLocalGraph(root, project, 'W');
  const coverage = graph.coverage ?? null;
  const eligibleComplete = Boolean(
    coverage
    && coverage.analyzedFiles === coverage.eligibleFiles
    && coverage.completeFiles === coverage.eligibleFiles
    && coverage.partialFiles === 0
    && coverage.failedFiles === 0
    && coverage.skippedFiles === 0
  );

  const semanticBootstrap = bootstrapSemanticCandidates(graph, { limit: 1000 });
  const semanticAudit = auditSemanticCandidates(graph, semanticBootstrap, {
    limit: semanticBootstrap.candidates.length || 1,
  });
  const authoritySafe = semanticBootstrap.candidates.every(candidate =>
    !candidate.authority.accepted
    && !candidate.authority.persisted
    && !candidate.authority.proofEligible
  );
  const factualityClean = semanticAudit.counts.factualityNeedsReview === 0;
  const valid = eligibleComplete && authoritySafe && factualityClean;

  return {
    valid,
    mode: 'analysis-only',
    project: graph.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    sourceFingerprint: graph.sourceFingerprint,
    topologyFingerprint: graph.topologyFingerprint,
    evidenceFingerprint: graph.evidenceFingerprint,
    coverage: coverage ? {
      trackedFiles: coverage.trackedFiles,
      eligibleFiles: coverage.eligibleFiles,
      analyzedFiles: coverage.analyzedFiles,
      completeFiles: coverage.completeFiles,
      partialFiles: coverage.partialFiles,
      failedFiles: coverage.failedFiles,
      skippedFiles: coverage.skippedFiles,
      unsupportedFiles: coverage.unsupportedFiles,
      completeForEligibleSources: eligibleComplete,
    } : null,
    semantic: {
      candidateCount: semanticBootstrap.candidates.length,
      groupedScopeCount: semanticBootstrap.capacity.groupedScopeCount,
      rejectedScopeCount: semanticBootstrap.capacity.rejectedScopeCount,
      exhausted: semanticBootstrap.capacity.exhausted,
      factualitySupported: semanticAudit.counts.factualitySupported,
      factualityNeedsReview: semanticAudit.counts.factualityNeedsReview,
      coreCandidates: semanticAudit.counts.coreCandidates,
      supportingCandidates: semanticAudit.counts.supportingCandidates,
      authoritySafe,
    },
    policy: {
      checkpointRead: false,
      checkpointWritten: false,
      acceptedGraphAffected: false,
      semanticAuthorityChanged: false,
      canonicalAuthorityOwner: 'Development Intelligence',
    },
  };
}
