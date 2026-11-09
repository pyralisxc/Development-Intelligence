import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLocalGraph } from '../src/intelligence/local.js';
import { evaluateTestIndependentSourceContract, isWrittenTestSource } from '../src/intelligence/independentSourceVerification.js';
import { run, runChecked } from '../src/util/process.js';

const required = { version: 1, relationships: [{
  from: 'symbol:src/entry.ts#function:run',
  kind: 'calls', to: 'symbol:src/logic.ts#function:safe',
  requirement: 'required',
}] } as const;

async function commit(root: string, message: string) {
  await runChecked('git', ['-C', root, 'add', '.']);
  await runChecked('git', ['-C', root, '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=DI Fixture', 'commit', '-m', message]);
}

test('source obligation proof is test-independent, mutation-sensitive, and never a runtime/replacement verdict', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-independent-source-proof-'));
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.mkdir(path.join(root, 'contracts'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'logic.ts'),
      'export function safe(value: number): number { return value + 1; }\n');
    await fs.writeFile(path.join(root, 'src', 'entry.ts'),
      "import { safe } from './logic.js';\nexport function run() { return safe(1); }\n");
    await fs.writeFile(path.join(root, 'tests', 'false-expectation.test.ts'),
      "import { safe } from '../src/logic.js';\n" +
      "test('deliberately wrong expected value', () => { expect(safe(1)).toBe(99); });\n");
    await fs.writeFile(path.join(root, 'contracts', 'source.json'), JSON.stringify(required));
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await commit(root, 'initial independent fixture');
    const graph = await buildLocalGraph(root, 'independent-fixture', 'W');
    const proven = evaluateTestIndependentSourceContract(graph, required);
    assert.equal(proven.counts.obligations, 1);
    assert.equal(proven.counts.sourceEstablished, 1);
    assert.equal(proven.decisions[0]?.originalStatus, 'satisfied');
    assert.ok(proven.decisions[0]?.witnessedResolvedEdgeIds.length);
    assert.equal(proven.policy.testResultUsed, false);
    assert.equal(proven.policy.testSourceEvidenceUsed, false);
    assert.equal(proven.policy.assertionValueProven, false);
    assert.equal(proven.policy.testReplacementProven, false);

    // Even if a consumer constructs a fake provider/semantic node with an
    // otherwise usable ID, it is not eligible source-backed proof.
    const semanticFixture = { ...graph, nodes: graph.nodes.map(item =>
      item.id === 'symbol:src/logic.ts#function:safe'
        ? { ...item, layer: 'semantic' as const } : item) };
    const fromSavedMeaning = evaluateTestIndependentSourceContract(semanticFixture, required);
    assert.equal(fromSavedMeaning.counts.sourceEstablished, 0);
    assert.equal(fromSavedMeaning.counts.unresolved, 1);
    assert.equal(fromSavedMeaning.policy.onlyCompleteSourceFilesAndResolvedCompilerOrModuleBindings, true);
    assert.ok(proven.counts.excludedTestNodes > 0);
    assert.equal(isWrittenTestSource('repo:src/intelligence/testClaimInventory.ts'), false);
    assert.equal(isWrittenTestSource('repo:tests/my-case.test.ts'), true);

    // The forbidden version has a resolved source counterexample, not a
    // conclusion that the written test passed.
    const forbidden = { version: 1, relationships: [{
      ...required.relationships[0], requirement: 'forbidden',
    }] };
    const contradicts = evaluateTestIndependentSourceContract(graph, forbidden);
    assert.equal(contradicts.counts.sourceCounterexamples, 1);
    assert.ok(contradicts.decisions[0]?.witnessedResolvedEdgeIds.length);

    // An expectation selecting a test-source edge is not independent proof.
    assert.throws(() => evaluateTestIndependentSourceContract(graph, {
      version: 1, relationships: [{
        from: 'file:tests/false-expectation.test.ts', kind: 'references-symbol',
        to: 'symbol:src/logic.ts#function:safe',
      }],
    }), /must not select written test sources/u);

    const notPresent = evaluateTestIndependentSourceContract(graph, {
      version: 1, relationships: [{
        from: 'file:src/entry.ts', kind: 'references-symbol',
        to: 'symbol:src/missing.ts#function:missing',
        requirement: 'forbidden',
      }],
    });
    assert.equal(notPresent.counts.unresolved, 1,
      'absence must remain unknown when test sources are excluded');

    const cli = await run(process.execPath, [
      path.resolve('scripts/verify-source-obligations.mjs'),
      '--repo-path', root, '--project', 'independent-fixture',
      '--contract-file', 'contracts/source.json',
      '--expected-sha', graph.repositoryRevision, '--require-established',
    ], { timeoutMs: 45000 });
    assert.equal(cli.code, 0, cli.stderr);
    const answer = JSON.parse(cli.stdout);
    assert.equal(answer.identity.graphId, proven.identity.graphId);
    assert.equal(answer.counts.sourceEstablished, 1);
    assert.equal(answer.policy.testReplacementProven, false);
    assert.ok(answer.measures.elapsedMs > 0 && answer.measures.rssBytes > 0);

    // Change only the *written test*, leaving the production source and its
    // independent static obligation unchanged.
    await fs.writeFile(path.join(root, 'tests', 'false-expectation.test.ts'),
      "test('entirely different false expectation', () => { throw Error('wrong'); });\n");
    await commit(root, 'rewrite test but keep production behavior');
    const revised = await buildLocalGraph(root, 'independent-fixture', 'W');
    const stillProven = evaluateTestIndependentSourceContract(revised, required);
    assert.equal(stillProven.counts.sourceEstablished, 1);
    assert.equal(stillProven.policy.executionObserved, false);

    // Now remove the actual production call; even though the test is still
    // present in the Git repository, it cannot satisfy the source obligation.
    await fs.writeFile(path.join(root, 'src', 'entry.ts'),
      "export function run() { return 2; }\n");
    await commit(root, 'remove actual call but leave tests');
    const changed = await buildLocalGraph(root, 'independent-fixture', 'W');
    const absent = evaluateTestIndependentSourceContract(changed, required);
    assert.equal(absent.counts.sourceEstablished, 0);
    assert.equal(absent.counts.unresolved, 1);
    assert.equal(absent.policy.sourceAbsenceNeverTreatedAsProof, true);

    // Candidate-only evidence cannot be promoted to static source proof.
    const candidateGraph = { ...graph, edges: graph.edges.map(edge =>
      proven.decisions[0]!.witnessedResolvedEdgeIds.includes(edge.id)
        ? { ...edge, status: 'candidate' as const } : edge) };
    const tentative = evaluateTestIndependentSourceContract(candidateGraph, required);
    assert.equal(tentative.counts.sourceEstablished, 0);
    assert.equal(tentative.counts.unresolved, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
