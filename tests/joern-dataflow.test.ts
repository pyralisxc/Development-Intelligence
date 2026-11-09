import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { generateTestClaimCatalog } from '../src/intelligence/testClaimInventory.js';
import { DEFAULT_JOERN_SOURCE_BUDGET, mergeJoernDataflowEvidence, pageJoernDataflowEvidence, projectLocalJoernDataflow, JOERN_DATAFLOW_STRATEGY } from '../src/intelligence/joernDataflow.js';
import { joinAssertionEvidence } from '../src/intelligence/assertionEvidenceRouting.js';
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
    // The pinned real Joern JS frontend uses zero-based column offsets.
    // Both conventions must locate the SAME source text, not guess.
    const zeroColumnSlice = {
      nodes: sampleFlow.nodes.map(item => ({
        ...item, columnNumber: item.columnNumber - 1,
      })),
      edges: sampleFlow.edges,
    };
    const zeroPath = await put(root, zeroColumnSlice, 'zero-column.json');
    const zeroProjection = await projectLocalJoernDataflow({
      ...input, slicePath: zeroPath,
    });
    assert.equal(zeroProjection.counts.sourceLocatedNodes, 3);
    assert.equal(zeroProjection.counts.candidateFlowEdges, 1);
    assert.deepEqual(
      zeroProjection.graph.nodes.slice(graph.nodes.length).map(item => item.locator).sort(),
      a.graph.nodes.slice(graph.nodes.length).map(item => item.locator).sort(),
      'same exact source anchors must survive either Joern column convention',
    );
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
    const joined = joinAssertionEvidence({ graph, catalog, joern: a }) as any;
    assert.ok(joined.counts.assertionsWithJoernSourceAnchors >= 1);
    assert.ok(joined.counts.assertionsWithPossibleFlowAnchors >= 1);
    assert.equal(joined.counts.assertionsWithExpectedValueProven, 0);
    assert.equal(joined.counts.independentlyProvenReplacements, 0);
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
    assert.ok(receipt.assertionEvidence.counts.assertionsWithPossibleFlowAnchors >= 1);
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


test('Joern corpus exceeds former 250-source ceiling through complete exact-source shards and recoverable pages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-joern-sharded-corpus-'));
  try {
    const count = 256;
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'joern-tmp'), { recursive: true });
    const allPaths: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const relative = 'src/shard-' + String(i).padStart(4, '0') + '.ts';
      allPaths.push(relative);
      await fs.writeFile(path.join(root, relative), [
        'export const value = ' + i + ';',
        'export const projected = value;',
        '',
      ].join('\n'));
    }
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', 'src']);
    await runChecked('git', ['-C', root, '-c', 'user.email=fixture@example.invalid',
      '-c', 'user.name=DI Source Corpus', 'commit', '-m', '256 real source files']);
    const graph = await buildLocalGraph(root, 'joern-corpus-capacity', 'W');
    assert.equal(graph.coverage?.failedFiles, 0);
    assert.ok(graph.coverage!.completeFiles >= count);
    assert.ok(DEFAULT_JOERN_SOURCE_BUDGET.maxSourceFiles < count);
    const createSlice = (paths: string[]) => ({
      nodes: paths.flatMap((parentFile, index) => [
        { id: index * 2 + 1, label: 'IDENTIFIER', code: 'value',
          parentFile, parentMethod: 'source', lineNumber: 1, columnNumber: 13 },
        { id: index * 2 + 2, label: 'IDENTIFIER', code: 'value',
          parentFile, parentMethod: 'source', lineNumber: 2, columnNumber: 26 },
      ]),
      edges: paths.map((_, index) => ({
        src: index * 2 + 1, dst: index * 2 + 2, label: 'REACHING_DEF',
      })),
    });
    // Use byte-identical real TS source offsets for every shard: producer
    // positions are no authority unless independently matched to Git.
    const firstPath = await put(root, createSlice(allPaths.slice(0, 128)), 'first.json');
    const secondPath = await put(root, createSlice(allPaths.slice(128)), 'second.json');
    const base = { root, graph, producerVersion: '4.0.666' };
    const a = await projectLocalJoernDataflow({ ...base, slicePath: firstPath });
    const b = await projectLocalJoernDataflow({ ...base, slicePath: secondPath });
    assert.equal(a.counts.sourceFilesChecked, 128);
    assert.equal(b.counts.sourceFilesChecked, 128);
    assert.equal(a.counts.candidateFlowEdges, 128,
      JSON.stringify(a.counts));
    assert.equal(b.counts.candidateFlowEdges, 128,
      JSON.stringify(b.counts));
    const joined = mergeJoernDataflowEvidence({ canonical: graph, segments: [b, a] });
    const repeated = mergeJoernDataflowEvidence({ canonical: graph, segments: [a, b] });
    assert.deepEqual(joined, repeated,
      'out-of-order producer shards cannot alter revision-bound graph identity');
    assert.equal(joined.segmentPopulation?.sourceArtifacts, 2);
    assert.equal(joined.segmentPopulation?.uniqueValidatedSourceNodes, count * 2);
    assert.equal(joined.counts.sourceLocatedNodes, count * 2);
    assert.equal(joined.counts.candidateFlowEdges, count);
    assert.equal(joined.segmentPopulation?.duplicateCandidateEdges, 0);
    assert.equal(joined.producer.batchSliceSha256s?.length, 2);
    assert.equal(joined.policy.actualAssertionOutcomeProven, false);
    assert.equal(joined.policy.testReplacementProven, false);
    assert.equal(graph.edges.some(edge => edge.strategy === JOERN_DATAFLOW_STRATEGY), false);
    const pages = [0,100,200].map(offset => pageJoernDataflowEvidence(joined, offset, 100));
    assert.deepEqual(pages.map(page => page.edges.length), [100,100,56]);
    assert.ok(pages.every(page => page.page.sliceSha256 === joined.producer.sliceSha256));
    assert.equal(pages[2]?.page.hasMore, false);
    const identifiers = pages.flatMap(page => page.edges.map(edge => edge.id));
    assert.equal(new Set(identifiers).size, count);
    assert.throws(() => pageJoernDataflowEvidence(joined, -1, 100), /invalid/u);
    assert.throws(() => pageJoernDataflowEvidence(joined, 0, 1001), /invalid/u);
    assert.throws(() => mergeJoernDataflowEvidence({ canonical: graph, segments: [a,a] }), /duplicat/u);
    assert.throws(() => mergeJoernDataflowEvidence({ canonical: {
      ...graph, repositoryRevision: 'f'.repeat(40),
    }, segments: [a,b] }), /one exact canonical graph/u);
    await assert.rejects(projectLocalJoernDataflow({
      ...base, slicePath: firstPath, budget: { maxSourceFiles: 64 },
    }), /configured per-shard source-file budget/u);

    const cli = [
      path.resolve('dist/src/graphCli.js'), 'joern-evidence',
      '--repo-path', root, '--project', 'joern-corpus-capacity',
      '--joern-version', '4.0.666',
      '--joern-slice-json', firstPath,
      '--joern-slice-json', secondPath,
    ];
    const first = await run(process.execPath, [...cli, '--joern-edge-page-size', '100'],
      { timeoutMs: 45000 });
    assert.equal(first.code, 0, first.stderr);
    const firstPage = JSON.parse(first.stdout);
    assert.equal(firstPage.counts.candidateFlowEdges, count);
    assert.equal(firstPage.candidateEvidence.page.total, count);
    assert.equal(firstPage.candidateEvidence.edges.length, 100);
    const recovered = await run(process.execPath, [
      ...cli, '--joern-edge-page-size', '100', '--joern-edge-offset', '200',
      '--joern-edge-expected-sha256', firstPage.producer.sliceSha256,
    ], { timeoutMs: 45000 });
    assert.equal(recovered.code, 0, recovered.stderr);
    const lastPage = JSON.parse(recovered.stdout);
    assert.equal(lastPage.candidateEvidence.edges.length, 56);
    assert.equal(lastPage.counts.candidateFlowEdges, count);
    assert.equal(lastPage.candidateEvidence.page.hasMore, false);
    const wrong = await run(process.execPath, [...cli, '--joern-edge-offset', '100',
      '--joern-edge-expected-sha256', '0'.repeat(64)], { timeoutMs: 45000 });
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.stderr, /digest does not match/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
