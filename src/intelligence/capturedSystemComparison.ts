/**
 * Captured-system evidence comparison over DI's existing canonical graph.
 *
 * This lens does NOT establish its input facts or authenticate CI. Its input
 * facts must be supplied by an independently verified producer, and the
 * provider-attestation boundary must be enforced by the invoking adapter.
 * It distinguishes equivalence of captured execution contexts from recency.
 */
export const CAPTURED_EXECUTION_COMPARISON = 'captured-execution-comparison.v1';

export interface CapturedSystemIdentity {
  project: string;
  revision: string;
  treeSha: string;
  graphId: string;
  analyzerVersion: string;
  /** Captured database evidence is environment-specific, not implied by Git. */
  database?: {
    environmentId: string;
    catalogSha256: string;
    observationId: string;
    sourceBinding: 'unverified' | 'independently-attested';
    observedSourceRevision: string | null;
  };
}

export interface DerivedExecutionFact {
  id: string;
  /** Same source graph as the system capture. */
  revision: string;
  graphId: string;
  /** Stable, content-addressed set of inputs/identity/flags/mocks. */
  executionContextSha256: string;
  /** Exact declaration/effect evidence belonging to this captured system. */
  evidence: string[];
  /** A producer assertion, never upgraded by this comparison itself. */
  proof: 'established-conditional' | 'possible' | 'unknown';
  dependenciesComplete: boolean;
  effect: 'occurs' | 'does-not-occur';
  /** Mocked dependencies are part of the execution model, not annotations. */
  mockedDependencies: string[];
  requiresDatabase?: boolean;
}

export interface TestAssertionObservation {
  id: string;
  factId: string;
  revision: string;
  graphId: string;
  executionContextSha256: string;
  mockedDependencies: string[];
  outcome: 'pass' | 'fail' | 'skip' | 'unknown';
  /** An assertion-specific observed effect, not a suite-wide result. */
  observedEffect: 'occurs' | 'does-not-occur' | null;
  /** Only an authenticated provider adapter may supply verified evidence. */
  provenance: 'report-only' | 'provider-verified';
  assertionIdentityVerified: boolean;
  /** A failed test may be unrelated to the asserted effect. */
  failureIsAssertionMismatch: boolean;
}

export type ComparisonStatus =
  | 'corroborated' | 'contradicted' | 'derived-only'
  | 'observed-only' | 'incomparable' | 'unverified';

export interface ComparisonItem {
  factId: string;
  observationId: string | null;
  status: ComparisonStatus;
  reason: string;
  sourceFactRemainsHistorical: true;
  currentEnvironmentEstablished: false;
}

const HEX40 = /^[a-f0-9]{40}$/iu;
const HEX64 = /^[a-f0-9]{64}$/iu;
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(a).size === a.length
    && new Set(b).size === b.length && a.every(x => b.includes(x));
}
function validCapture(capture: CapturedSystemIdentity): void {
  if (!capture.project || !capture.graphId || !capture.analyzerVersion
    || !HEX40.test(capture.revision) || !HEX40.test(capture.treeSha)) {
    throw new Error('Captured system requires an exact source/tree identity');
  }
  const db = capture.database;
  if (db && (!db.environmentId || !db.observationId
    || !HEX64.test(db.catalogSha256)
    || (db.observedSourceRevision !== null && !HEX40.test(db.observedSourceRevision)))) {
    throw new Error('Database capture identity is incomplete');
  }
}
/** Compare separately acquired captures; SHA equality never proves a deployment binding. */
export function compareCaptureIdentity(a: CapturedSystemIdentity, b: CapturedSystemIdentity) {
  validCapture(a);
  validCapture(b);
  const sameSource = a.project === b.project && a.treeSha === b.treeSha;
  const sameDatabase = Boolean(a.database && b.database
    && a.database.environmentId === b.database.environmentId
    && a.database.catalogSha256 === b.database.catalogSha256);
  const independentlyBound = Boolean(a.database && b.database
    && a.database.sourceBinding === 'independently-attested'
    && b.database.sourceBinding === 'independently-attested'
    && a.database.observedSourceRevision === a.revision
    && b.database.observedSourceRevision === b.revision);
  return {
    sameSourceTree: sameSource,
    sameDatabaseDefinition: sameDatabase,
    sameSystemComponentsEstablished: sameSource && sameDatabase && independentlyBound,
    sameLiveEnvironmentNowEstablished: false as const,
    historicalCaptureTruthExpiresWithAge: false as const,
    databaseComparisonUnavailable: !a.database || !b.database,
  };
}

/**
 * Compare only assertion-level observations to independently derived facts.
 * Report-only events never become an observed proof. No absence proof follows
 * from a missing event, a skipped case, or a partial static dependency set.
 */
export function compareCapturedExecution(
  capture: CapturedSystemIdentity,
  facts: readonly DerivedExecutionFact[],
  observations: readonly TestAssertionObservation[],
  limit = 100,
  offset = 0,
  expectedDigest?: string,
) {
  validCapture(capture);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Comparison page limit must be between 1 and 1000');
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 20000) {
    throw new Error('Comparison offset must be a non-negative bounded integer');
  }
  if (facts.length > 10000 || observations.length > 20000) {
    throw new Error('Captured evidence population exceeds bounded comparison');
  }
  const factIds = new Set<string>();
  for (const fact of facts) {
    if (!fact.id || factIds.has(fact.id) || !HEX64.test(fact.executionContextSha256)
      || fact.revision !== capture.revision || fact.graphId !== capture.graphId) {
      throw new Error('Derived facts require unique identities and exact graph binding');
    }
    factIds.add(fact.id);
  }
  const observationIds = new Set<string>();
  for (const event of observations) {
    if (!event.id || observationIds.has(event.id) || !HEX64.test(event.executionContextSha256)) {
      throw new Error('Test observations require unique identities and context digests');
    }
    observationIds.add(event.id);
  }
  const byFact = new Map<string, TestAssertionObservation[]>();
  for (const observation of observations) {
    const list = byFact.get(observation.factId) ?? [];
    list.push(observation);
    byFact.set(observation.factId, list);
  }
  const items: ComparisonItem[] = [];
  for (const fact of facts) {
    const events = byFact.get(fact.id) ?? [];
    if (!events.length) {
      const derived = fact.proof === 'established-conditional'
        && fact.dependenciesComplete && fact.evidence.length > 0
        && (!fact.requiresDatabase || Boolean(capture.database
          && capture.database.sourceBinding === 'independently-attested'
          && capture.database.observedSourceRevision === capture.revision));
      items.push({
        factId: fact.id, observationId: null,
        status: derived ? 'derived-only' : 'unverified',
        reason: derived
          ? 'Established captured fact has no mapped test observation; absence of execution is not proven'
          : 'Unestablished candidate has no mapped assertion event',
        sourceFactRemainsHistorical: true, currentEnvironmentEstablished: false,
      });
    }
    for (const event of events) {
      let status: ComparisonStatus;
      let reason: string;
      if (event.revision !== capture.revision || event.graphId !== capture.graphId
        || event.executionContextSha256 !== fact.executionContextSha256
        || !sameStrings(event.mockedDependencies, fact.mockedDependencies)) {
        status = 'incomparable';
        reason = 'Source or execution context differs, including mocks';
      } else if (fact.proof !== 'established-conditional' || !fact.dependenciesComplete
        || fact.evidence.length === 0
        || (fact.requiresDatabase && (!capture.database
          || capture.database.sourceBinding !== 'independently-attested'
          || capture.database.observedSourceRevision !== capture.revision))) {
        status = 'unverified';
        reason = 'Derived effect is not established for complete captured dependencies';
      } else if (event.provenance !== 'provider-verified' || !event.assertionIdentityVerified
        || event.outcome === 'skip' || event.outcome === 'unknown'
        || event.observedEffect === null) {
        status = 'unverified';
        reason = 'No authenticated assertion-specific execution observation';
      } else if (event.outcome === 'fail' && !event.failureIsAssertionMismatch) {
        status = 'unverified';
        reason = 'Test failed outside the verified effect assertion';
      } else if (event.observedEffect === fact.effect && event.outcome === 'pass') {
        status = 'corroborated';
        reason = 'Matching authenticated assertion event under equivalent captured context';
      } else if (event.outcome === 'pass' && event.observedEffect !== fact.effect) {
        status = 'contradicted';
        reason = 'Passing assertion observed the opposite effect under equivalent captured context';
      } else if (event.observedEffect !== fact.effect && event.outcome === 'fail'
        && event.failureIsAssertionMismatch) {
        status = 'contradicted';
        reason = 'Assertion-specific mismatch under equivalent captured context';
      } else {
        status = 'unverified';
        reason = 'Assertion outcome and effect observation are not coherently established';
      }
      items.push({
        factId: fact.id, observationId: event.id, status, reason,
        sourceFactRemainsHistorical: true, currentEnvironmentEstablished: false,
      });
    }
  }
  for (const event of observations) if (!factIds.has(event.factId)) {
    const attested = event.revision === capture.revision
      && event.graphId === capture.graphId
      && event.provenance === 'provider-verified'
      && event.assertionIdentityVerified && event.observedEffect !== null
      && event.outcome !== 'unknown' && event.outcome !== 'skip'
      && (event.outcome !== 'fail' || event.failureIsAssertionMismatch);
    items.push({
      factId: event.factId, observationId: event.id,
      status: attested ? 'observed-only' : 'unverified',
      reason: attested
        ? 'Authenticated assertion-specific observation lacks independently derived fact'
        : 'Reported or incomplete assertion is not verified execution evidence',
      sourceFactRemainsHistorical: true, currentEnvironmentEstablished: false,
    });
  }
  items.sort((a,b) => a.factId.localeCompare(b.factId)
    || (a.observationId ?? '').localeCompare(b.observationId ?? ''));
  const counts = Object.fromEntries(
    (['corroborated','contradicted','derived-only','observed-only','incomparable','unverified'] as const)
      .map(status => [status, items.filter(item => item.status === status).length]));
  const digest = createHash('sha256').update(JSON.stringify({
    capture: [capture.project, capture.revision, capture.treeSha, capture.graphId,
      capture.database?.environmentId ?? null, capture.database?.catalogSha256 ?? null],
    comparison: items.map(item => [item.factId, item.observationId, item.status, item.reason]),
  })).digest('hex');
  if (expectedDigest !== undefined && expectedDigest !== digest) {
    throw new Error('Comparison pagination digest differs from first-page population');
  }
  return {
    capture: { project: capture.project, revision: capture.revision,
      treeSha: capture.treeSha, graphId: capture.graphId },
    version: CAPTURED_EXECUTION_COMPARISON,
    digest,
    counts, total: items.length,
    offset,
    returned: Math.max(0, Math.min(limit, items.length - offset)),
    truncated: offset + limit < items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit),
    policy: {
      inputsAreNotAuthenticatedByThisPureLens: true,
      factProofMustBeEstablishedUpstream: true,
      providerRunMustBeVerifiedUpstream: true,
      mocksAreExecutionContext: true,
      noRuntimeFromSourceAlone: true,
      noTestDeletion: true,
      canonicalGraphUnchanged: true,
    },
  };
}
