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

export interface ProjectGeneration {
  generation: string;
  sha: string;
  worktree: string;
  cbmProject: string;
  indexedAt: string;
}

export interface ProjectState {
  project: string;
  repository: string;
  ref: string;
  selectedSha: string | null;
  selectedGeneration: string | null;
  selectedWorktree: string | null;
  selectedCbmProject: string | null;
  indexedAt: string | null;
  refreshedAt: string | null;
  lastFetchAt: string | null;
  lastError?: string | null;
  generations?: ProjectGeneration[];
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

export interface Observation {
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

export type ResolutionStatus = 'resolved' | 'candidate' | 'unresolved';

export interface Resolution {
  id: string;
  from: string | null;
  to: string | null;
  kind: string;
  strategy: string;
  confidence: number | null;
  status: ResolutionStatus;
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

export interface ParityScan {
  scanId: string;
  project: string;
  createdAt: string;
  repositoryRevision: string | null;
  sources: SourceDescriptor[];
  observations: Observation[];
  resolutions: Resolution[];
  namingDivergences: NamingDivergence[];
  explicitValueConflicts: ExplicitValueConflict[];
  unmatchedObservationIds: string[];
  unavailableSourceIds: string[];
}
