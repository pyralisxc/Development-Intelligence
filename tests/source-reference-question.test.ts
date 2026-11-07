import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecked } from '../src/util/process.js';
import { clearGraphCache } from '../src/intelligence/service.js';
import { callTool } from '../src/mcp.js';
import { parseSourceReferenceQuestion } from '../src/intelligence/sourceReferenceQuestion.js';

test('ordinary source-reference questions reuse exact compiler graph proof in investigate and query_intelligence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-source-reference-'));
  const source = path.join(root, 'source');
  const bare = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const original = process.env.DEVINT_PROJECTS_FILE;
  try {
    await fs.mkdir(path.join(source, 'src'), { recursive: true });
    await runChecked('git', ['init', '--initial-branch=main', source]);
    await fs.writeFile(path.join(source, 'src', 'impl.ts'), [
      'export function provideAnswer(value: number): number { return value + 1; }',
      'export function provideAnswerExtra(value: number): number { return value + 2; }', '',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'src', 'http.ts'), [
      "import { provideAnswer } from './impl.js';",
      'export function handleRequest() { return provideAnswer(42); }', '',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'src', 'mcp.ts'), [
      "import { provideAnswer } from './impl.js';",
      'export function handleMcp() { return provideAnswer(7); }', '',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'src', 'adjacent.ts'),
      'export function unrelated() { return 1; }\n');
    await runChecked('git', ['-C', source, 'add', '.']);
    await runChecked('git', ['-C', source,
      '-c', 'user.email=di@example.invalid', '-c', 'user.name=DI Test',
      'commit', '-m', 'source relationship fixture']);
    const sha = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    await runChecked('git', ['init', '--bare', bare]);
    await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(bare).href]);
    await runChecked('git', ['-C', source, 'push', '--all', 'origin']);
    await fs.writeFile(config, JSON.stringify({ SourceReferenceFixture: {
      repository: pathToFileURL(bare).href,
      defaultRef: 'refs/heads/main', allowedRefs: ['refs/heads/main'],
      revisionPolicy: 'repository-history', credential: { type: 'none' },
    }}));
    process.env.DEVINT_PROJECTS_FILE = config;
    clearGraphCache();

    const selected = { project: 'SourceReferenceFixture', ref: 'commit:' + sha };
    assert.equal(parseSourceReferenceQuestion('Which functions does src/http.ts call?'), null,
      'broad file traversal questions must retain their existing routes');
    const question = 'Where in src/http.ts is provideAnswer referenced or called, and which exact declaration does it resolve to?';
    const direct = await callTool('search_graph',
      { ...selected, query: 'provideAnswer', limit: 100 }) as any;
    const exact = direct.edges.find((edge: any) =>
      edge.from === 'file:src/http.ts'
      && edge.kind === 'references-symbol'
      && edge.strategy === 'typescript-checker-symbol.v1'
      && edge.status === 'resolved'
      && edge.to === 'symbol:src/impl.ts#function:provideAnswer');
    assert.ok(exact, 'the selected graph must independently prove the exact TypeChecker link');
    assert.ok(exact.evidence.includes('src/http.ts:2:42'));
    assert.ok(exact.evidence.includes('src/impl.ts:1'));

    const investigated = await callTool('investigate', { ...selected, question }) as any;
    const assessed = await callTool('query_intelligence', { ...selected, question }) as any;
    assert.equal(investigated.intent, 'source-relationship');
    assert.equal(investigated.routing.tool, 'canonical-graph-relationships');
    assert.equal(investigated.answerClassification, 'established-bounded');
    assert.equal(investigated.result.status, 'supported');
    assert.equal(investigated.result.sourcePath, 'src/http.ts');
    assert.equal(investigated.result.targetNodeId, exact.to);
    assert.ok(investigated.result.edges.some((edge: any) => edge.id === exact.id));
    assert.match(investigated.answer, /src\/http\.ts:2:42/u);
    assert.match(investigated.answer, /src\/impl\.ts:1/u);
    assert.match(investigated.answer, /does not establish runtime invocation/u);
    assert.equal(assessed.mode, 'source-relationship');
    assert.equal(assessed.answerStatus, 'supported');
    assert.ok(assessed.claims.some((c: any) =>
      c.type === 'relationship-resolved' && c.status === 'supported'
      && c.proof.edgeIds.includes(exact.id)));
    assert.equal(assessed.sourceRelationship.sourcePath, 'src/http.ts');
    assert.equal(assessed.sourceRelationship.targetNodeId, exact.to);
    assert.equal(direct.graphId, investigated.result.graphId);
    assert.equal(direct.graphId, assessed.graphId);
    assert.equal(direct.revision, assessed.revision);
    assert.equal(investigated.result.analyzerVersion, assessed.analyzerVersion);

    for (const [label, counterexample, expectedReason] of [
      ['missing target', 'Where in src/http.ts is provideAnswerMissing referenced?', 'no-resolved-reference'],
      ['other file', 'Where in src/adjacent.ts is provideAnswer referenced?', 'no-resolved-reference'],
      ['nearby symbol', 'Where in src/http.ts is provideAnswerExtra referenced?', 'no-resolved-reference'],
      ['missing file', 'Where in src/missing.ts is provideAnswer referenced?', 'source-unavailable'],
      ['ambiguous target', 'Where in src/http.ts are provideAnswer and provideAnswerExtra referenced?', 'ambiguous-symbol'],
    ]) {
      const [negativeInvestigation, negativeAssessment] = await Promise.all([
        callTool('investigate', { ...selected, question: counterexample }),
        callTool('query_intelligence', { ...selected, question: counterexample }),
      ]) as any[];
      assert.equal(negativeInvestigation.intent, 'source-relationship', label);
      assert.equal(negativeInvestigation.result.status, 'unproven', label);
      assert.equal(negativeInvestigation.result.reason, expectedReason, label);
      assert.equal(negativeInvestigation.answerClassification, 'evidence-only', label);
      assert.equal(negativeAssessment.answerStatus, 'unproven', label);
      assert.deepEqual(negativeAssessment.claims[0].proof.edgeIds, [], label);
      assert.equal(negativeAssessment.sourceRelationship.reason, expectedReason, label);
      assert.equal(negativeAssessment.graphId, direct.graphId, label);
    }
    const outOfScope = await callTool('investigate', {
      ...selected, question: 'Where in src/http.ts is provideAnswer referenced?',
      scope: 'src/mcp.ts',
    }) as any;
    assert.equal(outOfScope.result.status, 'unproven');
    assert.equal(outOfScope.result.reason, 'out-of-scope');
    assert.equal(outOfScope.result.coverage.absenceProven, false);
    const facetRequest = await callTool('query_intelligence', {
      ...selected, question, requiredFacets: ['provider'],
    }) as any;
    assert.notEqual(facetRequest.mode, 'source-relationship',
      'caller-provided realization requirements must not be silently dropped');
    const again = await callTool('query_intelligence', { ...selected, question }) as any;
    assert.deepEqual(again.claims.map((c: any) => c.id), assessed.claims.map((c: any) => c.id),
      'same question, source revision and analyzer must preserve proof identity');
  } finally {
    if (original === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = original;
    clearGraphCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
