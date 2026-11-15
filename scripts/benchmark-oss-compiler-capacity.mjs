#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildLocalGraph } from '../dist/src/intelligence/local.js';
import { loadCompilerOptions } from '../dist/src/intelligence/repository.js';
import {
  compilerTypeScriptReferences,
  TYPESCRIPT_COMPILER_LENS,
  DEFAULT_TYPESCRIPT_COMPILER_BUDGET,
} from '../dist/src/intelligence/typescriptCompilerLens.js';
import { runChecked } from '../dist/src/util/process.js';

const mode = process.argv.includes('--fixture') ? 'fixture' : 'repository';
function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}
function must(value, label) {
  if (!value || typeof value !== 'string') throw new Error('Expected ' + label);
  return value;
}
async function git(root, values) {
  return (await runChecked('git', ['-C', root, ...values])).stdout.trim();
}
async function construct() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-native-compiler-scale-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const roots = 1650;
  const calls = 3205;
  const written = [];
  for (let i = 0; i < roots; i += 1) {
    const rel = 'src/neutral-' + String(i).padStart(5, '0') + '.ts';
    written.push([rel, 'export const neutral' + i + ' = ' + i + ';\n']);
  }
  written.push(['src/target.ts', 'export function compute(value: number) { return value + 1; }\n']);
  const lines = ["import { compute } from './target.js';"];
  for (let i = 0; i < calls; i += 1) {
    lines.push('export const result' + String(i).padStart(4,'0') + ' = compute(' + i + ');');
  }
  written.push(['src/consumer.ts', lines.join('\n') + '\n']);
  written.push(['src/import-only.ts', "import { compute } from './target.js';\nvoid compute;\n"]);
  written.push(['src/ambiguous.ts', "function compute(value: number) { return value * 2; }\nexport const local = compute(3);\n"]);
  written.push(['src/dynamic.ts', "export function dynamic(value: any) { return value.compute(1); }\n"]);
  for (let offset = 0; offset < written.length; offset += 64) {
    await Promise.all(written.slice(offset, offset + 64).map(async ([relative, content]) =>
      fs.writeFile(path.join(root, relative), content)));
  }
  await runChecked('git', ['init', '--initial-branch=main', root]);
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=DI Capacity Oracle', '-c',
    'user.email=di-capacity@example.invalid', 'commit', '-m', 'generated exact source capacity oracle']);
  return { root, written, calls, roots };
}
async function proof(root, project, threshold) {
  const rev = await git(root, ['rev-parse', 'HEAD']);
  const started = performance.now();
  const graph = await buildLocalGraph(root, project, 'W');
  const coldMs = performance.now() - started;
  assert.equal(graph.repositoryRevision, rev);
  assert.ok(graph.coverage && graph.coverage.failedFiles === 0 && graph.coverage.partialFiles === 0);
  const compilerEdges = graph.edges.filter(edge =>
    edge.strategy === TYPESCRIPT_COMPILER_LENS && edge.status === 'resolved'
    && edge.kind === 'references-symbol');
  const all = new Set();
  const checked = [];
  for (const edge of compilerEdges) for (const locator of edge.evidence) {
    const match = /^(.+):(\d+):(\d+)$/u.exec(locator);
    if (!match || !match[1] || !graph.coverage.files.some(f => f.path === match[1])) continue;
    all.add(locator);
    if (checked.length < 32) {
      const source = await fs.readFile(path.join(root, match[1]), 'utf8');
      const line = source.split(/\r?\n/u)[Number(match[2]) - 1] ?? '';
      const col = Number(match[3]) - 1;
      assert.ok(col >= 0 && col < line.length, 'source callsite must exist in tracked exact source: ' + locator);
      checked.push(locator);
    }
  }
  assert.ok(all.size >= threshold,
    'expected at least ' + threshold + ' independently source-located compiler sites, got ' + all.size);
  let legacyBaseline = null;
  if (process.argv.includes('--compare-legacy')) {
    const sources = graph.coverage.files.filter(file => file.status === 'complete'
      && /\.(?:[cm]?[jt]s|tsx|jsx)$/iu.test(file.path));
    const sourceTexts = new Map(await Promise.all(sources.map(async file =>
      [file.path, await fs.readFile(path.join(root, file.path), 'utf8')])));
    const fileNodes = new Map(graph.nodes.filter(node => node.kind === 'file'
      && node.sourceId.startsWith('repo:'))
      .map(node => [node.sourceId.slice('repo:'.length), node]));
    const startedLegacy = performance.now();
    const oldEvidence = compilerTypeScriptReferences({
      root, sourceTexts, nodes: graph.nodes, fileNodes, options: loadCompilerOptions(root),
      budget: { maxFiles: 1600, maxSourceBytes: 12 * 1024 * 1024, maxBindings: 3000 },
    });
    const legacyElapsedMs = performance.now() - startedLegacy;
    const sites = edges => new Set(edges.filter(edge => edge.strategy === TYPESCRIPT_COMPILER_LENS
      && edge.kind === 'references-symbol' && edge.status === 'resolved')
      .flatMap(edge => edge.evidence.filter(value =>
        /^[^\n]+:\d+:\d+$/u.test(value))));
    const currentSites = sites(compilerEdges);
    const oldSites = sites(oldEvidence.edges);
    const novel = [...currentSites].filter(site => !oldSites.has(site));
    const vanished = [...oldSites].filter(site => !currentSites.has(site));
    assert.deepEqual(vanished, [],
      'new compiler resource budget must never lose old exact-source static facts');
    legacyBaseline = {
      state: oldEvidence.state, reason: oldEvidence.reason,
      oldResolvedBindings: oldEvidence.resolvedBindings,
      oldUniqueSourceSites: oldSites.size,
      newUniqueSourceSites: currentSites.size,
      newlyAvailableCompilerSourceSites: novel.length,
      formerlyAvailableSitesLost: vanished.length,
      elapsedMs: Number(legacyElapsedMs.toFixed(2)),
      rssBytesAfterComparison: process.memoryUsage().rss,
      oldBudget: { maxFiles: 1600, maxSourceBytes: 12 * 1024 * 1024, maxBindings: 3000 },
      sourceSiteProofOnlyNotBehavior: true,
    };
    const min = Number(arg('--min-legacy-new-sites') || '0');
    if (!Number.isSafeInteger(min) || min < 0) {
      throw new Error('min-legacy-new-sites must be a nonnegative integer');
    }
    assert.ok(novel.length >= min,
      'new TypeChecker capacity must establish ' + min + ' previously excluded static source sites; observed '
        + novel.length);
  }
  const report = {
    mode, revision: rev, graphId: graph.graphId, analyzerVersion: graph.analyzerVersion,
    ...(legacyBaseline ? { legacyBaseline } : {}),
    sourceFiles: graph.coverage.trackedFiles, eligibleFiles: graph.coverage.eligibleFiles,
    completeFiles: graph.coverage.completeFiles, unsupportedFiles: graph.coverage.unsupportedFiles,
    compilerEdges: compilerEdges.length, uniqueSourceSites: all.size,
    sampledSourceSpanValidation: checked.length, elapsedMs: Number(coldMs.toFixed(2)),
    rssBytes: process.memoryUsage().rss,
    cpu: process.cpuUsage(), defaultBudget: DEFAULT_TYPESCRIPT_COMPILER_BUDGET,
    compilerFactIsStaticNotRuntime: true, fullSuiteBehaviorProven: false,
  };
  return { graph, report };
}

if (mode === 'fixture') {
  const fixture = await construct();
  try {
    const { graph, report } = await proof(fixture.root, 'native-typescript-capacity-oracle', fixture.calls);
    assert.ok(report.eligibleFiles > 1600, 'must actually exceed former compiler file ceiling');
    const target = graph.nodes.find(n => n.sourceId === 'repo:src/target.ts'
      && n.name === 'compute' && n.kind === 'function');
    assert.ok(target, 'native source declaration must exist');
    const consumerEdges = graph.edges.filter(e => e.strategy === TYPESCRIPT_COMPILER_LENS
      && e.from === 'file:src/consumer.ts' && e.to === target.id && e.status === 'resolved');
    assert.ok(consumerEdges.length >= 1, 'compiler must bind exact cross-file target');
    const observed = new Set(consumerEdges.flatMap(e => e.evidence.filter(x =>
      x.startsWith('src/consumer.ts:'))));
    const lines = fixture.written.find(([name]) => name === 'src/consumer.ts')[1].split('\n');
    const expected = new Set(lines.slice(1, fixture.calls + 1).map((line,i) =>
      'src/consumer.ts:' + (i + 2) + ':' + (line.indexOf('compute(') + 1)));
    assert.deepEqual([...observed].sort(), [...expected].sort(),
      'all 3205 independently generated compiler callsite source spans must survive graph normalization');
    assert.ok(!graph.edges.some(e => e.strategy === TYPESCRIPT_COMPILER_LENS
      && e.from === 'file:src/import-only.ts'),
      'import-only must not be promoted to a compiler call');
    assert.ok(!graph.edges.some(e => e.strategy === TYPESCRIPT_COMPILER_LENS
      && e.from === 'file:src/ambiguous.ts' && e.to === target.id),
      'lexically shadowed same-name function must not become cross-file proof');
    assert.ok(!graph.edges.some(e => e.strategy === TYPESCRIPT_COMPILER_LENS
      && e.from === 'file:src/dynamic.ts'),
      'dynamic any-call must not become exact compiler proof');
    const sourceTexts = new Map(fixture.written);
    const fileNodes = new Map(graph.nodes.filter(n => n.kind === 'file'
      && n.sourceId.startsWith('repo:')).map(n => [n.sourceId.slice(5), n]));
    const explicitLower = compilerTypeScriptReferences({
      root: fixture.root, sourceTexts, nodes: graph.nodes, fileNodes,
      options: loadCompilerOptions(fixture.root), budget: { maxFiles: 1600 },
    });
    assert.equal(explicitLower.state, 'bounded-out');
    assert.equal(explicitLower.coverage.completeForEligibleSources, false);
    assert.equal(explicitLower.edges.length, 0,
      'a declined compiler program must not fabricate negative facts');
    report.oldLimitWouldRejectAll = true;
    report.generatedCallsExpected = fixture.calls;
    report.positiveSitesAllRecovered = observed.size === fixture.calls;
    report.invalidSameNameOrImportOnlyLinks = 0;
    process.stdout.write(JSON.stringify(report) + '\n');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
} else {
  const root = await fs.realpath(path.resolve(must(arg('--repo-path'), '--repo-path')));
  const expectedRevision = must(arg('--expected-sha'), '--expected-sha');
  assert.match(expectedRevision, /^[a-f0-9]{40}$/u);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), expectedRevision);
  const dirty = await git(root, ['status', '--porcelain', '--untracked-files=no']);
  assert.equal(dirty, '', 'must only measure exact committed source');
  const { report } = await proof(root, arg('--project') || path.basename(root),
    Number(must(arg('--min-sites'), '--min-sites')));
  process.stdout.write(JSON.stringify(report) + '\n');
}
