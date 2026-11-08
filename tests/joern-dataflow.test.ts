import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { generateTestClaimCatalog } from '../src/intelligence/testClaimInventory.js';
import { projectLocalJoernDataflow, JOERN_DATAFLOW_STRATEGY } from '../src/intelligence/joernDataflow.js';
import { runChecked, run } from '../src/util/process.js';

const sampleSource = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "function compute(value: number) { return value + 1; }",
  "test('exact assertion', () => {",
  '  const expected = 2;',
  '  const observed = compute(1);',
  '  assert.equal(observed, expected);',
  '});',
  '',
].join('\n');
const rows = sampleSource.split('\n');
function node(id: number, code: string, line: number) {
  const col = rows[line - 1]!.indexOf(code) + 1;
  assert.ok(col > 0);
  return { id, label: 'IDENTIFIER', code, parentFile: 'tests/dataflow.test.ts',
    parentMethod: 'exact assertion', lineNumber: line, columnNumber: col };
}
const sampleFlow = {
  nodes: [node(11, 'expected', 5), node(12, 'expected', 7), node(13, 'observed', 7)],
  edges: [
    { src: 11, dst: 12, label: 'REACHING_DEF' },
    { src: 12, dst: 13, label: 'AST' },
  ],
};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-joern-source-'));
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.mkdir(path.join(root, 'joern-tmp'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests', 'dataflow.test.ts'), sampleSource);
  await runChecked('git', ['init', '--initial-branch=main', root]);
  await runChecked('git', ['-C', root, 'add', 'tests']);
  await runChecked('git', ['-C', root, '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=DI Fixture', 'commit', '-m', 'source fixture']);
  const graph = await buildLocalGraph(root, 'joern-test', 'W');
  const catalog = await generateTestClaimCatalog(root, graph, {
    sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'],
  });
  return { root, graph, catalog };
}
async function put(root: string, value: unknown, file = 'slice.json') {
  await fs.writeFile(path.join(root, 'joern-tmp', file), JSON.stringify(value));
  return 'joern-tmp/' + file;
}

test('Joern dataflow joins exact Git source and assertion spans without claiming flow truth', async () => {
  const { root, graph, catalog } = await fixture();
  try {
    const slicePath = await put(root, sampleFlow);
    const input = { root, graph, slicePath, producerVersion: '4.0.666', testCatalog: catalog };
    const a = await projectLocalJoernDataflow(input);
    const b = await projectLocalJoernDataflow(input);
    assert.equal(a.counts.sourceLocatedNodes, 3);
    assert.equal(a.counts.sourceUnlocatedNodes, 0);
    assert.equal(a.counts.candidateFlowEdges, 1);
    assert.equal(a.counts.unlocatedFlowEdges, 1);
    assert.ok(a.counts.assertionSpanAnchors >= 2);
    const candidate = a.graph.edges.find(edge => edge.strategy === JOERN_DATAFLOW_STRATEGY);
    assert.ok(candidate, 'source-located Joern flow must remain nonauthoritative');
    assert.equal(candidate.status, 'candidate');
    assert.equal(candidate.confidence, null);
    assert.ok(candidate.evidence.some(value => value.includes('test.ts:7:')));
    assert.ok(a.graph.edges.some(edge => edge.kind === 'within-test-assertion'
      && edge.status === 'resolved'));
    assert.equal(a.policy.canonicalAuthorityUnaffected, true);
    assert.equal(a.policy.actualAssertionOutcomeProven, false);
    assert.equal(a.policy.testReplacementProven, false);
    assert.equal(a.producer.independentlyAttested, false);
    assert.notEqual(a.graph.graphId, graph.graphId);
    assert.equal(graph.edges.some(edge => edge.strategy === JOERN_DATAFLOW_STRATEGY), false);
    assert.deepEqual(a.graph.edges.slice(graph.edges.length), b.graph.edges.slice(graph.edges.length));
    assert.equal(a.graph.graphId, b.graph.graphId);

    const cmd = await run(process.execPath, [
      path.resolve('dist/src/graphCli.js'), 'joern-evidence',
      '--repo-path', root, '--project', 'joern-test',
      '--joern-slice-json', slicePath, '--joern-version', '4.0.666',
    ]);
    assert.equal(cmd.code, 0, cmd.stderr);
    const receipt = JSON.parse(cmd.stdout);
    assert.equal(receipt.mode, 'ephemeral-oss-dataflow-evidence');
    assert.equal(receipt.counts.candidateFlowEdges, 1);
    assert.equal(receipt.counts.assertionSpanAnchors >= 2, true);
    assert.equal(receipt.policy.stored, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('forged or changed source cannot become Joern proof, and unknown is not absence', async () => {
  const { root, graph, catalog } = await fixture();
  try {
    const falseSlice = {
      nodes: [
        { ...node(11, 'expected', 5), code: 'nonexistentGuarantee123' },
        node(12, 'expected', 7),
        { ...node(13, 'observed', 7), parentFile: '../secrets.ts' },
      ],
      edges: [{ src: 11, dst: 12, label: 'DDG' }, { src: 12, dst: 13, label: 'DDG' }],
    };
    const slicePath = await put(root, falseSlice);
    const unknown = await projectLocalJoernDataflow({
      root, graph, slicePath, producerVersion: '4.0.666', testCatalog: catalog,
    });
    assert.equal(unknown.counts.sourceLocatedNodes, 1);
    assert.equal(unknown.counts.candidateFlowEdges, 0);
    assert.equal(unknown.counts.unlocatedFlowEdges, 2);
    assert.equal(unknown.policy.missingFlowDoesNotProveAbsence, true);

    const duplicated = { nodes: [node(10, 'expected', 5), node(10, 'observed', 7)], edges: [] };
    await put(root, duplicated);
    await assert.rejects(
      projectLocalJoernDataflow({ root, graph, slicePath, producerVersion: '4.0.666' }),
      /duplicate node ids/u);
    await put(root, sampleFlow);
    await fs.writeFile(path.join(root, 'tests/dataflow.test.ts'),
      sampleSource.replace('const expected = 2', 'const expected = 4'));
    const stale = await projectLocalJoernDataflow({
      root, graph, slicePath, producerVersion: '4.0.666',
    });
    assert.equal(stale.counts.sourceLocatedNodes, 0);
    assert.equal(stale.counts.candidateFlowEdges, 0);
    await assert.rejects(projectLocalJoernDataflow({
      root, graph, slicePath: '../outside.json', producerVersion: '4.0.666',
    }), /confined/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
