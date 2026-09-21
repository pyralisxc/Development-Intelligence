export type ProjectCredential =
  | { type: 'none' }
  | { type: 'token-env'; tokenEnv: string; username?: string }
  | { type: 'github-app-env'; appIdEnv: string; privateKeyEnv: string; username?: string };

export interface RuntimeHeaderConfig {
  name: string;
  valueEnv: string;
}

export type TechnicalSourceCapability = 'query' | 'logs' | 'metrics';

export interface TechnicalSourceConfig {
  id: string;
  label?: string;
  type: 'read-only-http';
  endpoint: string;
  capabilities: TechnicalSourceCapability[];
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

export interface GraphNode {
  id: string;
  sourceId: string;
  kind: string;
  locator: string;
  field?: string;
  name?: string;
  value: unknown;
  raw: string;
  tags?: string[];
  layer?: GraphNodeLayer;
  checkpoint?: boolean;
  evidenceIds?: string[];
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
}

export type GraphCoverageStatus = 'complete' | 'partial' | 'unsupported' | 'skipped' | 'failed';

export interface GraphCoverageFile {
  path: string;
  status: GraphCoverageStatus;
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

export interface IntelligenceGraph {
  schemaVersion: 2;
  analyzerVersion: string;
  graphId: string;
  project: string;
  role: GraphRole;
  createdAt: string;
  repositoryRevision: string | null;
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
export type ParityExpectationResultStatus = 'satisfied' | 'missing' | 'forbidden-present' | 'unproven';

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

export interface ParityContract {
  version: 1;
  name?: string;
  description?: string;
  entities?: ParityEntityExpectation[];
  relationships?: ParityRelationshipExpectation[];
}
