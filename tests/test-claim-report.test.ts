import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectTestClaimDecisionPage, readTestClaimReportPage, writeTestClaimReportBundle } from '../src/intelligence/testClaimReport.js';
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
  evaluatorVersion: '1.2.0',
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
function canonical(value: any): string { if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return`{${Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;return JSON.stringify(value); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

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

test('native exact-source projections share canonical ordering and evaluator identity', () => {
  const first = projectTestClaimDecisionPage({ report: decision, catalog, producerCommit, page: 0, pageSize: 2 }) as any;
  const second = projectTestClaimDecisionPage({ report: decision, catalog, producerCommit, page: 1, pageSize: 2 }) as any;
  assert.equal(first.identity.mode, 'exact-source-recomputation');
  assert.equal(first.identity.reportSha256, second.identity.reportSha256);
  assert.equal(first.identity.projectionSha256, second.identity.projectionSha256);
  assert.equal(first.identity.catalogSha256, second.identity.catalogSha256);
  assert.equal(first.identity.evaluatorVersion, decision.evaluatorVersion);
  assert.equal(first.identity.producerCommit, producerCommit);
  assert.equal(first.page.totalItems, 4);
  assert.equal(first.page.hasNext, true);
  assert.equal(second.page.hasNext, false);
  assert.equal(first.policy.recommendsDeletion, false);
});

test('bundle reader rejects self-consistent catalog and report identity mismatches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-claim-report-mismatch-'));
  try {
    const bundle = await writeTestClaimReportBundle({ root, producerCommit, catalog, decisionRecord: decision });
    const directory = path.join(root, bundle.path);
    const manifestPath = path.join(directory, 'manifest-v1.json');
    const catalogPath = path.join(directory, 'catalog-v1.json');
    const alteredCatalog = { ...catalog, analyzerVersion: 'forged-analyzer' };
    const catalogBody = canonical(alteredCatalog);
    await fs.writeFile(catalogPath, `${catalogBody}\n`);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.catalogSha256 = digest(catalogBody);
    delete manifest.manifestSha256;
    manifest.manifestSha256 = digest(canonical(manifest));
    await fs.writeFile(manifestPath, `${canonical(manifest)}\n`);
    await assert.rejects(readTestClaimReportPage({ root, expectedDigest: manifest.manifestSha256, expectedRevision: revision, expectedProject: 'example/project' }), /catalog identity/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
