import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import type { IntelligenceGraph } from '../types.js';
import type { TestClaimCatalog } from './testClaimInventory.js';
import { runChecked } from '../util/process.js';
import { stableHash } from '../util/hash.js';

/**
 * Read the native Node TestStream reporter without parsing human TAP/spec
 * presentation. An externally supplied report is a provenance-identified
 * observation, NOT independent attestation that any test actually ran.
 */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 20000;
const MAX_TEXT = 4096;
export interface NodeTestEvidenceProjection {
  identity: { project: string; revision: string; graphId: string; reportSha256: string;
    nodeVersion: string; runId: string | null; independentlyAttested: false };
  counts: { testEvents: number; reportedPass: number; reportedFail: number;
    sourceMatched: number; ambiguous: number; unavailable: number; summariesObserved: number };
  tests: Array<{
    eventId: string;
    file: string;
    testName: string;
    outcome: 'reported-pass' | 'reported-fail';
    declarationId: string | null;
    sourceMapping: 'direct-git-source' | 'compiler-output-name-only' | 'unavailable';
    evidenceStatus: 'source-associated-unattested' | 'unproven';
  }>;
  policy: {
    nodeTestStreamIsRuntimeReport: true;
    reportIntegrityIsNotCIExecutionAttestation: true;
    compilerOutputMappingCannotProveRuntime: true;
    sourceAssociatedEventsProveAssertionResults: false;
    noneOrMissingDoesNotProveNoExecution: true;
    independentlyProvenReplacement: false;
    canonicalAuthorityUnaffected: true;
    stored: false;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function confined(root: string, location: string): boolean {
  const relative = path.relative(root, location);
  return Boolean(relative && relative !== '..'
    && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function safeText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT
    && !value.includes('\0') ? value : null;
}
async function sourceCurrent(root: string, sourcePath: string): Promise<boolean> {
  if (!sourcePath || sourcePath.includes('\0') || sourcePath.includes('\\')
    || sourcePath.startsWith('/') || sourcePath.split('/').some(p => !p || p === '..' || p === '.')) return false;
  try {
    const full = path.resolve(root, sourcePath);
    if (!confined(root, full)) return false;
    const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const real = await fs.realpath(full);
    if (!confined(root, real)) return false;
    const [expected, actual] = await Promise.all([
      runChecked('git', ['-C', root, 'rev-parse', 'HEAD:' + sourcePath]),
      runChecked('git', ['-C', root, 'hash-object', '--', sourcePath]),
    ]);
    return expected.stdout.trim() === actual.stdout.trim();
  } catch { return false; }
}
async function exactTestTitles(root: string, sourcePath: string,
  catalog: TestClaimCatalog): Promise<Array<{ id: string; name: string }>> {
  const source = await fs.readFile(path.resolve(root, sourcePath), 'utf8');
  const kind = /\.tsx$/iu.test(sourcePath) ? ts.ScriptKind.TSX
    : /\.jsx$/iu.test(sourcePath) ? ts.ScriptKind.JSX
      : /\.[cm]?js$/iu.test(sourcePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, kind);
  const bySpan = new Map(catalog.declarations.filter(item => item.sourceId === sourcePath
    && !item.dynamic).map(item => [item.start + ':' + item.end, item.id]));
  const matches: Array<{ id: string; name: string }> = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const id = bySpan.get(node.getStart(ast) + ':' + node.getEnd());
      const title = node.arguments[0];
      if (id && title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
        matches.push({ id, name: title.text });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  return matches;
}
async function eventSourcePath(root: string, supplied: string): Promise<{ path: string; mapping: 'direct-git-source' | 'compiler-output-name-only' } | null> {
  const location = supplied.startsWith('file:')
    ? (() => { try { return fileURLToPath(supplied); } catch { return ''; } })()
    : supplied;
  if (!location || location.includes('\0')) return null;
  // Native Windows TestStream can use short 8.3 source paths (RUNNER~1)
  // where the Git checkout uses the full filesystem identity. Resolve only
  // native source metadata before the same tracked-file and exact-blob check.
  // Never read source or admit reporter claims outside the checkout.
  const segments = location.replaceAll('\\', '/').split('/');
  if (segments.includes('..') || segments.includes('.')) return null;
  let sourceLocation = location;
  if (path.isAbsolute(location)) {
    try {
      const stat = await fs.lstat(location);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      sourceLocation = await fs.realpath(location);
    } catch { return null; }
  }
  const relative = (path.isAbsolute(sourceLocation)
    ? path.relative(root, sourceLocation) : sourceLocation)
    .split(path.sep).join('/');
  if (relative === '..' || relative.startsWith('../') || relative.startsWith('/')
    || relative.includes('\0') || relative.includes('\\')
    || relative.split('/').some((part: string) => !part || part === '.' || part === '..')) return null;
  if (/^(?:tests|scripts|packaging)\/.*\.(?:test|spec)\.(?:[cm]?js|tsx?)$/iu.test(relative)) {
    return { path: relative, mapping: 'direct-git-source' };
  }
  if (/^dist\/(?:tests|scripts)\/.+\.(?:test|spec)\.js$/iu.test(relative)) {
    return { path: relative.replace(/^dist\//u, '').replace(/\.js$/u, '.ts'),
      mapping: 'compiler-output-name-only' };
  }
  return null;
}

export async function projectNodeTestEvents(input: {
  root: string;
  graph: IntelligenceGraph;
  catalog: TestClaimCatalog;
  eventPath: string;
  nodeVersion: string;
  runId?: string;
}): Promise<NodeTestEvidenceProjection> {
  const root = await fs.realpath(path.resolve(input.root));
  const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (revision !== input.graph.repositoryRevision || revision !== input.catalog.revision
    || input.catalog.analyzerVersion !== input.graph.analyzerVersion) {
    throw new Error('Node test report graph/catalog must share one exact source revision and analyzer');
  }
  const requested = path.resolve(root, input.eventPath);
  if (!confined(root, requested)) throw new Error('Node test report path must be confined to checkout');
  const stat = await fs.lstat(requested);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BYTES) {
    throw new Error('Node test report must be a bounded ordinary file');
  }
  const physical = await fs.realpath(requested);
  if (!confined(root, physical)) throw new Error('Node test report physical path escapes checkout');
  if (!safeText(input.nodeVersion)) throw new Error('Node producer version must be supplied');
  if (input.runId !== undefined && !safeText(input.runId)) throw new Error('Node test run identity is invalid');
  const bytes = await fs.readFile(physical);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().split(/\r?\n/u);
  if (lines.length > MAX_EVENTS) throw new Error('Node test report exceeds bounded event population');
  const sourceCache = new Map<string, Promise<boolean>>();
  const sourceTitles = new Map<string, Promise<Array<{ id: string; name: string }>>>();
  const tests: NodeTestEvidenceProjection['tests'] = [];
  let ambiguous = 0, unavailable = 0, summariesObserved = 0, pass = 0, fail = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const raw: unknown = JSON.parse(line);
    if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.data)) {
      throw new Error('Node test stream must use the bounded v1 reporter event envelope');
    }
    if (raw.type === 'test:summary') { summariesObserved++; continue; }
    if (raw.type !== 'test:pass' && raw.type !== 'test:fail') continue;
    const name = safeText(raw.data.name);
    const file = safeText(raw.data.file);
    if (raw.type === 'test:pass') pass++; else fail++;
    if (!name || !file) { unavailable++; continue; }
    const location = await eventSourcePath(root, file);
    if (!location) { unavailable++; continue; }
    const sourcePath = location.path;
    // Untrusted reporter filenames must never trigger a source read before
    // coverage, path and exact-Git validation. Compiled output is name-only.
    const complete = input.graph.coverage?.files.some(item =>
      item.path === sourcePath && item.status === 'complete') ?? false;
    if (!sourceCache.has(sourcePath) && complete && location.mapping === 'direct-git-source') {
      sourceCache.set(sourcePath, sourceCurrent(root, sourcePath));
    }
    const current = complete && location.mapping === 'direct-git-source'
      && (await sourceCache.get(sourcePath) ?? false);
    if (current && !sourceTitles.has(sourcePath)) {
      sourceTitles.set(sourcePath, exactTestTitles(root, sourcePath, input.catalog));
    }
    const candidates = current
      ? (await sourceTitles.get(sourcePath)!).filter(item => item.name === name) : [];
    const uniquelyLocated = candidates.length === 1 && current;
    if (candidates.length > 1) ambiguous++;
    else if (!uniquelyLocated) unavailable++;
    tests.push({
      eventId: stableHash([revision, digest, index, file, name, raw.type]),
      file: sourcePath, testName: name,
      outcome: raw.type === 'test:pass' ? 'reported-pass' : 'reported-fail',
      declarationId: uniquelyLocated ? candidates[0]!.id : null,
      sourceMapping: location.mapping,
      evidenceStatus: uniquelyLocated ? 'source-associated-unattested' : 'unproven',
    });
  }
  tests.sort((a,b) => a.file.localeCompare(b.file)
    || a.testName.localeCompare(b.testName) || a.eventId.localeCompare(b.eventId));
  return {
    identity: {
      project: input.graph.project, revision, graphId: input.graph.graphId,
      reportSha256: digest, nodeVersion: input.nodeVersion,
      runId: input.runId ?? null, independentlyAttested: false,
    },
    counts: {
      testEvents: pass + fail, reportedPass: pass, reportedFail: fail,
      sourceMatched: tests.filter(item => item.evidenceStatus === 'source-associated-unattested').length,
      ambiguous, unavailable, summariesObserved,
    },
    tests: tests.slice(0, 100),
    policy: {
      nodeTestStreamIsRuntimeReport: true,
      reportIntegrityIsNotCIExecutionAttestation: true,
      compilerOutputMappingCannotProveRuntime: true,
      sourceAssociatedEventsProveAssertionResults: false,
      noneOrMissingDoesNotProveNoExecution: true,
      independentlyProvenReplacement: false,
      canonicalAuthorityUnaffected: true, stored: false,
    },
  };
}
