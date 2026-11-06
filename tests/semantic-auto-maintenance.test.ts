import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { IntelligenceGraph, GraphNode, GraphEdge } from '../src/types.js';
import { bootstrapSemanticCandidates } from '../src/intelligence/semanticBootstrap.js';
import { maintainDerivedSemanticsForGraph } from '../src/intelligence/semanticWorkflow.js';
import { loadSemanticAuthority, persistSemanticReview, semanticReviewsAtRevision } from '../src/intelligence/semanticAuthorityStore.js';
import { applySemanticReviewAction, semanticMeaningReview } from '../src/intelligence/semanticReview.js';

const firstRevision = 'a'.repeat(40);
const secondRevision = 'b'.repeat(40);

function sourceGraph(revision: string, incomplete = false): IntelligenceGraph {
  const paths = Array.from({ length: 5 }, (_, i) => `src/features/demo/module${i}.ts`);
  const nodes: GraphNode[] = paths.map(file => ({
    id: `file:${file}`, sourceId: 'repository', kind: 'file', locator: file,
    value: file, raw: file, layer: 'structural' as const,
  }));
  nodes.push({
    id: 'technical:api', sourceId: 'repository', kind: 'http-call',
    locator: `${paths[0]}:api`, value: null, raw: 'api', layer: 'structural',
  });
  nodes.push({
    id: 'technical:storage', sourceId: 'repository', kind: 'storage',
    locator: `${paths[1]}:storage`, value: null, raw: 'storage', layer: 'structural',
  });
  const edges: GraphEdge[] = Array.from({ length: 10 }, (_, i) => ({
    id: `edge:${i}`, from: `file:${paths[i % 5]}`, to: `file:${paths[(i + 1) % 5]}`,
    kind: 'imports', status: 'resolved' as const, strategy: 'source-test',
    confidence: 1, evidence: [], layer: 'structural' as const,
  }));
  return {
    schemaVersion: 2, analyzerVersion: 'fixture', graphId: `repo-${revision}-fixture`,
    project: 'fixture', role: 'W', createdAt: '2026-11-06T00:00:00Z', repositoryRevision: revision,
    sourceFingerprint: 'source', topologyFingerprint: 'topology', evidenceFingerprint: 'evidence',
    sources: [], evidence: [], nodes, edges, namingDivergences: [], explicitValueConflicts: [],
    unmatchedNodeIds: [], unavailableSourceIds: [],
    coverage: {
      trackedFiles: 5, eligibleFiles: 5, analyzedFiles: 5, completeFiles: incomplete ? 4 : 5,
      partialFiles: incomplete ? 1 : 0, unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0,
      skippedOversizedFiles: 0, skippedNonRegularFiles: 0, skippedFileLimitFiles: 0,
      files: paths.map((file, i) => ({ path: file, status: incomplete && i === 0 ? 'partial' as const : 'complete' as const })),
    },
  };
}

test('canonical semantic maintenance accepts source-proven technical scope and preserves identity across revision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-auto-semantic-'));
  const previous = process.env.DEVINT_CANONICAL_GRAPH_DIR;
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  const project = 'AutoSemanticProofFixture';
  try {
    const graphA = sourceGraph(firstRevision);
    const candidate = bootstrapSemanticCandidates(graphA, { limit: 1000 }).candidates[0];
    assert.ok(candidate, 'fixture should have an eligible intrinsic candidate');
    assert.equal(candidate.scope, 'src/features/demo');
    const first = await maintainDerivedSemanticsForGraph(project, graphA);
    assert.equal(first.state, 'stored');
    assert.equal(first.automaticallyAcceptedCount, 1);
    const stored = await loadSemanticAuthority(project);
    assert.equal(stored.ledger?.records.length, 1);
    assert.equal(stored.ledger?.records[0]?.review.acceptance?.actor.kind, 'intrinsic-derivation');
    assert.equal(stored.ledger?.records[0]?.review.proposal.kind, 'domain');
    assert.equal(stored.ledger?.records[0]?.review.proposal.name, candidate.scope);
    assert.equal(stored.ledger?.derivedMeanings?.length, 0);
    assert.equal(stored.ledger?.enrollment, undefined);
    const originalMeaningId = stored.ledger!.records[0]!.meaningId;

    const repeated = await maintainDerivedSemanticsForGraph(project, graphA);
    assert.equal(repeated.state, 'stored');
    assert.equal(repeated.automaticallyAcceptedCount, 0);
    assert.equal((await loadSemanticAuthority(project)).ledger?.records.length, 1);

    const next = await maintainDerivedSemanticsForGraph(project, sourceGraph(secondRevision));
    assert.equal(next.state, 'stored');
    assert.equal(next.automaticallyAcceptedCount, 1);
    const current = await loadSemanticAuthority(project);
    const currentReviews = semanticReviewsAtRevision(current.ledger, secondRevision);
    assert.equal(currentReviews.length, 1);
    assert.equal(currentReviews[0]?.meaningId, originalMeaningId);
    assert.equal(currentReviews[0]?.accepted, true);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    else process.env.DEVINT_CANONICAL_GRAPH_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('canonical semantic maintenance leaves incomplete source proof pending', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-pending-semantic-'));
  const previous = process.env.DEVINT_CANONICAL_GRAPH_DIR;
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  try {
    const project = 'PendingSemanticProofFixture';
    const result = await maintainDerivedSemanticsForGraph(project, sourceGraph(firstRevision, true));
    assert.equal(result.state, 'stored');
    assert.equal(result.automaticallyAcceptedCount, 0);
    const stored = await loadSemanticAuthority(project);
    assert.equal(stored.ledger?.records.length, 0);
    assert.equal(stored.ledger?.derivedMeanings?.length, 1);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    else process.env.DEVINT_CANONICAL_GRAPH_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('human semantic rejection takes precedence over otherwise sufficient source proof', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-governed-semantic-'));
  const previous = process.env.DEVINT_CANONICAL_GRAPH_DIR;
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  try {
    const project = 'GovernedSemanticProofFixture';
    const graph = sourceGraph(firstRevision);
    const candidate = bootstrapSemanticCandidates(graph, { limit: 1000 }).candidates[0]!;
    const rejected = applySemanticReviewAction(semanticMeaningReview(candidate), {
      kind: 'reject', actor: { kind: 'human', id: 'owner' }, at: '2026-11-06T00:00:00Z',
    });
    const saved = await persistSemanticReview(project, rejected, null);
    assert.equal(saved.state, 'stored');
    const result = await maintainDerivedSemanticsForGraph(project, graph);
    assert.equal(result.state, 'stored');
    assert.equal(result.automaticallyAcceptedCount, 0);
    const current = await loadSemanticAuthority(project);
    assert.equal(current.ledger?.records.length, 1);
    assert.equal(current.ledger?.records[0]?.review.state, 'rejected');
    assert.equal(current.ledger?.derivedMeanings?.length, 0);
  } finally {
    if (previous === undefined) delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    else process.env.DEVINT_CANONICAL_GRAPH_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
