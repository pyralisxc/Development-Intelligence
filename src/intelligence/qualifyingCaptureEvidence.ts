import type { CapturedSystemIdentity } from './capturedSystemComparison.js';

/**
 * Provider-neutral capture qualification. Accepts only externally authenticated
 * receipts from an adapter; this pure method cannot authenticate provider claims.
 * A green source run is a prerequisite for planned capture, not evidence that
 * the captured database state was used while that run executed.
 */
export const QUALIFY_CAPTURE_PROOF = 'qualified-capture-association.v1';
const SHA = /^[a-f0-9]{40}$/iu;
const DIGEST = /^[a-f0-9]{64}$/iu;

export interface QualifyingTestRun {
  sourceRevision: string;
  sourceTreeSha: string;
  finishedAt: string;
  source: 'provider-authenticated' | 'caller-reported';
  casesComplete: boolean;
  jobs: Array<{
    id: string; required: boolean;
    status: 'success' | 'failure' | 'skipped' | 'cancelled' | 'running';
  }>;
}
export interface DeploymentCaptureBinding {
  deploymentId: string;
  environmentId: string;
  databaseEnvironmentId: string | null;
  gitRevision: string;
  status: 'READY' | 'ACTIVE' | 'FAILED' | 'UNKNOWN';
  configurationSha256: string | null;
  source: 'provider-authenticated' | 'caller-reported';
}
export interface DatabaseCatalogCapture {
  observationId: string;
  environmentId: string;
  catalogSha256: string;
  capturedAt: string;
  consistency: 'consistent' | 'partial' | 'unknown';
  metadataOnly: boolean;
  sanitized: boolean;
  source: 'provider-authenticated' | 'caller-reported';
}
function timestamp(value: string): number | null {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
export function qualifyDatabaseCapture(input: {
  source: CapturedSystemIdentity;
  run: QualifyingTestRun | null;
  deployment: DeploymentCaptureBinding | null;
  catalog: DatabaseCatalogCapture | null;
}) {
  const { source,run,deployment,catalog } = input;
  if (!SHA.test(source.revision) || !SHA.test(source.treeSha)) {
    throw new Error('Qualifying source must have exact immutable Git identity');
  }
  const reasons: string[] = [];
  if (!run) reasons.push('qualifying-run-unavailable');
  else {
    if (run.source !== 'provider-authenticated') reasons.push('run-not-provider-authenticated');
    if (run.sourceRevision !== source.revision || run.sourceTreeSha !== source.treeSha) reasons.push('run-source-identity-mismatch');
    if (!run.jobs.length || !run.jobs.some(j => j.required)
      || run.jobs.some(j => j.required && j.status !== 'success')) reasons.push('required-run-jobs-not-green');
    if (!run.casesComplete) reasons.push('test-case-population-not-complete');
    if (timestamp(run.finishedAt) === null) reasons.push('invalid-run-timestamp');
    if (new Set(run.jobs.map(j => j.id)).size !== run.jobs.length
      || run.jobs.some(j => !j.id)) reasons.push('ambiguous-run-job-identity');
  }
  if (!deployment) reasons.push('deployment-binding-unavailable');
  else {
    if (deployment.source !== 'provider-authenticated') reasons.push('deployment-not-provider-authenticated');
    if (deployment.gitRevision !== source.revision) reasons.push('deployment-source-mismatch');
    if (!['READY','ACTIVE'].includes(deployment.status)) reasons.push('deployment-not-ready');
    if (!deployment.deploymentId || !deployment.environmentId
      || !deployment.databaseEnvironmentId || !deployment.configurationSha256
      || !DIGEST.test(deployment.configurationSha256)) reasons.push('deployment-configuration-or-database-identity-missing');
  }
  if (!catalog) reasons.push('database-observation-unavailable');
  else {
    if (catalog.source !== 'provider-authenticated') reasons.push('catalog-not-provider-authenticated');
    if (!catalog.observationId || !catalog.environmentId || !DIGEST.test(catalog.catalogSha256)) reasons.push('catalog-identity-invalid');
    if (catalog.consistency !== 'consistent') reasons.push('catalog-not-consistent');
    if (!catalog.metadataOnly || !catalog.sanitized) reasons.push('catalog-not-safe-metadata');
    const captureTime=timestamp(catalog.capturedAt);
    if (captureTime === null) reasons.push('catalog-timestamp-invalid');
    if (run && captureTime !== null && timestamp(run.finishedAt) !== null
      && captureTime < timestamp(run.finishedAt)!) reasons.push('catalog-captured-before-qualifying-tests-finished');
    if (deployment && catalog.environmentId !== deployment.databaseEnvironmentId) reasons.push('catalog-environment-differs-from-deployment');
  }
  const captureReady = reasons.length === 0;
  return {
    version: QUALIFY_CAPTURE_PROOF,
    source: {revision:source.revision, treeSha:source.treeSha, graphId:source.graphId},
    captureReady,
    databaseObservationId: catalog?.observationId ?? null,
    deploymentId:deployment?.deploymentId ?? null,
    reasons,
    policy:{
      noLiveCallsPerformed:true,
      noRecurringScheduleRequired:true,
      providerReceiptsMustBeAuthenticatedUpstream:true,
      greenTestDoesNotProveDatabaseWasUsedByRun:true,
      qualifiedCaptureDoesNotProveRuntimeBehavior:true,
      captureHistoricalTruthDoesNotExpire:true,
      canonicalGraphUnchanged:true,
    },
  };
}
