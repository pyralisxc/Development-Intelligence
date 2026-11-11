import { createHash } from 'node:crypto';
import type { GraphEdge, GraphNode, IntelligenceGraph, TechnicalEvidenceEnvelope } from '../types.js';

/**
 * Read-only reconciliation of canonical Git SQL declarations with an
 * already-sanitized provider-neutral database metadata envelope.
 *
 * The adapter's "complete" coverage currently means recognizable evidence;
 * expected:null does NOT establish a complete catalog inventory. This lens
 * never authenticates provider input, selects an active historical migration,
 * determines database execution permissions, or alters canonical authority.
 */
export const CAPTURED_CATALOG_COMPARISON = 'captured-catalog-candidates.v1';
export type CatalogComparisonKind =
  | 'candidate-signature-agreement'
  | 'candidate-signature-difference'
  | 'candidate-name-only'
  | 'source-without-observation'
  | 'observation-without-source'
  | 'incomparable';

export interface CatalogComparisonRow {
  sourceNodeId: string | null;
  sourcePath: string | null;
  observedRoutineId: string | null;
  qualifiedName: string;
  sourceSignature: string | null;
  observedIdentityArguments: string | null;
  comparison: CatalogComparisonKind;
  reason: string;
  /** No row establishes current environment state or an applied SQL body. */
  appliedFunctionProven: false;
  committedEffectProven: false;
}
const safeName = (s: unknown): string | null => typeof s === 'string'
  && /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$/u.test(s)
    ? s.toLowerCase() : null;
const normArgs = (s: unknown): string | null => {
  if (typeof s !== 'string' || !s.trim() || s.length > 2048 || s.includes('\0')) return null;
  // Deliberately conservative: do not rewrite PostgreSQL defaults, aliases,
  // type names, quoted identifiers or overloaded argument modes.
  if (/\bdefault\b|["']/iu.test(s)
    || !/^[A-Za-z0-9_.,()[\] \t]+$/u.test(s)) return null;
  return s.trim().replace(/\s+/gu, ' ').replace(/\s*,\s*/gu, ', ').toLowerCase();
};
const digest = (v: unknown): string => createHash('sha256')
  .update(JSON.stringify(v)).digest('hex');
const object = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const validIso = (s: string): boolean => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(s)
  && Number.isFinite(Date.parse(s));

interface SourceRoutine { id: string; path: string; signature: string | null; }
interface ObservedRoutine { id: string; signature: string | null; }

export function reconcileCapturedCatalog(input: {
  graph: IntelligenceGraph;
  /** Canonical schema-qualified name, not an unbound substring. */
  qualifiedName: string;
  /** Returned by the sanitized database-schema technical source adapter. */
  evidence: TechnicalEvidenceEnvelope;
  limit?: number;
  offset?: number;
  expectedDigest?: string;
}) {
  const { graph, evidence } = input;
  const qualifiedName = safeName(input.qualifiedName);
  if (!qualifiedName || !qualifiedName.includes('.')) {
    throw new Error('Exact schema-qualified SQL function identity required');
  }
  const limit = input.limit ?? 40, offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 20000) {
    throw new Error('Catalog comparison requires a bounded page');
  }
  if (typeof graph.repositoryRevision !== 'string'
    || !/^[0-9a-f]{40}$/iu.test(graph.repositoryRevision)
    || !graph.project || !graph.graphId || !graph.analyzerVersion) {
    throw new Error('Exact canonical graph identity required');
  }
  if (evidence.source.adapter !== 'database-schema') {
    throw new Error('Only sanitized database-schema observations are admissible');
  }
  if (evidence.observations.length > 20000 || graph.nodes.length > 200000) {
    throw new Error('Exceeds bounded catalog graph comparison; no absence proof');
  }

  const coverage = graph.coverage?.files ?? [];
  const sqlFiles = coverage.filter(f => /\.sql$/iu.test(f.path));
  const sqlComplete = sqlFiles.length > 0 && sqlFiles.every(f => f.status === 'complete');
  const completePaths = new Set(sqlFiles.filter(f => f.status === 'complete').map(f => f.path));
  const revisionReported = evidence.snapshot.sourceRevision;
  const reportedRevisionMatches = revisionReported === graph.repositoryRevision;
  // This is not independent attestation of the reported Git revision.
  const source: SourceRoutine[] = graph.nodes.filter(n => n.kind === 'sql-function'
    && safeName(object(n.value)?.qualifiedName ?? n.name) === qualifiedName)
    .map(n => {
      const path = n.sourceId.startsWith('repo:') ? n.sourceId.slice(5) : '';
      return { id: n.id, path, signature: normArgs(object(n.value)?.signature) };
    }).sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  const observed: ObservedRoutine[] = evidence.observations.filter(o => o.kind === 'database-function'
    && safeName(object(o.value)?.qualifiedName ?? o.name) === qualifiedName)
    .map(o => {
      const v = object(o.value), raw = object(v?.raw);
      const signature = normArgs(raw?.identity_arguments ?? raw?.identityArguments
        ?? raw?.signature ?? v?.identityArguments);
      // The upstream normalized database-function id is name-scoped, so
      // overloads must remain distinct by captured identity arguments.
      return { id: digest([o.id,o.locator,o.observedAt,signature]), signature };
    }).sort((a,b) => a.id.localeCompare(b.id));
  if (source.length > 1000 || observed.length > 1000 || source.length * observed.length > 10000) {
    throw new Error('Catalog candidate population exceeds bounded comparison; not proof of absence');
  }
  const ambiguousObservedIdentity = new Set(observed.map(o => o.id)).size !== observed.length;
  const usableObservation = !ambiguousObservedIdentity && evidence.availability.available
    && evidence.availability.httpStatus >= 200 && evidence.availability.httpStatus < 300
    && Boolean(evidence.snapshot.id) && validIso(evidence.snapshot.observedAt);
  const rows: CatalogComparisonRow[] = [];
  const makeRow = (s: SourceRoutine | null, o: ObservedRoutine | null,
    comparison: CatalogComparisonKind, reason: string): CatalogComparisonRow => ({
    sourceNodeId: s?.id ?? null, sourcePath: s?.path ?? null,
    observedRoutineId: o?.id ?? null, qualifiedName,
    sourceSignature: s?.signature ?? null,
    observedIdentityArguments: o?.signature ?? null,
    comparison, reason, appliedFunctionProven:false,
    committedEffectProven:false,
  });
  for (const s of source) {
    if (!observed.length) {
      rows.push(makeRow(s,null,'source-without-observation',
        'No matching provider metadata observed; incomplete inventory cannot establish absence'));
      continue;
    }
    for (const o of observed) {
      const comparable = sqlComplete && completePaths.has(s.path)
        && usableObservation && reportedRevisionMatches;
      const kind: CatalogComparisonKind = !comparable ? 'incomparable'
        : !s.signature || !o.signature ? 'candidate-name-only'
          : s.signature === o.signature
            ? 'candidate-signature-agreement' : 'candidate-signature-difference';
      rows.push(makeRow(s,o,kind,
        kind === 'candidate-signature-agreement'
          ? 'Historical source declaration and reported catalog identity arguments agree; body and active definition remain unknown'
          : kind === 'candidate-signature-difference'
            ? 'Reported catalog identity arguments differ from this historical declaration; do not infer current drift'
            : kind === 'candidate-name-only'
              ? 'Signature comparison unavailable; schema and function name alone cannot select a routine'
              : 'Source coverage, observation identity or reported revision is incomplete or mismatched'));
    }
  }
  if(!source.length) for (const o of observed) rows.push(makeRow(null,o,
    'observation-without-source','Reported database routine has no located source declaration; not proof of undocumented code'));
  rows.sort((a,b)=> (a.sourcePath??'').localeCompare(b.sourcePath??'')
    || (a.sourceNodeId??'').localeCompare(b.sourceNodeId??'')
    || (a.observedRoutineId??'').localeCompare(b.observedRoutineId??''));
  const projectionDigest = digest([graph.project,graph.repositoryRevision,graph.graphId,
    evidence.source.id,evidence.snapshot.id,evidence.snapshot.observedAt,qualifiedName,
    source,observed,rows]);
  if (input.expectedDigest !== undefined && input.expectedDigest !== projectionDigest) {
    throw new Error('Captured catalog page digest differs from requested evidence snapshot');
  }
  const page = rows.slice(offset, offset + limit);
  const graphNodes:GraphNode[] = [],graphEdges:GraphEdge[] = [];
  const overlayId = 'snapshot-catalog:' + projectionDigest.slice(0,32);
  const sourceIds = new Set(graph.nodes.map(n => n.id));
  for (const row of page) {
    if (!row.observedRoutineId) continue;
    const id = overlayId+':routine:'+row.observedRoutineId;
    if (!graphNodes.some(n => n.id === id)) graphNodes.push({
      id,sourceId:'external:'+evidence.source.id,kind:'captured-database-routine',
      locator:overlayId,name:qualifiedName,layer:'semantic',checkpoint:false,
      value:{qualifiedName,identityArguments:row.observedIdentityArguments,
        sourceRevisionReported:revisionReported,
        snapshotId:evidence.snapshot.id, freshness:evidence.snapshot.freshness,
        status:'reported-metadata-candidate'},raw:qualifiedName,
    });
    if (row.sourceNodeId && sourceIds.has(row.sourceNodeId)
      && row.comparison === 'candidate-signature-agreement') graphEdges.push({
      id:'captured-catalog-edge:'+digest([row.sourceNodeId,id]),
      from:row.sourceNodeId,to:id,kind:'candidate-catalog-signature',
      strategy:CAPTURED_CATALOG_COMPARISON,
      confidence:null,status:'candidate',layer:'semantic',checkpoint:false,
      evidence:[row.sourcePath??'unknown-source','catalog-signature-agreement-not-body-proof'],
    });
  }
  return {
    version:CAPTURED_CATALOG_COMPARISON,
    source:{project:graph.project,revision:graph.repositoryRevision,graphId:graph.graphId},
    capture:{
      providerSourceId:evidence.source.id,observationId:evidence.snapshot.id,
      observedAt:evidence.snapshot.observedAt,
      sourceObservedAt:evidence.snapshot.sourceObservedAt,
      reportedRevision:revisionReported,reportedRevisionMatches,
      freshness:evidence.snapshot.freshness,
      metadataRecognized:evidence.coverage.status === 'complete',
      inventoryComplete:false,
      // Freshness is a query-window signal, not historical invalidation.
      historicalCaptureExpiredByAge:false,
      currentEnvironmentEstablished:false,
    },
    coverage:{sourceSqlFiles:sqlFiles.length,sqlComplete,
      providerObservedCount:evidence.coverage.observed,
      providerExpectedCount:evidence.coverage.expected,
      providerInventoryExhaustive:false,
      ambiguousObservedRoutineIdentity:ambiguousObservedIdentity},
    population:{sourceCandidates:source.length,observedCandidates:observed.length,
      total:rows.length,returned:page.length,omitted:Math.max(0,rows.length-offset-page.length),
      offset,limit,hasNext:offset+page.length<rows.length,projectionDigest},
    rows:page,graphProjection:{nodes:graphNodes,edges:graphEdges,
      canonicalGraphUnchanged:true,onlyCandidateRelations:true},
    policy:{noExternalAccess:true,noSecondGraphAuthority:true,
      providerObservationNotAuthenticatedHere:true,
      noAppliedRoutineOrCommittedWriteProof:true,
      noNegativeAbsenceFromAdapterRecognition:true,
      exactSourceAndCatalogBodyEquivalenceNotEstablished:true,
      noRecurringSchedule:true,noTestDeletion:true},
  };
}
