import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecked } from '../src/util/process.js';
import { clearGraphCache } from '../src/intelligence/service.js';
import { queryWorkbench, scopeOrientation } from '../src/intelligence/workbench.js';
import { callTool } from '../src/mcp.js';

test('investigation keeps callable identity, call direction and unknown-symbol boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'di-investigation-fidelity-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const config = path.join(root, 'projects.json');
  const before = process.env.DEVINT_PROJECTS_FILE;
  try {
    await fs.mkdir(path.join(source, 'src'), { recursive: true });
    await fs.mkdir(path.join(source, 'tests'), { recursive: true });
    await runChecked('git', ['init', '--initial-branch=main', source]);
    await fs.writeFile(path.join(source, 'src', 'workbench.ts'), [
      'export function leaf() { return 1; }',
      'export function target() { return leaf(); }',
      'export function caller() { return target(); }',
      'export function guarded(owner: boolean) { if (owner) return target(); return leaf(); }',
      'export function ignore(_callback: () => number) { return 0; }',
      'export function ownerStored() { return ignore(() => 42); }',
      ''
    ].join('\n'));
    await fs.writeFile(path.join(source, 'src', 'consumer.ts'),
      "import { target } from './workbench.js';\nexport function consumer() { return target(); }\n");
    await fs.writeFile(path.join(source, 'tests', 'consumer.test.ts'),
      "import { target } from '../src/workbench.js';\nvoid target;\n");
    await fs.writeFile(path.join(source, 'src', 'many-callers.ts'),
      "import { target } from './workbench.js';\n"
      + Array.from({ length: 112 }, (_, index) => `export function generatedCaller${index}() { return target(); }\n`).join(''));
    await fs.writeFile(path.join(source, 'src', 'service.ts'),
      'export function service() { return 1; }\n');
    await fs.writeFile(path.join(source, 'src', 'duplicate-one.ts'),
      'export function duplicateName() { return 1; }\n');
    await fs.writeFile(path.join(source, 'src', 'duplicate-two.ts'),
      'export function duplicateName() { return 2; }\n');
    await runChecked('git', ['-C', source, 'add', '.']);
    await runChecked('git', ['-C', source, '-c', 'user.email=di@example.invalid', '-c', 'user.name=DI Test', 'commit', '-m', 'fixture']);
    const sha = (await runChecked('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    await runChecked('git', ['init', '--bare', remote]);
    await runChecked('git', ['-C', source, 'remote', 'add', 'origin', pathToFileURL(remote).href]);
    await runChecked('git', ['-C', source, 'push', '--all', 'origin']);
    await fs.writeFile(config, JSON.stringify({ InvestigationFixture: {
      repository: pathToFileURL(remote).href,
      defaultRef: 'refs/heads/main', allowedRefs: ['refs/heads/main'],
      revisionPolicy: 'repository-history', credential: { type: 'none' },
    } }));
    process.env.DEVINT_PROJECTS_FILE = config;
    clearGraphCache();
    const input = { project: 'InvestigationFixture', ref: 'commit:' + sha };
    const implementation = await queryWorkbench({ ...input, text: 'Where is target implemented?' }) as any;
    assert.equal(implementation.subject.kind, 'function');
    assert.match(implementation.subject.id, /src\/workbench\.ts#function:target/u);
    const scenario = await callTool('investigate', {
      ...input, question: 'What happens when an external service rollback fails?',
    }) as any;
    assert.equal(scenario.intent, 'unproven');
    assert.equal(scenario.result.outcome, 'unproven-subject');
    assert.equal(scenario.routing.reason, 'subject-not-exactly-identified');
    assert.equal(scenario.routing.targetResolution.node, null);
    assert.match(scenario.answer, /not proof/u);
    const otherScenario = await callTool('investigate', {
      ...input, question: 'Why does the service database fail?',
    }) as any;
    assert.notEqual(otherScenario.intent, 'inspect', 'incidental nouns are not exact technical subjects');
    const exactService = await callTool('investigate', { ...input, question: 'What is service?' }) as any;
    assert.equal(exactService.intent, 'inspect', 'an explicitly named symbol remains resolvable');
    const neutral = await queryWorkbench({ ...input, text: 'What is target?' }) as any;
    assert.equal(neutral.intent, 'inspect');
    assert.equal(typeof neutral.subject.id, 'string');
    const outgoing = await queryWorkbench({ ...input, text: 'What does target call?' }) as any;
    assert.equal(outgoing.subject.kind, 'function');
    assert.equal(outgoing.routing.direction, 'outbound');
    assert.deepEqual(outgoing.routing.relationshipKinds, ['calls']);
    assert.equal(outgoing.answerClassification, 'established-bounded');
    assert.match(outgoing.answer, /leaf/u);
    const callbackQuestion = await queryWorkbench({ ...input,
      text: 'Which callbacks does ownerStored pass?' }) as any;
    assert.equal(callbackQuestion.intent, 'trace');
    assert.equal(callbackQuestion.routing.tool, 'trace_path');
    assert.deepEqual(callbackQuestion.routing.relationshipKinds, ['callback-argument']);
    assert.equal(callbackQuestion.answerClassification, 'established-bounded');
    assert.match(callbackQuestion.answer, /src\/workbench\.ts/u);
    assert.match(callbackQuestion.answer, /not proof of effective delivery/u);
    const argument = callbackQuestion.result.edges.find((edge: any) =>
      edge.kind === 'callback-argument' && edge.status === 'resolved');
    assert.ok(argument, 'ordinary questions must select the existing source argument relationship');
    const callbackEvidence = await callTool('get_evidence', { ...input, edge: argument.id }) as any;
    assert.ok(callbackEvidence.evidence.some((item: any) => item.kind === 'source-callback-argument'));
    const compiledControl = await queryWorkbench({ ...input,
      text: 'What does guarded do?' }) as any;
    assert.equal(compiledControl.intent, 'source-condition-effects');
    assert.equal(compiledControl.routing.tool, 'canonical-graph-relationships',
      'ordinary source behavior must use already compiled graph facts');
    assert.equal(compiledControl.result.mode, 'canonical-source-condition-effects');
    assert.equal(compiledControl.result.coverage.branchTotal, 1);
    assert.equal(compiledControl.result.coverage.effectTotal, 2);
    assert.equal(compiledControl.result.proof.returnOrCallRuntimeObserved, false);
    assert.equal(compiledControl.result.proof.sourceDerivedExecution.status, 'established',
      'source-derived conditional effects are established facts without a runtime witness');
    assert.equal(compiledControl.result.proof.sourceDerivedExecution.establishedEffectFacts, 2);
    assert.equal(compiledControl.result.proof.sourceDerivedExecution.runtimeWitnessRequiredForSourceFact, false);
    assert.equal(compiledControl.result.proof.sourceDerivedExecution.runtimeObserved, false);
    assert.match(compiledControl.answer, /not whether the conditions are true/);
    const ordinaryCalls = await queryWorkbench({ ...input,
      text: 'What does ownerStored call?' }) as any;
    assert.deepEqual(ordinaryCalls.routing.relationshipKinds, ['calls']);
    assert.ok(!ordinaryCalls.result.edges.some((edge: any) => edge.kind === 'callback-argument'),
      'source argument edges may not masquerade as executed calls');
    const orientation = await queryWorkbench({ ...input, text: 'What does this project do?' }) as any;
    assert.equal(orientation.intent, 'orientation');
    assert.equal(orientation.routing.projection, 'repository-semantic-summary');
    assert.equal(orientation.result.projection.structuralOrientationMaterialized, false);
    const detailedOrientation = await scopeOrientation({
      ...input, semanticDepth: 'nucleus',
    }) as any;
    assert.deepEqual(orientation.result.semanticUnderstanding,
      detailedOrientation.semanticUnderstanding,
      'semantic summary must preserve the complete current-revision semantic answer');
    assert.equal(orientation.result.summary, detailedOrientation.summary);
    assert.ok(detailedOrientation.keyEntities?.length > 0,
      'explicit structural orientation must retain its full graph-ranked projection');
    const timings = orientation.result.observability;
    assert.equal(timings.owner, 'di-query-orientation');
    assert.equal(timings.revision, sha);
    assert.equal(timings.ephemeral, true);
    assert.equal(timings.phaseMs.rankingAndRoles, 0,
      'a semantic summary must not compute an unused whole-repository structural ranking');
    assert.ok(Object.values(timings.phaseMs).every((ms: any) =>
      typeof ms === 'number' && ms >= 0 && Number.isFinite(ms)));
    assert.ok(timings.totalMeasuredMs >= 0);
    assert.equal(JSON.stringify(timings).includes('What does this project do'), false,
      'timing diagnostics must not log question text');
    const incoming = await queryWorkbench({ ...input, text: 'What calls target?' }) as any;
    assert.equal(incoming.subject.id, outgoing.subject.id);
    assert.equal(incoming.routing.direction, 'inbound');
    assert.match(incoming.answer, /caller/u);
    const unknown = await queryWorkbench({ ...input, text: 'What does nonexistentTarget do?' }) as any;
    assert.equal(unknown.intent, 'unresolved');
    assert.equal(unknown.result.outcome, 'unresolved-input');
    const lowercaseUnknown = await queryWorkbench({ ...input, text: 'What does leafextra do?' }) as any;
    assert.equal(lowercaseUnknown.intent, 'unresolved', 'a lowercase unknown must not resolve to leaf');
    assert.equal(lowercaseUnknown.result.outcome, 'unresolved-input');
    const duplicate = await queryWorkbench({ ...input, text: 'What is duplicateName?' }) as any;
    assert.equal(duplicate.subject.ambiguous, true, 'two distinct declarations cannot become one confident identity');
    assert.equal(duplicate.subject.id, undefined);
    assert.equal(duplicate.result.ambiguous, true);
    assert.equal(duplicate.subject.candidates.length, 2);
    const explicitBlank = await callTool('investigate', {
      ...input, questions: ['What is target?', '   '],
    }) as any;
    assert.equal(explicitBlank.request.questionCount, 2, 'blank positions must not be erased');
    assert.deepEqual(explicitBlank.items.map((item: any) => item.status), ['ok', 'error']);
    assert.equal(explicitBlank.items[1].index, 1);
    assert.equal(explicitBlank.items[1].question, '');
    assert.match(explicitBlank.items[1].error, /non-empty/u);
    const oneBlank = await callTool('investigate', { ...input, questions: ['  '] }) as any;
    assert.equal(oneBlank.request.questionCount, 1);
    assert.equal(oneBlank.counts.error, 1);

    const inspected = await callTool('inspect_entity', { ...input, node: outgoing.subject.id }) as any;
    const connectionTotal = Object.values(inspected.connectionCounts)
      .reduce((sum: number, count: any) => sum + Number(count), 0);
    assert.ok(connectionTotal > 100, 'fixture must actually exercise the compact 100-connection bound');
    assert.equal(inspected.connections.length, 100);
    assert.equal(inspected.connectionProjection.total, connectionTotal);
    assert.equal(inspected.connectionProjection.returned, 100);
    assert.equal(inspected.connectionProjection.truncated, true);
    assert.equal(inspected.connectionProjection.detailTool, 'trace_path');
    const again = await queryWorkbench({ ...input, text: 'What does target call?' }) as any;
    assert.equal(again.subject.id, outgoing.subject.id);
    assert.equal(again.routing.direction, outgoing.routing.direction);
    assert.equal(again.answer, outgoing.answer);
  } finally {
    if (before === undefined) delete process.env.DEVINT_PROJECTS_FILE;
    else process.env.DEVINT_PROJECTS_FILE = before;
    clearGraphCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});
