import { createHash } from 'node:crypto';
import type { IntelligenceGraph } from '../types.js';
import { evaluateParityContractGraph, normalizeParityContract } from './parityContract.js';

/**
 * Evaluate a caller-owned source obligation while excluding every test
 * source/edge from the proof input. Reuses DI's canonical graph and existing
 * parity evaluator; no test assertion, execution result, new graph authority,
 * history database or novel language parser is consulted.
 *
 * A resolved source call/reference can establish that static relationship.
 * It cannot establish a value, runtime outcome, universal safety property or
 * replacement for the written test. Absence remains unknown because the
 * exclusion deliberately prevents a closed-world negative proof.
 */
export const TEST_INDEPENDENT_SOURCE_STRATEGY = 'source-obligation-without-test-evidence.v1';

export function isWrittenTestSource(value: string): boolean {
  const clean = value.replace(/^(?:repo:|file:|symbol:)/u, '')
    .replaceAll('\\', '/').split('#', 1)[0]!;
  return /(?:^|\/)(?:tests?|__tests__|specs?|__specs__|test-fixtures|__fixtures__)(?:\/|$)/iu.test(clean)
    || /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)(?=$|:\d+)/iu.test(clean);
}

function contractIdentities(contract: ReturnType<typeof normalizeParityContract>): string[] {
  return [
    ...(contract.entities ?? []).map(item => item.id),
    ...(contract.relationships ?? []).flatMap(item => [item.from, item.to]),
    ...(contract.predicates ?? []).flatMap(item => [
      ...(item.from.ids ?? []), ...(item.from.sourceIds ?? []),
      ...(item.to.ids ?? []), ...(item.to.sourceIds ?? []),
      ...(item.scopeSourceIds ?? []),
    ]),
  ];
}

type Decision = {
  id: string;
  type: string;
  expectation: 'required' | 'forbidden';
  outcome: 'established-static-source' | 'source-counterexample' | 'unproven';
  originalStatus: string;
  witnessedResolvedEdgeIds: string[];
  explanation: string;
};

export function evaluateTestIndependentSourceContract(
  graph: IntelligenceGraph,
  contractInput: unknown,
): {
  identity: {
    project: string; revision: string; graphId: string;
    analyzerVersion: string; contractSha256: string;
  };
  mode: typeof TEST_INDEPENDENT_SOURCE_STRATEGY;
  counts: {
    obligations: number; sourceEstablished: number;
    sourceCounterexamples: number; unresolved: number;
    excludedTestNodes: number; excludedTestOrUnavailableEdges: number;
    proofSourceNodes: number; proofSourceEdges: number;
  };
  decisions: Decision[];
  policy: {
    sourceOnly: true; callerAuthoredObligation: true;
    testSourceEvidenceUsed: false; testResultUsed: false;
    staticRelationshipIsNotBehavioralProof: true;
    sourceAbsenceNeverTreatedAsProof: true;
    executionObserved: false; assertionValueProven: false;
    testReplacementProven: false; canonicalAuthorityUnaffected: true;
    persistedInterpretation: false;
  };
} {
  const contract = normalizeParityContract(contractInput);
  if (contractIdentities(contract).some(isWrittenTestSource)) {
    throw new Error('Independent source contracts must not select written test sources');
  }

  const excludedIds = new Set(graph.nodes.filter(node =>
    isWrittenTestSource(node.sourceId) || isWrittenTestSource(node.id)
    || /^test-(?:declaration|assertion)$/u.test(node.kind)).map(node => node.id));
  const nodes = graph.nodes.filter(node => !excludedIds.has(node.id));
  const allowedIds = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge =>
    Boolean(edge.from && edge.to && allowedIds.has(edge.from) && allowedIds.has(edge.to))
    && !(edge.evidence ?? []).some(isWrittenTestSource));

  // Existing parity proof must not use original repository-wide negative
  // coverage after tests and unknown source edges have been excluded.
  const { coverage: _coverage, ...graphWithoutCoverage } = graph;
  const sourceOnly: IntelligenceGraph = {
    ...graphWithoutCoverage, nodes, edges,
  };
  const evaluated = evaluateParityContractGraph(sourceOnly, contract) as {
    results: Array<{
      type: string; status: string;
      expectation?: { id?: string; from?: string; to?: string; requirement?: string };
      predicate?: { id?: string; requirement?: string };
      observed?: unknown; explanation?: string;
    }>;
  };

  const decisions: Decision[] = evaluated.results.map((row, i) => {
    const requirement = row.expectation?.requirement ?? row.predicate?.requirement ?? 'required';
    const established = row.status === 'satisfied' && requirement === 'required';
    const counterexample = row.status === 'forbidden-present' && requirement === 'forbidden';
    const edgesObserved = Array.isArray(row.observed) ? row.observed : [];
    const paths = !Array.isArray(row.observed)
      && row.observed && typeof row.observed === 'object'
      ? (row.observed as { counterexamples?: Array<{ edgeIds?: string[] }> }).counterexamples ?? [] : [];
    const witnessed = [
      ...edgesObserved.filter((item): item is { id: string; status: string } =>
        Boolean(item && typeof item.id === 'string' && item.status === 'resolved'))
        .map(item => item.id),
      ...paths.flatMap(item => item.edgeIds ?? []),
    ];
    const name = row.predicate?.id ?? row.expectation?.id
      ?? (row.expectation?.from && row.expectation?.to
        ? row.expectation.from + ' -> ' + row.expectation.to : 'obligation-' + i);
    return {
      id: name, type: row.type,
      expectation: requirement === 'forbidden' ? 'forbidden' : 'required',
      outcome: established ? 'established-static-source'
        : counterexample ? 'source-counterexample' : 'unproven',
      originalStatus: row.status,
      witnessedResolvedEdgeIds: [...new Set(witnessed)].sort(),
      explanation: row.explanation ?? 'No source-supported conclusion available',
    };
  });

  return {
    mode: TEST_INDEPENDENT_SOURCE_STRATEGY,
    identity: {
      project: graph.project, revision: graph.repositoryRevision,
      graphId: graph.graphId, analyzerVersion: graph.analyzerVersion,
      contractSha256: createHash('sha256').update(JSON.stringify(contract)).digest('hex'),
    },
    counts: {
      obligations: decisions.length,
      sourceEstablished: decisions.filter(item => item.outcome === 'established-static-source').length,
      sourceCounterexamples: decisions.filter(item => item.outcome === 'source-counterexample').length,
      unresolved: decisions.filter(item => item.outcome === 'unproven').length,
      excludedTestNodes: excludedIds.size,
      excludedTestOrUnavailableEdges: graph.edges.length - edges.length,
      proofSourceNodes: nodes.length, proofSourceEdges: edges.length,
    },
    decisions,
    policy: {
      sourceOnly: true,
      callerAuthoredObligation: true,
      testSourceEvidenceUsed: false,
      testResultUsed: false,
      staticRelationshipIsNotBehavioralProof: true,
      sourceAbsenceNeverTreatedAsProof: true,
      executionObserved: false,
      assertionValueProven: false,
      testReplacementProven: false,
      canonicalAuthorityUnaffected: true,
      persistedInterpretation: false,
    },
  };
}
