import type { SourceDescriptor } from '../types.js';

export type InterfaceRuntimeObservationPlane =
  | 'dom'
  | 'accessibility'
  | 'geometry'
  | 'interaction'
  | 'network'
  | 'console';

export type InterfaceRuntimeCorrelationStatus = 'resolved' | 'candidate' | 'unresolved';

export interface InterfaceRuntimeObservationEnvelope {
  version: 1;
  plane: 'interface-runtime';
  source: {
    id: string;
    kind: string;
    provider?: string;
  };
  identity: {
    project: string;
    repositoryRevision: string | null;
    deploymentId: string | null;
    environment: string | null;
    route: string | null;
    url: string;
    viewport: {
      width: number;
      height: number;
      deviceScaleFactor: number | null;
    } | null;
    sessionClass: string | null;
  };
  observedAt: string;
  observations: Array<{
    id: string;
    plane: InterfaceRuntimeObservationPlane;
    locator: string;
    value: unknown;
  }>;
  correlations: Array<{
    observationId: string;
    sourceEntityId: string | null;
    status: InterfaceRuntimeCorrelationStatus;
    strategy: string;
    evidence: string[];
  }>;
}

export function isInterfaceRuntimeObservationSource(source: SourceDescriptor): boolean {
  return source.kind === 'runtime-http'
    || source.kind === 'runtime-browser'
    || source.kind === 'browser-observation'
    || source.id.startsWith('runtime:');
}

export function interfaceRuntimeObservationContract(): Record<string, unknown> {
  return {
    version: 1,
    plane: 'interface-runtime',
    providerNeutral: true,
    identity: {
      project: 'required',
      repositoryRevision: 'exact-sha-or-null',
      deploymentId: 'provider-neutral-id-or-null',
      environment: 'bounded-label-or-null',
      route: 'route-or-null',
      url: 'required',
      viewport: 'width-height-device-scale-or-null',
      sessionClass: 'non-identifying-bounded-label-or-null',
    },
    observationPlanes: ['dom', 'accessibility', 'geometry', 'interaction', 'network', 'console'],
    observationExamples: [
      'rendered-element',
      'visibility',
      'bounds',
      'stacking',
      'scroll-owner',
      'pointer-owner',
      'focus-owner',
      'accessibility-fact',
      'action-state-transition',
      'network-anomaly',
      'console-anomaly',
    ],
    correlation: {
      statuses: ['resolved', 'candidate', 'unresolved'],
      sourceEntityIdRequiredForResolved: true,
      exactRepositoryRevisionRequiredForResolved: true,
      strategyAndEvidenceRequired: true,
      nameOnlyCrossPlaneResolutionAllowed: false,
    },
    retention: {
      boundedObservations: true,
      rawHighCardinalityTelemetryRetainedByDefault: false,
    },
    authority: {
      semanticAuthority: false,
      productIntent: false,
      runtimeObservationIsEvidence: true,
      persistedByThisProjection: false,
    },
  };
}
