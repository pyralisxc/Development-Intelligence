#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { queryWorkbench } from '../dist/src/intelligence/workbench.js';
import { queryIntelligence } from '../dist/src/intelligence/assessment.js';
import { projectSourceConditionEffects } from '../dist/src/intelligence/sourceConditionEffects.js';
import { runChecked } from '../dist/src/util/process.js';

const sourceKind = process.argv[process.argv.indexOf('--source') + 1];
if (!['di', 'cardforge'].includes(sourceKind)) throw new Error('Use --source di|cardforge');
const config = sourceKind === 'di' ? {
  root: '.',
  name: 'authorizeOwnerWrite', file: 'src/auth.ts',
  question: 'Under what conditions does authorizeOwnerWrite allow owner writes, return or reject?',
  additional: 'What must be true for authorizeOwnerWrite to return true?',
  mutationBefore: "if (mode === 'none')",
  mutationAfter: "if (mode !== 'none')",
  evidenceNames: ['authorize', 'writeHead'],
  minimumBranches: 2, minimumEffects: 5,
} : {
  root: 'benchmark/cardforge',
  name: 'cardforgeMiddleware', file: 'src/infrastructure/auth/middleware.ts',
  question: 'What does cardforgeMiddleware do when the Clerk keys are missing?',
  additional: 'Under what conditions does cardforgeMiddleware invoke oauthClerkHandler or browserClerkHandler?',
  mutationBefore: '!process.env.CLERK_SECRET_KEY',
  mutationAfter: 'process.env.CLERK_SECRET_KEY',
  evidenceNames: ['NextResponse.next', 'oauthClerkHandler', 'browserClerkHandler'],
  minimumBranches: 2, minimumEffects: 3,
};

const started = Date.now();
const root = await fs.realpath(path.resolve(config.root));
const sha = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
if (sourceKind === 'cardforge') assert.equal(sha, '0e86857cedfc14cf7c3d12ce4df00d20909c637c',
  'The external source checkout must stay pinned and read-only');
const sourceText = await fs.readFile(path.join(root, config.file), 'utf8');
const parsed = ts.createSourceFile(config.file, sourceText, ts.ScriptTarget.Latest, true);
const named = [];
const visit = (node) => {
  if ((ts.isFunctionDeclaration(node) && node.name?.text === config.name)
    || (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === config.name)) {
    named.push(node);
  }
  ts.forEachChild(node, visit);
};
visit(parsed);
assert.equal(named.length, 1, 'exact independent AST declaration count');
const branchPositions = [];
const walk = node => {
  if (ts.isIfStatement(node)) branchPositions.push(node.expression.getStart(parsed));
  ts.forEachChild(node, walk);
};
walk(named[0]);
assert.ok(branchPositions.length >= config.minimumBranches, 'independent native AST branch oracle');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'di-condition-source-'));
const oldRegistry = process.env.DEVINT_PROJECTS_FILE;
const project = sourceKind === 'di' ? 'ExactDIConditions' : 'ExactCardForgeConditions';
try {
  const registry = path.join(temp, 'projects.json');
  await fs.writeFile(registry, JSON.stringify({
    [project]: {
      repository: pathToFileURL(root).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      revisionPolicy: 'repository-history',
      credential: { type: 'none' },
    },
  }));
  process.env.DEVINT_PROJECTS_FILE = registry;
  const first = await queryWorkbench({ project, ref: 'commit:' + sha, text: config.question });
  const second = await queryWorkbench({ project, ref: 'commit:' + sha, text: config.additional });
  const intelligent = await queryIntelligence({ project, ref: 'commit:' + sha, question: config.question });
  for (const answer of [first, second]) {
    assert.equal(answer.intent, 'source-condition-effects',
      'ordinary natural question must select source-exact AST, not incidental lexical neighbors');
    assert.equal(answer.result.status, 'supported');
    assert.equal(answer.result.identity.sourceRevision, sha);
    assert.equal(answer.result.identity.functionName, config.name);
    assert.equal(answer.result.identity.sourcePath, config.file);
    assert.ok(answer.result.coverage.branchTotal >= config.minimumBranches);
    assert.ok(answer.result.coverage.effectTotal >= config.minimumEffects);
    assert.equal(answer.result.proof.actualSourceSyntaxLocated, true);
    assert.equal(answer.result.proof.returnOrCallRuntimeObserved, false);
    assert.equal(answer.result.proof.allPossibleExecutionPathsProven, false);
    assert.equal(answer.result.proof.testReplacementProven, false);
    assert.equal(answer.result.proof.noSecondGraphOrSemanticHistory, true);
    assert.ok(config.evidenceNames.every(name => answer.result.effects
      .some(effect => effect.expression.includes(name))),
      'returned source effects must include grounded function-specific calls');
  }
  assert.equal(intelligent.mode, 'source-condition-effects');
  assert.equal(intelligent.conditionEffects.identity.functionId, first.result.identity.functionId);
  assert.equal(intelligent.conditionEffects.identity.sourceSha256, first.result.identity.sourceSha256);
  assert.equal(intelligent.answerStatus, 'supported');
  assert.equal(intelligent.policy.sourceSyntaxNotRuntime, true);

  const original = sourceText;
  const targetStart = named[0].getStart(parsed);
  const targetEnd = named[0].getEnd();
  const at = original.indexOf(config.mutationBefore, targetStart);
  assert.ok(at >= targetStart && at < targetEnd,
    'oracle mutation must belong to the exact selected callable, not a homonymous guard elsewhere');
  const modified = original.slice(0, at) + config.mutationAfter
    + original.slice(at + config.mutationBefore.length);
  assert.notEqual(modified, original, 'production guard mutation must affect actual source');
  const node = {
    id: first.result.identity.functionId, sourceId: 'repo:' + config.file,
    name: config.name, kind: 'function',
    layer: 'structural', locator: config.file + ':' + first.result.identity.sourceLine,
  };
  const minimumGraph = { project, graphId: first.result.identity.graphId,
    repositoryRevision: sha, analyzerVersion: 'source-ast-exact' };
  const changed = projectSourceConditionEffects({
    sourcePath: config.file, source: modified, symbol: node, graph: minimumGraph,
  });
  assert.equal(changed.status, 'supported');
  const oldHashes = first.result.branches.map(x => x.predicateSha256);
  const newHashes = changed.branches.map(x => x.predicateSha256);
  assert.notDeepEqual(oldHashes, newHashes,
    'altering a real branch predicate must be observable even if all calls still exist');
  assert.equal(changed.proof.returnOrCallRuntimeObserved, false);
  const receipt = {
    kind: sourceKind, exactGitSha: sha, currentGraphId: first.result.identity.graphId,
    sourceFile: config.file, subject: first.result.identity.functionId,
    sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
    independentAstBranches: branchPositions.length,
    sourceBranches: first.result.coverage.branchTotal,
    sourceDirectEffects: first.result.coverage.effectTotal,
    alteredBranchPredicateDetected: true,
    effects: first.result.effects.map(x => ({ kind: x.kind, line: x.sourceLine,
      requiredConditions: x.requiredConditions.length })).slice(0, 12),
    sourceSyntaxEstablished: true, runtimeExecutionObserved: false,
    branchFeasibilityProven: false, testRedundancyProven: false,
    elapsedMs: Date.now() - started, rssBytes: process.memoryUsage().rss,
  };
  await fs.writeFile('condition-effects-' + sourceKind + '.json', JSON.stringify(receipt));
  console.log(JSON.stringify(receipt));
} finally {
  if (oldRegistry === undefined) delete process.env.DEVINT_PROJECTS_FILE;
  else process.env.DEVINT_PROJECTS_FILE = oldRegistry;
  await fs.rm(temp, { recursive: true, force: true });
}
