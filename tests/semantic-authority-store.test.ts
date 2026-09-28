import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SemanticCandidate } from '../src/intelligence/semanticBootstrap.js';
import { semanticMeaningReview, applySemanticReviewAction } from '../src/intelligence/semanticReview.js';
import {
  latestAcceptedMeanings,
  loadSemanticAuthority,
  persistSemanticReview,
  promoteCanonicalAcceptedGraph,
  semanticReviewsAtRevision,
} from '../src/intelligence/semanticAuthorityStore.js';
import { makeCanonicalGraphRecord, saveCanonicalGraph, loadCanonicalGraph } from '../src/intelligence/canonicalStore.js';
import type { IntelligenceGraph } from '../src/types.js';

function candidate(id: string, revision: string): SemanticCandidate {
  return {
    id,
    scope: 'src/features/example',
    proposal: { name: 'Example', description: 'Example', kind: 'capability', alternatives: [] },
    authority: { state: 'proposed', accepted: false, reviewed: false, proofEligible: false, persisted: false, requiresExplicitReview: true },
    provenance: {
      origin: 'intrinsic-derivation',
      producer: 'semantic-bootstrap.v1',
      revision,
      evidenceFamilies: ['structure', 'relationship'],
      nodeIds: ['node:example'],
      edgeIds: ['edge:example'],
      evidenceIds: [],
    },
    support: { scopeRole: 'functional-container', scopeDepth: 3, evidenceFamilyCount: 2, fileCount: 3, nodeCount: 5, resolvedEdgeCount: 2, motifKinds: [] },
    evidencePacket: { representativeNodes: [], representativeEdges: [] },
  };
}

function graph(project: string, revision: string, source: string): IntelligenceGraph {
  return {
    schemaVersion: 2,
    analyzerVersion: '2.9.0-rust-structural',
    graphId: `repo-${revision}-fixture0000`,
    project,
    role: 'W',
    createdAt: new Date(0).toISOString(),
    repositoryRevision: revision,
    sourceFingerprint: source,
    topologyFingerprint: 'semantic-topology-stable',
    evidenceFingerprint: `evidence-${source}`,
    sources: [],
    evidence: [],
    nodes: [],
    edges: [],
    namingDivergences: [],
    explicitValueConflicts: [],
    unmatchedNodeIds: [],
    unavailableSourceIds: [],
    coverage: {
      trackedFiles: 0, eligibleFiles: 0, analyzedFiles: 0, completeFiles: 0, partialFiles: 0,
      unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0, skippedOversizedFiles: 0,
      skippedNonRegularFiles: 0, skippedFileLimitFiles: 0, files: [],
    },
  };
}

test('semantic review history persists in DI canonical derived storage with optimistic concurrency', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-semantic-authority-'));
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  try {
    const revision = '1111111111111111111111111111111111111111';
    const proposed = semanticMeaningReview(candidate('candidate:example', revision));
    const accepted = applySemanticReviewAction(proposed, {
      kind: 'accept',
      actor: { kind: 'human', id: 'human:owner' },
      at: '2026-09-28T00:00:00.000Z',
      rationale: 'Reviewed on Preview.',
    });

    const empty = await loadSemanticAuthority('fixture/project');
    assert.equal(empty.state, 'miss');
    const stored = await persistSemanticReview('fixture/project', accepted, empty.etag);
    assert.equal(stored.state, 'stored');
    assert.equal(stored.ledger?.records.length, 1);
    assert.equal(stored.ledger?.records[0]?.review.policy.persisted, true);

    const conflict = await persistSemanticReview('fixture/project', accepted, empty.etag);
    assert.equal(conflict.state, 'conflict');

    const loaded = await loadSemanticAuthority('fixture/project');
    assert.equal(loaded.state, 'hit');
    assert.equal(semanticReviewsAtRevision(loaded.ledger, revision).length, 1);
    assert.deepEqual(latestAcceptedMeanings(loaded.ledger).map(item => item.meaningId), [accepted.meaningId]);
  } finally {
    delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('canonical semantic promotion requires a revision-bound ready gate and stores accepted A inside DI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-semantic-promote-'));
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  try {
    const project = 'fixture/promote';
    const repository = 'file:///fixture.git';
    const revision = '2222222222222222222222222222222222222222';
    const working = graph(project, revision, 'source-a');
    const initial = makeCanonicalGraphRecord({
      project,
      repository,
      revision,
      working,
      accepted: null,
      currentness: {
        acceptedSemanticCurrent: false, sourceCurrent: false, topologyCurrent: false, evidenceCurrent: false,
        analyzerCurrent: false, schemaSupported: false, integrityCurrent: false, checkpointError: null,
      },
    });
    assert.equal((await saveCanonicalGraph(initial)).saveState, 'stored');

    const blockedGate: any = {
      version: 1, baseRevision: null, previewRevision: revision, semanticDeltaCount: 1, approvedCount: 0,
      pendingCount: 1, readyForMainSemanticPromotion: false, items: [], policy: {},
    };
    await assert.rejects(
      promoteCanonicalAcceptedGraph({ project, repository, revision, gate: blockedGate }),
      /not ready/i,
    );

    const readyGate: any = { ...blockedGate, approvedCount: 1, pendingCount: 0, readyForMainSemanticPromotion: true };
    const promoted = await promoteCanonicalAcceptedGraph({ project, repository, revision, gate: readyGate });
    assert.equal(promoted.state, 'stored');

    const loaded = await loadCanonicalGraph({ project, repository, revision });
    assert.equal(loaded.record?.accepted?.role, 'A');
    assert.equal(loaded.record?.accepted?.repositoryRevision, revision);
    assert.equal(loaded.record?.currentness.acceptedSemanticCurrent, true);
  } finally {
    delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('canonical record can carry an accepted A from an older exact revision while W advances', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-semantic-carry-'));
  process.env.DEVINT_CANONICAL_GRAPH_DIR = root;
  try {
    const project = 'fixture/carry';
    const repository = 'file:///fixture.git';
    const oldRevision = '3333333333333333333333333333333333333333';
    const newRevision = '4444444444444444444444444444444444444444';
    const oldWorking = graph(project, oldRevision, 'source-old');
    const accepted = { ...oldWorking, role: 'A' as const };
    const nextWorking = graph(project, newRevision, 'source-new');
    const record = makeCanonicalGraphRecord({
      project,
      repository,
      revision: newRevision,
      working: nextWorking,
      accepted,
      currentness: {
        acceptedSemanticCurrent: true,
        sourceCurrent: false,
        topologyCurrent: true,
        evidenceCurrent: false,
        analyzerCurrent: true,
        schemaSupported: true,
        integrityCurrent: true,
        checkpointError: null,
      },
    });
    assert.equal((await saveCanonicalGraph(record)).saveState, 'stored');
    const loaded = await loadCanonicalGraph({ project, repository, revision: newRevision });
    assert.equal(loaded.record?.accepted?.repositoryRevision, oldRevision);
    assert.equal(loaded.record?.currentness.acceptedSemanticCurrent, true);
    assert.equal(loaded.record?.currentness.sourceCurrent, false);
  } finally {
    delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    await fs.rm(root, { recursive: true, force: true });
  }
});
