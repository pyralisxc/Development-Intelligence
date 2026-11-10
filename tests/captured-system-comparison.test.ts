import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareCaptureIdentity, compareCapturedExecution,
  type CapturedSystemIdentity, type DerivedExecutionFact,
  type TestAssertionObservation,
} from '../src/intelligence/capturedSystemComparison.js';

const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const cap: CapturedSystemIdentity = {
  project: 'CardForge', revision: sha, treeSha: 'c'.repeat(40),
  graphId: 'repo-captured-cardforge', analyzerVersion: 'test-analyzer',
};
const fact: DerivedExecutionFact = {
  id: 'middleware-oauth-owner', revision: sha, graphId: cap.graphId,
  executionContextSha256: hash, evidence: ['src/infrastructure/auth/middleware.ts:25'],
  proof: 'established-conditional', dependenciesComplete: true,
  effect: 'occurs', mockedDependencies: ['@clerk/nextjs/server'],
};
const event: TestAssertionObservation = {
  id: 'test-owner-oauth', factId: fact.id, revision: sha, graphId: cap.graphId,
  executionContextSha256: hash, mockedDependencies: ['@clerk/nextjs/server'],
  outcome: 'pass', observedEffect: 'occurs', provenance: 'provider-verified',
  assertionIdentityVerified: true, failureIsAssertionMismatch: false,
};
test('same exact captured mock context can corroborate independently derived routing', () => {
  const r = compareCapturedExecution(cap, [fact], [event]);
  assert.equal(r.counts.corroborated, 1);
  assert.equal(r.policy.noRuntimeFromSourceAlone, true);
  assert.equal(r.items[0]?.currentEnvironmentEstablished, false);
});
test('unattested test reports and skipped instances cannot be treated as observed proof', () => {
  for (const patch of [{provenance: 'report-only' as const},
                       {outcome: 'skip' as const},
                       {assertionIdentityVerified: false}]) {
    const r = compareCapturedExecution(cap,[fact],[{...event,...patch}]);
    assert.equal(r.counts.unverified,1);
  }
});
test('mock mismatch or stale revision is not a behavioral contradiction', () => {
  assert.equal(compareCapturedExecution(cap,[fact],[{...event,mockedDependencies:[]}]).counts.incomparable,1);
  assert.equal(compareCapturedExecution(cap,[fact],[{...event,revision:'d'.repeat(40)}]).counts.incomparable,1);
});
test('only a verified assertion-specific failure can contradict matching established fact', () => {
  const mismatch = { ...event, outcome:'fail' as const,
    observedEffect:'does-not-occur' as const, failureIsAssertionMismatch:true };
  assert.equal(compareCapturedExecution(cap,[fact],[mismatch]).counts.contradicted,1);
  assert.equal(compareCapturedExecution(cap,[fact],[{...mismatch,failureIsAssertionMismatch:false}]).counts.unverified,1);
});
test('partial proof, missing assertion, and wrong database binding cannot upgrade truth', () => {
  assert.equal(compareCapturedExecution(cap,[{...fact,dependenciesComplete:false}],[event]).counts.unverified,1);
  assert.equal(compareCapturedExecution(cap,[fact],[]).counts['derived-only'],1);
  assert.equal(compareCapturedExecution(cap,[],[event]).counts['observed-only'],1);
  assert.equal(compareCapturedExecution(cap,[],[{...event,provenance:'report-only'}]).counts.unverified,1);
  assert.equal(compareCapturedExecution(cap,[{...fact,proof:'possible'}],[]).counts.unverified,1);
  assert.equal(compareCapturedExecution(cap,[{...fact,requiresDatabase:true}],[event]).counts.unverified,1);
});
test('capture identities distinguish unchanged source from database drift and historical truth', () => {
  const database = {
    environmentId: 'staging', catalogSha256:'e'.repeat(64),
    observationId:'observation-1', sourceBinding:'independently-attested' as const,
    observedSourceRevision:sha,
  };
  const a: CapturedSystemIdentity = {...cap,database};
  const b: CapturedSystemIdentity = {...cap,database:{...database, catalogSha256:'f'.repeat(64)}};
  const compared = compareCaptureIdentity(a,b);
  assert.equal(compared.sameSourceTree,true);
  assert.equal(compared.sameDatabaseDefinition,false);
  assert.equal(compared.historicalCaptureTruthExpiresWithAge,false);
  assert.equal(compared.sameLiveEnvironmentNowEstablished,false);
  assert.equal(compareCaptureIdentity(a,a).sameSystemComponentsEstablished,true);
  assert.equal(compareCaptureIdentity({...a,database:{...database,sourceBinding:'unverified'}},a).sameSystemComponentsEstablished,false);
});
test('bounded output discloses omitted comparison population', () => {
  const a = compareCapturedExecution(cap,[fact],[event,{...event,id:'another',outcome:'skip'}],1);
  assert.equal(a.total,2);
  assert.equal(a.returned,1);
  assert.equal(a.truncated,true);
});
