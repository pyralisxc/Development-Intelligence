import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLocalGraph } from '../src/intelligence/local.js';
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

test('compiler-level precision gaps are explicitly disclosed without inventing negative evidence', () => {
  const content = new Map(Array.from({ length: 601 }, (_, i) => [`file${i}.ts`, 'export const value = 1;']));
  const result = compilerTypeScriptReferences({
    root: '/root/unused', sourceTexts: content, nodes: [], fileNodes: new Map(), options: {},
  });
  assert.equal(result.state, 'bounded-out');
  assert.deepEqual(result.edges, []);
  assert.match(compilerPrecisionWarning(result) ?? '', /bounded-out/);
  assert.match(compilerPrecisionWarning(result) ?? '', /negative or exhaustive conclusions are not established/);
  assert.equal(compilerPrecisionWarning({ ...result, state: 'completed', reason: null }), null);
});
