import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildLocalGraph } from '../dist/src/intelligence/local.js';
import { bootstrapSemanticCandidates } from '../dist/src/intelligence/semanticBootstrap.js';
import { auditSemanticCandidates } from '../dist/src/intelligence/semanticAudit.js';
import { projectOrientation } from '../dist/src/intelligence/orientation.js';
import { synthesizeRepositoryAudit } from '../dist/src/intelligence/repositoryAudit.js';
import { scoreAccuracyCase } from './accuracy-benchmark-lib.mjs';

const root = path.resolve(process.argv[2] ?? 'benchmark/di-benchmark-gin');
const expectedSha = process.env.GIN_BENCHMARK_SHA ?? 'bae9b98d8d60fde4aa55a83185ba15a922f98bd7';
const actualSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actualSha !== expectedSha) throw new Error(`DI Benchmark Gin SHA mismatch: expected ${expectedSha}, got ${actualSha}`);

const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/u)
  .map(value => value.trim())
  .filter(Boolean);
const trackedGo = tracked.filter(file => file.endsWith('.go')).sort();
if (trackedGo.length < 80) throw new Error(`Gin specimen expected a substantial Go corpus, got only ${trackedGo.length} tracked .go files`);

const started = process.hrtime.bigint();
const graph = await buildLocalGraph(root, 'DI-Benchmark-Gin');
const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
if (!graph.coverage) throw new Error('Gin external benchmark requires graph coverage');
if (graph.coverage.failedFiles !== 0) throw new Error(`Gin external benchmark has ${graph.coverage.failedFiles} failed source analyses`);

const coverageByPath = new Map(graph.coverage.files.map(file => [file.path, file]));
const goCoverage = trackedGo.map(file => ({ file, status: coverageByPath.get(file)?.status ?? 'missing' }));
const incompleteGo = goCoverage.filter(item => item.status !== 'complete');
if (incompleteGo.length) throw new Error(`Every tracked Go source file must be structurally analyzable: ${JSON.stringify(incompleteGo.slice(0, 20))}`);
if (graph.coverage.eligibleFiles < trackedGo.length) throw new Error(`Gin eligible-source coverage ${graph.coverage.eligibleFiles} is smaller than tracked Go corpus ${trackedGo.length}`);

const requiredKinds = ['package', 'struct', 'interface', 'function', 'method', 'import-binding'];
const kindCounts = Object.fromEntries(requiredKinds.map(kind => [kind, graph.nodes.filter(node => node.kind === kind).length]));
for (const [kind, count] of Object.entries(kindCounts)) if (count < 1) throw new Error(`Gin Go benchmark expected observed ${kind} nodes`);

const requiredRelationships = ['contains', 'imports', 'targets-module'];
const relationshipCounts = Object.fromEntries(requiredRelationships.map(kind => [kind, graph.edges.filter(edge => edge.kind === kind && edge.status === 'resolved').length]));
for (const [kind, count] of Object.entries(relationshipCounts)) if (count < 1) throw new Error(`Gin Go benchmark expected resolved ${kind} relationships`);

const semanticStarted = process.hrtime.bigint();
const semanticBootstrap = bootstrapSemanticCandidates(graph, { limit: 1000 });
const semanticElapsedMs = Number(process.hrtime.bigint() - semanticStarted) / 1_000_000;
if (!semanticBootstrap.capacity.exhausted) throw new Error('Gin semantic census did not exhaust within the operational limit');
if (semanticBootstrap.candidates.length < 1) throw new Error('Gin external benchmark expected intrinsic semantic candidates after Go analysis');
if (semanticBootstrap.candidates.some(candidate => candidate.authority.accepted || candidate.authority.persisted || candidate.authority.proofEligible)) {
  throw new Error('Gin semantic candidates crossed the proposal authority boundary');
}

const auditStarted = process.hrtime.bigint();
const semanticAudit = auditSemanticCandidates(graph, semanticBootstrap, { limit: semanticBootstrap.candidates.length });
const semanticAuditElapsedMs = Number(process.hrtime.bigint() - auditStarted) / 1_000_000;
if (semanticAudit.counts.factualityNeedsReview !== 0) {
  throw new Error(`Gin derived semantic candidates contain broken factuality: ${JSON.stringify(semanticAudit.items.filter(item => item.factuality.status === 'needs-review'))}`);
}
if (semanticAudit.policy.authorityUnaffected !== true || semanticAudit.policy.verificationUnaffected !== true) {
  throw new Error('Gin semantic audit crossed the non-authoritative audit boundary');
}

const reviewedSemanticTruth = {
  version: 1,
  id: 'gin-external-reviewed-semantic-universe',
  capability: 'semantic-bootstrap',
  language: 'go',
  project: 'DI-Benchmark-Gin',
  ref: `commit:${actualSha}`,
  question: 'Which externally reviewed Gin concepts can DI recover from intrinsic repository evidence?',
  groundTruth: {
    semanticCandidates: {
      universeScopes: ['gin.go', 'context.go', 'routergroup.go', 'binding', 'render'],
      required: [
        { scope: 'gin.go', origin: 'intrinsic-derivation', accepted: false, persisted: false, proofEligible: false, requiresExplicitReview: true },
        { scope: 'context.go', origin: 'intrinsic-derivation', accepted: false, persisted: false, proofEligible: false, requiresExplicitReview: true },
        { scope: 'routergroup.go', origin: 'intrinsic-derivation', accepted: false, persisted: false, proofEligible: false, requiresExplicitReview: true },
        { scope: 'binding', origin: 'intrinsic-derivation', accepted: false, persisted: false, proofEligible: false, requiresExplicitReview: true },
        { scope: 'render', origin: 'intrinsic-derivation', accepted: false, persisted: false, proofEligible: false, requiresExplicitReview: true },
      ],
      forbidden: [],
      complete: true,
    },
  },
};
const reviewedSemanticAccuracy = scoreAccuracyCase(reviewedSemanticTruth, {
  caseId: reviewedSemanticTruth.id,
  semanticCandidates: semanticBootstrap.candidates,
});
if (!reviewedSemanticAccuracy.pass) {
  throw new Error(`Gin reviewed semantic truth failed: ${JSON.stringify(reviewedSemanticAccuracy.semanticCandidateScore)}`);
}
if (reviewedSemanticAccuracy.semanticCandidateScore?.precision !== 1 || reviewedSemanticAccuracy.semanticCandidateScore?.recall !== 1) {
  throw new Error(`Gin reviewed semantic truth must remain 1.0 precision/recall within its bounded universe: ${JSON.stringify(reviewedSemanticAccuracy.semanticCandidateScore)}`);
}
const reviewedCorePackageScopes = ['binding', 'render'];
const missingReviewedCorePackageScopes = reviewedCorePackageScopes.filter(scope =>
  !semanticAudit.items.some(item => item.scope === scope && item.coreness.classification === 'core-candidate' && item.factuality.status === 'supported')
);
if (missingReviewedCorePackageScopes.length) {
  throw new Error(`Gin reviewed package-boundary concepts must remain layout-neutral core candidates: ${missingReviewedCorePackageScopes.join(', ')}`);
}
function correctionScope(value) {
  return String(value).split('|', 1)[0].trim();
}
const reviewedSemanticFlags = [
  ...(reviewedSemanticAccuracy.semanticCandidateScore?.missingRequired ?? []),
  ...(reviewedSemanticAccuracy.semanticCandidateScore?.forbiddenPresent ?? []),
  ...(reviewedSemanticAccuracy.semanticCandidateScore?.falseObserved ?? []),
];
const reviewedCorrectionScopes = [...new Set(reviewedSemanticFlags.map(correctionScope).filter(Boolean))].sort();
const reviewedCorrectionBurden = {
  flagCount: reviewedSemanticFlags.length,
  affectedScopeCount: reviewedCorrectionScopes.length,
  affectedScopes: reviewedCorrectionScopes,
  reviewedRequiredCount: reviewedSemanticTruth.groundTruth.semanticCandidates.required.length,
  rate: reviewedSemanticTruth.groundTruth.semanticCandidates.required.length
    ? reviewedCorrectionScopes.length / reviewedSemanticTruth.groundTruth.semanticCandidates.required.length
    : 0,
};
if (reviewedCorrectionBurden.affectedScopeCount !== 0) {
  throw new Error(`Gin reviewed semantic universe requires human correction: ${JSON.stringify(reviewedCorrectionBurden)}`);
}

const orientationSubject = graph.nodes.find(node => node.kind === 'struct' && node.name === 'Engine')
  ?? graph.nodes.find(node => ['struct', 'interface', 'function', 'method'].includes(node.kind) && String(node.locator).endsWith('.go'));
if (!orientationSubject) throw new Error('Gin benchmark could not select a Go orientation subject');
const orientation = projectOrientation(graph, orientationSubject, [orientationSubject], false, []);
if (orientation.analyzer?.technology !== 'Go' || orientation.analyzer?.depth !== 'structural') {
  throw new Error(`Gin orientation did not report Go/structural analyzer identity: ${JSON.stringify(orientation.analyzer)}`);
}
if (orientation.source?.scope !== 'implementation') throw new Error('Gin Go source must orient as implementation');
if (!orientation.analyzer?.limitations?.some(value => /cross-file call binding|runtime execution/i.test(String(value)))) {
  throw new Error('Gin Go orientation must disclose structural/runtime limitations');
}

const repositoryAuditStarted = process.hrtime.bigint();
const repositoryAudit = synthesizeRepositoryAudit(graph, { acceptedPresent: false, currentness: null, limit: 20 });
const repositoryAuditElapsedMs = Number(process.hrtime.bigint() - repositoryAuditStarted) / 1_000_000;
if (repositoryAudit.investigationTargets.length > 20) throw new Error('Gin repository audit must remain bounded');

const report = {
  benchmark: 'Development Intelligence external Go specimen',
  provenance: {
    specimenRepository: 'pyralisxc/DI-Benchmark-Gin',
    upstreamReference: 'gin-gonic/gin',
  },
  targetSha: actualSha,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  coverage: {
    trackedFiles: graph.coverage.trackedFiles,
    trackedGoFiles: trackedGo.length,
    eligibleFiles: graph.coverage.eligibleFiles,
    analyzedFiles: graph.coverage.analyzedFiles,
    completeFiles: graph.coverage.completeFiles,
    partialFiles: graph.coverage.partialFiles,
    unsupportedFiles: graph.coverage.unsupportedFiles,
    failedFiles: graph.coverage.failedFiles,
    goCompleteFiles: trackedGo.length - incompleteGo.length,
  },
  graph: { nodes: graph.nodes.length, edges: graph.edges.length },
  kindCounts,
  relationshipCounts,
  semantic: {
    elapsedMs: Number(semanticElapsedMs.toFixed(3)),
    candidateCount: semanticBootstrap.candidates.length,
    capacity: semanticBootstrap.capacity,
    factualitySupported: semanticAudit.counts.factualitySupported,
    factualityNeedsReview: semanticAudit.counts.factualityNeedsReview,
    coreCandidates: semanticAudit.counts.coreCandidates,
    supportingCandidates: semanticAudit.counts.supportingCandidates,
    auditElapsedMs: Number(semanticAuditElapsedMs.toFixed(3)),
    reviewedTruth: {
      provenance: {
        basis: 'independently-reviewed-upstream-source-and-documentation',
        scopes: reviewedSemanticTruth.groundTruth.semanticCandidates.universeScopes,
        notes: [
          'gin.go: Engine is documented in source as the framework instance containing muxer, middleware and configuration.',
          'context.go: Context is documented in source as request/middleware flow, validation and response rendering context.',
          'routergroup.go: RouterGroup is documented in source as route-prefix and middleware grouping.',
          'binding: package boundary corresponds to request binding and validation documented by Gin.',
          'render: package boundary corresponds to built-in response rendering documented by Gin.',
        ],
      },
      precision: reviewedSemanticAccuracy.semanticCandidateScore.precision,
      recall: reviewedSemanticAccuracy.semanticCandidateScore.recall,
      falsePositiveRate: reviewedSemanticAccuracy.semanticCandidateScore.falsePositiveRate,
      required: reviewedSemanticAccuracy.semanticCandidateScore.required,
      observed: reviewedSemanticAccuracy.semanticCandidateScore.observed,
      missingRequired: reviewedSemanticAccuracy.semanticCandidateScore.missingRequired,
      falseObserved: reviewedSemanticAccuracy.semanticCandidateScore.falseObserved,
      correctionBurden: reviewedCorrectionBurden,
    },
    sample: semanticBootstrap.candidates.slice(0, 30).map(candidate => ({
      id: candidate.id,
      scope: candidate.scope,
      name: candidate.proposal.name,
      kind: candidate.proposal.kind,
      evidenceFamilies: candidate.provenance.evidenceFamilies,
      fileCount: candidate.support.fileCount,
    })),
  },
  orientation: {
    subject: { id: orientationSubject.id, name: orientationSubject.name, kind: orientationSubject.kind, locator: orientationSubject.locator },
    analyzer: orientation.analyzer,
    source: orientation.source,
  },
  repositoryAudit: {
    elapsedMs: Number(repositoryAuditElapsedMs.toFixed(3)),
    findingTotal: repositoryAudit.findingSummary.total,
    targetCount: repositoryAudit.investigationTargets.length,
  },
};
await fs.writeFile(process.env.DEVINT_GIN_JSON ?? path.resolve('benchmark-gin.json'), `${JSON.stringify(report, null, 2)}\n`);

const summary = [
  '# Development Intelligence external Go benchmark',
  '',
  `- Specimen: **pyralisxc/DI-Benchmark-Gin** (upstream reference: \`gin-gonic/gin\`)`,
  `- Exact SHA: \`${actualSha}\``,
  `- Go source coverage: **${trackedGo.length - incompleteGo.length}/${trackedGo.length} tracked .go files complete**`,
  `- Repository coverage: **${graph.coverage.analyzedFiles}/${graph.coverage.eligibleFiles} eligible analyzed; ${graph.coverage.unsupportedFiles} unsupported non-eligible files; ${graph.coverage.failedFiles} failed**`,
  `- Graph: **${graph.nodes.length} nodes / ${graph.edges.length} edges**`,
  `- Go kinds: **${Object.entries(kindCounts).map(([kind,count]) => `${kind}=${count}`).join(' / ')}**`,
  `- Go relationships: **${Object.entries(relationshipCounts).map(([kind,count]) => `${kind}=${count}`).join(' / ')}**`,
  `- Semantic census: **${semanticBootstrap.candidates.length} evidence-qualified / ${semanticBootstrap.capacity.groupedScopeCount} grouped scopes / ${semanticBootstrap.capacity.rejectedScopeCount} rejected**`,
  `- Semantic factuality/core: **${semanticAudit.counts.factualitySupported} supported / ${semanticAudit.counts.factualityNeedsReview} need review / ${semanticAudit.counts.coreCandidates} core / ${semanticAudit.counts.supportingCandidates} supporting**`,
  `- Reviewed external semantic truth: **precision ${(reviewedSemanticAccuracy.semanticCandidateScore.precision * 100).toFixed(0)}% / recall ${(reviewedSemanticAccuracy.semanticCandidateScore.recall * 100).toFixed(0)}% / false-positive rate ${(reviewedSemanticAccuracy.semanticCandidateScore.falsePositiveRate * 100).toFixed(0)}% across ${reviewedSemanticTruth.groundTruth.semanticCandidates.required.length} independently reviewed scopes**`,
  `- Reviewed layout-neutral core packages: **${reviewedCorePackageScopes.length - missingReviewedCorePackageScopes.length}/${reviewedCorePackageScopes.length} core**`,
  `- Reviewed semantic correction burden: **${reviewedCorrectionBurden.affectedScopeCount} affected scope(s) / ${reviewedCorrectionBurden.reviewedRequiredCount} required concepts (${(reviewedCorrectionBurden.rate * 100).toFixed(0)}%)**`,
  `- Orientation: **${orientation.analyzer.technology}/${orientation.analyzer.depth}** on \`${orientationSubject.name ?? orientationSubject.id}\``,
  '',
  '> This is an external framework specimen. The five-scope reviewed truth set is benchmark ground truth only; it does not promote any Gin semantic candidate into DI accepted authority.',
].join('\n');
await fs.writeFile(process.env.DEVINT_GIN_MARKDOWN ?? path.resolve('benchmark-gin.md'), `${summary}\n`);
console.log(summary);
