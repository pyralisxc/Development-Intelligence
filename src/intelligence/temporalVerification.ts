import type {
  GraphEdge,
  GraphNode,
  GraphNodeLayer,
  IntelligenceGraph,
  ParityContract,
  ParityEntityExpectation,
  ParityRelationshipExpectation,
  RelationshipStatus,
} from '../types.js';
import { resolveProjectRevision, revisionIdentity } from '../source/git.js';
import { analyzeImpact, diffGraphs } from './query.js';
import { evaluateParityContractGraph, normalizeParityContract } from './parityContract.js';
import { graphContext } from './service.js';

export interface TransitionExpectationContract {
  version: 1;
  name?: string;
  description?: string;
  head?: ParityContract;
  preserve?: ParityContract;
}

interface ContractResult {
  type: 'entity' | 'relationship';
  expectation: ParityEntityExpectation | ParityRelationshipExpectation;
  status: 'satisfied' | 'missing' | 'forbidden-present' | 'unproven';
  observed: unknown;
  explanation: string;
}

function cleanText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (text.length > 500) throw new Error(`${field} exceeds 500 characters`);
  return text || undefined;
}

export function normalizeTransitionContract(value: unknown): TransitionExpectationContract | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('contract must be an object');
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error('contract.version must be 1');
  if (record.head === undefined && record.preserve === undefined) throw new Error('contract must include head and/or preserve expectations');
  const name = cleanText(record.name, 'contract.name');
  const description = cleanText(record.description, 'contract.description');
  return {
    version: 1,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(record.head === undefined ? {} : { head: normalizeParityContract(record.head) }),
    ...(record.preserve === undefined ? {} : { preserve: normalizeParityContract(record.preserve) }),
  };
}

function resultKey(result: ContractResult): string {
  if (result.type === 'entity') return `entity:${(result.expectation as ParityEntityExpectation).id}`;
  const item = result.expectation as ParityRelationshipExpectation;
  return `relationship:${item.from}\u0000${item.kind}\u0000${item.to}`;
}

function relationshipKey(item: Pick<GraphEdge, 'from' | 'kind' | 'to'>): string {
  return `${item.from ?? ''}\u0000${item.kind}\u0000${item.to ?? ''}`;
}

function expectationSurface(contract: TransitionExpectationContract | null) {
  const nodes = new Set<string>();
  const relationships = new Set<string>();
  for (const part of [contract?.head, contract?.preserve]) {
    for (const item of part?.entities ?? []) nodes.add(item.id);
    for (const item of part?.relationships ?? []) relationships.add(relationshipKey(item));
  }
  return { nodes, relationships };
}

function parity(graph: IntelligenceGraph, contract?: ParityContract): Record<string, unknown> | null {
  return contract ? evaluateParityContractGraph(graph, contract) : null;
}

function results(value: Record<string, unknown> | null): ContractResult[] {
  return Array.isArray(value?.results) ? value.results as ContractResult[] : [];
}

function classifyHead(value: Record<string, unknown> | null) {
  const classified = {
    expectedAndObserved: [] as ContractResult[],
    satisfiedAbsence: [] as ContractResult[],
    expectedButMissing: [] as ContractResult[],
    forbiddenButObserved: [] as ContractResult[],
    unproven: [] as ContractResult[],
  };
  for (const item of results(value)) {
    const requirement = item.expectation.requirement ?? 'required';
    if (item.status === 'unproven') classified.unproven.push(item);
    else if (item.status === 'missing') classified.expectedButMissing.push(item);
    else if (item.status === 'forbidden-present') classified.forbiddenButObserved.push(item);
    else if (requirement === 'forbidden') classified.satisfiedAbsence.push(item);
    else classified.expectedAndObserved.push(item);
  }
  return classified;
}

function classifyInvariants(baseValue: Record<string, unknown> | null, headValue: Record<string, unknown> | null) {
  const headByKey = new Map(results(headValue).map(item => [resultKey(item), item]));
  const classified = {
    preserved: [] as Array<{ base: ContractResult; head: ContractResult }>,
    broken: [] as Array<{ base: ContractResult; head: ContractResult | null }>,
    unproven: [] as Array<{ base: ContractResult; head: ContractResult | null }>,
    notEstablishedAtBase: [] as Array<{ base: ContractResult; head: ContractResult | null }>,
  };
  for (const base of results(baseValue)) {
    const head = headByKey.get(resultKey(base)) ?? null;
    if (base.status === 'unproven' || head?.status === 'unproven') classified.unproven.push({ base, head });
    else if (base.status !== 'satisfied') classified.notEstablishedAtBase.push({ base, head });
    else if (head?.status === 'satisfied') classified.preserved.push({ base, head });
    else classified.broken.push({ base, head });
  }
  return classified;
}

function nodeSummary(node: GraphNode) {
  return { id: node.id, kind: node.kind, layer: node.layer ?? 'structural', locator: node.locator, name: node.name ?? null };
}
function edgeSummary(edge: GraphEdge) {
  return { id: edge.id, from: edge.from, kind: edge.kind, to: edge.to, layer: edge.layer ?? 'structural', status: edge.status, strategy: edge.strategy };
}

function unexpectedChanges(diff: any, surface: { nodes: Set<string>; relationships: Set<string> }) {
  const nodes = [
    ...(diff.nodes?.added ?? []).filter((item: GraphNode) => !surface.nodes.has(item.id)).map((item: GraphNode) => ({ change: 'added', ...nodeSummary(item) })),
    ...(diff.nodes?.removed ?? []).filter((item: GraphNode) => !surface.nodes.has(item.id)).map((item: GraphNode) => ({ change: 'removed', ...nodeSummary(item) })),
    ...(diff.nodes?.changed ?? []).filter((item: { before: GraphNode; after: GraphNode }) => !surface.nodes.has(item.after.id)).map((item: { before: GraphNode; after: GraphNode }) => ({ change: 'changed', id: item.after.id, before: nodeSummary(item.before), after: nodeSummary(item.after) })),
  ];
  const edges = [
    ...(diff.edges?.added ?? []).filter((item: GraphEdge) => !surface.relationships.has(relationshipKey(item))).map((item: GraphEdge) => ({ change: 'added', ...edgeSummary(item) })),
    ...(diff.edges?.removed ?? []).filter((item: GraphEdge) => !surface.relationships.has(relationshipKey(item))).map((item: GraphEdge) => ({ change: 'removed', ...edgeSummary(item) })),
    ...(diff.edges?.changed ?? []).filter((item: { before: GraphEdge; after: GraphEdge }) => !surface.relationships.has(relationshipKey(item.after))).map((item: { before: GraphEdge; after: GraphEdge }) => ({ change: 'changed', id: item.after.id, before: edgeSummary(item.before), after: edgeSummary(item.after) })),
  ];
  return { nodes, edges };
}

function issueItems(head: ReturnType<typeof classifyHead>, invariants: ReturnType<typeof classifyInvariants>) {
  return [
    ...head.expectedButMissing.map(item => ({ kind: 'expected-but-missing', item })),
    ...head.forbiddenButObserved.map(item => ({ kind: 'forbidden-but-observed', item })),
    ...head.unproven.map(item => ({ kind: 'unproven-head-expectation', item })),
    ...invariants.broken.map(item => ({ kind: 'broken-invariant', item })),
    ...invariants.unproven.map(item => ({ kind: 'unproven-invariant', item })),
    ...invariants.notEstablishedAtBase.map(item => ({ kind: 'invariant-not-established-at-base', item })),
  ];
}

export async function verifyTransition(input: {
  project: string;
  baseRef: string;
  ref: string;
  contract?: unknown;
  layers?: GraphNodeLayer[];
  direction?: 'inbound' | 'outbound' | 'both';
  depth?: number;
  relationshipKinds?: string[];
  statuses?: RelationshipStatus[];
  limit?: number;
}): Promise<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const contract = normalizeTransitionContract(input.contract);
  const [baseRevision, headRevision] = await Promise.all([
    resolveProjectRevision(input.project, input.baseRef),
    resolveProjectRevision(input.project, input.ref),
  ]);
  const exactBaseRef = `commit:${baseRevision.sha}`;
  const exactHeadRef = `commit:${headRevision.sha}`;
  const [base, head, impact] = await Promise.all([
    graphContext(input.project, { ref: exactBaseRef }),
    graphContext(input.project, { ref: exactHeadRef }),
    analyzeImpact({
      project: input.project,
      baseRef: exactBaseRef,
      ref: exactHeadRef,
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.depth === undefined ? {} : { depth: input.depth }),
      ...(input.relationshipKinds?.length ? { relationshipKinds: input.relationshipKinds } : {}),
      ...(input.statuses?.length ? { statuses: input.statuses } : {}),
      ...(input.layers?.length ? { layers: input.layers } : {}),
      limit,
    }),
  ]);
  if (base.graph.repositoryRevision !== baseRevision.sha || head.graph.repositoryRevision !== headRevision.sha) {
    throw new Error('Repository revision changed while preparing transition verification');
  }

  const diff = diffGraphs(base.graph, head.graph, input.layers) as any;
  const headEvaluation = parity(head.graph, contract?.head);
  const preserveBaseEvaluation = parity(base.graph, contract?.preserve);
  const preserveHeadEvaluation = parity(head.graph, contract?.preserve);
  const headClassification = classifyHead(headEvaluation);
  const invariants = classifyInvariants(preserveBaseEvaluation, preserveHeadEvaluation);
  const unexpected = unexpectedChanges(diff, expectationSurface(contract));
  const issues = issueItems(headClassification, invariants);
  const changedFiles = Array.isArray((impact as any).changedFiles) ? (impact as any).changedFiles : [];
  const beforePaths = Array.isArray((impact as any).beforeImpact?.paths) ? (impact as any).beforeImpact.paths as string[] : [];
  const afterPaths = Array.isArray((impact as any).afterImpact?.paths) ? (impact as any).afterImpact.paths as string[] : [];
  const affectedPaths = [...new Set([...beforePaths, ...afterPaths])].sort();
  const unexpectedTotal = unexpected.nodes.length + unexpected.edges.length;

  return {
    project: input.project,
    comparisonMode: 'current-analyzer-replay',
    base: {
      graphId: base.graph.graphId,
      revision: base.graph.repositoryRevision,
      identity: revisionIdentity(baseRevision),
      analyzerVersion: base.graph.analyzerVersion,
      schemaVersion: base.graph.schemaVersion,
      topologyFingerprint: base.graph.topologyFingerprint,
      evidenceFingerprint: base.graph.evidenceFingerprint,
      coverage: base.graph.coverage ?? null,
    },
    head: {
      graphId: head.graph.graphId,
      revision: head.graph.repositoryRevision,
      identity: revisionIdentity(headRevision),
      analyzerVersion: head.graph.analyzerVersion,
      schemaVersion: head.graph.schemaVersion,
      topologyFingerprint: head.graph.topologyFingerprint,
      evidenceFingerprint: head.graph.evidenceFingerprint,
      coverage: head.graph.coverage ?? null,
    },
    delta: {
      topologyChanged: diff.topologyChanged,
      evidenceChanged: diff.evidenceChanged,
      analyzerChanged: diff.analyzerChanged,
      nodes: diff.nodes,
      edges: diff.edges,
      changedFiles,
      changedFileCount: changedFiles.length,
    },
    impact: {
      mapping: (impact as any).mapping ?? null,
      before: (impact as any).beforeImpact ?? null,
      after: (impact as any).afterImpact ?? null,
    },
    expectations: contract ? {
      contract,
      head: headClassification,
      invariants,
      counts: {
        expectedAndObserved: headClassification.expectedAndObserved.length,
        satisfiedAbsence: headClassification.satisfiedAbsence.length,
        expectedButMissing: headClassification.expectedButMissing.length,
        forbiddenButObserved: headClassification.forbiddenButObserved.length,
        unprovenHead: headClassification.unproven.length,
        preservedInvariants: invariants.preserved.length,
        brokenInvariants: invariants.broken.length,
        unprovenInvariants: invariants.unproven.length,
        invariantsNotEstablishedAtBase: invariants.notEstablishedAtBase.length,
      },
      contractSatisfied: issues.length === 0,
    } : null,
    unexpectedChanges: {
      nodeTotal: unexpected.nodes.length,
      edgeTotal: unexpected.edges.length,
      total: unexpectedTotal,
      nodes: unexpected.nodes.slice(0, limit),
      edges: unexpected.edges.slice(0, limit),
      truncated: unexpected.nodes.length > limit || unexpected.edges.length > limit,
      note: contract
        ? 'Changes outside caller-declared head expectations and preserved-invariant surfaces are review candidates, not automatically defects.'
        : 'No expectation contract was supplied, so every observed graph delta remains an unexpected/review change.',
    },
    reviewSurface: {
      changedFiles: changedFiles.slice(0, limit),
      affectedPaths: affectedPaths.slice(0, limit),
      expectationIssues: issues.slice(0, limit),
      unexpectedNodes: unexpected.nodes.slice(0, limit),
      unexpectedEdges: unexpected.edges.slice(0, limit),
      truncated: changedFiles.length > limit || affectedPaths.length > limit || issues.length > limit || unexpected.nodes.length > limit || unexpected.edges.length > limit,
    },
    policy: {
      persisted: false,
      acceptedCheckpointAffected: false,
      modifiesRepository: false,
      approvesMerge: false,
      futurePrediction: false,
      note: 'Transition verification is an ephemeral evidence projection. It compares two actual immutable revisions and caller-owned expectations; it does not approve product intent or mutate graph authority.',
    },
  };
}
