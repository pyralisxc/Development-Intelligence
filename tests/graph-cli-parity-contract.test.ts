import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run, runChecked } from '../src/util/process.js';
import { ANALYZER_VERSION } from '../src/intelligence/repository.js';

const cli = path.resolve('dist/src/graphCli.js');
const ownerSource = `export function registerOwnerTools(server: any) {
  server.registerTool('get_owner_site_snapshot', {}, async () => ({ ok: true }));
}
`;
const renamedOwnerSource = `export function registerOwnerTools(server: any) {
  // Decoy only: 'get_owner_site_snapshot' is no longer a registration.
  server.registerTool('get_owner_site_snapshot_renamed', {}, async () => ({ ok: true }));
}
`;
const ownerTestSource = "import { readFileSync } from 'node:fs';\nimport { expect, test } from 'vitest';\ntest('registration', () => { const tools = readFileSync('src/owner.ts', 'utf8'); expect(tools).toContain(\"'get_owner_site_snapshot'\"); });\n";
const contract = {
  version: 1,
  name: 'Owner snapshot registration',
  predicates: [{
    id: 'owner-get-snapshot-is-registered',
    type: 'reachability',
    from: { ids: ['mcp:get_owner_site_snapshot'] },
    to: { kinds: ['mcp-tool'], sourceIds: ['repo:src/owner.ts'] },
    requirement: 'required',
    quantifier: 'any',
    direction: 'outbound',
    relationshipKinds: ['registered-as'],
    maxDepth: 1,
    scopeSourceIds: ['src/owner.ts'],
  }],
};

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-cli-parity-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'owner.ts'), ownerSource);
  await fs.writeFile(path.join(root, 'tests', 'owner.test.ts'), ownerTestSource);
  await fs.writeFile(path.join(root, 'tests', 'custom-guard.test.ts'), "const assert = (condition: boolean) => { if (!condition) throw new Error('guard'); };\nassert(process.env.LOCAL_READY === '1');\n");
  await fs.writeFile(path.join(root, 'tests', 'playwright-modifiers.test.ts'), "import { expect, test } from '@playwright/test';\ntest('modifier accounting', async () => { await expect.poll(() => 1).toBe(1); expect.soft(2).toBe(2); });\n");
  await fs.writeFile(path.join(root, 'tests', 'schema.sql'), 'select 1;\n');
  await fs.writeFile(path.join(root, 'parity.json'), `${JSON.stringify(contract, null, 2)}\n`);
  await runChecked('git', ['-C', root, 'add', '.']);
  await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
  const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const expression = `expect(tools).toContain("'get_owner_site_snapshot'")`;
  const start = ownerTestSource.indexOf(expression);
  const declarationStart = ownerTestSource.indexOf("test('registration'");
  const declarationExpression = ownerTestSource.slice(declarationStart).trim().replace(/;$/u, '');
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  await fs.writeFile(path.join(root, 'claims.json'), `${JSON.stringify({ version: 1, revision, analyzerVersion: ANALYZER_VERSION, scope: { sourcePrefixes: ['tests/'], sourceSuffixes: ['.test.ts'] }, files: [{ sourceId: 'tests/owner.test.ts', contentSha256: sha(ownerTestSource), declarationIds: ['test:owner-registration'], assertionIds: ['assert:owner-registration'], disposition: 'analyzed' }], declarations: [{ id: 'test:owner-registration', sourceId: 'tests/owner.test.ts', start: declarationStart, end: declarationStart + declarationExpression.length, spanSha256: sha(declarationExpression), title: 'registration', dynamic: false }], assertions: [{ id: 'assert:owner-registration', sourceId: 'tests/owner.test.ts', start, end: start + expression.length, spanSha256: sha(expression), dynamic: false }], claims: [{ id: 'owner-registration-source-assertion', originalClaim: 'Owner snapshot tool is registered', equivalenceRationale: 'The required registered-as predicate covers source membership in the same direction.', assertionIds: ['assert:owner-registration'], parityClaimIds: ['owner-get-snapshot-is-registered'], productionSourceIds: ['src/owner.ts'] }] }, null, 2)}\n`);
  return root;
}

async function analyze(root: string, contractPath?: string, catalogPath?: string, report = false) {
  return await run(process.execPath, [
    cli,
    'analyze',
    '--repo-path', root,
    '--project', 'fixture/project',
    ...(contractPath ? ['--parity-contract', contractPath] : []),
    ...(catalogPath ? ['--test-claim-catalog', catalogPath] : []),
    ...(report ? ['--test-claim-report-path', '.development-intelligence/test-claims', '--producer-commit', 'c'.repeat(40)] : []),
  ]);
}

test('analyze preserves no-contract behavior and gates a supplied registration contract against the same graph', async () => {
  const root = await fixture();
  try {
    const ordinary = await analyze(root);
    assert.equal(ordinary.code, 0, ordinary.stderr);
    const ordinaryReceipt = JSON.parse(ordinary.stdout);
    assert.equal(ordinaryReceipt.valid, true);
    assert.equal('parityContract' in ordinaryReceipt, false, 'omitting the contract must preserve the ordinary receipt');

    const passing = await analyze(root, 'parity.json');
    assert.equal(passing.code, 0, passing.stderr);
    const passingReceipt = JSON.parse(passing.stdout);
    assert.equal(passingReceipt.valid, true);
    assert.equal(passingReceipt.parityContract.path, 'parity.json');
    assert.equal(passingReceipt.parityContract.valid, true);
    assert.equal(passingReceipt.parityContract.claims[0].status, 'satisfied');
    assert.equal(passingReceipt.parityContract.claims[0].qualified, true);
    assert.equal(passingReceipt.parityContract.claims[0].replacementEligible, true);

    await fs.writeFile(path.join(root, 'src', 'owner.ts'), renamedOwnerSource);
    const failing = await analyze(root, 'parity.json');
    assert.equal(failing.code, 1, failing.stderr);
    const failingReceipt = JSON.parse(failing.stdout);
    assert.equal(failingReceipt.valid, false);
    assert.equal(failingReceipt.parityContract.valid, false);
    assert.equal(failingReceipt.parityContract.claims[0].status, 'not-applicable');
    assert.match(failingReceipt.parityContract.claims[0].blockers.join('\n'), /mcp:get_owner_site_snapshot/u);
    assert.match(await fs.readFile(path.join(root, 'src', 'owner.ts'), 'utf8'), /Decoy only: 'get_owner_site_snapshot'/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyze emits a revision-bound whole-suite decision record over the same evaluated graph', async () => {
  const root = await fixture();
  try {
    const result = await analyze(root, 'parity.json', 'claims.json', true);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.testClaimDecisionRecord.revision, receipt.revision);
    assert.equal(receipt.testClaimDecisionRecord.graphId, receipt.graphId);
    assert.equal(receipt.testClaimDecisionRecord.counts.assertions, 1);
    assert.equal(receipt.testClaimDecisionRecord.claims[0].outcome, 'partial-overlap');
    assert.equal(receipt.testClaimDecisionRecord.claims[0].staticReplacementEquivalent, false);
    assert.equal(receipt.testClaimDecisionRecord.claims[0].maintainedCompositeEquivalent, true);
    assert.equal(receipt.testClaimDecisionRecord.nativeObligations[0].maintainedComposite.satisfied, true);
    assert.equal(receipt.testClaimDecisionRecord.nativeObligations[0].directionalReplacementProven, false);
    assert.equal(receipt.testClaimDecisionRecord.nativeObligations[0].graphInterpretation.status, 'satisfied');
    assert.equal(receipt.testClaimDecisionRecord.policy.recommendsDeletion, false);
    assert.equal(receipt.testClaimReport.sourceRevision, receipt.revision);
    assert.equal(receipt.testClaimReport.producerCommit, 'c'.repeat(40));
    const page = await run(process.execPath, [cli, 'test-claims', '--repo-path', root, '--project', 'fixture/project', '--test-claim-report-path', receipt.testClaimReport.path, '--report-digest', receipt.testClaimReport.manifestSha256, '--revision', receipt.revision, '--page-size', '1']);
    assert.equal(page.code, 0, page.stderr);
    const projection = JSON.parse(page.stdout);
    assert.equal(projection.available, true);
    assert.equal(projection.identity.manifestSha256, receipt.testClaimReport.manifestSha256);
    assert.equal(projection.page.size, 1);

    const nativeOnly = await analyze(root, undefined, 'claims.json');
    assert.equal(nativeOnly.code, 0, nativeOnly.stderr);
    const nativeReceipt = JSON.parse(nativeOnly.stdout).testClaimDecisionRecord;
    assert.equal(nativeReceipt.nativeObligations[0].maintainedComposite.satisfied, true);
    assert.equal(nativeReceipt.claims[0].outcome, 'unproven-equivalence');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('catalog command deterministically emits supported and explicit unsupported source facts and refreshes revision', async () => {
  const root = await fixture();
  try {
    const command = (output: string) => run(process.execPath, [cli, 'catalog', '--repo-path', root, '--project', 'fixture/project', '--source-prefix', 'tests/', '--source-suffix', '.test.ts', '--source-suffix', '.sql', '--output', output]);
    const first = await command('.generated/catalog-a.json');
    assert.equal(first.code, 0, first.stderr);
    const firstReceipt = JSON.parse(first.stdout);
    const firstBody = await fs.readFile(path.join(root, firstReceipt.path), 'utf8');
    const catalog = JSON.parse(firstBody);
    assert.equal(catalog.version, 1);
    assert.equal(catalog.revision, firstReceipt.revision);
    assert.equal(catalog.claims.length, 0);
    assert.ok(catalog.declarations.length >= 1);
    assert.ok(catalog.assertions.length >= 4);
    assert.equal(catalog.files.find((file: any) => file.sourceId === 'tests/schema.sql').disposition, 'unsupported');
    assert.match(catalog.files.find((file: any) => file.sourceId === 'tests/schema.sql').reason, /coverage|does not support/u);
    const guard = catalog.files.find((file: any) => file.sourceId === 'tests/custom-guard.test.ts');
    assert.equal(guard.disposition, 'analyzed');
    assert.ok(guard.assertionIds.length >= 1, 'custom guard site must remain explicitly accounted for');
    const evaluated = await analyze(root, undefined, firstReceipt.path);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    const decision = JSON.parse(evaluated.stdout).testClaimDecisionRecord;
    assert.deepEqual(decision.population.problems, []);
    assert.deepEqual(decision.population.unsupportedFiles, ['tests/schema.sql']);
    assert.ok(decision.nativeObligations.some((item: any) => item.sourceId === 'tests/owner.test.ts'));
    assert.ok(decision.unclassified.some((item: any) => guard.assertionIds.includes(item.assertionId)), 'custom guard must remain explicitly unclassified');
    const modifiers = catalog.files.find((file: any) => file.sourceId === 'tests/playwright-modifiers.test.ts');
    assert.equal(modifiers.assertionIds.length, 2);
    assert.ok(modifiers.assertionIds.every((id: string) => decision.unclassified.some((item: any) => item.assertionId === id && /poll|soft|unsupported|semantic-obligation/u.test(item.blocker))), 'poll/soft sites must remain explicitly unknown');
    assert.ok(modifiers.assertionIds.every((id: string) => decision.assertions.some((item: any) => item.id === id && /expect\.(?:poll|soft).*no established obligation semantics/u.test(item.blocker))), 'poll/soft unsupported reasons must remain visible');
    const second = await command('.generated/catalog-b.json');
    assert.equal(second.code, 0, second.stderr);
    assert.equal(await fs.readFile(path.join(root, JSON.parse(second.stdout).path), 'utf8'), firstBody);
    const rootOutput = await command('catalog-root.json');
    assert.equal(rootOutput.code, 0, rootOutput.stderr);
    assert.equal(await fs.readFile(path.join(root, 'catalog-root.json'), 'utf8'), firstBody);
    const ownerPath = path.join(root, 'src', 'owner.ts');
    const ownerBefore = await fs.readFile(ownerPath, 'utf8');
    await fs.appendFile(ownerPath, '\nexport const dirtySourceMustFail = true;\n');
    const dirty = await command('.generated/catalog-dirty.json');
    assert.equal(dirty.code, 1);
    assert.match(JSON.parse(dirty.stderr).error.message, /tracked source bytes to match HEAD/u);
    await fs.writeFile(ownerPath, `${ownerBefore}\nexport const revisionRefresh = true;\n`);
    await runChecked('git', ['-C', root, 'add', 'src/owner.ts']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'refresh source revision']);
    const refreshed = await command('.generated/catalog-c.json');
    assert.equal(refreshed.code, 0, refreshed.stderr);
    const refreshedCatalog = JSON.parse(await fs.readFile(path.join(root, JSON.parse(refreshed.stdout).path), 'utf8'));
    assert.notEqual(refreshedCatalog.revision, catalog.revision);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('analyze fails closed for unreadable, malformed, and escaping parity contract paths', async () => {
  const root = await fixture();
  const outside = `${root}-outside`;
  try {
    const unreadable = await analyze(root, 'missing.json');
    assert.equal(unreadable.code, 1);
    assert.equal(JSON.parse(unreadable.stderr).error.code, 'parity-contract-error');
    assert.match(JSON.parse(unreadable.stderr).error.message, /could not be read/u);

    await fs.writeFile(path.join(root, 'malformed.json'), '{ nope');
    const malformed = await analyze(root, 'malformed.json');
    assert.equal(malformed.code, 1);
    assert.match(JSON.parse(malformed.stderr).error.message, /not valid JSON/u);

    await fs.writeFile(path.join(root, 'invalid-contract.json'), '{"version":1}\n');
    const evaluationError = await analyze(root, 'invalid-contract.json');
    assert.equal(evaluationError.code, 1);
    assert.match(JSON.parse(evaluationError.stderr).error.message, /at least one entity, relationship, or predicate/u);

    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'parity.json'), `${JSON.stringify(contract)}\n`);
    const lexicalEscape = await analyze(root, path.join('..', path.basename(outside), 'parity.json'));
    assert.equal(lexicalEscape.code, 1);
    assert.match(JSON.parse(lexicalEscape.stderr).error.message, /escapes repository root/u);

    const linkPath = path.join(root, 'linked-contracts');
    await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const symlinkEscape = await analyze(root, path.join('linked-contracts', 'parity.json'));
    assert.equal(symlinkEscape.code, 1);
    assert.match(JSON.parse(symlinkEscape.stderr).error.message, /resolves outside repository root/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('composite action exposes the optional caller-owned parity contract input', async () => {
  const action = await fs.readFile(path.resolve('action.yml'), 'utf8');
  assert.match(action, /^  parity-contract:/mu);
  assert.match(action, /args\+=\(--parity-contract "\$DEVINT_PARITY_CONTRACT"\)/u);
  assert.match(action, /DEVINT_PARITY_CONTRACT: \$\{\{ inputs\['parity-contract'\] \}\}/u);
  assert.match(action, /^  test-claim-catalog:/mu);
  assert.match(action, /args\+=\(--test-claim-catalog "\$DEVINT_TEST_CLAIM_CATALOG"\)/u);
  assert.match(action, /DEVINT_TEST_CLAIM_CATALOG: \$\{\{ inputs\['test-claim-catalog'\] \}\}/u);
  assert.match(action, /^  test-claim-report-path:/mu);
  assert.match(action, /--test-claim-report-path "\$report_path" --producer-commit "\$producer_commit"/u);
  assert.match(action, /actions\/upload-artifact@v4/u);
  assert.match(action, /continue-on-error: true/u);
  assert.match(action, /always\(\) && inputs\['test-claim-catalog'\] != ''/u);
  assert.match(action, /include-hidden-files: true/u);
  assert.match(action, /manifest-v1\.json[\s\S]*catalog-v1\.json[\s\S]*report-v1\.json/u);
  assert.match(action, /steps\.operation\.outcome == 'failure'/u);
  assert.match(action, /github\.action_ref \|\| github\.sha/u);
  assert.match(action, /run-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}-\$\{GITHUB_JOB\}/u);
  assert.match(action, /steps\.operation\.outputs\.report-path/u);
  assert.doesNotMatch(action, /rmSync\(target,\{recursive:true/u);
  assert.match(action, /^  test-claim-report-digest:/mu);
});

test('authenticated tool contract exposes exact-source test claim pages without accepting artifact URLs', async () => {
  const { listTools } = await import('../src/mcp.js');
  const tool = listTools().find(item => item.name === 'get_test_claim_report') as any;
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['project', 'sourcePrefixes', 'sourceSuffixes']);
  assert.ok(tool.inputSchema.properties.ref);
  assert.ok(tool.inputSchema.properties.graphId);
  assert.ok(tool.inputSchema.properties.sourcePrefixes);
  assert.ok(tool.inputSchema.properties.sourceSuffixes);
  assert.ok(tool.inputSchema.properties.expectedReportDigest);
  assert.equal('artifactUrl' in tool.inputSchema.properties, false);
  assert.equal(tool.annotations.readOnlyHint, true);
});
