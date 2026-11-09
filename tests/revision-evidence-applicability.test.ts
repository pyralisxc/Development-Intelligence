import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { assessRevisionEvidence } from '../src/intelligence/revisionEvidenceApplicability.js';
import { runChecked } from '../src/util/process.js';
import { callTool, listTools } from '../src/mcp.js';
const contract = { version: 1, relationships: [{
  from: 'symbol:src/entry.ts#function:run',
  kind: 'calls',
  to: 'symbol:src/logic.ts#function:safe',
  requirement: 'required',
}] };
async function git(root: string, args: string[]) {
  return (await runChecked('git', ['-C', root, ...args])).stdout.trim();
}
async function commit(root: string, message: string) {
  await git(root, ['add', '-A']);
  await git(root, ['-c', 'user.name=DI Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

test('prior source obligations are independently re-proven; runtime passes are never transposed across Git', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'di-evidence-applicability-'));
  const root = path.join(temp, 'source');
  const remote = path.join(temp, 'remote.git');
  const config = path.join(temp, 'projects.json');
  const prior = process.env.DEVINT_PROJECTS_FILE;
  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await git(root, ['init', '--initial-branch=main']);
    await fs.writeFile(path.join(root, 'src', 'logic.ts'),
      'export function safe(value: number) { return value + 1; }\n');
    await fs.writeFile(path.join(root, 'src', 'entry.ts'),
      "import { safe } from './logic.js';\nexport function run() { return safe(1); }\n");
    // Deliberately wrong written assertion; neither its expected value nor
    // its reported CI pass is an independent source correctness oracle.
    await fs.writeFile(path.join(root, 'tests', 'wrong.test.ts'),
      "test('wrong', () => { expect(2).toBe(99); });\n");
    await commit(root, 'common base');
    await git(root, ['switch', '-c', 'verified']);
    await fs.writeFile(path.join(root, 'src', 'extra.ts'), 'export const extra = true;\n');
    const verified = await commit(root, 'prior run exact source');
    await git(root, ['switch', 'main']);
    await fs.writeFile(path.join(root, 'src', 'extra.ts'), 'export const extra = true;\n');
    const equivalent = await commit(root, 'same Git tree, different commit identity');
    assert.notEqual(verified, equivalent);
    assert.equal(await git(root, ['rev-parse', verified + '^{tree}']),
      await git(root, ['rev-parse', equivalent + '^{tree}']));

    await fs.mkdir(path.join(root, 'migrations'));
    await fs.writeFile(path.join(root, 'migrations', '002.sql'),
      'create or replace function public.changed() returns int language sql as $$ select 2 $$;\n');
    await fs.writeFile(path.join(root, 'src', 'entry.ts'),
      "import { safe } from './logic.js';\nexport function run() { if (false) return 0; return safe(1); }\n");
    const changed = await commit(root, 'source guard and database migration changed');
    await fs.writeFile(path.join(root, 'src', 'entry.ts'),
      'export function run() { return 0; }\n');
    const removed = await commit(root, 'remove production call');

    await runChecked('git', ['init', '--bare', remote]);
    await git(root, ['remote', 'add', 'origin', pathToFileURL(remote).href]);
    await git(root, ['push', '--all', 'origin']);
    await fs.writeFile(config, JSON.stringify({
      EvidenceContinuity: {
        repository: pathToFileURL(remote).href,
        defaultRef: 'refs/heads/main',
        allowedRefs: ['refs/heads/main'],
        revisionPolicy: 'repository-history',
        credential: { type: 'none' },
      },
    }));
    process.env.DEVINT_PROJECTS_FILE = config;
    const input = { project: 'EvidenceContinuity', baseRef: 'commit:' + verified,
      contract, priorTestRun: { runId: 'ci-example', claimedSourceRevision: verified,
        reportedOutcome: 'pass' as const } };

    const same = await assessRevisionEvidence({ ...input, ref: 'commit:' + equivalent });
    assert.equal(same.source.sameTrackedGitTree, true);
    assert.equal(same.source.trackedSourceChanges, 0);
    assert.equal(same.source.obligations[0]?.outcome, 'source-fact-independently-reestablished');
    assert.equal(same.priorTestRun?.reportedOutcome, 'pass');
    assert.equal(same.priorTestRun?.applicability, 'historical-report-only');
    assert.equal(same.priorTestRun?.currentRuntimeExecutionProven, false);
    assert.equal(same.priorTestRun?.provenanceStatus, 'caller-supplied-unattested-reference');
    assert.equal(same.policy.sameTreeDoesNotProveSameRuntimeEnvironment, true);
    assert.equal(same.database.liveDatabaseStateVerified, false);
    assert.equal(same.controlFlow.needsIndependentBehavioralRecheck, false);
    assert.equal(same.controlFlow.conditionsAndEffectsIndependentlyVerified, false);

    const migrated = await assessRevisionEvidence({ ...input, ref: 'commit:' + changed });
    assert.equal(migrated.source.sameTrackedGitTree, false);
    assert.ok(migrated.source.changedFiles.some(x => x.path === 'migrations/002.sql'));
    assert.deepEqual(migrated.database.changedSqlOrMigrationPaths, ['migrations/002.sql']);
    assert.equal(migrated.source.obligations[0]?.outcome, 'source-fact-independently-reestablished');
    assert.equal(migrated.database.sourceChangeRequiresStateCheck, true);
    assert.equal(migrated.controlFlow.needsIndependentBehavioralRecheck, true);
    assert.ok(migrated.controlFlow.changedExecutableSourcePaths.includes('src/entry.ts'));
    assert.ok(migrated.nextChecks.some(x => x.kind === 'condition-effect'));
    assert.ok(migrated.nextChecks.some(x => x.kind === 'database-state'));
    assert.equal(migrated.policy.staticSourceClaimDoesNotProveBehavior, true);

    const missing = await assessRevisionEvidence({ ...input, ref: 'commit:' + removed });
    assert.equal(missing.source.obligations[0]?.outcome, 'source-fact-unproven');
    assert.ok(missing.nextChecks.some(x => x.kind === 'source-obligation'));
    assert.equal(missing.priorTestRun?.currentRuntimeExecutionProven, false);

    const wrongRun = await assessRevisionEvidence({ ...input, ref: 'commit:' + equivalent,
      priorTestRun: { ...input.priorTestRun,
        claimedSourceRevision: 'a'.repeat(40) } });
    assert.equal(wrongRun.priorTestRun?.matchesBaselineGitRevision, false);
    assert.equal(wrongRun.priorTestRun?.currentRuntimeExecutionProven, false);
    await assert.rejects(assessRevisionEvidence({
      ...input, ref: 'commit:' + equivalent,
      priorTestRun: { ...input.priorTestRun, reportDigest: 'invalid' },
    }), /SHA-bound untrusted pointer/u);
  } finally {
    if (prior === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = prior;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('the shared read-only MCP contract exposes source-only revision evaluation without runtime attestation', async () => {
  const descriptor = listTools().find(item => item.name === 'assess_revision_evidence');
  assert.ok(descriptor);
  assert.equal(descriptor.annotations?.readOnlyHint, true);
  assert.ok(JSON.stringify(descriptor.inputSchema).includes('priorTestRun'));
  await assert.rejects(callTool('assess_revision_evidence', {
    project: 'EvidenceContinuity', baseRef: 'commit:' + 'a'.repeat(40),
    ref: 'commit:' + 'b'.repeat(40),
    contract: { version: 1, relationships: [] },
    priorTestRun: { runId: 'synthetic', claimedSourceRevision: 'wrong',
      reportedOutcome: 'pass' },
  }), /priorTestRun|reportDigest|revision|SHA|pattern|valid/i);
});
