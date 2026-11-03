import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeTestClaimCatalog, type TestClaimCatalog } from './testClaimInventory.js';

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

async function secureDirectory(root: string, target: string, create: boolean): Promise<string> {
  if (!inside(root, target)) throw new Error('test claim report path must remain inside the repository');
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('test claim report path must not traverse a symbolic link');
      if (cursor !== target && !stat.isDirectory()) throw new Error('test claim report path traverses a non-directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
  if (create) await fs.mkdir(target, { recursive: true });
  const real = await fs.realpath(target);
  if (!inside(root, real)) throw new Error('test claim report path resolves outside the repository');
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error('test claim report path is not a directory');
  return real;
}

async function secureRead(directory: string, name: string): Promise<string> {
  const target = path.join(directory, name);
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`test claim report file is not a regular file: ${name}`);
  return await fs.readFile(target, 'utf8');
}

async function atomicWrite(directory: string, name: string, body: string): Promise<void> {
  const target = path.join(directory, name);
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`test claim report file is not a regular file: ${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(directory, `.${name}.${process.pid}.${createHash('sha256').update(body).digest('hex').slice(0, 12)}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(body, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, target); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
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
  const directory = await secureDirectory(root, target, true);
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
  await Promise.all([
    atomicWrite(directory, manifest.files.catalog, `${catalogBody}\n`),
    atomicWrite(directory, manifest.files.report, `${reportBody}\n`),
    atomicWrite(directory, 'manifest-v1.json', `${canonical(manifest)}\n`),
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
  let directory: string;
  try { directory = await secureDirectory(root, target, false); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, reason: 'missing-report', expectedDigest: input.expectedDigest, expectedRevision: input.expectedRevision, expectedProject: input.expectedProject };
    throw error;
  }
  let manifestText: string; let catalogBody: string; let reportBody: string;
  try {
    [manifestText, catalogBody, reportBody] = await Promise.all([
      secureRead(directory, 'manifest-v1.json'),
      secureRead(directory, 'catalog-v1.json'),
      secureRead(directory, 'report-v1.json'),
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
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(manifest.producerCommit)) throw new Error('test claim report producer identity is invalid');
  if (manifest.sourceRevision !== input.expectedRevision) throw new Error('test claim report source revision is stale or mismatched');
  if (manifest.project !== input.expectedProject) throw new Error('test claim report project does not match the authorized project');
  const report = JSON.parse(reportBody) as Record<string, any>;
  const normalizedCatalog = normalizeTestClaimCatalog(JSON.parse(catalogBody));
  if (canonical(normalizedCatalog) !== catalogBody.trimEnd()
    || normalizedCatalog.revision !== manifest.sourceRevision
    || normalizedCatalog.analyzerVersion !== manifest.analyzerVersion) throw new Error('test claim report catalog identity does not match its manifest');
  if (report.project !== manifest.project || report.revision !== manifest.sourceRevision || report.graphId !== manifest.graphId
    || report.sourceFingerprint !== manifest.sourceFingerprint || report.analyzerVersion !== manifest.analyzerVersion
    || report.evaluatorVersion !== manifest.evaluatorVersion || canonical(report.counts) !== canonical(manifest.counts)) {
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
