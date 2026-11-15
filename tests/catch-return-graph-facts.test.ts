import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { analyzeTypeScript } from '../src/intelligence/analyzers/typescript.js';
import { querySourceConditionEffects, sourceConditionsAnswer } from '../src/intelligence/sourceConditionEffects.js';
import { runChecked } from '../src/util/process.js';

const fixture = [
  'export async function processRevisionPurge(client: any) {',
  '  try {',
  '    await client.storage.remove();',
  '    await client.rpc("finalize");',
  '    return {purged: true, failed: false};',
  '  } catch (error) {',
  '    console.error("incomplete");',
  '    return {purged: false, failed: true};',
  '  }',
  '}',
  '',
].join('\n');

test('canonical graph build owns source catch-return facts before any question, without recomputing source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-catch-return-graph-'));
  try {
    await fs.mkdir(path.join(root, 'src'), {recursive: true});
    await fs.writeFile(path.join(root, 'src', 'processor.ts'), fixture);
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.name=DI', '-c', 'user.email=di@example.invalid',
      'commit', '-m', 'catch source proof']);
    const graph = await buildLocalGraph(root, 'catch-source-fixture', 'W');
    const fn = graph.nodes.find(node => node.kind === 'function' && node.name === 'processRevisionPurge');
    assert.ok(fn);
    const edges = graph.edges.filter(edge => edge.from === fn.id && edge.kind === 'catch-returns' && edge.status === 'resolved');
    assert.equal(edges.length, 1);
    const fact = graph.nodes.find(node => node.id === edges[0]?.to);
    assert.equal(fact?.kind, 'source-catch-return');
    const value = fact?.value as any;
    assert.deepEqual(value.outcome, {purged: false, failed: true});
    assert.equal(value.guaranteedOnCatchEntry, false);
    assert.equal(value.runtimeObserved, false);
    assert.ok((fact?.evidenceIds?.length ?? 0) > 0);
    assert.equal(graph.evidence.some(item => fact?.evidenceIds?.includes(item.id)), true);

    const tryEdges = graph.edges.filter(edge => edge.from === fn.id
      && edge.kind === 'try-returns' && edge.status === 'resolved');
    assert.equal(tryEdges.length, 1);
    const tryFact = graph.nodes.find(node => node.id === tryEdges[0]?.to);
    assert.equal(tryFact?.kind, 'source-try-return');
    assert.deepEqual((tryFact?.value as any).outcome, {purged: true, failed: false});
    assert.equal((tryFact?.value as any).tryCompletionProven, false);
    assert.equal((tryFact?.value as any).runtimeObserved, false);
    assert.equal(graph.evidence.some(item => tryFact?.evidenceIds?.includes(item.id)), true);

    // The selected immutable graph has already earned this source fact.
    // Changing the local working file must not cause the answer to recompute it.
    await fs.writeFile(path.join(root, 'src', 'processor.ts'),
      fixture.replace('failed: true', 'failed: false'));
    const derived = await querySourceConditionEffects({
      project: 'catch-source-fixture', graph,
      question: 'When does processRevisionPurge return failed true?',
    }) as any;
    assert.equal(derived.mode, 'canonical-source-catch-return');
    assert.equal(derived.identity.proofRule, 'typescript-ast-direct-catch-return.v1');
    assert.equal(derived.status, 'supported');
    assert.deepEqual(derived.sourceReturns[0].outcome, {purged: false, failed: true});
    assert.equal(derived.coverage.catchReachabilityProven, false);
    assert.equal(derived.proof.externalProviderEffectProven, false);
    assert.match(sourceConditionsAnswer(derived), /not proof that the catch executes/u);

    const success = await querySourceConditionEffects({
      project: 'catch-source-fixture', graph,
      question: 'When does processRevisionPurge return failed false?',
    }) as any;
    assert.equal(success.mode, 'canonical-source-try-return');
    assert.equal(success.identity.proofRule, 'typescript-ast-direct-try-return.v1');
    assert.deepEqual(success.sourceReturns[0].outcome, {purged: true, failed: false});
    assert.equal(success.proof.tryCompletionProven, false);
    assert.equal(success.proof.externalProviderEffectProven, false);
    assert.match(sourceConditionsAnswer(success), /not proof that the catch executes/u);
    const summary = await querySourceConditionEffects({
      project: 'catch-source-fixture', graph,
      question: 'What does processRevisionPurge return?',
    }) as any;
    assert.equal(summary.mode, 'canonical-source-try-catch-returns');
    assert.equal(summary.sourceReturns.length, 2);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('catch-return fact emission fails closed on finally, nested or nonliteral returns', () => {
  const cases = [
    'export function masked() { try { throw Error("x"); } catch { return {failed: true}; } finally { return {failed: false}; } }',
    'export function conditional(flag: boolean) { try { throw Error("x"); } catch { if (flag) return {failed: true}; } }',
    'export function indirect() { try { throw Error("x"); } catch { const result = {failed: true}; return result; } }',
    'export function noCatch() { try { return {failed: true}; } finally {} }',
    'export function risky() { try {} catch { return {message: "unrestricted literal"}; } }',
    'export function malformed() { try {} catch { return {failed: true}; }',
    'export function maskedTry() { try { return {failed: false}; } catch { return {failed: true}; } finally { return {failed: false}; } }',
    'export function nestedTry(flag: boolean) { try { if (flag) return {failed: false}; } catch {} }',
    'export function variableTry() { try { const value = {failed: false}; return value; } catch {} }',
    'export function privateTry() { try { return {error: "internal details"}; } catch {} }',
    'export function brokenTry() { try { return {failed: false}; } catch {',
  ];
  for (const source of cases) {
    const result = analyzeTypeScript({
      source: {id: 'repo:src/control.ts', kind: 'repository-file', locator: 'src/control.ts',
        revision: 'f'.repeat(40), observedAt: '2026-01-01T00:00:00Z', available: true},
      text: source, locatorBase: 'src/control.ts',
    });
    assert.equal(result.observations.filter(node => node.kind === 'source-catch-return').length, 0, source);
    assert.equal(result.resolutions.filter(edge => edge.kind === 'catch-returns').length, 0, source);
    assert.equal(result.observations.filter(node => node.kind === 'source-try-return').length, 0, source);
    assert.equal(result.resolutions.filter(edge => edge.kind === 'try-returns').length, 0, source);
  }
});

test('direct catch-return statements remain conditional source syntax, never negative evidence about effects', () => {
  const source = 'export function failed(flag: boolean) { try { run(); } catch { if (flag) throw Error("again"); return {failed: true}; } }';
  const result = analyzeTypeScript({
    source: {id: 'repo:src/failed.ts', kind: 'repository-file', locator: 'src/failed.ts',
      revision: 'f'.repeat(40), observedAt: '2026-01-01T00:00:00Z', available: true},
    text: source, locatorBase: 'src/failed.ts',
  });
  const observed = result.observations.filter(node => node.kind === 'source-catch-return');
  assert.equal(observed.length, 1);
  const value = observed[0]!.value as any;
  assert.equal(value.guaranteedOnCatchEntry, false);
  assert.equal(value.exceptionCauseEstablished, false);
  assert.equal(value.sourceOnly, true);
});

test('same-line identical catch returns have distinct exact source identities', () => {
  const source = 'export function many(flag: boolean) { if (flag) { try {} catch { return {failed: true}; } } else { try {} catch { return {failed: true}; } } }';
  const result = analyzeTypeScript({
    source: {id: 'repo:src/many.ts', kind: 'repository-file', locator: 'src/many.ts',
      revision: 'f'.repeat(40), observedAt: '2026-01-01T00:00:00Z', available: true},
    text: source, locatorBase: 'src/many.ts',
  });
  const facts = result.observations.filter(node => node.kind === 'source-catch-return');
  assert.equal(facts.length, 2);
  assert.equal(new Set(facts.map(fact => fact.id)).size, 2);
  assert.equal(new Set(facts.flatMap(fact => fact.evidenceIds ?? [])).size, 2);
  const edges = result.resolutions.filter(edge => edge.kind === 'catch-returns');
  assert.equal(edges.length, 2);
});

test('same-line try returns have independent site and evidence identities', () => {
  const source = 'export function different(flag: boolean) { if(flag) { try { return {failed:false}; } catch{} } else { try { return {failed:false}; } catch{} } }';
  const result = analyzeTypeScript({
    source: {id: 'repo:src/two.ts', kind: 'repository-file', locator: 'src/two.ts',
      revision: 'f'.repeat(40), observedAt: '2026-01-01T00:00:00Z', available: true},
    text: source, locatorBase: 'src/two.ts',
  });
  const facts = result.observations.filter(node => node.kind === 'source-try-return');
  assert.equal(facts.length, 2);
  assert.equal(new Set(facts.map(fact => fact.id)).size, 2);
  assert.equal(new Set(facts.flatMap(fact => fact.evidenceIds ?? [])).size, 2);
  assert.equal(result.resolutions.filter(edge => edge.kind === 'try-returns').length, 2);
});
