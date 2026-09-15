export type ProjectCredential =
  | { type: 'none' }
  | { type: 'token-env'; tokenEnv: string; username?: string };

export interface RuntimeHeaderConfig {
  name: string;
  valueEnv: string;
}

export interface ProjectConfig {
  repository: string;
  defaultRef: string;
  allowedRefs?: string[];
  credential?: ProjectCredential;
  runtimeOrigins?: string[];
  runtimeHeaders?: RuntimeHeaderConfig[];
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
}

export interface NamingDivergence {
  resolutionId: string;
  fromObservationId: string;
  toObservationId: string;
  fromName: string;
  toName: string;
}

export interface ExplicitValueConflict {
  leftObservationId: string;
  rightObservationId: string;
  key: string;
  leftValue: unknown;
  rightValue: unknown;
}

export interface GraphCoverage {
  trackedFiles: number;
  eligibleFiles: number;
  analyzedFiles: number;
  skippedOversizedFiles: number;
  skippedNonRegularFiles: number;
}

export type GraphRole = 'A' | 'W' | 'B';

export interface IntelligenceGraph {
  schemaVersion: 1;
  graphId: string;
  project: string;
  role: GraphRole;
  createdAt: string;
  repositoryRevision: string | null;
  sourceFingerprint: string | null;
  sources: SourceDescriptor[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  namingDivergences: NamingDivergence[];
  explicitValueConflicts: ExplicitValueConflict[];
  unmatchedNodeIds: string[];
  unavailableSourceIds: string[];
  coverage?: GraphCoverage;
}

export interface GraphCheckpointMeta {
  type: 'meta';
  schemaVersion: 1;
  sourceFingerprint: string;
  summary: {
    nodes: number;
    edges: number;
    unresolved: number;
    candidate: number;
    kinds: Record<string, number>;
  };
}

// Compatibility aliases for analyzer internals and the public Parity lens. They do
// not represent separate storage or lifecycle owners.
export type Observation = GraphNode;
export type Resolution = GraphEdge;
export type ResolutionStatus = RelationshipStatus;
export type ParityScan = IntelligenceGraph;
