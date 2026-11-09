#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { callTool, listTools } from '../dist/src/mcp.js';
import { runChecked } from '../dist/src/util/process.js';

const source = process.argv[process.argv.indexOf('--source') + 1];
if (source !== 'di' && source !== 'cardforge') throw new Error('Use --source di|cardforge');
const configs = {
  di: {
    root: '.',
    project: 'ExactDIBenchmark',
    base: '63eaf0d2bbe5b88d99df190aceb1eb55d69ccbab',
    head: '4ab33242c07fe8066061ab5b49b2e25dabb64c00',
    caller: 'src/http.ts', target: 'src/auth.ts', functionName: 'authorizeOwnerWrite',
    relationship: { from: 'file:src/http.ts', kind: 'references-symbol',
      to: 'symbol:src/auth.ts#function:authorizeOwnerWrite' },
    sameTree: true,
  },
  cardforge: {
    root: 'benchmark/cardforge',
    project: 'ExactCardForgeBenchmark',
    base: 'bd2ed93f7746df6fcc1fc7b88f63f5ee798a4084',
    head: '0e86857cedfc14cf7c3d12ce4df00d20909c637c',
    caller: 'src/proxy.ts', target: 'src/infrastructure/auth/middleware.ts',
    functionName: 'cardforgeMiddleware',
    relationship: { from: 'symbol:src/proxy.ts#function:proxy', kind: 'calls',
      to: 'symbol:src/infrastructure/auth/middleware.ts#function:cardforgeMiddleware' },
    sameTree: false,
  },
};
const spec = configs[source];
const root = await fs.realpath(spec.root);
const rootSha = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
if (source === 'cardforge') assert.equal(rootSha, spec.head,
  'read-only external acceptance must use the pinned CardForge head SHA');

// A separate TypeScript AST oracle reads only the production source, not tests.
const [callerText, targetText] = await Promise.all([
  fs.readFile(path.join(root, spec.caller), 'utf8'),
  fs.readFile(path.join(root, spec.target), 'utf8'),
]);
const callerTree = ts.createSourceFile(spec.caller, callerText, ts.ScriptTarget.Latest, true);
const targetTree = ts.createSourceFile(spec.target, targetText, ts.ScriptTarget.Latest, true);
let actualCall = 0, actualTarget = 0;
function visit(node, fn) { fn(node); ts.forEachChild(node, child => visit(child, fn)); }
visit(callerTree, node => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === spec.functionName) actualCall++;
});
visit(targetTree, node => {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node))
    && node.name && ts.isIdentifier(node.name)
    && node.name.text === spec.functionName) actualTarget++;
});
assert.ok(actualCall >= 1 && actualTarget >= 1,
  'independent source oracle must find call and exact named declaration');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'di-real-revision-evidence-'));
const before = process.env.DEVINT_PROJECTS_FILE;
try {
  const configPath = path.join(temp, 'projects.json');
  await fs.writeFile(configPath, JSON.stringify({
    [spec.project]: {
      repository: pathToFileURL(root).href,
      defaultRef: 'refs/heads/main',
      allowedRefs: ['refs/heads/main'],
      revisionPolicy: 'repository-history',
      credential: { type: 'none' },
    },
  }));
  process.env.DEVINT_PROJECTS_FILE = configPath;
  const contract = { version: 1, relationships: [
    { ...spec.relationship, requirement: 'required' },
  ] };
  const result = await callTool('assess_revision_evidence', {
    project: spec.project,
    baseRef: 'commit:' + spec.base, ref: 'commit:' + spec.head, contract,
    // This intentionally FAKED historical claim is a negative attestation oracle.
    priorTestRun: {
      runId: 'not-a-verified-provider-run',
      claimedSourceRevision: spec.base, reportedOutcome: 'pass',
      reportDigest: 'a'.repeat(64),
    },
  });
  assert.ok(listTools().some(tool => tool.name === 'assess_revision_evidence'
    && tool.annotations?.readOnlyHint === true));
  assert.equal(result.identity.base.sha, spec.base);
  assert.equal(result.identity.head.sha, spec.head);
  assert.equal(result.source.sameTrackedGitTree, spec.sameTree);
  assert.equal(result.source.completeChangePopulation, true);
  assert.equal(result.source.obligations.length, 1);
  assert.equal(result.source.obligations[0].outcome, 'source-fact-independently-reestablished');
  assert.ok(result.source.obligations[0].currentResolvedWitnesses.length);
  assert.equal(result.source.obligations[0].provesBehavioralTestReplacement, false);
  assert.equal(result.priorTestRun.reportedOutcome, 'pass');
  assert.equal(result.priorTestRun.applicability, 'historical-report-only');
  assert.equal(result.priorTestRun.provenanceStatus, 'caller-supplied-unattested-reference');
  assert.equal(result.priorTestRun.reportDigestAuthenticated, false);
  assert.equal(result.priorTestRun.currentRuntimeExecutionProven, false);
  assert.equal(result.priorTestRun.expectedValueIndependentlyProven, false);
  assert.ok(result.nextChecks.some(check => check.kind === 'runtime-execution'));
  assert.equal(result.controlFlow.conditionsAndEffectsIndependentlyVerified, false);
  assert.equal(result.controlFlow.transitiveDependencyClosureProven, false);
  assert.equal(result.database.appliedMigrationStateVerified, false);
  assert.equal(result.database.liveDatabaseStateVerified, false);
  assert.equal(result.policy.noAutomaticTestDeletion, true);
  if (source === 'di') {
    assert.equal(result.source.trackedSourceChanges, 0);
    assert.equal(result.controlFlow.needsIndependentBehavioralRecheck, false);
    assert.equal(result.database.changedSqlOrMigrationPaths.length, 0);
    assert.equal(result.nextChecks.some(check => check.kind === 'database-state'), false);
  } else {
    assert.ok(result.source.trackedSourceChanges >= 10,
      'real CardForge history must include many non-identical paths');
    assert.ok(result.database.changedSqlOrMigrationPaths.length > 0,
      'real CardForge history must show migration source changes');
    assert.ok(result.nextChecks.some(check => check.kind === 'database-state'));
    assert.ok(result.nextChecks.some(check => check.kind === 'condition-effect'));
    assert.equal(result.controlFlow.needsIndependentBehavioralRecheck, true);
  }
  const receipt = {
    source, immutableBase: spec.base, immutableHead: spec.head,
    graphIdentity: { base: result.identity.base.graphId, head: result.identity.head.graphId },
    staticSourceOracle: { directCalls: actualCall, declarations: actualTarget },
    changedPaths: result.source.trackedSourceChanges,
    migrationChangedPaths: result.database.changedSqlOrMigrationPaths.length,
    sameTrackedGitTree: result.source.sameTrackedGitTree,
    sourceObligations: result.source.obligations.map(item => ({
      outcome: item.outcome, witnessCount: item.currentResolvedWitnesses.length,
      testReplacementProven: item.provesBehavioralTestReplacement,
    })),
    historicalRun: { status: result.priorTestRun.provenanceStatus,
      currentRuntimeExecutionProven: result.priorTestRun.currentRuntimeExecutionProven },
    outstandingChecks: result.nextChecks.map(item => item.kind),
    externalLiveDatabaseVerified: result.database.liveDatabaseStateVerified,
    policy: result.policy,
  };
  await fs.writeFile('revision-evidence-' + source + '.json', JSON.stringify(receipt));
  console.log(JSON.stringify(receipt));
} finally {
  if (before === undefined) delete process.env.DEVINT_PROJECTS_FILE;
  else process.env.DEVINT_PROJECTS_FILE = before;
  await fs.rm(temp, { recursive: true, force: true });
}
