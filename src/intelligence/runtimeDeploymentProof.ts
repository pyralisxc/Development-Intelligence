import { getProjectConfig } from '../config/registry.js';
import { queryTechnicalSource } from './technicalSources.js';
import type { TechnicalEvidenceEnvelope } from '../types.js';

/** A Git ref is source truth, not runtime identity. Require a current provider
 * deployment observation with the exact selected SHA and a subsequent HTTP GET. */
export interface ProvenRuntimeDeployment {
  deploymentId: string;
  revision: string;
  deploymentSourceId: string;
  providerId: string | null;
  observedAt: string;
  assertedUrl: string;
  evidenceClass: 'provider-reported-ready-deployment';
}
const GIT_SHA = /^[0-9a-f]{40}$/u;
const RUNNING = new Set(['READY', 'ACTIVE']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export async function proveRuntimeDeployment(
  project: string, sourceRevision: string, url: URL,
): Promise<ProvenRuntimeDeployment> {
  if (!GIT_SHA.test(sourceRevision)) throw new Error('Runtime observations require an exact Git source revision');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Runtime observation URL must not carry credentials, query parameters or fragments');
  }
  const projectConfig = await getProjectConfig(project);
  const deploymentSources = (projectConfig.technicalSources ?? [])
    .filter(source => source.adapter === 'deployment-state' && source.capabilities.includes('query'));
  if (!deploymentSources.length) throw new Error('Runtime observation requires an authorized read-only deployment-state evidence source');

  const matches: ProvenRuntimeDeployment[] = [];
  for (const source of deploymentSources) {
    // Operator-configured HTTPS source, never a user-provided provider URL.
    let response: Record<string, unknown>;
    try {
      response = await queryTechnicalSource({
        project, sourceId: source.id, capability: 'query', query: 'current', limit: 100,
      });
    } catch {
      continue; // Provider unavailability never upgrades a runtime claim.
    }
    if (response.ok !== true) continue;
    const envelope = response.evidence as TechnicalEvidenceEnvelope | undefined;
    if (!envelope?.availability?.available) continue;
    for (const item of envelope.observations ?? []) {
      if (item.kind !== 'deployment-state') continue;
      const values = record(item.value);
      if (!values || values.gitSha !== sourceRevision
        || !RUNNING.has(String(values.status ?? '').toUpperCase())) continue;
      const deploymentId = values.deploymentId;
      const declaredUrl = values.url;
      if (typeof deploymentId !== 'string' || !deploymentId.trim()
        || typeof declaredUrl !== 'string') continue;
      let deploymentUrl: URL;
      try { deploymentUrl = new URL(declaredUrl); } catch { continue; }
      if (!['https:', 'http:'].includes(deploymentUrl.protocol)
        || deploymentUrl.origin !== url.origin
        || deploymentUrl.username || deploymentUrl.password
        || deploymentUrl.search || deploymentUrl.hash) continue;
      matches.push({
        deploymentId, revision: sourceRevision,
        deploymentSourceId: source.id,
        providerId: source.providerId ?? null,
        observedAt: envelope.snapshot.observedAt,
        assertedUrl: deploymentUrl.origin + deploymentUrl.pathname,
        evidenceClass: 'provider-reported-ready-deployment',
      });
    }
  }
  // Neither a stale ref nor an arbitrary URL nor ambiguous deployment owners
  // may produce source-correlated runtime facts.
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? 'Runtime deployment provenance is ambiguous for the selected Git revision and origin'
      : 'No matching ready deployment proved the selected Git revision and runtime origin');
  }
  return matches[0]!;
}
