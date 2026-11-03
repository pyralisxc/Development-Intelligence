import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestClaimDecisionRecord, normalizeTestClaimCatalog } from '../src/intelligence/testClaimInventory.js';
import type { IntelligenceGraph } from '../src/types.js';

const revision = 'a'.repeat(40);
function graph(): IntelligenceGraph {
  return { schemaVersion: 2, analyzerVersion: 'inventory-test', graphId: 'repo-abc-inventory', project: 'example/project', role: 'W', createdAt: '2026-11-03T00:00:00.000Z', repositoryRevision: revision, sourceFingerprint: 'source-fingerprint', topologyFingerprint: 'topology', evidenceFingerprint: 'evidence', sources: [], evidence: [], nodes: [], edges: [], namingDivergences: [], explicitValueConflicts: [], unmatchedNodeIds: [], unavailableSourceIds: [], coverage: { trackedFiles: 1, eligibleFiles: 1, analyzedFiles: 1, completeFiles: 1, partialFiles: 0, unsupportedFiles: 0, skippedFiles: 0, failedFiles: 0, skippedOversizedFiles: 0, skippedNonRegularFiles: 0, skippedFileLimitFiles: 0, files: [] } };
}

test('suite decision record expresses directional equivalence, overlap, distinct protection and unclassified boundaries', () => {
  const catalog = normalizeTestClaimCatalog({ version: 1, revision, analyzerVersion: 'inventory-test', inventory: {
    declarations: [{ id: 'test:registration', sourceId: 'tests/example.test.tsx', line: 1, title: 'registration', dynamic: false }],
    assertions: [
      { id: 'assert:static', sourceId: 'tests/example.test.tsx', line: 2, expression: 'expect(source).toContain(name)', contextSignals: ['registration'], dynamic: false },
      { id: 'assert:browser', sourceId: 'tests/example.test.tsx', line: 3, expression: 'expect(page.locator(button).click())', contextSignals: [], dynamic: false },
      { id: 'assert:dynamic', sourceId: 'tests/example.test.tsx', line: 4, contextSignals: [], dynamic: true },
    ],
  }, claims: [
    { id: 'registration', originalClaim: 'tool is registered', equivalenceRationale: 'The required registered-as predicate covers the source membership assertion in the same direction.', assertionIds: ['assert:static'], parityClaimIds: ['registration-proof'] },
    { id: 'gesture', originalClaim: 'button works', equivalenceRationale: 'Static registration overlaps but cannot prove the browser gesture.', assertionIds: ['assert:browser'], parityClaimIds: ['registration-proof'], protectionSignals: ['browser setup and gesture execution'] },
    { id: 'dynamic', originalClaim: 'generated cases hold', equivalenceRationale: 'Dynamic generation cannot be classified from this inventory.', assertionIds: ['assert:dynamic'], parityClaimIds: [] },
  ] });
  const record = buildTestClaimDecisionRecord(graph(), catalog, [{ id: 'registration-proof', status: 'satisfied', qualified: true, replacementEligible: true, blockers: [], counterexamples: [] }]) as any;
  assert.deepEqual(record, buildTestClaimDecisionRecord(graph(), catalog, [{ id: 'registration-proof', status: 'satisfied', qualified: true, replacementEligible: true, blockers: [], counterexamples: [] }]));
  assert.equal(record.counts.declarations, 1); assert.equal(record.counts.assertions, 3);
  assert.equal(record.claims[0].outcome, 'equivalent'); assert.equal(record.claims[0].staticReplacementEquivalent, true);
  assert.equal(record.claims[1].outcome, 'distinct-protection'); assert.equal(record.claims[1].staticReplacementEquivalent, false);
  assert.equal(record.claims[2].outcome, 'unclassified'); assert.match(record.claims[2].blockers.join(' '), /dynamic or unclassified/);
  assert.equal(record.policy.recommendsDeletion, false);
});

test('claim inventory fails closed on revision drift and reports analyzer refresh as unproven', () => {
  const input = { version: 1, revision, analyzerVersion: 'old-analyzer', inventory: { declarations: [], assertions: [{ id: 'a', sourceId: 'tests/a.ts', line: 1, contextSignals: ['static-source'], dynamic: false }] }, claims: [{ id: 'c', originalClaim: 'claim', equivalenceRationale: 'directional mapping', assertionIds: ['a'], parityClaimIds: ['p'] }] };
  const catalog = normalizeTestClaimCatalog(input);
  const record = buildTestClaimDecisionRecord(graph(), catalog, [{ id: 'p', status: 'satisfied', qualified: true, replacementEligible: true, blockers: [] }]) as any;
  assert.equal(record.claims[0].outcome, 'unproven-equivalence'); assert.match(record.claims[0].blockers.join(' '), /refresh/);
  assert.throws(() => buildTestClaimDecisionRecord({ ...graph(), repositoryRevision: 'b'.repeat(40) }, catalog, []), /does not match analyzed revision/);
});

test('claim catalog rejects duplicate identities and missing directional rationale', () => {
  assert.throws(() => normalizeTestClaimCatalog({ version: 1, revision, inventory: { declarations: [], assertions: [] }, claims: [
    { id: 'same', originalClaim: 'one', equivalenceRationale: 'one', assertionIds: ['a'] },
    { id: 'same', originalClaim: 'two', equivalenceRationale: 'two', assertionIds: ['b'] },
  ] }), /duplicate/);
  assert.throws(() => normalizeTestClaimCatalog({ version: 1, revision, inventory: { declarations: [], assertions: [] }, claims: [{ id: 'c', originalClaim: 'claim', assertionIds: ['a'] }] }), /equivalenceRationale/);
});
