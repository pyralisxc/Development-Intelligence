import type {
  GraphCoverage,
  GraphEdge,
  IntelligenceGraph,
  ParityContract,
  ParityEntityExpectation,
  ParityExpectationRequirement,
  ParityExpectationResultStatus,
  ParityNodeSelector,
  ParityReachabilityPredicate,
  ParityRelationshipExpectation,
} from '../types.js';
import { currentGraph } from './service.js';

const MAX_EXPECTATIONS = 200;
const MAX_TEXT_LENGTH = 500;
const MAX_SELECTOR_VALUES = 200;
const MAX_DEPTH = 20;

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

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > MAX_SELECTOR_VALUES) throw new Error(`${field} exceeds ${MAX_SELECTOR_VALUES} values`);
  const normalized = value.map((item, index) => cleanText(item, `${field}[${index}]`, true)!);
  return [...new Set(normalized)];
}

function normalizeSelector(value: unknown, field: string): ParityNodeSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  const ids = stringList(record.ids, `${field}.ids`);
  const kinds = stringList(record.kinds, `${field}.kinds`);
  const sourceIds = stringList(record.sourceIds, `${field}.sourceIds`);
  const layers = stringList(record.layers, `${field}.layers`);
  if (layers?.some(layer => !['semantic', 'structural', 'representation'].includes(layer))) {
    throw new Error(`${field}.layers must contain semantic, structural, or representation`);
  }
  if (!ids?.length && !kinds?.length && !layers?.length && !sourceIds?.length) {
    throw new Error(`${field} must contain at least one selector constraint`);
  }
  return {
    ...(ids?.length ? { ids } : {}),
    ...(kinds?.length ? { kinds } : {}),
    ...(layers?.length ? { layers: layers as NonNullable<ParityNodeSelector['layers']> } : {}),
    ...(sourceIds?.length ? { sourceIds } : {}),
  };
}

function normalizePredicate(value: unknown, index: number): ParityReachabilityPredicate {
  const field = `contract.predicates[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  if (record.type !== 'reachability') throw new Error(`${field}.type must be reachability`);
  if (record.quantifier !== undefined && record.quantifier !== 'any' && record.quantifier !== 'all') throw new Error(`${field}.quantifier must be any or all`);
  if (record.direction !== undefined && record.direction !== 'outbound' && record.direction !== 'inbound') throw new Error(`${field}.direction must be outbound or inbound`);
  if (record.maxDepth !== undefined && (!Number.isInteger(record.maxDepth) || Number(record.maxDepth) < 1 || Number(record.maxDepth) > MAX_DEPTH)) {
    throw new Error(`${field}.maxDepth must be an integer from 1 to ${MAX_DEPTH}`);
  }
  const rationale = cleanText(record.rationale, `${field}.rationale`);
  const originalClaim = cleanText(record.originalClaim, `${field}.originalClaim`);
  const relationshipKinds = stringList(record.relationshipKinds, `${field}.relationshipKinds`);
  const scopeSourceIds = stringList(record.scopeSourceIds, `${field}.scopeSourceIds`);
  return {
    id: cleanText(record.id, `${field}.id`, true)!,
    type: 'reachability',
    from: normalizeSelector(record.from, `${field}.from`),
    to: normalizeSelector(record.to, `${field}.to`),
    requirement: requirement(record.requirement, `${field}.requirement`),
    quantifier: record.quantifier === 'all' ? 'all' : 'any',
    direction: record.direction === 'inbound' ? 'inbound' : 'outbound',
    maxDepth: record.maxDepth === undefined ? 8 : Number(record.maxDepth),
    ...(relationshipKinds?.length ? { relationshipKinds } : {}),
    ...(scopeSourceIds?.length ? { scopeSourceIds } : {}),
    ...(rationale ? { rationale } : {}),
    ...(originalClaim ? { originalClaim } : {}),
  };
}

export function normalizeParityContract(value: unknown): ParityContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('contract must be an object');
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error('contract.version must be 1');
  const entities = record.entities === undefined ? [] : record.entities;
  const relationships = record.relationships === undefined ? [] : record.relationships;
  const predicates = record.predicates === undefined ? [] : record.predicates;
  if (!Array.isArray(entities)) throw new Error('contract.entities must be an array');
  if (!Array.isArray(relationships)) throw new Error('contract.relationships must be an array');
  if (!Array.isArray(predicates)) throw new Error('contract.predicates must be an array');
  if (entities.length + relationships.length + predicates.length === 0) throw new Error('contract must contain at least one entity, relationship, or predicate expectation');
  if (entities.length > MAX_EXPECTATIONS || relationships.length > MAX_EXPECTATIONS || predicates.length > MAX_EXPECTATIONS || entities.length + relationships.length + predicates.length > MAX_EXPECTATIONS) {
    throw new Error(`contract exceeds ${MAX_EXPECTATIONS} expectations`);
  }
  const predicateIds = predicates.map((item, index) => normalizePredicate(item, index).id);
  if (new Set(predicateIds).size !== predicateIds.length) throw new Error('contract.predicates contains duplicate predicate IDs');
  const name = cleanText(record.name, 'contract.name');
  const description = cleanText(record.description, 'contract.description');
  return {
    version: 1,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(entities.length ? { entities: entities.map(normalizeEntity) } : {}),
    ...(relationships.length ? { relationships: relationships.map(normalizeRelationship) } : {}),
    ...(predicates.length ? { predicates: predicates.map(normalizePredicate) } : {}),
  };
}

function coverageSupportsNegative(coverage: GraphCoverage | undefined): boolean {
  return Boolean(coverage
    && coverage.failedFiles === 0
    && coverage.partialFiles === 0
    && coverage.skippedFiles === 0
    && coverage.unsupportedFiles === 0
    && coverage.analyzedFiles === coverage.eligibleFiles
    && coverage.completeFiles === coverage.trackedFiles);
}

function negativeCoverage(graph: IntelligenceGraph) {
  const coverage = graph.coverage;
  if (!coverage) return {
    scope: 'repository' as const,
    supportsNegative: false,
    blockers: [],
    note: 'Coverage is unavailable, so absence cannot prove a negative expectation.',
  };
  const blockers = (coverage.files ?? [])
    .filter(item => item.status !== 'complete')
    .map(item => ({ path: item.path, status: item.status, ...(item.reason ? { reason: item.reason } : {}) }));
  return {
    scope: 'repository' as const,
    supportsNegative: coverageSupportsNegative(coverage) && graph.unavailableSourceIds.length === 0,
    blockers,
    note: blockers.length
      ? 'Unsupported, partial, skipped, or failed tracked sources can contain contrary evidence; absence remains unproven.'
      : 'Repository coverage is exhaustive for tracked sources and may support bounded negative conclusions.',
  };
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
      : status === 'unproven' ? 'The entity was not observed, but claim-scope coverage is not exhaustive so absence is not proven.'
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
        : status === 'unproven' ? 'The relationship was not observed, but claim-scope coverage is not exhaustive so absence is not proven.'
          : requirementValue === 'required' ? 'The required relationship was not observed.' : 'The forbidden relationship was not observed.',
  };
}

function selectNodes(graph: IntelligenceGraph, selector: ParityNodeSelector) {
  const ids = selector.ids ? new Set(selector.ids) : null;
  const kinds = selector.kinds ? new Set(selector.kinds) : null;
  const layers = selector.layers ? new Set(selector.layers) : null;
  const sourceIds = selector.sourceIds ? new Set(selector.sourceIds) : null;
  return graph.nodes.filter(node => (!ids || ids.has(node.id))
    && (!kinds || kinds.has(node.kind))
    && (!layers || layers.has(node.layer ?? 'structural'))
    && (!sourceIds || sourceIds.has(node.sourceId)));
}

interface ReachPath { nodeIds: string[]; edgeIds: string[]; relationshipKinds: string[]; statuses: string[] }

function pathsFrom(graph: IntelligenceGraph, startId: string, targetIds: Set<string>, predicate: ParityReachabilityPredicate, statuses: Set<string>): { paths: ReachPath[]; truncated: boolean; unknownEndpoints: boolean } {
  const allowedKinds = predicate.relationshipKinds?.length ? new Set(predicate.relationshipKinds) : null;
  const direction = predicate.direction ?? 'outbound';
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (!statuses.has(edge.status) || (allowedKinds && !allowedKinds.has(edge.kind))) continue;
    const key = direction === 'outbound' ? edge.from : edge.to;
    if (!key) continue;
    const items = adjacency.get(key) ?? [];
    items.push(edge);
    adjacency.set(key, items);
  }
  const found: ReachPath[] = [];
  const queue: ReachPath[] = [{ nodeIds: [startId], edgeIds: [], relationshipKinds: [], statuses: [] }];
  const seenDepth = new Map<string, number>([[`${startId}:false`, 0]]);
  let expansions = 0;
  let cursor = 0;
  let unknownEndpoints = false;
  let truncated = false;
  while (cursor < queue.length && !truncated) {
    const path = queue[cursor++]!;
    const current = path.nodeIds[path.nodeIds.length - 1]!;
    if (path.edgeIds.length >= (predicate.maxDepth ?? 8)) continue;
    for (const edge of adjacency.get(current) ?? []) {
      if (expansions >= 10_000) {
        truncated = true;
        break;
      }
      expansions += 1;
      const next = direction === 'outbound' ? edge.to : edge.from;
      if (!next) {
        unknownEndpoints = true;
        continue;
      }
      if (path.nodeIds.includes(next)) continue;
      const candidate = {
        nodeIds: [...path.nodeIds, next],
        edgeIds: [...path.edgeIds, edge.id],
        relationshipKinds: [...path.relationshipKinds, edge.kind],
        statuses: [...path.statuses, edge.status],
      };
      if (targetIds.has(next)) {
        if (found.length < 50) found.push(candidate);
        else truncated = true;
      } else {
        const tentative = candidate.statuses.some(status => status !== 'resolved');
        const key = `${next}:${tentative}`;
        const depth = candidate.edgeIds.length;
        if ((seenDepth.get(key) ?? Number.POSITIVE_INFINITY) <= depth) continue;
        seenDepth.set(key, depth);
        queue.push(candidate);
      }
    }
  }
  return { paths: found, truncated, unknownEndpoints };
}

function evaluatePredicate(graph: IntelligenceGraph, predicate: ParityReachabilityPredicate, complete: boolean) {
  const subjects = selectNodes(graph, predicate.from);
  const targets = selectNodes(graph, predicate.to);
  const matchedSubjectIds = new Set(subjects.map(node => node.id));
  const matchedTargetIds = new Set(targets.map(node => node.id));
  const missingSubjectIds = (predicate.from.ids ?? []).filter(id => !matchedSubjectIds.has(id));
  const missingTargetIds = (predicate.to.ids ?? []).filter(id => !matchedTargetIds.has(id));
  const targetIds = new Set(targets.map(node => node.id));
  const traversalBySubject = new Map(subjects.map(node => [node.id, pathsFrom(graph, node.id, targetIds, predicate, new Set(['resolved', 'candidate', 'unresolved']))]));
  const resolvedBySubject = new Map([...traversalBySubject].map(([id, traversal]) => [id, traversal.paths.filter(path => path.statuses.every(status => status === 'resolved'))]));
  const tentativeBySubject = new Map([...traversalBySubject].map(([id, traversal]) => [id, traversal.paths.filter(path => path.statuses.some(status => status !== 'resolved'))]));
  // Bounded scope is a separate, explicitly qualified claim. It never
  // upgrades repository-wide absence and is not automatically test-replacement
  // eligible. Every selected source must have complete tracked coverage.
  const scopeFiles = (predicate.scopeSourceIds ?? []).map(id => id.replace(/^repo:/u, ''));
  const sourceScope = new Set(scopeFiles);
  const coverageFiles = graph.coverage?.files ?? [];
  const coverageByPath = new Map(coverageFiles.map(item => [item.path, item]));
  const scopeComplete = scopeFiles.length > 0 && scopeFiles.every(path => coverageByPath.get(path)?.status === 'complete');
  const selectedInsideScope = subjects.every(node => sourceScope.has(node.sourceId.replace(/^repo:/u, '')))
    && targets.every(node => sourceScope.has(node.sourceId.replace(/^repo:/u, '')));
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const relevantKinds = predicate.relationshipKinds?.length ? new Set(predicate.relationshipKinds) : null;
  const directionForScope = predicate.direction ?? 'outbound';
  const visited = new Set(subjects.map(node => node.id));
  const pending = subjects.map(node => ({ id: node.id, depth: 0 }));
  let sourceScopeEscaped = false;
  let sourceScopeUnknown = false;
  let sourceScopeTruncated = false;
  let exploredEdges = 0;
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor]!;
    if (current.depth >= (predicate.maxDepth ?? 8)) continue;
    for (const edge of graph.edges) {
      if ((directionForScope === 'outbound' ? edge.from : edge.to) !== current.id
          || (relevantKinds && !relevantKinds.has(edge.kind))) continue;
      if (++exploredEdges > 10_000) { sourceScopeTruncated = true; break; }
      const nextId = directionForScope === 'outbound' ? edge.to : edge.from;
      const next = nextId ? nodeById.get(nextId) : null;
      if (!next || edge.status !== 'resolved') { sourceScopeUnknown = true; continue; }
      if (!sourceScope.has(next.sourceId.replace(/^repo:/u, ''))) sourceScopeEscaped = true;
      if (!visited.has(next.id)) {
        visited.add(next.id);
        pending.push({ id: next.id, depth: current.depth + 1 });
      }
    }
    if (sourceScopeTruncated) break;
  }
  const boundedScopeQualified = scopeComplete && selectedInsideScope && !sourceScopeEscaped && !sourceScopeUnknown && !sourceScopeTruncated;
  const traversalIncomplete = [...traversalBySubject.values()].some(item => item.truncated || item.unknownEndpoints);
  const truncated = [...traversalBySubject.values()].some(item => item.truncated);
  const unknownEndpoints = [...traversalBySubject.values()].some(item => item.unknownEndpoints);
  const reached = subjects.filter(node => (resolvedBySubject.get(node.id)?.length ?? 0) > 0);
  const tentative = subjects.filter(node => (tentativeBySubject.get(node.id)?.length ?? 0) > 0);
  const quantifier = predicate.quantifier ?? 'any';
  const requirementValue = predicate.requirement ?? 'required';
  const subjectUniverseClosed = Boolean(predicate.from.ids?.length) && missingSubjectIds.length === 0;
  const resolvedMatch = quantifier === 'all'
    ? subjects.length > 0 && reached.length === subjects.length && missingSubjectIds.length === 0
    : reached.length > 0;
  const tentativeMatch = quantifier === 'all'
    ? subjects.length > 0 && missingSubjectIds.length === 0 && reached.length + tentative.filter(node => !reached.some(item => item.id === node.id)).length === subjects.length
    : tentative.length > 0;
  let status: ParityExpectationResultStatus;
  if (!subjects.length || !targets.length) status = 'not-applicable';
  else if (resolvedMatch && (requirementValue === 'forbidden' || quantifier === 'any' || subjectUniverseClosed || complete)) status = requirementValue === 'required' ? 'satisfied' : 'forbidden-present';
  else if (tentativeMatch || !complete || traversalIncomplete) status = 'unproven';
  else status = requirementValue === 'required' ? 'missing' : 'satisfied';
  const counterexamples = [...resolvedBySubject.entries()]
    .flatMap(([subjectId, paths]) => paths.slice(0, 5).map(path => ({ subjectId, ...path })))
    .slice(0, 20);
  const tentativePaths = [...tentativeBySubject.entries()]
    .flatMap(([subjectId, paths]) => paths.slice(0, 5).map(path => ({ subjectId, ...path })))
    .slice(0, 20);
  const relationKinds = predicate.relationshipKinds?.length ? new Set(predicate.relationshipKinds) : null;
  const direction = predicate.direction ?? 'outbound';
  const outboundEvidence = subjects.map(subject => {
    const edges = graph.edges.filter(edge =>
      (direction === 'outbound' ? edge.from === subject.id : edge.to === subject.id)
      && (!relationKinds || relationKinds.has(edge.kind)));
    return {
      subjectId: subject.id,
      sourceId: subject.sourceId,
      layer: subject.layer ?? 'structural',
      eligibleEdgeCount: edges.length,
      resolvedEdgeCount: edges.filter(edge => edge.status === 'resolved').length,
      observedKinds: [...new Set(edges.map(edge => edge.kind))].sort(),
    };
  });
  const disconnectedSubjects = outboundEvidence.filter(subject => subject.eligibleEdgeCount === 0);
  const blockers = [
    ...(!subjects.length ? ['The from selector matched no graph nodes.'] : []),
    ...(!targets.length ? ['The to selector matched no graph nodes.'] : []),
    ...(missingSubjectIds.length ? [`The from selector did not match requested IDs: ${missingSubjectIds.join(', ')}.`] : []),
    ...(missingTargetIds.length ? [`The to selector did not match requested IDs: ${missingTargetIds.join(', ')}.`] : []),
    ...(tentativePaths.length ? ['Candidate or unresolved paths cannot satisfy graph proof.'] : []),
    ...(truncated ? ['Graph traversal was truncated before exhaustiveness could be established.'] : []),
    ...(unknownEndpoints ? ['Reachable relationships with unknown endpoints prevent negative graph proof.'] : []),
    ...(scopeFiles.length && !boundedScopeQualified ? ['Declared claim source scope is not closed or completely analyzed.'] : []),
    ...(!complete && !resolvedMatch ? ['Claim-scope coverage is not exhaustive.'] : []),
  ];
  const replacementEligible = status === 'satisfied'
    && (requirementValue === 'required' && (quantifier === 'any' || subjectUniverseClosed) || complete);
  return {
    type: 'predicate' as const,
    predicate,
    status,
    matched: { subjects: subjects.map(node => node.id), targets: targets.map(node => node.id) },
    observed: { resolvedSubjectIds: reached.map(node => node.id), tentativeSubjectIds: tentative.map(node => node.id), counterexamples, tentativePaths, traversal: { truncated, unknownEndpoints }, sourceScope: { sourceIds: scopeFiles, qualified: boundedScopeQualified, escaped: sourceScopeEscaped, unknown: sourceScopeUnknown, truncated: sourceScopeTruncated, scopeOnly: true, replacementEligible: false }, subjectConnectivity: outboundEvidence, connectivityWarning: disconnectedSubjects.length ? 'Some selected subjects have no graph edges of the requested kinds. Inspect registration-to-handler bridging before asserting original-test equivalence.' : null },
    replacementAssessment: {
      modality: 'static-graph',
      eligible: replacementEligible,
      blockers,
      note: replacementEligible
        ? 'This exact-revision static graph claim has bounded proof and can replace an equivalent source-only assertion after owner review.'
        : 'This result is not replacement proof. Runtime behavior, browser interaction, concurrency, package bytes, and rendered artifacts remain outside this static graph claim.',
    },
    explanation: status === 'forbidden-present' ? 'A resolved path violates the forbidden reachability claim.'
      : status === 'satisfied' ? requirementValue === 'required' ? 'The required reachability claim is proven.' : 'No forbidden path was observed under exhaustive claim coverage.'
        : status === 'missing' ? 'The required reachability claim was not observed under exhaustive claim coverage.'
          : status === 'not-applicable' ? 'The predicate is not applicable because one or both selectors matched no nodes.'
            : 'Reachability remains unproven because evidence is tentative or claim coverage is incomplete.',
  };
}

export function evaluateParityContractGraph(graph: IntelligenceGraph, contractInput: unknown): Record<string, unknown> {
  const contract = normalizeParityContract(contractInput);
  const claimCoverage = negativeCoverage(graph);
  const complete = claimCoverage.supportsNegative;
  const results = [
    ...(contract.entities ?? []).map(item => evaluateEntity(graph, item, complete)),
    ...(contract.relationships ?? []).map(item => evaluateRelationship(graph, item, complete)),
    ...(contract.predicates ?? []).map(item => evaluatePredicate(graph, item, complete)),
  ];
  const counts = { satisfied: 0, missing: 0, forbiddenPresent: 0, unproven: 0, notApplicable: 0 };
  for (const result of results) {
    if (result.status === 'satisfied') counts.satisfied += 1;
    else if (result.status === 'missing') counts.missing += 1;
    else if (result.status === 'forbidden-present') counts.forbiddenPresent += 1;
    else if (result.status === 'unproven') counts.unproven += 1;
    else counts.notApplicable += 1;
  }
  return {
    project: graph.project,
    graphId: graph.graphId,
    revision: graph.repositoryRevision,
    topologyFingerprint: graph.topologyFingerprint,
    contract,
    passed: counts.missing === 0 && counts.forbiddenPresent === 0 && counts.unproven === 0 && counts.notApplicable === 0,
    counts,
    results,
    coverage: graph.coverage ?? null,
    claimCoverage,
    note: 'This caller-owned expectation overlay is evaluated ephemerally. Candidate or unresolved relationships never satisfy proof, and non-exhaustive claim coverage keeps absence unproven. It does not modify or become accepted graph truth.',
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
