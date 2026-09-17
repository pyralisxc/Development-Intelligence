import type {
  GraphCoverage,
  GraphEdge,
  IntelligenceGraph,
  ParityContract,
  ParityEntityExpectation,
  ParityExpectationRequirement,
  ParityExpectationResultStatus,
  ParityRelationshipExpectation,
} from '../types.js';
import { currentGraph } from './service.js';

const MAX_EXPECTATIONS = 200;
const MAX_TEXT_LENGTH = 500;

function cleanText(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const cleaned = value.trim();
  if (required && !cleaned) throw new Error(`${field} must be non-empty`);
  if (cleaned.length > MAX_TEXT_LENGTH) throw new Error(`${field} exceeds ${MAX_TEXT_LENGTH} characters`);
  return cleaned || undefined;
}

function requirement(value: unknown, field: string): ParityExpectationRequirement {
  if (value === undefined) return 'required';
  if (value !== 'required' && value !== 'forbidden') throw new Error(`${field} must be required or forbidden`);
  return value;
}

function normalizeEntity(value: unknown, index: number): ParityEntityExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`contract.entities[${index}] must be an object`);
  const record = value as Record<string, unknown>;
  const rationale = cleanText(record.rationale, `contract.entities[${index}].rationale`);
  return {
    id: cleanText(record.id, `contract.entities[${index}].id`, true)!,
    requirement: requirement(record.requirement, `contract.entities[${index}].requirement`),
    ...(rationale ? { rationale } : {}),
  };
}

function normalizeRelationship(value: unknown, index: number): ParityRelationshipExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`contract.relationships[${index}] must be an object`);
  const record = value as Record<string, unknown>;
  const rationale = cleanText(record.rationale, `contract.relationships[${index}].rationale`);
  return {
    from: cleanText(record.from, `contract.relationships[${index}].from`, true)!,
    kind: cleanText(record.kind, `contract.relationships[${index}].kind`, true)!,
    to: cleanText(record.to, `contract.relationships[${index}].to`, true)!,
    requirement: requirement(record.requirement, `contract.relationships[${index}].requirement`),
    ...(rationale ? { rationale } : {}),
  };
}

export function normalizeParityContract(value: unknown): ParityContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('contract must be an object');
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error('contract.version must be 1');
  const entities = record.entities === undefined ? [] : record.entities;
  const relationships = record.relationships === undefined ? [] : record.relationships;
  if (!Array.isArray(entities)) throw new Error('contract.entities must be an array');
  if (!Array.isArray(relationships)) throw new Error('contract.relationships must be an array');
  if (entities.length + relationships.length === 0) throw new Error('contract must contain at least one entity or relationship expectation');
  if (entities.length > MAX_EXPECTATIONS || relationships.length > MAX_EXPECTATIONS || entities.length + relationships.length > MAX_EXPECTATIONS) {
    throw new Error(`contract exceeds ${MAX_EXPECTATIONS} expectations`);
  }
  const name = cleanText(record.name, 'contract.name');
  const description = cleanText(record.description, 'contract.description');
  return {
    version: 1,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(entities.length ? { entities: entities.map(normalizeEntity) } : {}),
    ...(relationships.length ? { relationships: relationships.map(normalizeRelationship) } : {}),
  };
}

function coverageSupportsNegative(coverage: GraphCoverage | undefined): boolean {
  return Boolean(coverage
    && coverage.failedFiles === 0
    && coverage.partialFiles === 0
    && coverage.skippedFiles === 0
    && coverage.analyzedFiles === coverage.eligibleFiles);
}

function negativeStatus(complete: boolean, requirementValue: ParityExpectationRequirement): ParityExpectationResultStatus {
  if (!complete) return 'unproven';
  return requirementValue === 'required' ? 'missing' : 'satisfied';
}

function evaluateEntity(graph: IntelligenceGraph, expectation: ParityEntityExpectation, complete: boolean) {
  const requirementValue = expectation.requirement ?? 'required';
  const observed = graph.nodes.find(node => node.id === expectation.id) ?? null;
  const status: ParityExpectationResultStatus = observed
    ? requirementValue === 'required' ? 'satisfied' : 'forbidden-present'
    : negativeStatus(complete, requirementValue);
  return {
    type: 'entity' as const,
    expectation,
    status,
    observed,
    explanation: observed
      ? requirementValue === 'required' ? 'The expected entity is present.' : 'A forbidden entity is present.'
      : status === 'unproven' ? 'The entity was not observed, but coverage is incomplete so absence is not proven.'
        : requirementValue === 'required' ? 'The required entity was not observed.' : 'The forbidden entity was not observed.',
  };
}

function edgeMatches(edge: GraphEdge, expectation: ParityRelationshipExpectation): boolean {
  return edge.from === expectation.from && edge.kind === expectation.kind && edge.to === expectation.to;
}

function evaluateRelationship(graph: IntelligenceGraph, expectation: ParityRelationshipExpectation, complete: boolean) {
  const requirementValue = expectation.requirement ?? 'required';
  const observed = graph.edges.filter(edge => edgeMatches(edge, expectation));
  const resolved = observed.filter(edge => edge.status === 'resolved');
  const tentative = observed.filter(edge => edge.status !== 'resolved');
  let status: ParityExpectationResultStatus;
  if (resolved.length) status = requirementValue === 'required' ? 'satisfied' : 'forbidden-present';
  else if (tentative.length) status = 'unproven';
  else status = negativeStatus(complete, requirementValue);
  return {
    type: 'relationship' as const,
    expectation,
    status,
    observed,
    explanation: resolved.length
      ? requirementValue === 'required' ? 'The required relationship is resolved.' : 'A forbidden relationship is resolved.'
      : tentative.length ? 'The relationship has candidate or unresolved evidence but is not proven.'
        : status === 'unproven' ? 'The relationship was not observed, but coverage is incomplete so absence is not proven.'
          : requirementValue === 'required' ? 'The required relationship was not observed.' : 'The forbidden relationship was not observed.',
  };
}

export function evaluateParityContractGraph(graph: IntelligenceGraph, contractInput: unknown): Record<string, unknown> {
  const contract = normalizeParityContract(contractInput);
  const complete = coverageSupportsNegative(graph.coverage);
  const results = [
    ...(contract.entities ?? []).map(item => evaluateEntity(graph, item, complete)),
    ...(contract.relationships ?? []).map(item => evaluateRelationship(graph, item, complete)),
  ];
  const counts = { satisfied: 0, missing: 0, forbiddenPresent: 0, unproven: 0 };
  for (const result of results) {
    if (result.status === 'satisfied') counts.satisfied += 1;
    else if (result.status === 'missing') counts.missing += 1;
    else if (result.status === 'forbidden-present') counts.forbiddenPresent += 1;
    else counts.unproven += 1;
  }
  return {
    project: graph.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    topologyFingerprint: graph.topologyFingerprint,
    contract,
    passed: counts.missing === 0 && counts.forbiddenPresent === 0 && counts.unproven === 0,
    counts,
    results,
    coverage: graph.coverage ?? null,
    note: 'This caller-owned expectation overlay is evaluated ephemerally. It does not modify or become accepted graph truth.',
  };
}

export async function evaluateParityContract(input: {
  project: string;
  ref?: string | undefined;
  graphId?: string | undefined;
  contract: unknown;
}): Promise<Record<string, unknown>> {
  const graph = await currentGraph(input.project, input.ref, input.graphId);
  return evaluateParityContractGraph(graph, input.contract);
}
