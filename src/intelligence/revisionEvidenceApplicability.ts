import { createHash } from 'node:crypto';
import {
  changedFilesBetweenRevisions,
  resolveProjectRevision,
  revisionIdentity,
} from '../source/git.js';
import { evaluateTestIndependentSourceContract } from './independentSourceVerification.js';
import { graphContext } from './service.js';
import { normalizeParityContract } from './parityContract.js';
import { projectExactConditionSignatures } from './sourceConditionEffects.js';

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

  // Extract source-only condition/effect fingerprints for exactly named
  // caller-owned callable obligations, never for incidental lexical guesses.
  // This is a projection of the same two exact Git graphs, not a historical
  // semantic authority and not an execution-result replay.
  const normalized = normalizeParityContract(input.contract);
  const possibleIds = [...new Set([
    ...(normalized.entities ?? []).map(item => item.id),
    ...(normalized.relationships ?? []).flatMap(item => [item.from, item.to]),
    ...(normalized.predicates ?? []).flatMap(item => [
      ...(item.from.ids ?? []), ...(item.to.ids ?? []),
    ]),
  ])].filter(id => id.startsWith('symbol:')).sort();
  const isCallable = (graph: typeof base.graph, id: string) => graph.nodes.some(
    node => node.id === id && (node.kind === 'function' || node.kind === 'method')
      && node.layer === 'structural');
  const ids = possibleIds.filter(id => isCallable(base.graph, id) || isCallable(head.graph, id));
  const [baseConditions, currentConditions] = await Promise.all([
    projectExactConditionSignatures({ project: input.project, graph: base.graph, functionIds: ids }),
    projectExactConditionSignatures({ project: input.project, graph: head.graph, functionIds: ids }),
  ]);
  const oldById = new Map(baseConditions.map(item => [item.functionId, item]));
  const currentById = new Map(currentConditions.map(item => [item.functionId, item]));
  const conditionComparisons = ids.map(id => {
    const before = oldById.get(id);
    const after = currentById.get(id);
    const comparable = Boolean(before?.status === 'supported' && after?.status === 'supported'
      && base.graph.analyzerVersion === head.graph.analyzerVersion);
    const guardsChanged = comparable
      ? JSON.stringify(before!.branchFingerprints) !== JSON.stringify(after!.branchFingerprints) : null;
    const effectsChanged = comparable
      ? JSON.stringify(before!.directEffectFingerprints) !== JSON.stringify(after!.directEffectFingerprints) : null;
    const outcome = !comparable ? 'conditional-source-unproven'
      : guardsChanged || effectsChanged ? 'conditional-source-changed'
        : 'conditional-source-reobserved';
    return {
      functionId: id,
      sourcePath: after?.sourcePath ?? before?.sourcePath ?? null,
      priorStatus: before?.status ?? 'unproven',
      currentStatus: after?.status ?? 'unproven',
      priorBranchCount: before?.branchCount ?? 0,
      currentBranchCount: after?.branchCount ?? 0,
      priorDirectEffectCount: before?.directEffectCount ?? 0,
      currentDirectEffectCount: after?.directEffectCount ?? 0,
      guardsChanged, directEffectsChanged: effectsChanged,
      outcome, syntaxOnly: true, runtimeExecutionEstablished: false,
      transitiveClosureProven: false, priorTestPassCarriedForward: false,
    };
  });
  const namedConditionChanges = conditionComparisons.filter(item =>
    item.outcome === 'conditional-source-changed');
  const unresolvedNamedConditions = conditionComparisons.filter(item =>
    item.outcome === 'conditional-source-unproven');

  const changedFiles = changes.files;
  const migrationPaths = changedFiles
    .filter(row => /(?:^|\/)(?:migrations|schema)\/.*\.sql$/iu.test(row.path)
      || /(?:^|\/)supabase\/config\.toml$/iu.test(row.path)
      || /\.sql$/iu.test(row.path))
    .map(row => row.path).sort();
  const changedExecutableSourcePaths = changedFiles.filter(row =>
    /\.(?:[cm]?[jt]sx?|py|rs|go|cs|java|c|cc|cpp|h|hpp|sql)$/iu.test(row.path)
    || /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|Cargo\.lock|pyproject\.toml|supabase\/config\.toml)$/iu.test(row.path))
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
    ...(namedConditionChanges.length ? [{
      kind: 'condition-effect',
      reason: 'Exact source predicates or direct effect paths changed for ' + namedConditionChanges.length
        + ' caller-named function(s), even if static calls still resolve. Re-evaluate those branch conditions independently.',
    }] : changedExecutableSourcePaths.length ? [{
      kind: 'condition-effect',
      reason: 'Executable source or dependency configuration changed. A static call still resolving does not prove that branch guards, effects, errors, or transitive behavior are preserved.',
    }] : []),
    ...(unresolvedNamedConditions.length ? [{
      kind: 'source-condition-unknown',
      reason: 'Some named function conditions could not be source-verified exhaustively. Never preserve their semantics from an old run or a static call.',
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
    controlFlow: {
      changedExecutableSourcePaths,
      selectedFunctionConditions: conditionComparisons,
      selectedFunctionConditionCount: conditionComparisons.length,
      selectedFunctionConditionReobserved: conditionComparisons.filter(item =>
        item.outcome === 'conditional-source-reobserved').length,
      selectedFunctionConditionChanged: namedConditionChanges.length,
      selectedFunctionConditionUnproven: unresolvedNamedConditions.length,
      sourceConditionSignaturesComparedAtExactRevisions: true,
      conditionsAndEffectsIndependentlyVerified: false,
      transitiveDependencyClosureProven: false,
      needsIndependentBehavioralRecheck: changedExecutableSourcePaths.length > 0
        || namedConditionChanges.length > 0 || unresolvedNamedConditions.length > 0,
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
      reportDigest: priorRun.reportDigest ?? null,
      reportDigestAuthenticated: false,
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
      sourceConditionSignaturesNeverProveRuntimeBehavior: true,
      noSemanticHistoryStore: true,
      noAutomaticTestDeletion: true,
      doesNotApproveRelease: true,
    },
  };
}
