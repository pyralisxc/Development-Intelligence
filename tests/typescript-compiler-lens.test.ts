import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { advanceRepositoryGraph } from '../src/intelligence/repository.js';
import { compilerTypeScriptReferences, compilerPrecisionWarning } from '../src/intelligence/typescriptCompilerLens.js';
import { runChecked } from '../src/util/process.js';

test('TypeScript compiler enriches exact cross-file method identity but never infers dynamic calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-typescript-compiler-lens-'));
  try {
    await fs.writeFile(path.join(root, 'types.ts'), `export class First {
  run() { return 1; }
}
export class Second {
  run() { return 2; }
}
`);
    await fs.writeFile(path.join(root, 'consumer.ts'), `import { First, Second } from './types.js';
export function useFirst(first: First) { return first.run(); }
export function useSecond(second: Second) { return second.run(); }
export function dynamic(value: any) { return value.run(); }
`);
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture',
      'commit', '-m', 'typechecker fixture']);
    const first = await buildLocalGraph(root, 'typechecker-fixture', 'W');
    const bindings = first.edges.filter(edge => edge.strategy === 'typescript-checker-symbol.v1'
      && edge.kind === 'references-symbol' && edge.status === 'resolved');
    const resolved = bindings.map(edge => ({
      from: first.nodes.find(node => node.id === edge.from),
      target: first.nodes.find(node => node.id === edge.to),
      location: edge.evidence[0],
    }));
    assert.equal(resolved.length, 2, 'only exact First/Second method calls should be compiler-bound');
    assert.deepEqual(resolved.map(item => [item.location, item.target?.locator]).sort(), [
      ['consumer.ts:2:49', 'types.ts:2'],
      ['consumer.ts:3:52', 'types.ts:5'],
    ].sort());
    assert.ok(resolved.every(item => item.from?.kind === 'file' && item.target?.name === 'run'));
    assert.equal(resolved.some(item => item.location?.startsWith('consumer.ts:4:')), false);
    assert.equal(first.nodes.some(node => node.kind === 'compiler-call-reference'), false,
      'compiler evidence must not create competing selectable symbol identities');
    assert.equal(first.edges.some(edge => edge.strategy === 'typescript-checker-symbol.v1'
      && edge.kind === 'calls'), false, 'static type binding is not runtime execution proof');
    const again = await buildLocalGraph(root, 'typechecker-fixture', 'W');
    assert.deepEqual(again.edges.filter(edge => edge.strategy === 'typescript-checker-symbol.v1')
      .map(edge => edge.id).sort(), first.edges.filter(edge => edge.strategy === 'typescript-checker-symbol.v1')
      .map(edge => edge.id).sort(), 'same source and analyzer must have stable compiler evidence');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('compiler retains exact TypeChecker truth beyond the old 600-source ceiling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-typescript-large-compiler-lens-'));
  try {
    for (let i = 0; i < 601; i += 1) {
      await fs.writeFile(path.join(root, 'neutral-' + String(i).padStart(4, '0') + '.ts'),
        'export const neutral' + i + ' = ' + i + ';\n');
    }
    await fs.writeFile(path.join(root, 'types.ts'),
      'export function helper(input: number): number { return input + 1; }\n');
    await fs.writeFile(path.join(root, 'consumer.ts'),
      "import { helper } from './types.js';\nexport const value = helper(42);\n");
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=fixture@example.com',
      '-c', 'user.name=Fixture', 'commit', '-m', 'large compiler fixture']);
    const graph = await buildLocalGraph(root, 'typescript-large-lens', 'W');
    assert.equal(graph.coverage?.failedFiles, 0);
    const target = graph.nodes.find(node => node.kind === 'function'
      && node.name === 'helper' && node.sourceId === 'repo:types.ts');
    assert.ok(target, 'the native source declaration must be present');
    const proven = graph.edges.filter(edge => edge.strategy === 'typescript-checker-symbol.v1'
      && edge.kind === 'references-symbol' && edge.status === 'resolved'
      && edge.from === 'file:consumer.ts' && edge.to === target.id);
    assert.equal(proven.length, 1,
      'compiler must establish the exact source signature after 600 other files');
    assert.ok(proven[0]!.evidence.some(locator => locator.startsWith('consumer.ts:2:')));
    assert.equal(graph.edges.some(edge => edge.strategy === 'typescript-checker-symbol.v1'
      && edge.kind === 'calls'), false, 'static binding is not runtime execution');

    // A new exact Git revision must produce the SAME compiler facts whether DI
    // advances its canonical graph incrementally or reconstructs a cold W.
    await fs.writeFile(path.join(root, 'consumer.ts'),
      "import { helper } from './types.js';\nexport const value = helper(7);\n");
    await runChecked('git', ['-C', root, 'add', 'consumer.ts']);
    await runChecked('git', ['-C', root, '-c', 'user.email=fixture@example.com',
      '-c', 'user.name=Fixture', 'commit', '-m', 'advance compiler source']);
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const incremental = await advanceRepositoryGraph({
      previous: graph, project: 'typescript-large-lens',
      repository: root, root, revision,
      changedFiles: [{ status: 'M', path: 'consumer.ts' }], role: 'W',
    });
    assert.equal(incremental.strategy, 'incremental', incremental.reason ?? 'expected real incremental path');
    assert.ok(incremental.graph);
    const cold = await buildLocalGraph(root, 'typescript-large-lens', 'W');
    const compilerFacts = (edges: typeof graph.edges) => edges.filter(edge =>
      edge.strategy === 'typescript-checker-symbol.v1' && edge.kind === 'references-symbol')
      .map(edge => ({ id: edge.id, status: edge.status, from: edge.from,
        to: edge.to, evidence: edge.evidence })).sort((a,b) => a.id.localeCompare(b.id));
    assert.ok(compilerFacts(cold.edges).length > 0, 'fresh revision retains actual compiler facts');
    assert.deepEqual(compilerFacts(incremental.graph!.edges), compilerFacts(cold.edges),
      'incremental and full graph must agree on source-proven TypeChecker facts');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('compiler-level precision gaps are explicitly disclosed without inventing negative evidence', () => {
  const content = new Map(Array.from({ length: 1601 }, (_, i) => [`file${i}.ts`, 'export const value = 1;']));
  const result = compilerTypeScriptReferences({
    root: '/root/unused', sourceTexts: content, nodes: [], fileNodes: new Map(), options: {},
  });
  assert.equal(result.state, 'bounded-out');
  assert.deepEqual(result.edges, []);
  assert.match(compilerPrecisionWarning(result) ?? '', /bounded-out/);
  assert.match(compilerPrecisionWarning(result) ?? '', /negative or exhaustive conclusions are not established/);
  assert.equal(compilerPrecisionWarning({ ...result, state: 'completed', reason: null }), null);
});
