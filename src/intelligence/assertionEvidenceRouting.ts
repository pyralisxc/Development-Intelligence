import type { IntelligenceGraph } from '../types.js';
import type { TestClaimCatalog } from './testClaimInventory.js';
import type { JoernEvidenceProjection } from './joernDataflow.js';
import type { NodeTestEvidenceProjection } from './nodeTestEvidence.js';

/**
 * Pure evidence routing: reuses AST inventory identities, source-located
 * Joern possible flow and native runtime report identities without deriving
 * a new semantic model, claim registry, or independent replacement verdict.
 */
export function joinAssertionEvidence(input: {
  graph: IntelligenceGraph;
  catalog: TestClaimCatalog;
  joern?: JoernEvidenceProjection | null;
  testEvents?: NodeTestEvidenceProjection | null;
  limit?: number;
}): Record<string, unknown> {
  const { graph, catalog } = input;
  if (graph.repositoryRevision !== catalog.revision
    || graph.analyzerVersion !== catalog.analyzerVersion) {
    throw new Error('assertion evidence must use the exact canonical source and analyzer');
  }
  if (input.joern && (input.joern.source.revision !== graph.repositoryRevision
    || input.joern.source.graphId !== graph.graphId)) {
    throw new Error('Joern evidence does not match the source graph');
  }
  if (input.testEvents && (input.testEvents.identity.revision !== graph.repositoryRevision
    || input.testEvents.identity.graphId !== graph.graphId)) {
    throw new Error('Node test event evidence does not match the source graph');
  }
  const declarations = new Map<string, TestClaimCatalog['declarations']>();
  for (const item of catalog.declarations) {
    const list = declarations.get(item.sourceId) ?? [];
    list.push(item);
    declarations.set(item.sourceId, list);
  }
  const sourceAnchors = new Map<string, Set<string>>();
  const candidateFlows = new Set<string>();
  for (const edge of input.joern?.graph.edges ?? []) {
    if (edge.kind === 'within-test-assertion' && edge.status === 'resolved' && edge.to && edge.from) {
      const set = sourceAnchors.get(edge.to) ?? new Set<string>();
      set.add(edge.from);
      sourceAnchors.set(edge.to, set);
    } else if (edge.kind === 'dataflow-reported' && edge.status === 'candidate') {
      if (edge.from) candidateFlows.add(edge.from);
      if (edge.to) candidateFlows.add(edge.to);
    }
  }
  const events = new Map<string, NodeTestEvidenceProjection['tests']>();
  for (const item of input.testEvents?.tests ?? []) {
    if (!item.declarationId) continue;
    const list = events.get(item.declarationId) ?? [];
    list.push(item);
    events.set(item.declarationId, list);
  }

  let mappedToTest = 0, ambiguousOwner = 0, withSourceAnchors = 0;
  let withPossibleFlow = 0, withReportedPass = 0, withReportedFail = 0;
  const items: Array<{
    assertionId: string;
    source: string;
    containingTestId: string | null;
    sourceAnchorCount: number;
    possibleFlowAnchors: number;
    containingTestReported: 'pass' | 'fail' | 'unavailable' | 'ambiguous';
    assertionExecutionProven: false;
    expectedValueProven: false;
    independentReplacementProven: false;
  }> = [];

  for (const assertion of catalog.assertions) {
    const owners = (declarations.get(assertion.sourceId) ?? []).filter(item =>
      // A test owns an assertion only when its actual AST span encloses
      // both ends. Comparing assertion.end to itself incorrectly made every
      // preceding sibling test appear to own later assertions.
      item.start <= assertion.start && item.end >= assertion.end && !item.dynamic);
    const owner = owners.length === 1 ? owners[0]! : null;
    if (owner) mappedToTest++;
    else if (owners.length > 1) ambiguousOwner++;
    const anchors = sourceAnchors.get(assertion.id) ?? new Set<string>();
    const flows = [...anchors].filter(id => candidateFlows.has(id)).length;
    if (anchors.size) withSourceAnchors++;
    if (flows) withPossibleFlow++;
    const observations = owner ? (events.get(owner.id) ?? []) : [];
    const reported = observations.length === 1
      && observations[0]!.evidenceStatus === 'source-associated-unattested'
      ? observations[0]!.outcome === 'reported-pass' ? 'pass' : 'fail'
      : observations.length > 1 ? 'ambiguous' : 'unavailable';
    if (reported === 'pass') withReportedPass++;
    if (reported === 'fail') withReportedFail++;
    items.push({
      assertionId: assertion.id, source: assertion.sourceId,
      containingTestId: owner?.id ?? null,
      sourceAnchorCount: anchors.size, possibleFlowAnchors: flows,
      containingTestReported: reported,
      assertionExecutionProven: false,
      expectedValueProven: false,
      independentReplacementProven: false,
    });
  }
  const max = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20) || 20));
  const ordered = items.sort((a,b) =>
    Number(b.possibleFlowAnchors > 0) - Number(a.possibleFlowAnchors > 0)
    || Number(b.containingTestReported === 'pass') - Number(a.containingTestReported === 'pass')
    || a.source.localeCompare(b.source) || a.assertionId.localeCompare(b.assertionId));
  return {
    project: graph.project, revision: graph.repositoryRevision,
    analyzerVersion: graph.analyzerVersion, canonicalGraphId: graph.graphId,
    sources: {
      joernSliceSha256: input.joern?.producer.sliceSha256 ?? null,
      nodeEventsSha256: input.testEvents?.identity.reportSha256 ?? null,
      nativeCatalogAssertionCount: catalog.assertions.length,
    },
    counts: {
      assertions: catalog.assertions.length,
      assertionsWithUniqueContainingTest: mappedToTest,
      assertionsWithAmbiguousContainingTest: ambiguousOwner,
      assertionsWithJoernSourceAnchors: withSourceAnchors,
      assertionsWithPossibleFlowAnchors: withPossibleFlow,
      assertionsInsideReportedPassingTests: withReportedPass,
      assertionsInsideReportedFailingTests: withReportedFail,
      assertionsWhoseOwnRuntimeExecutionIsProven: 0,
      assertionsWithExpectedValueProven: 0,
      independentlyProvenReplacements: 0,
    },
    samples: ordered.slice(0, max),
    returned: Math.min(max, ordered.length), total: ordered.length,
    truncated: ordered.length > max,
    policy: {
      testContainmentIsSourceSpansOnly: true,
      JoernFlowIsCandidateNotValueProof: true,
      testOutcomeIsRunReportNotPerAssertionObservation: true,
      unknownDoesNotEstablishAbsence: true,
      noSecondGraphAuthority: true,
      noAutomaticDeletion: true,
    },
  };
}
