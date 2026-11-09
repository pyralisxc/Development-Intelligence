import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntelligenceGraph, GraphNode } from '../src/types.js';
import {
  projectSourceConditionEffects, querySourceConditionEffects,
  sourceConditionsAnswer,
} from '../src/intelligence/sourceConditionEffects.js';

const path = 'src/auth/middleware.ts';
const source = [
  'export const middleware = (request: Request) => {',
  '  if (!process.env.PUBLISHABLE_KEY || !process.env.SECRET_KEY) {',
  '    return NextResponse.next();',
  '  }',
  "  if (request.nextUrl.pathname === '/mcp' || request.nextUrl.pathname === '/mcp/owner') {",
  '    return oauthHandler(request);',
  '  }',
  '  return browserHandler(request);',
  '};',
].join('\n');
function graph(nodes: GraphNode[], covered = true): IntelligenceGraph {
  return {
    graphId: 'repo-exact-fixture-7', project: 'fixture',
    repositoryRevision: 'c'.repeat(40), analyzerVersion: 'source-ast-check',
    nodes, edges: [],
    coverage: { files: [{ path, status: covered ? 'complete' : 'partial' }] },
  } as unknown as IntelligenceGraph;
}
const symbol: GraphNode = {
  id: 'symbol:src/auth/middleware.ts#function:middleware',
  name: 'middleware', kind: 'function', sourceId: 'repo:' + path,
  locator: path + ':1', layer: 'structural', value: 'middleware', raw: 'middleware',
};

test('native AST predicates reveal negative-guard continuation into real OAuth/browser return sites', () => {
  const result = projectSourceConditionEffects({ sourcePath: path, source,
    graph: graph([symbol]), symbol }) as any;
  assert.equal(result.status, 'supported');
  assert.equal(result.coverage.branchTotal, 2);
  assert.equal(result.coverage.effectTotal, 3);
  assert.equal(result.coverage.completeForSupportedStatements, true);
  assert.equal(result.branches[0].trueBranchTerminates, true);
  assert.equal(result.branches[1].trueBranchTerminates, true);
  assert.match(result.branches[0].predicate, /process\.env\.PUBLISHABLE_KEY/u);
  assert.match(result.branches[0].predicate, /process\.env\.SECRET_KEY/u);
  assert.ok(!result.branches[1].predicate.includes('/mcp'),
    'arbitrary string literal content must not be reflected as evidence');
  assert.match(result.effects[0].expression, /NextResponse\.next/u);
  assert.match(result.effects[1].expression, /oauthHandler/u);
  assert.match(result.effects[2].expression, /browserHandler/u);
  assert.deepEqual(result.effects[0].requiredConditions,
    [{ conditionId: result.branches[0].id, expectedTruth: true }]);
  assert.deepEqual(result.effects[1].requiredConditions, [
    { conditionId: result.branches[0].id, expectedTruth: false },
    { conditionId: result.branches[1].id, expectedTruth: true },
  ]);
  assert.deepEqual(result.effects[2].requiredConditions, [
    { conditionId: result.branches[0].id, expectedTruth: false },
    { conditionId: result.branches[1].id, expectedTruth: false },
  ]);
  assert.equal(result.proof.actualSourceSyntaxLocated, true);
  assert.equal(result.proof.predicateSatisfiabilityProven, false);
  assert.equal(result.proof.returnOrCallRuntimeObserved, false);
  assert.equal(result.proof.testReplacementProven, false);
  assert.match(sourceConditionsAnswer(result), /not whether the conditions are true/i);
});

test('a changed guard changes the evidence fingerprint even when call sites remain unchanged', () => {
  const mutated = source.replace('!process.env.SECRET_KEY', 'process.env.SECRET_KEY');
  assert.notEqual(mutated, source);
  const old = projectSourceConditionEffects({ sourcePath: path, source,
    graph: graph([symbol]), symbol }) as any;
  const next = projectSourceConditionEffects({ sourcePath: path, source: mutated,
    graph: graph([symbol]), symbol }) as any;
  assert.notEqual(old.branches[0].predicateSha256, next.branches[0].predicateSha256);
  assert.equal(old.coverage.effectTotal, next.coverage.effectTotal);
  assert.equal(next.proof.conditionsAndEffectsIndependentlyVerifiedAtRuntime, false);
});

test('candidate inference refuses ambiguous exact callable, incomplete file and wrong subject', async () => {
  const duplicate: GraphNode = { ...symbol, id: symbol.id + '~2', locator: path + ':8' };
  const ambiguous = await querySourceConditionEffects({ graph: graph([symbol, duplicate]),
    project: 'fixture', question: 'When does middleware return true?' });
  assert.equal(ambiguous?.status, 'unproven');
  assert.equal(ambiguous?.reason, 'ambiguous-exact-callable');
  const partial = await querySourceConditionEffects({ graph: graph([symbol], false),
    project: 'fixture', question: 'What conditions govern middleware?' });
  assert.equal(partial?.status, 'unproven');
  assert.equal(partial?.reason, 'source-coverage-not-complete');
  const missing = await querySourceConditionEffects({ graph: graph([symbol]),
    project: 'fixture', question: 'Under what conditions does missingMiddleware run?' });
  assert.equal(missing, null);
  const unrelated = await querySourceConditionEffects({ graph: graph([symbol]),
    project: 'fixture', question: 'Which tests cover middleware?' });
  assert.equal(unrelated, null);
});

test('nested source branches and exception paths preserve requirements without runtime proof', () => {
  const code = [
    'export function authorizeOwnerWrite(mode: string, req: unknown) {',
    "  if (mode === 'private' || mode === 'oauth') {",
    '    if (ownerSessionValid(req)) return true;',
    '    res.writeHead(403);',
    "    throw new Error('denied');",
    '  }',
    "  if (mode === 'none') return authorize(req);",
    '  return false;',
    '}',
  ].join('\n');
  const owner: GraphNode = { ...symbol, name: 'authorizeOwnerWrite',
    id: 'symbol:src/auth/middleware.ts#function:authorizeOwnerWrite', locator: path + ':1' };
  const result = projectSourceConditionEffects({ sourcePath: path, source: code,
    graph: graph([owner]), symbol: owner }) as any;
  assert.equal(result.coverage.branchTotal, 3);
  assert.equal(result.coverage.effectTotal, 5);
  assert.ok(result.effects.some((x: any) => x.kind === 'throw' && x.requiredConditions.length === 2));
  assert.ok(result.effects.some((x: any) => /authorize\(/u.test(x.expression)));
  assert.equal(result.proof.allPossibleExecutionPathsProven, false);
  assert.equal(result.proof.transitiveCallEffectsProven, false);
});
