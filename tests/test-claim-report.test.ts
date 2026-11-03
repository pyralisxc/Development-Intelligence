import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTestClaimReportPage, writeTestClaimReportBundle } from '../src/intelligence/testClaimReport.js';
import type { TestClaimCatalog } from '../src/intelligence/testClaimInventory.js';

const revision = 'a'.repeat(40);
const producerCommit = 'b'.repeat(40);
const catalog: TestClaimCatalog = {
  version: 1,
  revision,
  analyzerVersion: 'inventory-test',
  scope: { sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'] },
  files: [], declarations: [], assertions: [], claims: [],
};
const decision = {
  formatVersion: 1,
  evaluatorVersion: '1.1.0',
  project: 'example/project',
  revision,
  graphId: 'repo-a',
  analyzerVersion: 'inventory-test',
  sourceFingerprint: 'source-a',
  population: { supportedDiscoveryComplete: false, problems: ['unsupported input remains explicit'] },
  counts: { files: 1, assertions: 2, nativeObligations: 1, unclassified: 1 },
  assertions: [{ id: 'a' }, { id: 'b' }],
  nativeObligations: [{ id: 'native:a', assertionId: 'a', observationKind: 'runtime-value', executionObserved: false }],
  claims: [],
  unclassified: [{ assertionId: 'b', outcome: 'unclassified', blocker: 'unsupported' }],
};

test('canonical claim reports repeat, page stably, and refuse stale or tampered reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-claim-report-'));
  try {
    const first = await writeTestClaimReportBundle({ root, outputPath: 'reports/a', producerCommit, catalog, decisionRecord: decision });
    const second = await writeTestClaimReportBundle({ root, outputPath: 'reports/b', producerCommit, catalog, decisionRecord: decision });
    assert.deepEqual(first.manifest, second.manifest);
    assert.equal(first.manifest.status, 'diagnostic');
    const page0 = await readTestClaimReportPage({ root, reportPath: first.path, expectedDigest: first.manifest.manifestSha256, expectedRevision: revision, expectedProject: 'example/project', page: 0, pageSize: 2 }) as any;
    const page1 = await readTestClaimReportPage({ root, reportPath: first.path, expectedDigest: first.manifest.manifestSha256, expectedRevision: revision, expectedProject: 'example/project', page: 1, pageSize: 2 }) as any;
    assert.equal(page0.identity.reportSha256, page1.identity.reportSha256);
    assert.equal(page0.page.totalItems, 4);
    assert.equal(page0.page.hasNext, true);
    assert.equal(page1.page.hasNext, false);
    assert.equal(page0.policy.recommendsDeletion, false);
    const missing = await readTestClaimReportPage({ root, reportPath: 'reports/missing', expectedDigest: first.manifest.manifestSha256, expectedRevision: revision, expectedProject: 'example/project' }) as any;
    assert.deepEqual(missing, { available: false, reason: 'missing-report', expectedDigest: first.manifest.manifestSha256, expectedRevision: revision, expectedProject: 'example/project' });
    await assert.rejects(readTestClaimReportPage({ root, reportPath: first.path, expectedDigest: first.manifest.manifestSha256, expectedRevision: 'c'.repeat(40), expectedProject: 'example/project' }), /stale or mismatched/u);
    await assert.rejects(readTestClaimReportPage({ root, reportPath: first.path, expectedDigest: first.manifest.manifestSha256, expectedRevision: revision, expectedProject: 'other/project' }), /authorized project/u);
    await fs.appendFile(path.join(root, first.path, 'report-v1.json'), 'x');
    await assert.rejects(readTestClaimReportPage({ root, reportPath: first.path, expectedDigest: first.manifest.manifestSha256, expectedRevision: revision, expectedProject: 'example/project' }), /digest validation/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
