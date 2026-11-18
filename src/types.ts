export type ProjectCredential =
  | { type: 'none' }
  | { type: 'token-env'; tokenEnv: string; username?: string }
  | { type: 'github-app-env'; appIdEnv: string; privateKeyEnv: string; username?: string }
  | { type: 'github-app-bound'; binding: string };

export interface RuntimeHeaderConfig {
  name: string;
  valueEnv: string;
}

export type TechnicalSourceCapability = 'query' | 'logs' | 'metrics';
export type TechnicalSourceAdapterKind = 'generic-json' | 'deployment-state' | 'database-schema';

export interface TechnicalEvidenceObservation {
  id: string;
  kind: string;
  locator: string;
  name?: string;
  value: unknown;
  observedAt: string;
  sourceRevision?: string;
}

export interface TechnicalEvidenceRelationship {
  id: string;
  from: string;
  to: string;
  kind: string;
  status: 'resolved' | 'candidate';
  confidence: number;
  evidence: string[];
}

export interface TechnicalEvidenceCorrelation {
  externalId: string;
  repositoryTarget: string;
  kind: 'matches-revision' | 'matches-entity' | 'matches-provider';
  status: 'resolved';
  evidence: string[];
}

export interface TechnicalEvidenceEnvelope {
  sanitization: import('./intelligence/externalSanitization.js').RedactionSummary;
  source: {
    id: string;
    label: string;
    type: 'read-only-http';
    adapter: TechnicalSourceAdapterKind;
    capability: TechnicalSourceCapability;
    endpoint: string;
    providerId?: string;
  };
  snapshot: {
    id: string | null;
    sourceRevision: string | null;
    observedAt: string;
    sourceObservedAt: string | null;
    freshness: 'fresh' | 'stale' | 'unknown';
    ageMs: number | null;
  };
  availability: {
    available: boolean;
    httpStatus: number;
  };
  coverage: {
    status: 'complete' | 'partial' | 'unavailable' | 'unknown';
    observed: number;
    expected: number | null;
    reason?: string;
  };
  observations: TechnicalEvidenceObservation[];
  relationships: TechnicalEvidenceRelationship[];
  correlations: TechnicalEvidenceCorrelation[];
  correlationStatus: {
    attempted: boolean;
    available: boolean;
    error?: string;
  };
  raw: unknown;
}

export interface TechnicalSourceConfig {
  id: string;
  label?: string;
  type: 'read-only-http';
  endpoint: string;
  capabilities: TechnicalSourceCapability[];
  adapter?: TechnicalSourceAdapterKind;
  providerId?: string;
  freshnessMs?: number;
  headers?: RuntimeHeaderConfig[];
  timeoutMs?: number;
}

export interface ProjectConfig {
  repository: string;
  defaultRef: string;
  allowedRefs?: string[];
  revisionPolicy?: 'allowlisted' | 'repository-history';
  credential?: ProjectCredential;
  runtimeOrigins?: string[];
  runtimeHeaders?: RuntimeHeaderConfig[];
  technicalSources?: TechnicalSourceConfig[];
}

export interface ProjectRegistry {
  [project: string]: ProjectConfig;
}

export interface SourceDescriptor {
  id: string;
  kind: string;
  locator: string;
  revision: string | null;
  observedAt: string;
  available: boolean;
  error?: string;
  warnings?: string[];
}

export type GraphNodeLayer = 'semantic' | 'structural' | 'representation';

export interface EvidenceRecord {
  id: string;
  sourceId: string;
  kind: string;
  locator: string;
  message?: string;
  field?: string;
  value?: unknown;
}

/** Membership is built from the selected graph. The family id is an existing
 * graph subject; via identifies the relationships that make the node a member. */
export interface GraphFamilyMembership {
  id: string;
  roles: string[];
  via: string[];
}

/** Producer identities enrich the same source subject without replacing it. */
export interface GraphProducerContribution {
  producer: string;
  version: string;
  symbol: string;
  locator: string;
}

export interface GraphNode {
  id: string;
  sourceId: string;
  kind: string;
  locator: string;
  field?: string;
  name?: string;
  value: unknown;
  /** Distinct captured source text; omitted when it only repeats name/value. */
  raw?: string;
  tags?: string[];
  layer?: GraphNodeLayer;
  checkpoint?: boolean;
  evidenceIds?: string[];
  families?: GraphFamilyMembership[];
  contributions?: GraphProducerContribution[];
}

export type RelationshipStatus = 'resolved' | 'candidate' | 'unresolved';

export interface GraphEdge {
  id: string;
  from: string | null;
  to: string | null;
  kind: string;
  strategy: string;
  confidence: number | null;
  status: RelationshipStatus;
  evidence: string[];
  layer?: GraphNodeLayer;
  checkpoint?: boolean;
  evidenceIds?: string[];
}

export interface NamingDivergence {
  resolutionId: string;
  fromObservationId: string;
  toObservationId: string;
  fromName: string;
  toName: string;
}

export interface ExplicitValueConflict {
  entityId: string;
  leftSourceId: string;
  rightSourceId: string;
  key: string;
  leftValue: unknown;
  rightValue: unknown;
  /** Explicit same-claim reconciliation, not silent evidence deletion. */
  resolution?: 'higher-source-proof-preferred' | 'contested';
  preferredEvidenceIds?: string[];
}

export type GraphCoverageStatus = 'complete' | 'partial' | 'unsupported' | 'skipped' | 'failed';

export interface GraphCoverageFile {
  path: string;
  status: GraphCoverageStatus;
  contentSha256?: string;
  reason?: string;
}

export interface GraphCoverage {
  trackedFiles: number;
  eligibleFiles: number;
  analyzedFiles: number;
  completeFiles: number;
  partialFiles: number;
  unsupportedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  skippedOversizedFiles: number;
  skippedNonRegularFiles: number;
  skippedFileLimitFiles: number;
  files: GraphCoverageFile[];
}

export type GraphRole = 'A' | 'W' | 'B';

export interface GraphRelationshipCoverage {
  relationshipKind: string;
  subjectId: string;
  direction: 'inbound' | 'outbound';
  complete: boolean;
  allTargets?: boolean;
  comparisonIds?: string[];
  basis: string;
  evidenceIds?: string[];
}

export const GRAPH_SCHEMA_VERSION = 2 as const;

export interface IntelligenceGraph {
  schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  analyzerVersion: string;
  graphId: string;
  project: string;
  role: GraphRole;
  createdAt: string;
  repositoryRevision: string | null;
  /** Working copies have their own content identity; HEAD is context, not their revision. */
  sourceState?: { kind: 'working-tree'; headRevision: string };
  sourceFingerprint: string | null;
  topologyFingerprint: string | null;
  evidenceFingerprint: string | null;
  sources: SourceDescriptor[];
  evidence: EvidenceRecord[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  namingDivergences: NamingDivergence[];
  explicitValueConflicts: ExplicitValueConflict[];
  unmatchedNodeIds: string[];
  unavailableSourceIds: string[];
  coverage?: GraphCoverage;
  producerCoverage?: Array<{
    producer: string;
    state: 'complete' | 'partial' | 'failed';
    version?: string;
    indexSha256?: string;
    documents?: number;
    matchedDocuments?: number;
    skippedDocuments?: number;
    unindexedSourcePaths?: string[];
    definitions?: number;
    references?: number;
    reason?: string;
  }>;
  relationshipCoverage?: GraphRelationshipCoverage[];
}

export interface GraphCheckpointSummary {
  nodes: number;
  edges: number;
  unresolved: number;
  candidate: number;
  kinds: Record<string, number>;
}

export interface GraphCheckpointMetaV1 {
  type: 'meta';
  schemaVersion: 1;
  format: 'sharded-ndjson';
  sourceFingerprint: string;
  shards: string[];
  summary: GraphCheckpointSummary;
}

export interface GraphCheckpointMetaV2 {
  type: 'meta';
  schemaVersion: 2;
  format: 'sharded-ndjson';
  analyzerVersion: string;
  sourceFingerprint: string;
  topologyFingerprint: string;
  evidenceFingerprint: string;
  shards: string[];
  summary: GraphCheckpointSummary;
}

export type GraphCheckpointMeta = GraphCheckpointMetaV1 | GraphCheckpointMetaV2;

// Compatibility aliases for analyzer internals and the public Parity lens. They do
// not represent separate storage or lifecycle owners.
export type Observation = GraphNode;
export type Resolution = GraphEdge;
export type ResolutionStatus = RelationshipStatus;
export type ParityScan = IntelligenceGraph;

export type ParityExpectationRequirement = 'required' | 'forbidden';
export type ParityExpectationResultStatus = 'satisfied' | 'missing' | 'forbidden-present' | 'unproven' | 'not-applicable';

export interface ParityEntityExpectation {
  id: string;
  requirement?: ParityExpectationRequirement;
  rationale?: string;
}

export interface ParityRelationshipExpectation {
  from: string;
  kind: string;
  to: string;
  requirement?: ParityExpectationRequirement;
  rationale?: string;
}

export interface ParityNodeSelector {
  ids?: string[];
  kinds?: string[];
  layers?: GraphNodeLayer[];
  sourceIds?: string[];
}

export interface ParityReachabilityPredicate {
  id: string;
  type: 'reachability';
  from: ParityNodeSelector;
  to: ParityNodeSelector;
  requirement?: ParityExpectationRequirement;
  quantifier?: 'any' | 'all';
  direction?: 'outbound' | 'inbound';
  relationshipKinds?: string[];
  maxDepth?: number;
  /** Caller-defined bounded source claim; not repository-wide negative proof. */
  scopeSourceIds?: string[];
  rationale?: string;
  originalClaim?: string;
}

export interface ParityContract {
  version: 1;
  name?: string;
  description?: string;
  entities?: ParityEntityExpectation[];
  relationships?: ParityRelationshipExpectation[];
  predicates?: ParityReachabilityPredicate[];
}
