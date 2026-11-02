import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runChecked } from '../util/process.js';
import type { IntelligenceGraph } from '../types.js';
import { buildRepositoryGraph } from './repository.js';
import { checkpointAnalyzerCurrent, readCheckpoint, writeCheckpoint } from './checkpoint.js';
import { assertGraphIntegrity } from './integrity.js';
import { bootstrapSemanticCandidates } from './semanticBootstrap.js';
import { auditSemanticCandidates } from './semanticAudit.js';
import { evaluateParityContractGraph } from './parityContract.js';

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


export interface LocalParityContractInput {
  path: string;
  contract: unknown;
}

function pathInside(root: string, target: string): string | null {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export async function readLocalParityContract(rootInput: string, contractPathInput: string): Promise<LocalParityContractInput> {
  const requestedPath = contractPathInput.trim();
  if (!requestedPath) throw new Error('parity contract path must be non-empty');
  const root = await fs.realpath(path.resolve(rootInput));
  const lexicalPath = path.resolve(root, requestedPath);
  if (!pathInside(root, lexicalPath)) throw new Error(`parity contract path escapes repository root: ${requestedPath}`);

  let lexicalStat;
  try {
    lexicalStat = await fs.lstat(lexicalPath);
  } catch (error) {
    throw new Error(`parity contract could not be read: ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (lexicalStat.isSymbolicLink()) throw new Error(`parity contract must not be a symbolic link: ${requestedPath}`);

  const realPath = await fs.realpath(lexicalPath);
  const relative = pathInside(root, realPath);
  if (!relative) throw new Error(`parity contract resolves outside repository root: ${requestedPath}`);
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error(`parity contract is not a regular file: ${requestedPath}`);

  let text: string;
  try {
    text = await fs.readFile(realPath, 'utf8');
  } catch (error) {
    throw new Error(`parity contract could not be read: ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { path: relative, contract: JSON.parse(text) as unknown };
  } catch (error) {
    throw new Error(`parity contract is not valid JSON: ${requestedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function maintainedParityReceipt(graph: IntelligenceGraph, input: LocalParityContractInput): Record<string, unknown> {
  const evaluation = evaluateParityContractGraph(graph, input.contract) as any;
  const claims = (evaluation.results as any[]).map(result => {
    const predicate = result.type === 'predicate';
    const qualified = predicate && result.observed?.sourceScope?.qualified === true;
    const replacementEligible = predicate && result.replacementAssessment?.eligible === true;
    const blockers = [
      ...(Array.isArray(result.replacementAssessment?.blockers) ? result.replacementAssessment.blockers : []),
      ...(!qualified ? ['Claim does not provide qualified source-scope evidence.'] : []),
      ...(!replacementEligible ? ['Claim is not replacement-eligible.'] : []),
    ];
    return {
      type: result.type,
      id: result.predicate?.id ?? result.expectation?.id ?? `${result.expectation?.from ?? 'unknown'}:${result.expectation?.kind ?? 'unknown'}:${result.expectation?.to ?? 'unknown'}`,
      status: result.status,
      qualified,
      replacementEligible,
      blockers,
      ...(result.matched ? { matched: result.matched } : {}),
      ...(result.observed?.traversal ? { traversal: result.observed.traversal } : {}),
      ...(result.observed?.sourceScope ? { sourceScope: result.observed.sourceScope } : {}),
      explanation: result.explanation,
    };
  });
  const valid = evaluation.passed === true && claims.every(claim => claim.status === 'satisfied' && claim.qualified && claim.replacementEligible);
  return {
    supplied: true,
    valid,
    path: input.path,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    contract: evaluation.contract,
    counts: evaluation.counts,
    claims,
    policy: {
      callerOwned: true,
      persisted: false,
      requiresSatisfiedClaims: true,
      requiresQualifiedSourceScope: true,
      requiresReplacementEligibility: true,
    },
    note: valid
      ? 'Every supplied claim is satisfied with qualified, replacement-eligible static graph evidence.'
      : 'The supplied contract failed closed. Every claim must be satisfied with qualified, replacement-eligible static graph evidence.',
  };
}

export async function analyzeLocalGraph(root: string, project?: string, parityContract?: LocalParityContractInput): Promise<Record<string, unknown>> {
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
  const parityReceipt = parityContract ? maintainedParityReceipt(graph, parityContract) : null;
  const valid = eligibleComplete && authoritySafe && factualityClean && (!parityReceipt || parityReceipt.valid === true);

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
    ...(parityReceipt ? { parityContract: parityReceipt } : {}),
    policy: {
      checkpointRead: false,
      checkpointWritten: false,
      acceptedGraphAffected: false,
      semanticAuthorityChanged: false,
      canonicalAuthorityOwner: 'Development Intelligence',
    },
  };
}
