#!/usr/bin/env node
/**
 * Source-only, real-repository proof oracle for DI's first captured-system
 * execution slice. No application, database, or third-party handler is run.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { selectCapturedReturnCall } from '../dist/src/intelligence/conditionalReturnSelector.js';
import { projectSourceConditionEffects } from '../dist/src/intelligence/sourceConditionEffects.js';

const SHAS = {
  old: 'bd2ed93f7746df6fcc1fc7b88f63f5ee798a4084',
  current: '0e86857cedfc14cf7c3d12ce4df00d20909c637c',
};
function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error('Missing argument ' + name);
  return path.resolve(process.argv[index + 1]);
}
const oldRoot = argument('--old-cardforge');
const newRoot = argument('--new-cardforge');
const diRoot = argument('--di');
function gitSha(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
function read(root, relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}
function sha(source) {
  return createHash('sha256').update(source).digest('hex');
}
assert.equal(gitSha(oldRoot), SHAS.old);
assert.equal(gitSha(newRoot), SHAS.current);
const rel = 'src/infrastructure/auth/middleware.ts';
const before = read(oldRoot, rel);
const after = read(newRoot, rel);
assert.notEqual(sha(before), sha(after));
assert.equal(read(oldRoot, 'src/proxy.ts'), read(newRoot, 'src/proxy.ts'),
  'caller must truly be identical between the exact pinned revisions');
const bound = {
  'process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY': 'configured-for-source-oracle',
  'process.env.CLERK_SECRET_KEY': 'configured-for-source-oracle',
  'request.nextUrl.pathname': '/mcp/owner',
};
const select = (source, bindings) => selectCapturedReturnCall({
  sourcePath: rel, source, callable: 'cardforgeMiddleware', bindings,
});
const prior = select(before, bound);
const later = select(after, bound);
assert.equal(prior.status, 'established-conditional-selection');
assert.equal(later.status, 'established-conditional-selection');
assert.equal(prior.selectedCall, 'browserClerkHandler');
assert.equal(later.selectedCall, 'oauthClerkHandler');
const missingKey = select(after, { ...bound, 'process.env.CLERK_SECRET_KEY': null });
assert.equal(missingKey.selectedCall, 'NextResponse.next');
const unknownKeys = select(after, { 'request.nextUrl.pathname': '/mcp/owner' });
assert.equal(unknownKeys.status, 'unproven');
assert.equal(unknownKeys.selectedCall, null);
assert.equal(later.proof.externalCalleeExecutionObserved, false);
assert.equal(later.proof.environmentIndependentlyAttested, false);
// Independent test-source check. This *does not* execute the CardForge test suite.
const mockSource = read(newRoot, 'tests/product/unit/clerk-mcp-routing.test.ts');
assert.match(mockSource, /vi\.mock\(['"]@clerk\/nextjs\/server['"]/u);
assert.match(mockSource, /vi\.stubEnv\(['"]CLERK_SECRET_KEY['"]/u);
assert.match(mockSource, /it\.each\(\['\/mcp', '\/mcp\/owner'\]\)/u);
const authPath = 'src/auth.ts';
const authSource = read(diRoot, authPath);
function sourceEffect(functionName) {
  const marker = 'export function ' + functionName + '(';
  const index = authSource.indexOf(marker);
  assert.ok(index >= 0, 'missing DI auth source function: ' + functionName);
  const line = authSource.slice(0, index).split('\n').length;
  const node = {
    id: 'symbol:src/auth.ts#function:' + functionName,
    name: functionName, kind: 'function',
    sourceId: 'repo:src/auth.ts', locator: 'src/auth.ts:' + line,
    layer: 'structural', value: functionName, raw: functionName,
  };
  const graph = {
    project: 'Development-Intelligence', graphId: 'oracle-' + sha(authSource),
    repositoryRevision: gitSha(diRoot), analyzerVersion: 'native-real-source-oracle',
    nodes: [node], edges: [], coverage: { files: [{ path: authPath, status: 'complete' }] },
  };
  return projectSourceConditionEffects({ sourcePath: authPath, source: authSource, symbol: node, graph });
}
const owner = sourceEffect('authorizeOwnerWrite');
const authorize = sourceEffect('authorize');
assert.equal(owner.status, 'supported');
assert.equal(authorize.status, 'supported');
assert.ok(owner.effects.some(e => e.kind === 'return-call' && e.expression.includes('authorize')),
  'mode-none source delegates to authorize');
assert.ok(owner.branches.some(b => b.predicate.includes('mode')),
  'auth mode is a source condition');
// The source producer itself rejects higher runtime proof claims.
assert.equal(owner.proof.allPossibleExecutionPathsProven, false);
assert.equal(owner.proof.transitiveCallEffectsProven, false);
// SQL source evidence is historical; no deployed catalog may be assumed.
const migration = read(newRoot,
  'supabase/migrations/20260922194500_disambiguate_pipeline_heart_columns.sql');
assert.match(migration, /create or replace function public\.cardforge_set_pipeline_heart\(/iu);
assert.match(migration, /security invoker/iu);
assert.match(migration, /grant execute on function public\.cardforge_set_pipeline_heart[\s\S]*?to service_role/iu);
assert.match(migration, /insert into public\.cardforge_pipeline_asset_hearts/iu);
assert.match(migration, /delete from public\.cardforge_pipeline_asset_hearts/iu);
const result = {
  oldCardForgeRevision: SHAS.old, newCardForgeRevision: SHAS.current,
  middleware: {
    oldSourceSha256: sha(before), newSourceSha256: sha(after),
    unchangedProxyCallSource: true,
    oldOwnerPath: prior.selectedCall, newOwnerPath: later.selectedCall,
    missingKey: missingKey.selectedCall,
    unconfiguredSourceResult: unknownKeys.status,
    sourceOnly: true, realClerkExecutionObserved: false,
    productionConfigurationProven: false,
    mockTestSourceIdentified: true, mockTestExecutionAttested: false,
  },
  auth: {
    sourceRevision: gitSha(diRoot), ownerConditions: owner.coverage.branchTotal,
    ownerEffects: owner.coverage.effectTotal,
    delegatedCallLocated: true, transitiveEffectsProven: false,
  },
  database: {
    sourceFunctionSha256: sha(migration),
    securityInvokerDeclared: true,
    serviceRoleGrantDeclared: true,
    tableWriteOperationsDeclared: true,
    appliedSchemaObserved: false, runtimeWriteObserved: false,
  },
};
writeFileSync('captured-real-source-evidence.json', JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
