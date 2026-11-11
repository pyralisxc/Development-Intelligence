import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyDatabaseCapture, type QualifyingTestRun,
  type DeploymentCaptureBinding, type DatabaseCatalogCapture,
} from '../src/intelligence/qualifyingCaptureEvidence.js';
import type { CapturedSystemIdentity } from '../src/intelligence/capturedSystemComparison.js';

const sha='a'.repeat(40), tree='b'.repeat(40), digest='c'.repeat(64);
const source:CapturedSystemIdentity={
  project:'CardForge',revision:sha,treeSha:tree,
  graphId:'repo-captured',analyzerVersion:'producer',
};
const run:QualifyingTestRun={
  sourceRevision:sha,sourceTreeSha:tree,finishedAt:'2026-11-09T12:00:00Z',
  source:'provider-authenticated',casesComplete:true,
  jobs:[{id:'verify',required:true,status:'success'},
        {id:'real-cardforge',required:true,status:'success'}],
};
const deployment:DeploymentCaptureBinding={
  deploymentId:'dpl-captured',environmentId:'staging',
  databaseEnvironmentId:'cardforge-staging',gitRevision:sha,
  status:'READY', configurationSha256:digest,source:'provider-authenticated',
};
const catalog:DatabaseCatalogCapture={
  observationId:'metadata-1',environmentId:'cardforge-staging',
  catalogSha256:digest,capturedAt:'2026-11-09T12:01:00Z',
  consistency:'consistent',metadataOnly:true,sanitized:true,
  source:'provider-authenticated',
};
test('qualifying evidence may bind one scoped captured catalog without asserting execution',()=>{
  const r=qualifyDatabaseCapture({source,run,deployment,catalog});
  assert.equal(r.captureReady,true);
  assert.deepEqual(r.reasons,[]);
  assert.equal(r.policy.greenTestDoesNotProveDatabaseWasUsedByRun,true);
  assert.equal(r.policy.qualifiedCaptureDoesNotProveRuntimeBehavior,true);
});
test('a pass cannot authorize collection by itself',()=>{
  assert.equal(qualifyDatabaseCapture({source,run,deployment:null,catalog}).captureReady,false);
  assert.equal(qualifyDatabaseCapture({source,run,deployment,catalog:null}).captureReady,false);
});
test('different revision, database environment, or ordering is not same capture',()=>{
  assert.ok(qualifyDatabaseCapture({source,run:{...run,sourceRevision:'d'.repeat(40)},deployment,catalog}).reasons.includes('run-source-identity-mismatch'));
  assert.ok(qualifyDatabaseCapture({source,run,deployment,catalog:{...catalog,environmentId:'production'}}).reasons.includes('catalog-environment-differs-from-deployment'));
  assert.ok(qualifyDatabaseCapture({source,run,deployment,catalog:{...catalog,capturedAt:'2026-11-09T11:59:59Z'}}).reasons.includes('catalog-captured-before-qualifying-tests-finished'));
});
test('reported or incomplete coverage never becomes an authenticated capture',()=>{
  assert.equal(qualifyDatabaseCapture({source,run:{...run,source:'caller-reported'},deployment,catalog}).captureReady,false);
  assert.equal(qualifyDatabaseCapture({source,run:{...run,casesComplete:false},deployment,catalog}).captureReady,false);
  assert.equal(qualifyDatabaseCapture({source,run,deployment:{...deployment,source:'caller-reported'},catalog}).captureReady,false);
  assert.equal(qualifyDatabaseCapture({source,run,deployment,catalog:{...catalog,consistency:'partial'}}).captureReady,false);
});
test('skipped required test and missing binding fail closed',()=>{
  const unrun={...run,jobs:[{id:'verify',required:true,status:'skipped' as const}]};
  assert.equal(qualifyDatabaseCapture({source,run:unrun,deployment,catalog}).captureReady,false);
  assert.equal(qualifyDatabaseCapture({source,run,deployment:{...deployment,databaseEnvironmentId:null},catalog}).captureReady,false);
});

test('a coherent captured catalog remains qualified when no tests have run',()=>{
  const r=qualifyDatabaseCapture({source,run:null,deployment,catalog});
  assert.equal(r.catalogObservation.qualifiedByUpstreamReceipts,true);
  assert.equal(r.environmentAssociation.qualifiedByUpstreamReceipts,true);
  assert.equal(r.postCiCollectionPolicy.ready,false);
  assert.ok(r.postCiCollectionPolicy.testReasons.includes('qualifying-run-unavailable'));
  assert.equal(r.catalogObservation.historicalValidityRequiresGreenTests,false);
  assert.equal(r.catalogObservation.currentEnvironmentEstablished,false);
});
test('a failed or mocked/unauthenticated CI run is not an epistemic veto over captured metadata',()=>{
  const red={...run,jobs:[{id:'verify',required:true,status:'failure' as const}]};
  const observed=qualifyDatabaseCapture({source,run:red,deployment,catalog});
  assert.equal(observed.catalogObservation.qualifiedByUpstreamReceipts,true);
  assert.equal(observed.environmentAssociation.qualifiedByUpstreamReceipts,true);
  assert.equal(observed.postCiCollectionPolicy.ready,false);
  assert.ok(observed.postCiCollectionPolicy.testReasons.includes('required-run-jobs-not-green'));
  const reported=qualifyDatabaseCapture({source,run:{...run,source:'caller-reported'},deployment,catalog});
  assert.equal(reported.catalogObservation.qualifiedByUpstreamReceipts,true);
  assert.equal(reported.postCiCollectionPolicy.ready,false);
});
test('untrusted catalog and mismatched deployment never become qualified observations',()=>{
  const unverified=qualifyDatabaseCapture({source,run,deployment,
    catalog:{...catalog,source:'caller-reported'}});
  assert.equal(unverified.catalogObservation.qualifiedByUpstreamReceipts,false);
  assert.equal(unverified.environmentAssociation.qualifiedByUpstreamReceipts,false);
  const mismatch=qualifyDatabaseCapture({source,run,
    deployment:{...deployment,databaseEnvironmentId:'other-db'},catalog});
  assert.equal(mismatch.catalogObservation.qualifiedByUpstreamReceipts,true);
  assert.equal(mismatch.environmentAssociation.qualifiedByUpstreamReceipts,false);
  assert.equal(mismatch.postCiCollectionPolicy.ready,false);
});
test('CI timing is a collection policy and cannot negate a historical capture',()=>{
  const earlier=qualifyDatabaseCapture({source,run,deployment,
    catalog:{...catalog,capturedAt:'2026-11-09T11:59:59Z'}});
  assert.equal(earlier.catalogObservation.qualifiedByUpstreamReceipts,true);
  assert.equal(earlier.environmentAssociation.qualifiedByUpstreamReceipts,true);
  assert.equal(earlier.postCiCollectionPolicy.ready,false);
  assert.ok(earlier.postCiCollectionPolicy.testReasons
    .includes('catalog-captured-before-qualifying-tests-finished'));
});
