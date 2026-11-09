import { createHash } from 'node:crypto';
import {
  changedFilesBetweenRevisions,
  resolveProjectRevision,
  revisionIdentity,
} from '../source/git.js';
import { evaluateTestIndependentSourceContract } from './independentSourceVerification.js';
import { graphContext } from './service.js';

/**
 * Ephemeral comparison of independently evaluated SOURCE obligations across
 * two immutable revisions. Prior CI/test results remain historical reports,
 * never current proof. Git retains code history; this saves no interpretation.
 */
export const REVISION_EVIDENCE_APPLICABILITY = 'rechecked-source-with-historical-runtime-boundary.v1';

export interface PriorTestRunReference {
  runId: string;
  claimedSourceRevision: string;
  reportedOutcome: 'pass' | 'fail' | 'unknown';
  reportDigest?: string;
}

export interface RevisionEvidenceInput {
  project: string;
  baseRef: string;
  ref: string;
  /** Caller-authored parity contract, never harvested from written tests. */
  contract: unknown;
  /** Metadata pointer only; neither run nor artifact is attested here. */
  priorTestRun?: PriorTestRunReference;
}

function isHexRevision(value: string): boolean {
  return /^[a-f0-9]{40}$/iu.test(value);
}
function validatePriorTestRun(value: PriorTestRunReference | undefined): void {
  if (!value) return;
  if (!value.runId || value.runId.length > 200 || value.runId.includes('\0')
    || !isHexRevision(value.claimedSourceRevision)
    || !['pass', 'fail', 'unknown'].includes(value.reportedOutcome)
    || (value.reportDigest !== undefined && !/^[a-f0-9]{64}$/iu.test(value.reportDigest))) {
    throw new Error('Prior test-run reference must be a bounded SHA-bound untrusted pointer');
  }
}

export async function assessRevisionEvidence(input: RevisionEvidenceInput) {
  validatePriorTestRun(input.priorTestRun);
  const [baseRevision, headRevision] = await Promise.all([
    resolveProjectRevision(input.project, input.baseRef),
    resolveProjectRevision(input.project, input.ref),
  ]);
  const exactBase = 'commit:' + baseRevision.sha;
  const exactHead = 'commit:' + headRevision.sha;
  const [base, head, changes] = await Promise.all([
    graphContext(input.project, { ref: exactBase }),
    graphContext(input.project, { ref: exactHead }),
    changedFilesBetweenRevisions(input.project, exactBase, exactHead),
  ]);
  if (base.graph.repositoryRevision !== baseRevision.sha
    || head.graph.repositoryRevision !== headRevision.sha
    || changes.base.sha !== baseRevision.sha || changes.head.sha !== headRevision.sha) {
    throw new Error('Evidence applicability requires two consistent exact Git revisions');
  }

  const oldProof = evaluateTestIndependentSourceContract(base.graph, input.contract);
  const currentProof = evaluateTestIndependentSourceContract(head.graph, input.contract);
  if (oldProof.decisions.length !== currentProof.decisions.length
    || oldProof.identity.contractSha256 !== currentProof.identity.contractSha256) {
    throw new Error('Independent source obligations changed during the exact-revision comparison');
  }
  const obligations = currentProof.decisions.map((current, i) => {
    const prior = oldProof.decisions[i]!;
    if (current.id !== prior.id || current.type !== prior.type
      || current.expectation !== prior.expectation) {
      throw new Error('Obligation identity changed between exact revisions');
    }
    const outcome = current.outcome === 'source-counterexample'
      ? 'static-source-counterexample'
      : current.outcome === 'established-static-source'
        ? prior.outcome === 'established-static-source'
          ? 'source-fact-independently-reestablished'
          : 'source-fact-newly-established'
        : 'source-fact-unproven';
    return {
      id: current.id, type: current.type, expected: current.expectation,
      prior: prior.outcome, current: current.outcome, outcome,
      currentResolvedWitnesses: current.witnessedResolvedEdgeIds,
      // A resolved edge is a source fact; no assertion expected value is inferred.
      provesBehavioralTestReplacement: false,
    };
  });

  const changedFiles = changes.files;
  const migrationPaths = changedFiles
    .filter(row => /(?:^|\/)(?:migrations|schema)\/.*\.sql$/iu.test(row.path)
      || /(?:^|\/)supabase\/config\.toml$/iu.test(row.path)
      || /\.sql$/iu.test(row.path))
    .map(row => row.path).sort();
  const sourcePathDigest = createHash('sha256').update(JSON.stringify(changedFiles))
    .digest('hex');
  const priorRun = input.priorTestRun;
  const oldRunMatchesBase = Boolean(priorRun
    && priorRun.claimedSourceRevision.toLowerCase() === baseRevision.sha);
  const requiresSourceFollowup = obligations.some(item =>
    item.outcome === 'source-fact-unproven' || item.outcome === 'static-source-counterexample');
  const nextChecks = [
    ...(requiresSourceFollowup ? [{
      kind: 'source-obligation',
      reason: 'Current exact source contains a counterexample or cannot independently establish the requested static obligation.',
    }] : []),
    ...(migrationPaths.length ? [{
      kind: 'database-state',
      reason: 'SQL/migration source changed. Applied migration order, live schema, RLS and function bodies require independent provider evidence.',
    }] : []),
    ...(priorRun ? [{
      kind: 'runtime-execution',
      reason: oldRunMatchesBase
        ? 'The referenced run applies only as a historical report at its claimed source revision; current execution and environment were not attested.'
        : 'The referenced run does not even claim the exact baseline Git revision; treat its source identity as mismatched.',
    }] : []),
  ];
  return {
    mode: REVISION_EVIDENCE_APPLICABILITY,
    identity: {
      project: input.project,
      base: { ...revisionIdentity(baseRevision), graphId: base.graph.graphId,
        analyzerVersion: base.graph.analyzerVersion },
      head: { ...revisionIdentity(headRevision), graphId: head.graph.graphId,
        analyzerVersion: head.graph.analyzerVersion },
      contractSha256: currentProof.identity.contractSha256,
    },
    source: {
      trackedSourceChanges: changedFiles.length,
      sameTrackedGitTree: changedFiles.length === 0,
      changedFiles, changedFilesSha256: sourcePathDigest,
      completeChangePopulation: true,
      sourceProofWasIndependentlyReevaluatedAtHead: true,
      analyzerIdentitySame: base.graph.analyzerVersion === head.graph.analyzerVersion,
      obligations,
    },
    database: {
      changedSqlOrMigrationPaths: migrationPaths,
      appliedMigrationStateVerified: false,
      liveDatabaseStateVerified: false,
      sourceChangeRequiresStateCheck: migrationPaths.length > 0,
      liveDatabaseCanChangeWithoutGitChanges: true,
    },
    priorTestRun: priorRun ? {
      runId: priorRun.runId,
      reportedOutcome: priorRun.reportedOutcome,
      claimedSourceRevision: priorRun.claimedSourceRevision,
      matchesBaselineGitRevision: oldRunMatchesBase,
      provenanceStatus: 'caller-supplied-unattested-reference',
      applicability: 'historical-report-only',
      currentRuntimeExecutionProven: false,
      expectedValueIndependentlyProven: false,
    } : null,
    nextChecks,
    policy: {
      immutableGitSourceIdentity: true,
      sameTreeDoesNotProveSameRuntimeEnvironment: true,
      staticSourceClaimDoesNotProveBehavior: true,
      externalStateNeverInferredFromCommittedSql: true,
      priorTestPassNeverUpgradedToCurrentRuntimePass: true,
      noSemanticHistoryStore: true,
      noAutomaticTestDeletion: true,
      doesNotApproveRelease: true,
    },
  };
}
