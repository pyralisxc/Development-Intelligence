import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TestClaimCatalog } from './testClaimInventory.js';

export const TEST_CLAIM_REPORT_FORMAT_VERSION = 1;
export const DEFAULT_TEST_CLAIM_REPORT_PATH = '.development-intelligence/test-claims';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export interface TestClaimReportManifest {
  formatVersion: 1;
  project: string;
  sourceRevision: string;
  graphId: string;
  sourceFingerprint: string;
  analyzerVersion: string;
  evaluatorVersion: string;
  producerCommit: string;
  configFingerprint: string;
  catalogSha256: string;
  reportSha256: string;
  manifestSha256: string;
  status: 'complete' | 'diagnostic';
  counts: Record<string, number>;
  files: { catalog: 'catalog-v1.json'; report: 'report-v1.json' };
}

export async function writeTestClaimReportBundle(input: {
  root: string;
  outputPath?: string;
  producerCommit: string;
  catalog: TestClaimCatalog;
  decisionRecord: Record<string, any>;
  parityContract?: unknown;
}): Promise<{ path: string; manifest: TestClaimReportManifest }> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.producerCommit)) throw new Error('test claim report producer commit must be exact');
  const root = await fs.realpath(path.resolve(input.root));
  const target = path.resolve(root, input.outputPath ?? DEFAULT_TEST_CLAIM_REPORT_PATH);
  if (!inside(root, target)) throw new Error('test claim report path must remain inside the repository');
  const decision = { ...input.decisionRecord };
  delete decision.path;
  const catalogBody = canonical(input.catalog);
  const reportBody = canonical(decision);
  const catalogSha256 = sha256(catalogBody);
  const reportSha256 = sha256(reportBody);
  const configFingerprint = sha256(canonical({ scope: input.catalog.scope, parityContract: input.parityContract ?? null }));
  const diagnostic = decision.population?.supportedDiscoveryComplete !== true
    || (Array.isArray(decision.population?.problems) && decision.population.problems.length > 0);
  const unsigned = {
    formatVersion: 1 as const,
    project: String(decision.project),
    sourceRevision: String(decision.revision),
    graphId: String(decision.graphId),
    sourceFingerprint: String(decision.sourceFingerprint),
    analyzerVersion: String(decision.analyzerVersion),
    evaluatorVersion: String(decision.evaluatorVersion),
    producerCommit: input.producerCommit,
    configFingerprint,
    catalogSha256,
    reportSha256,
    status: diagnostic ? 'diagnostic' as const : 'complete' as const,
    counts: decision.counts as Record<string, number>,
    files: { catalog: 'catalog-v1.json' as const, report: 'report-v1.json' as const },
  };
  const manifest: TestClaimReportManifest = { ...unsigned, manifestSha256: sha256(canonical(unsigned)) };
  await fs.mkdir(target, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(target, manifest.files.catalog), `${catalogBody}\n`, 'utf8'),
    fs.writeFile(path.join(target, manifest.files.report), `${reportBody}\n`, 'utf8'),
    fs.writeFile(path.join(target, 'manifest-v1.json'), `${canonical(manifest)}\n`, 'utf8'),
  ]);
  return { path: path.relative(root, target).split(path.sep).join('/'), manifest };
}

function reportItems(report: Record<string, any>): Array<Record<string, unknown>> {
  const groups: Array<[string, any[]]> = [
    ['assertion', report.assertions ?? []],
    ['native-obligation', report.nativeObligations ?? []],
    ['claim', report.claims ?? []],
    ['unclassified', report.unclassified ?? []],
  ];
  return groups.flatMap(([kind, values]) => values.map(value => ({ kind, ...value })))
    .sort((a, b) => `${a.kind}:${a.id ?? a.assertionId ?? ''}`.localeCompare(`${b.kind}:${b.id ?? b.assertionId ?? ''}`));
}

export function projectTestClaimDecisionPage(input: {
  report: Record<string, any>;
  catalog: TestClaimCatalog;
  page?: number;
  pageSize?: number;
}): Record<string, unknown> {
  const pageSize = Math.min(Math.max(input.pageSize ?? 100, 1), 500);
  const page = Math.max(input.page ?? 0, 0);
  const items = reportItems(input.report);
  const start = page * pageSize;
  const catalogSha256 = sha256(canonical(input.catalog));
  const reportSha256 = sha256(canonical(input.report));
  return {
    available: true,
    identity: {
      formatVersion: TEST_CLAIM_REPORT_FORMAT_VERSION,
      project: input.report.project,
      sourceRevision: input.report.revision,
      graphId: input.report.graphId,
      sourceFingerprint: input.report.sourceFingerprint,
      analyzerVersion: input.report.analyzerVersion,
      evaluatorVersion: input.report.evaluatorVersion,
      inputFingerprint: input.report.inputFingerprint,
      catalogSha256,
      reportSha256,
      mode: 'exact-source-recomputation',
    },
    population: input.report.population,
    counts: input.report.counts,
    page: { index: page, size: pageSize, totalItems: items.length, hasNext: start + pageSize < items.length },
    items: items.slice(start, start + pageSize),
    policy: { readOnly: true, recommendsDeletion: false, executionObserved: false },
  };
}

export async function readTestClaimReportPage(input: {
  root: string;
  reportPath?: string;
  expectedDigest: string;
  expectedRevision: string;
  expectedProject: string;
  page?: number;
  pageSize?: number;
}): Promise<Record<string, unknown>> {
  const root = await fs.realpath(path.resolve(input.root));
  const target = path.resolve(root, input.reportPath ?? DEFAULT_TEST_CLAIM_REPORT_PATH);
  if (!inside(root, target)) throw new Error('test claim report path must remain inside the repository');
  let manifestText: string; let catalogBody: string; let reportBody: string;
  try {
    [manifestText, catalogBody, reportBody] = await Promise.all([
      fs.readFile(path.join(target, 'manifest-v1.json'), 'utf8'),
      fs.readFile(path.join(target, 'catalog-v1.json'), 'utf8'),
      fs.readFile(path.join(target, 'report-v1.json'), 'utf8'),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, reason: 'missing-report', expectedDigest: input.expectedDigest, expectedRevision: input.expectedRevision, expectedProject: input.expectedProject };
    throw error;
  }
  const manifest = JSON.parse(manifestText) as TestClaimReportManifest;
  const unsigned = { ...manifest } as Record<string, unknown>;
  delete unsigned.manifestSha256;
  if (manifest.formatVersion !== TEST_CLAIM_REPORT_FORMAT_VERSION
    || manifest.manifestSha256 !== sha256(canonical(unsigned))
    || manifest.reportSha256 !== sha256(reportBody.trimEnd())
    || manifest.catalogSha256 !== sha256(catalogBody.trimEnd())) throw new Error('test claim report bundle failed digest validation');
  if (manifest.manifestSha256 !== input.expectedDigest) throw new Error('test claim report digest does not match the requested immutable report');
  if (manifest.sourceRevision !== input.expectedRevision) throw new Error('test claim report source revision is stale or mismatched');
  if (manifest.project !== input.expectedProject) throw new Error('test claim report project does not match the authorized project');
  const report = JSON.parse(reportBody) as Record<string, any>;
  if (report.revision !== manifest.sourceRevision || report.graphId !== manifest.graphId || report.evaluatorVersion !== manifest.evaluatorVersion) {
    throw new Error('test claim report identity does not match its manifest');
  }
  const pageSize = Math.min(Math.max(input.pageSize ?? 100, 1), 500);
  const page = Math.max(input.page ?? 0, 0);
  const items = reportItems(report);
  const start = page * pageSize;
  return {
    available: true,
    identity: manifest,
    population: report.population,
    counts: report.counts,
    page: { index: page, size: pageSize, totalItems: items.length, hasNext: start + pageSize < items.length },
    items: items.slice(start, start + pageSize),
    policy: { readOnly: true, recommendsDeletion: false, executionObserved: false },
  };
}
