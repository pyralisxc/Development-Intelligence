import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecked } from '../src/util/process.js';
import { clearGraphCache } from '../src/intelligence/service.js';
import { callTool } from '../src/mcp.js';
import { parseSourceReferenceQuestion, parseFileOutboundQuestion, fileOutboundProjection } from '../src/intelligence/sourceReferenceQuestion.js';
import { currentGraph } from '../src/intelligence/service.js';

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
    await fs.writeFile(path.join(source, 'src', 'noCalls.ts'),
      "import { provideAnswer } from './impl.js';\nvoid provideAnswer;\n");
    await fs.writeFile(path.join(source, 'src', 'batchFunctions.ts'),
      Array.from({ length: 26 }, (_, index) =>
        'export function batch' + index + '(): number { return ' + index + '; }\n').join(''));
    await fs.writeFile(path.join(source, 'src', 'manyCalls.ts'),
      'import { ' + Array.from({ length: 26 }, (_, index) => 'batch' + index).join(', ')
      + " } from './batchFunctions.js';\n"
      + 'export function manyCalls(): number { return '
      + Array.from({ length: 26 }, (_, index) => 'batch' + index + '()').join(' + ') + '; }\n');
    await fs.writeFile(path.join(source, 'src', 'left.ts'),
      'export function duplicateName(): number { return 1; }\n');
    await fs.writeFile(path.join(source, 'src', 'right.ts'),
      'export function duplicateName(): number { return 2; }\n');
    await fs.writeFile(path.join(source, 'src', 'sameNameCalls.ts'),
      "import { duplicateName as left } from './left.js';\n"
      + "import { duplicateName as right } from './right.js';\n"
      + 'export function both() { return left() + right(); }\n');
    await fs.mkdir(path.join(source, 'tests'), { recursive: true });
    await fs.writeFile(path.join(source, 'tests', 'reference.test.ts'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { provideAnswer } from '../src/impl.js';",
      "test('referenced function', () => {",
      ...Array.from({ length: 8 }, (_, i) =>
        '  assert.equal(provideAnswer(' + (i + 1) + '), ' + (i + 2) + ');'),
      '});', '',
    ].join('\n'));
    await fs.writeFile(path.join(source, 'tests', 'importOnly.test.ts'), [
      "import { unrelated } from '../src/adjacent.js';",
      'void unrelated;', '',
    ].join('\n'));
    // More than the default 20 response rows: each file must have a true
    // compiler-resolved call, not a misleading import or name match.
    await Promise.all(Array.from({ length: 24 }, (_, i) =>
      fs.writeFile(path.join(source, 'tests', 'z-extra-' + String(i).padStart(3, '0') + '.test.ts'), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { provideAnswer } from '../src/impl.js';",
        "test('native source call " + i + "', () => { assert.equal(provideAnswer(" + i + "), " + (i + 1) + "); });",
        '',
      ].join('\n'))));
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

    // A real held-out test call is already resolved by the compiler; ordinary
    // questions should use the SAME graph edge without claiming runtime proof.
    const testQuestion = 'Which tests cover provideAnswer?';
    const testDirect = await callTool('trace_path', {
      ...selected, node: 'symbol:src/impl.ts#function:provideAnswer',
      direction: 'inbound', depth: 1,
      relationshipKinds: ['references-symbol'], status: ['resolved'], limit: 100,
    }) as any;
    const compilerTestEdge = testDirect.edges.find((edge: any) =>
      edge.from === 'file:tests/reference.test.ts'
      && edge.to === 'symbol:src/impl.ts#function:provideAnswer'
      && edge.strategy === 'typescript-checker-symbol.v1'
      && edge.status === 'resolved');
    assert.ok(compilerTestEdge, 'the real exact-source compiler must independently prove the test call');
    const [testInvestigation, testAssessment] = await Promise.all([
      callTool('investigate', { ...selected, question: testQuestion }),
      callTool('query_intelligence', { ...selected, question: testQuestion }),
    ]) as any[];
    assert.equal(testInvestigation.intent, 'test-source-links');
    assert.equal(testInvestigation.answerClassification, 'established-bounded');
    assert.equal(testInvestigation.result.status, 'supported');
    assert.equal(testInvestigation.result.totalTestFiles, 25);
    assert.equal(testInvestigation.result.returnedTestFiles, 20);
    assert.equal(testInvestigation.result.testFilesTruncated, true);
    assert.equal(testInvestigation.result.callsiteEvidenceTruncated, true);
    assert.equal(testInvestigation.result.tests[0]?.path, 'tests/reference.test.ts');
    assert.match(testInvestigation.answer, /additional source-linked test file\(s\) are omitted/u);
    const exhaustive = await callTool('investigate', {
      ...selected, question: testQuestion, semanticDepth: 'exhaustive',
    }) as any;
    assert.equal(exhaustive.intent, 'test-source-links');
    assert.equal(exhaustive.result.totalTestFiles, 25);
    assert.equal(exhaustive.result.returnedTestFiles, 25);
    assert.equal(exhaustive.result.testFilesTruncated, false,
      'exhaustive mode must not preserve the artificial 20-file ceiling');
    assert.equal(exhaustive.result.callsiteEvidenceTruncated, true,
      'separate callsite presentation omission from test-file completeness');
    assert.equal(exhaustive.result.tests.length, 25);
    assert.equal(exhaustive.result.graphId, testInvestigation.result.graphId);
    assert.ok(exhaustive.result.totalCallsites > exhaustive.result.returnedCallsites,
      'one compiler edge may hold many exact source callsite locations');
    assert.match(exhaustive.answer, /source callsite\(s\) and .*relationship edge\(s\) are omitted/u);
    assert.doesNotMatch(exhaustive.answer, /not an exhaustive test listing/u);
    assert.equal(testInvestigation.result.tests[0].compilerVerified, true);
    assert.equal(testInvestigation.result.executionObserved, false);
    assert.equal(testInvestigation.result.assertionBehaviorEstablished, false);
    assert.match(testInvestigation.answer, /does not prove that the test ran/u);
    assert.equal(testAssessment.mode, 'test-source-links');
    assert.equal(testAssessment.answerStatus, 'supported');
    assert.ok(testAssessment.claims[0].proof.edgeIds.some((id: string) =>
      testDirect.edges.some((edge: any) => edge.id === id
        && edge.from === 'file:tests/reference.test.ts'
        && edge.strategy === 'typescript-checker-symbol.v1')),
      'bounded source proof must be an exact independently resolved compiler edge');
    assert.equal(testDirect.graphId, testAssessment.graphId);
    assert.equal(testAssessment.graphId, testInvestigation.result.graphId);

    for (const [negative, expectedReason] of [
      ['Which tests cover provideAnswerExtra?', 'no-resolved-test-call'],
      ['Which tests cover unrelated?', 'no-resolved-test-call'],
      ['Which tests cover absentFunctionXYZ?', 'missing-target'],
      ['Which tests cover duplicateName?', 'ambiguous-target'],
    ]) {
      const [unknownInvestigation, unknownAssessment] = await Promise.all([
        callTool('investigate', { ...selected, question: negative }),
        callTool('query_intelligence', { ...selected, question: negative }),
      ]) as any[];
      assert.equal(unknownInvestigation.intent, 'test-source-links', negative);
      assert.equal(unknownInvestigation.result.reason, expectedReason, negative);
      assert.equal(unknownInvestigation.result.coverage.absenceProven, false, negative);
      assert.equal(unknownAssessment.answerStatus, 'unproven', negative);
      assert.deepEqual(unknownAssessment.claims[0].proof.edgeIds, [], negative);
    }
    const wrongTestScope = await callTool('investigate', {
      ...selected, question: testQuestion, scope: 'src/http.ts',
    }) as any;
    assert.equal(wrongTestScope.result.reason, 'out-of-scope');
    assert.equal(wrongTestScope.answerClassification, 'evidence-only');
    const requiredFacet = await callTool('query_intelligence', {
      ...selected, question: testQuestion, requiredFacets: ['provider'],
    }) as any;
    assert.notEqual(requiredFacet.mode, 'test-source-links');
    const repeatedTest = await callTool('query_intelligence',
      { ...selected, question: testQuestion }) as any;
    assert.deepEqual(repeatedTest.claims.map((item: any) => item.id),
      testAssessment.claims.map((item: any) => item.id),
      'same source graph must give deterministic relationship proof identity');

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

    // Broad file-as-caller questions have a different subject from the exact
    // named target handled above; no lexical "functions src/http.ts" node.
    const broadQuestion = 'Which functions does src/http.ts call?';
    assert.deepEqual(parseFileOutboundQuestion(broadQuestion), { paths: ['src/http.ts'] });
    assert.equal(parseFileOutboundQuestion('What calls src/http.ts?'), null,
      'inbound questions must not be redirected as outbound source calls');
    assert.equal(parseFileOutboundQuestion('Where is src/http.ts implemented?'), null);
    const directFile = await callTool('trace_path', {
      ...selected, node: 'file:src/http.ts', direction: 'outbound',
      depth: 1, relationshipKinds: ['references-symbol'], status: ['resolved'], limit: 100,
    }) as any;
    const directLink = directFile.edges.find((edge: any) =>
      edge.from === 'file:src/http.ts' && edge.to === exact.to
      && edge.kind === 'references-symbol' && edge.status === 'resolved');
    assert.ok(directLink, 'direct graph traversal must establish the original exact call evidence');
    const [broadInvestigate, broadIntelligence] = await Promise.all([
      callTool('investigate', { ...selected, question: broadQuestion }),
      callTool('query_intelligence', { ...selected, question: broadQuestion }),
    ]) as any[];
    assert.equal(broadInvestigate.intent, 'file-outbound');
    assert.equal(broadInvestigate.routing.direction, 'outbound');
    assert.equal(broadInvestigate.subject.id, 'file:src/http.ts');
    assert.equal(broadInvestigate.answerClassification, 'established-bounded');
    assert.equal(broadInvestigate.result.direction, 'outbound');
    assert.equal(broadInvestigate.result.status, 'supported');
    assert.ok(broadInvestigate.result.targets.some((target: any) =>
      target.id === exact.to && target.callsites.includes('src/http.ts:2:42')
      && target.declaration === 'src/impl.ts:1' && target.compilerVerified));
    assert.ok(broadInvestigate.result.edges.some((edge: any) => edge.id === exact.id));
    assert.equal(broadIntelligence.answerStatus, 'supported');
    assert.equal(broadIntelligence.mode, 'file-outbound');
    assert.ok(broadIntelligence.claims.some((c: any) =>
      c.type === 'relationship-resolved' && c.status === 'supported'
      && c.proof.edgeIds.includes(exact.id)));
    assert.equal(directFile.graphId, broadIntelligence.graphId);
    assert.equal(directFile.graphId, broadInvestigate.result.graphId);
    assert.equal(directFile.revision, broadIntelligence.revision);
    assert.equal(broadInvestigate.result.analyzerVersion, broadIntelligence.analyzerVersion);
    assert.match(broadInvestigate.answer, /src\/http\.ts:2:42/u);
    assert.match(broadInvestigate.answer, /src\/impl\.ts:1/u);
    assert.match(broadInvestigate.answer, /do not establish runtime invocation/u);

    for (const [name, broadNegative, reason] of [
      ['missing file', 'Which functions does src/httpp.ts call?', 'source-unavailable'],
      ['wrong caller', 'Which functions does src/noCalls.ts call?', 'no-resolved-outbound'],
      ['nearby file', 'Show calls from src/httpExtra.ts', 'source-unavailable'],
      ['ambiguous files', 'Which functions do src/http.ts and src/mcp.ts call?', 'ambiguous-source'],
    ]) {
      const [investigated, assessed] = await Promise.all([
        callTool('investigate', { ...selected, question: broadNegative }),
        callTool('query_intelligence', { ...selected, question: broadNegative }),
      ]) as any[];
      assert.equal(investigated.intent, 'file-outbound', name);
      assert.equal(investigated.result.reason, reason, name);
      assert.equal(investigated.result.status, 'unproven', name);
      assert.equal(investigated.result.coverage.absenceProven, false, name);
      assert.equal(assessed.answerStatus, 'unproven', name);
      assert.equal(assessed.fileOutbound.reason, reason, name);
      assert.deepEqual(assessed.claims[0].proof.edgeIds, [], name);
      assert.equal(assessed.graphId, directFile.graphId, name);
    }
    const wrongScope = await callTool('investigate', {
      ...selected, question: broadQuestion, scope: 'src/mcp.ts',
    }) as any;
    assert.equal(wrongScope.result.reason, 'out-of-scope');
    assert.equal(wrongScope.result.status, 'unproven');

    const boundedQuestion = 'Which functions does src/manyCalls.ts call?';
    const bounded = await callTool('investigate', { ...selected, question: boundedQuestion }) as any;
    assert.equal(bounded.result.status, 'supported');
    assert.equal(bounded.result.totalTargets, 26);
    assert.equal(bounded.result.returnedTargets, 20);
    assert.equal(bounded.result.truncated, true);
    assert.ok(bounded.result.targets.every((target: any) =>
      target.callsites.some((site: string) => site.startsWith('src/manyCalls.ts:'))
      && target.declaration.startsWith('src/batchFunctions.ts:')));
    assert.equal(bounded.result.direction, 'outbound');
    assert.match(bounded.answer, /not an exhaustive callee inventory/u);
    const distinctDeclarations = await callTool('investigate', {
      ...selected, question: 'Which functions does src/sameNameCalls.ts call?',
    }) as any;
    const duplicates = distinctDeclarations.result.targets.filter(
      (target: any) => target.name === 'duplicateName');
    assert.equal(duplicates.length, 2,
      'same-name functions in different source files must remain distinct declarations');
    assert.equal(new Set(duplicates.map((target: any) => target.id)).size, 2);
    assert.ok(duplicates.some((target: any) => target.declaration.startsWith('src/left.ts:')));
    assert.ok(duplicates.some((target: any) => target.declaration.startsWith('src/right.ts:')));
    const sameBounded = await callTool('query_intelligence',
      { ...selected, question: boundedQuestion }) as any;
    assert.equal(sameBounded.fileOutbound.totalTargets, 26);
    assert.equal(sameBounded.fileOutbound.truncated, true);
    assert.equal(sameBounded.answerStatus, 'supported');
    assert.ok(sameBounded.claims[0].proof.edgeIds.length > 0,
      'the compact assessment must retain actual accepted source proof');
    const graph = await currentGraph(selected.project, selected.ref);
    // Explicitly inject an unproven source relationship into an immutable
    // independent fixture; the canonical projection must not upgrade it.
    const unprovenGraph = { ...graph, edges: [...graph.edges, {
      id: 'fixture:candidate-outbound', from: 'file:src/noCalls.ts',
      to: exact.to, kind: 'references-symbol' as const,
      status: 'candidate' as const, confidence: null, strategy: 'fixture',
      layer: 'structural' as const, checkpoint: false, evidenceIds: [],
      evidence: ['src/noCalls.ts:2:1', 'src/impl.ts:1'],
    }] };
    const unknownCandidate = fileOutboundProjection(unprovenGraph, { paths: ['src/noCalls.ts'] });
    assert.equal(unknownCandidate.status, 'unproven');
    assert.equal(unknownCandidate.totalTargets, 0);
    assert.equal(unknownCandidate.edges.length, 0);
    assert.ok(unknownCandidate.unprovenRelationships >= 1);
    const slice = fileOutboundProjection(graph, { paths: ['src/manyCalls.ts'] }, undefined, 3);
    assert.equal(slice.totalTargets, 26);
    assert.equal(slice.returnedTargets, 3);
    assert.equal(slice.truncated, true);
    const facet = await callTool('query_intelligence', {
      ...selected, question: broadQuestion, requiredFacets: ['provider'],
    }) as any;
    assert.notEqual(facet.mode, 'file-outbound',
      'caller-owned required facets remain a distinct capability question');

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
