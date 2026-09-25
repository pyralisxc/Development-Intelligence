import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildLocalGraph } from '../dist/src/intelligence/local.js';
import { assessGraph } from '../dist/src/intelligence/assessment.js';
import { synthesizeRepositoryAudit } from '../dist/src/intelligence/repositoryAudit.js';
import { verifyTransition } from '../dist/src/intelligence/temporalVerification.js';

const targets = [
  {
    project: 'Game-Studio-Core',
    root: path.resolve(process.argv[2] ?? 'benchmark/game-studio-core'),
    expectedSha: process.env.GAME_STUDIO_CORE_BENCHMARK_SHA ?? '55263c4c0a1ee80fb9d28e6d6c0750d30db4c59d',
    requiredKinds: ['class', 'interface', 'method', 'unity-object', 'unity-asset-guid'],
    requiredStrategies: ['unity-guid', 'unity-file-id', 'unity-meta-companion'],
  },
  {
    project: 'Medieval-Sim',
    root: path.resolve(process.argv[3] ?? 'benchmark/medieval-sim'),
    expectedSha: process.env.MEDIEVAL_SIM_BENCHMARK_SHA ?? '8f721556d9548dfd09378d337b06416415ee09e7',
    requiredKinds: ['class', 'method', 'constructor', 'package', 'import-binding'],
    requiredRelationships: ['imports', 'resolves_to'],
  },
];

function ensureParentSha(root, sha) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', `${sha}^`], { encoding: 'utf8' }).trim();
  } catch {
    execFileSync('git', ['-C', root, 'fetch', '--no-tags', '--depth=2', 'origin', sha], { stdio: 'inherit' });
    return execFileSync('git', ['-C', root, 'rev-parse', `${sha}^`], { encoding: 'utf8' }).trim();
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-polyglot-temporal-'));
const configPath = path.join(temp, 'projects.json');
for (const target of targets) execFileSync('git', ['-C', target.root, 'update-ref', 'refs/heads/devint-benchmark', target.expectedSha]);
await fs.writeFile(configPath, JSON.stringify(Object.fromEntries(targets.map(target => [target.project, {
  repository: pathToFileURL(path.join(target.root, '.git')).href,
  defaultRef: 'refs/heads/devint-benchmark',
  allowedRefs: ['refs/heads/devint-benchmark'],
  revisionPolicy: 'repository-history',
  credential: { type: 'none' },
}])), null, 2));
process.env.DEVINT_PROJECTS_FILE = configPath;
process.env.DEVINT_SCRATCH_DIR = path.join(temp, 'scratch');

const reports = [];
for (const target of targets) {
  const actualSha = execFileSync('git', ['-C', target.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actualSha !== target.expectedSha) throw new Error(`${target.project} benchmark SHA mismatch: expected ${target.expectedSha}, got ${actualSha}`);
  const started = Date.now();
  const graph = await buildLocalGraph(target.root, target.project);
  const kindCounts = Object.fromEntries(target.requiredKinds.map(kind => [kind, graph.nodes.filter(node => node.kind === kind).length]));
  const strategyCounts = Object.fromEntries((target.requiredStrategies ?? []).map(strategy => [strategy, graph.edges.filter(edge => edge.strategy === strategy && edge.status === 'resolved').length]));
  const relationshipCounts = Object.fromEntries((target.requiredRelationships ?? []).map(kind => [kind, graph.edges.filter(edge => edge.kind === kind && edge.status === 'resolved').length]));
  if (target.project === 'Game-Studio-Core') {
    const csharpDeepCounts = {
      calls: graph.edges.filter(edge => edge.kind === 'calls' && edge.status === 'resolved' && edge.strategy === 'csharp-static-binding').length,
      constructs: graph.edges.filter(edge => edge.kind === 'constructs' && edge.status === 'resolved' && edge.strategy === 'csharp-static-binding').length,
      implementedBy: graph.edges.filter(edge => edge.kind === 'implemented-by' && edge.status === 'resolved' && edge.strategy === 'csharp-base-type').length,
      unityReverse: graph.edges.filter(edge => edge.kind === 'used-by-unity-asset' && edge.status === 'resolved').length,
    };
    if (csharpDeepCounts.implementedBy < 1) throw new Error('Game-Studio-Core expected at least one resolved C# interface implementation');
    if (csharpDeepCounts.calls + csharpDeepCounts.constructs < 1) throw new Error('Game-Studio-Core expected at least one resolved C# call or constructor binding');
    if (csharpDeepCounts.unityReverse < 1) throw new Error('Game-Studio-Core expected reverse Unity script-to-asset usage evidence');
    relationshipCounts['csharp-calls'] = csharpDeepCounts.calls;
    relationshipCounts['csharp-constructs'] = csharpDeepCounts.constructs;
    relationshipCounts['csharp-implemented-by'] = csharpDeepCounts.implementedBy;
    relationshipCounts['unity-reverse-usage'] = csharpDeepCounts.unityReverse;
  }
  if (target.project === 'Medieval-Sim') {
    const javaDeepCounts = {
      calls: graph.edges.filter(edge => edge.kind === 'calls' && edge.status === 'resolved' && edge.strategy === 'java-static-binding').length,
      constructs: graph.edges.filter(edge => edge.kind === 'constructs' && edge.status === 'resolved' && edge.strategy === 'java-static-binding').length,
    };
    if (javaDeepCounts.calls + javaDeepCounts.constructs < 1) throw new Error('Medieval-Sim expected at least one resolved Java call or constructor binding');
    relationshipCounts['java-calls'] = javaDeepCounts.calls;
    relationshipCounts['java-constructs'] = javaDeepCounts.constructs;
  }

  for (const [kind, count] of Object.entries(kindCounts)) if (count < 1) throw new Error(`${target.project} expected observed ${kind} nodes`);
  for (const [strategy, count] of Object.entries(strategyCounts)) if (count < 1) throw new Error(`${target.project} expected resolved ${strategy} relationships`);
  for (const [kind, count] of Object.entries(relationshipCounts)) if (count < 1) throw new Error(`${target.project} expected resolved ${kind} relationships`);
  if (!graph.coverage || graph.coverage.failedFiles > 0) throw new Error(`${target.project} has failed or unavailable coverage`);
  if (graph.coverage.analyzedFiles < 1 || graph.nodes.length < 1 || graph.edges.length < 1) throw new Error(`${target.project} did not produce useful graph depth`);
  const auditStarted = process.hrtime.bigint();
  const repositoryAudit = synthesizeRepositoryAudit(graph, { acceptedPresent: false, currentness: null, limit: 20 });
  const auditElapsedMs = Number(process.hrtime.bigint() - auditStarted) / 1_000_000;
  if (auditElapsedMs > 1000) throw new Error(`${target.project} repository audit exceeded 1000 ms acceptance budget: ${auditElapsedMs.toFixed(2)} ms`);
  if (!Array.isArray(repositoryAudit.investigationTargets) || repositoryAudit.investigationTargets.length > 20) throw new Error(`${target.project} repository audit was not bounded`);
  if (target.project === 'Game-Studio-Core') {
    if (!repositoryAudit.relationshipConcentrations.some(item => item.status === 'unresolved' && item.kind === 'uses-script' && item.count > 0)) throw new Error('Game-Studio-Core audit expected unresolved uses-script concentration');
    if (!repositoryAudit.coverageBlockers.some(item => item.status === 'partial' && item.count > 0)) throw new Error('Game-Studio-Core audit expected partial coverage blockers');
    const unresolvedScript = repositoryAudit.relationshipConcentrations.find(item => item.status === 'unresolved' && item.kind === 'uses-script');
    if (!unresolvedScript?.fixSurface?.paths?.length) throw new Error('Game-Studio-Core unresolved uses-script audit target must expose a source fix surface');
  }
  let temporalVerification = null;
  if (target.project === 'Game-Studio-Core') {
    const parentSha = ensureParentSha(target.root, actualSha);
    const temporalStarted = process.hrtime.bigint();
    const temporal = await verifyTransition({
      project: target.project,
      baseRef: `commit:${parentSha}`,
      ref: `commit:${actualSha}`,
      limit: 20,
      depth: 2,
    });
    const temporalElapsedMs = Number(process.hrtime.bigint() - temporalStarted) / 1_000_000;
    if (temporal.base?.identity?.sha !== parentSha || temporal.head?.identity?.sha !== actualSha) throw new Error('Game-Studio-Core temporal verification lost exact endpoint identity');
    if (Number(temporal.delta?.changedFileCount ?? 0) < 1) throw new Error('Game-Studio-Core parent→pinned temporal verification expected changed files');
    if (!Array.isArray(temporal.reviewSurface?.changedFiles) || temporal.reviewSurface.changedFiles.length > 20) throw new Error('Game-Studio-Core temporal review surface must remain bounded');
    if (temporal.policy?.persisted !== false || temporal.policy?.approvesMerge !== false) throw new Error('Game-Studio-Core temporal verification must remain ephemeral and non-approving');
    temporalVerification = {
      elapsedMs: Number(temporalElapsedMs.toFixed(3)),
      baseSha: parentSha,
      headSha: actualSha,
      changedFileCount: temporal.delta.changedFileCount,
      unexpectedTotal: temporal.unexpectedChanges.total,
    };
  }

  let orientationProbe = null;
  if (target.project === 'Game-Studio-Core') {
    const bootstrap = graph.nodes.find(node => node.kind === 'class' && node.name === 'GameplaySessionBootstrap');
    if (!bootstrap) throw new Error('Game-Studio-Core benchmark expected GameplaySessionBootstrap class');

    assessGraph(graph, bootstrap.id);
    const knownStarted = process.hrtime.bigint();
    const known = assessGraph(graph, bootstrap.id);
    const knownElapsedMs = Number(process.hrtime.bigint() - knownStarted) / 1_000_000;

    const stateMachine = graph.nodes.find(node => node.kind === 'class' && node.name === 'SessionStateMachine');
    const adapter = graph.nodes.find(node => node.kind === 'class' && node.name === 'InteractionInputAdapter2D');
    if (!stateMachine || !adapter) throw new Error('Game-Studio-Core benchmark expected state-machine and adapter subjects');

    const stateStarted = process.hrtime.bigint();
    const stateAssessment = assessGraph(graph, stateMachine.id);
    const stateElapsedMs = Number(process.hrtime.bigint() - stateStarted) / 1_000_000;
    const stateMotif = stateAssessment.orientation?.certainty?.derived?.find(item => item.kind === 'state-machine');
    if (!stateMotif || stateMotif.confidence !== 'high' || stateMotif.signals.length < 3 || stateMotif.proofEligible !== false) throw new Error('Game-Studio-Core SessionStateMachine motif was not conservatively derived');

    const adapterStarted = process.hrtime.bigint();
    const adapterAssessment = assessGraph(graph, adapter.id);
    const adapterElapsedMs = Number(process.hrtime.bigint() - adapterStarted) / 1_000_000;
    const adapterMotif = adapterAssessment.orientation?.certainty?.derived?.find(item => item.kind === 'adapter');
    if (!adapterMotif || adapterMotif.signals.length < 2 || adapterMotif.proofEligible !== false) throw new Error('Game-Studio-Core InteractionInputAdapter2D motif was not conservatively derived');

    const unknownStarted = process.hrtime.bigint();
    const unknown = assessGraph(graph, 'Prove DefinitelyMissingRuntimeOwner exists');
    const unknownElapsedMs = Number(process.hrtime.bigint() - unknownStarted) / 1_000_000;

    const ruleOutStarted = process.hrtime.bigint();
    const ruleOut = assessGraph(graph, 'Rule out DefinitelyMissingRuntimeOwner exists');
    const ruleOutElapsedMs = Number(process.hrtime.bigint() - ruleOutStarted) / 1_000_000;

    if (known.answerStatus !== 'supported') throw new Error(`Game-Studio-Core bootstrap orientation expected supported, got ${known.answerStatus}`);
    if (known.orientation?.subject?.id !== bootstrap.id) throw new Error('Game-Studio-Core bootstrap orientation selected the wrong subject');
    if (known.orientation?.source?.scope !== 'implementation') throw new Error(`Game-Studio-Core bootstrap source scope expected implementation, got ${known.orientation?.source?.scope}`);
    if (known.orientation?.analyzer?.technology !== 'C#') throw new Error(`Game-Studio-Core bootstrap analyzer expected C#, got ${known.orientation?.analyzer?.technology}`);
    if (known.orientation?.analyzer?.depth !== 'structural') throw new Error(`Game-Studio-Core bootstrap analyzer depth expected structural, got ${known.orientation?.analyzer?.depth}`);
    if (!known.orientation?.analyzer?.limitations?.some(item => /cross-file call binding/i.test(item))) throw new Error('Game-Studio-Core bootstrap orientation must disclose C# cross-file behavior limits');
    if (!known.orientation?.certainty?.known?.some(item => /directly observed as a class/i.test(item))) throw new Error('Game-Studio-Core bootstrap orientation must expose direct observed class evidence');
    if (!known.orientation?.certainty?.disambiguatingEvidence?.some(item => /cross-file relationship evidence/i.test(item))) throw new Error('Game-Studio-Core bootstrap orientation must name disambiguating cross-file evidence');
    const bootstrapMotif = known.orientation?.certainty?.derived?.find(item => item.kind === 'composition-root');
    if (!bootstrapMotif || bootstrapMotif.status !== 'derived' || bootstrapMotif.proofEligible !== false || bootstrapMotif.signals.length < 2) throw new Error('Game-Studio-Core bootstrap must derive a non-authoritative composition-root motif from multiple signals');
    if (known.orientation?.policy?.persisted !== false || known.orientation?.policy?.acceptedCheckpointAffected !== false) throw new Error('Game-Studio-Core orientation must remain assessment-only');

    if (unknown.answerStatus !== 'unproven') throw new Error(`Game-Studio-Core absent subject must remain unproven under incomplete tracked-source coverage, got ${unknown.answerStatus}`);
    if (!unknown.orientation?.certainty?.unknown?.some(item => /No entity matching/i.test(item))) throw new Error('Game-Studio-Core absent subject must be represented as unknown evidence');
    if ((unknown.orientation?.certainty?.missing ?? []).length !== 0) throw new Error('Game-Studio-Core absent subject must not be promoted to proven missing under incomplete coverage');
    if (ruleOut.answerStatus !== 'unproven') throw new Error(`Game-Studio-Core incomplete coverage must refuse rule-out, got ${ruleOut.answerStatus}`);
    if ((ruleOut.orientation?.certainty?.ruledOut ?? []).length !== 0) throw new Error('Game-Studio-Core incomplete coverage must not produce ruled-out existence claims');
    if (!ruleOut.orientation?.certainty?.unknown?.some(item => /cannot be ruled out/i.test(item))) throw new Error('Game-Studio-Core rule-out refusal must explain uncertainty');

    const maxQueryMs = Math.max(knownElapsedMs, stateElapsedMs, adapterElapsedMs, unknownElapsedMs, ruleOutElapsedMs);
    if (maxQueryMs > 1000) throw new Error(`Game-Studio-Core orientation query exceeded bounded acceptance budget: ${maxQueryMs.toFixed(2)} ms`);

    orientationProbe = {
      known: {
        subject: bootstrap.id,
        answerStatus: known.answerStatus,
        analyzerTechnology: known.orientation.analyzer.technology,
        analyzerDepth: known.orientation.analyzer.depth,
        sourceScope: known.orientation.source.scope,
        resolvedRelationships: known.orientation.relationshipSummary.resolved,
        candidateRelationships: known.orientation.relationshipSummary.candidate,
        unresolvedRelationships: known.orientation.relationshipSummary.unresolved,
        disambiguatingEvidenceCount: known.orientation.certainty.disambiguatingEvidence.length,
        elapsedMs: Number(knownElapsedMs.toFixed(3)),
        motifs: known.orientation.certainty.derived.map(item => item.kind),
      },
      stateMachine: {
        elapsedMs: Number(stateElapsedMs.toFixed(3)),
        confidence: stateMotif.confidence,
        signalCount: stateMotif.signals.length,
      },
      adapter: {
        elapsedMs: Number(adapterElapsedMs.toFixed(3)),
        confidence: adapterMotif.confidence,
        signalCount: adapterMotif.signals.length,
      },
      unknown: {
        answerStatus: unknown.answerStatus,
        missingCount: unknown.orientation.certainty.missing.length,
        unknownCount: unknown.orientation.certainty.unknown.length,
        elapsedMs: Number(unknownElapsedMs.toFixed(3)),
      },
      ruleOut: {
        answerStatus: ruleOut.answerStatus,
        ruledOutCount: ruleOut.orientation.certainty.ruledOut.length,
        unknownCount: ruleOut.orientation.certainty.unknown.length,
        elapsedMs: Number(ruleOutElapsedMs.toFixed(3)),
      },
      maxQueryBudgetMs: 1000,
    };
  }
  reports.push({
    project: target.project,
    targetSha: actualSha,
    elapsedMs: Date.now() - started,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    coverage: {
      eligibleFiles: graph.coverage.eligibleFiles,
      analyzedFiles: graph.coverage.analyzedFiles,
      completeFiles: graph.coverage.completeFiles,
      partialFiles: graph.coverage.partialFiles,
      skippedFiles: graph.coverage.skippedFiles,
      failedFiles: graph.coverage.failedFiles,
    },
    kindCounts,
    strategyCounts,
    relationshipCounts,
    temporalVerification,
    repositoryAudit: { elapsedMs: Number(auditElapsedMs.toFixed(3)), findingTotal: repositoryAudit.findingSummary.total, targetCount: repositoryAudit.investigationTargets.length, relationshipConcentrations: repositoryAudit.relationshipConcentrations.slice(0, 5), coverageBlockers: repositoryAudit.coverageBlockers, architectureBoundaryCount: repositoryAudit.architectureBoundaries.length },
    orientationProbe,
  });
}

const processMemory = process.memoryUsage();
const processResources = process.resourceUsage();
const resourceReport = {
  rssMiB: Number((processMemory.rss / 1_048_576).toFixed(1)),
  heapUsedMiB: Number((processMemory.heapUsed / 1_048_576).toFixed(1)),
  peakRssMiB: Number((processResources.maxRSS / 1024).toFixed(1)),
  userCpuMs: Number((processResources.userCPUTime / 1000).toFixed(1)),
  systemCpuMs: Number((processResources.systemCPUTime / 1000).toFixed(1)),
};
const jsonPath = process.env.DEVINT_PORTFOLIO_JSON ?? path.resolve('benchmark-polyglot-portfolio.json');
await fs.writeFile(jsonPath, `${JSON.stringify({ benchmark: 'Development Intelligence pinned C#/Unity + Java portfolio', processResources: resourceReport, reports }, null, 2)}\n`);
const summary = [
  '# Development Intelligence polyglot portfolio benchmark',
  '',
  `- Process resources: **${resourceReport.peakRssMiB} MiB peak RSS / ${resourceReport.userCpuMs} ms user CPU / ${resourceReport.systemCpuMs} ms system CPU**`,
  '',
  '| Repository | Exact SHA | Graph | Coverage | Partial | Skipped | Failed | Elapsed |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...reports.map(item => `| ${item.project} | \`${item.targetSha}\` | ${item.nodes} nodes / ${item.edges} edges | ${item.coverage.analyzedFiles}/${item.coverage.eligibleFiles} analyzed | ${item.coverage.partialFiles} | ${item.coverage.skippedFiles} | ${item.coverage.failedFiles} | ${item.elapsedMs} ms |`),
  '',
  ...reports.flatMap(item => [
    `## ${item.project} evidence`,
    '',
    ...Object.entries({ ...item.kindCounts, ...item.strategyCounts, ...item.relationshipCounts }).map(([name, count]) => `- ${name}: **${count}**`),
    ...(item.temporalVerification ? [`- parent→pinned temporal verification: **${item.temporalVerification.elapsedMs} ms — ${item.temporalVerification.changedFileCount} changed files / ${item.temporalVerification.unexpectedTotal} unexpected graph changes**`] : []),
    `- repository audit: **${item.repositoryAudit.elapsedMs} ms** — ${item.repositoryAudit.findingTotal} deterministic findings / ${item.repositoryAudit.targetCount} bounded investigation target(s)`,
    ...(item.orientationProbe ? [
      `- orientation known query: **${item.orientationProbe.known.elapsedMs} ms** — ${item.orientationProbe.known.answerStatus}, ${item.orientationProbe.known.analyzerTechnology}/${item.orientationProbe.known.analyzerDepth}, ${item.orientationProbe.known.disambiguatingEvidenceCount} disambiguating-evidence hint(s)`,
      `- orientation motifs: bootstrap **${item.orientationProbe.known.motifs.join(', ')}** / state-machine **${item.orientationProbe.stateMachine.confidence}, ${item.orientationProbe.stateMachine.signalCount} signals, ${item.orientationProbe.stateMachine.elapsedMs} ms** / adapter **${item.orientationProbe.adapter.confidence}, ${item.orientationProbe.adapter.signalCount} signals, ${item.orientationProbe.adapter.elapsedMs} ms**`,
      `- orientation absent-subject query: **${item.orientationProbe.unknown.elapsedMs} ms** — ${item.orientationProbe.unknown.answerStatus}, ${item.orientationProbe.unknown.missingCount} proven missing / ${item.orientationProbe.unknown.unknownCount} unknown`,
      `- orientation rule-out query: **${item.orientationProbe.ruleOut.elapsedMs} ms** — ${item.orientationProbe.ruleOut.answerStatus}, ${item.orientationProbe.ruleOut.ruledOutCount} ruled out / ${item.orientationProbe.ruleOut.unknownCount} unknown`,
      `- orientation bounded query budget: **${item.orientationProbe.maxQueryBudgetMs} ms**`,
    ] : []),
    '',
  ]),
  '> These replays are read-only and SHA-pinned. Partial and skipped coverage remains explicit rather than being promoted to complete inspection.',
].join('\n');
const markdownPath = process.env.DEVINT_PORTFOLIO_MARKDOWN ?? path.resolve('benchmark-polyglot-portfolio.md');
await fs.writeFile(markdownPath, `${summary}\n`);
console.log(summary);

await fs.rm(temp, { recursive: true, force: true });
