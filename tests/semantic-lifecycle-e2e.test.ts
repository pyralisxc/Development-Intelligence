import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runChecked } from '../src/util/process.js';
import { clearGraphCache, scanGraph } from '../src/intelligence/service.js';
import {
  reviewSemanticMeaning,
  semanticReviewSurface,
  setSemanticPromotionEnrollment,
  verifySemanticPromotionChange,
} from '../src/intelligence/semanticWorkflow.js';
import { queryWorkbenchRequest } from '../src/intelligence/workbench.js';
import {
  latestAcceptedMeanings,
  loadSemanticAuthority,
  promoteCanonicalAcceptedGraph,
} from '../src/intelligence/semanticAuthorityStore.js';
import { loadCanonicalGraph } from '../src/intelligence/canonicalStore.js';

async function commit(repo: string, message: string): Promise<string> {
  await runChecked('git', ['-C', repo, 'add', '.']);
  await runChecked('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message]);
  return (await runChecked('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
}

async function push(repo: string): Promise<void> {
  await runChecked('git', ['-C', repo, 'push', 'origin', 'main']);
}

test('zero-metadata semantic meaning survives durable T2→T4 lifecycle and exact promotion gates', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-semantic-lifecycle-e2e-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const scratch = path.join(root, 'scratch');
  const canonical = path.join(root, 'canonical');
  const config = path.join(root, 'projects.json');
  const project = 'SemanticLifecycleFixture';
  const repository = pathToFileURL(remote).href;

  try {
    await fs.mkdir(scratch, { recursive: true });
    await runChecked('git', ['init', '--bare', '--initial-branch=main', remote]);
    await runChecked('git', ['init', '--initial-branch=main', source]);
    await fs.mkdir(path.join(source, 'src', 'features', 'storage'), { recursive: true });

    await fs.writeFile(path.join(source, 'src', 'features', 'storage', 'api.ts'), `
export async function saveItem(id: string) {
  const response = await fetch(\`/api/items/\${id}\`, { method: 'POST' });
  return await response.json();
}
`);
    await fs.writeFile(path.join(source, 'src', 'features', 'storage', 'panel.tsx'), `
import { useState } from 'react';
import { saveItem } from './api';

export function StoragePanel({ id }: { id: string }) {
  const [status, setStatus] = useState('idle');
  const save = async () => {
    setStatus('saving');
    await saveItem(id);
    setStatus('saved');
  };
  return <button onClick={save}>Save item</button>;
}
`);
    await fs.writeFile(path.join(source, 'src', 'features', 'storage', 'state.ts'), `
export const storageRoute = '/api/items';
export const storageState = { durable: true };
`);

    const baseRevision = await commit(source, 'zero metadata storage feature');
    await runChecked('git', ['-C', source, 'remote', 'add', 'origin', repository]);
    await runChecked('git', ['-C', source, 'push', '-u', 'origin', 'main']);

    await fs.writeFile(config, JSON.stringify({
      [project]: {
        repository,
        defaultRef: 'refs/heads/main',
        allowedRefs: ['refs/heads/main'],
        revisionPolicy: 'repository-history',
        credential: { type: 'none' },
        runtimeOrigins: [],
      },
    }, null, 2));

    process.env.DEVINT_PROJECTS_FILE = config;
    process.env.DEVINT_SCRATCH_DIR = scratch;
    process.env.DEVINT_CANONICAL_GRAPH_DIR = canonical;
    process.env.DEVINT_GRAPH_CACHE_SIZE = '2';
    clearGraphCache(project);

    const baseGraph = await scanGraph(project);
    assert.equal(baseGraph.repositoryRevision, baseRevision);
    await assert.rejects(
      fs.stat(path.join(source, '.development-intelligence', 'manifest.json')),
      /ENOENT/,
      'T2/T3/T4 proof must not rely on repository-owned DI metadata',
    );

    const initialSurface = await semanticReviewSurface({ project, limit: 1000 }) as any;
    assert.equal(initialSurface.zeroMetadata, true);
    assert.equal(initialSurface.authority.enrollmentState, 'not-enrolled');
    assert.equal(initialSurface.promotionAudit.gateStatus, 'non-blocking');
    assert.equal(initialSurface.promotionAudit.blockingPendingCount, 0);
    const storageCandidate = initialSurface.candidates.find((item: any) => item.scope === 'src/features/storage');
    assert.ok(storageCandidate, 'zero-metadata feature should produce an evidence-qualified storage candidate');

    const accepted = await reviewSemanticMeaning({
      project,
      candidateId: storageCandidate.id,
      command: { kind: 'accept', rationale: 'Human accepted the storage capability as project meaning.' },
      actor: { kind: 'human', id: 'human:owner' },
      at: '2026-10-01T10:00:00.000Z',
    });
    assert.equal(accepted.state, 'stored');
    assert.equal(accepted.review.accepted, true);

    const semanticAnswer = await queryWorkbenchRequest({
      project,
      text: 'What does this project do?',
    }) as any;
    assert.equal(semanticAnswer.result.semanticUnderstanding.source, 'accepted-authority');
    assert.equal(semanticAnswer.result.semanticUnderstanding.authority.acceptedCount, 1);
    assert.ok(
      semanticAnswer.result.semanticUnderstanding.meanings.some((item: any) => item.meaningId === accepted.meaningId),
      'ordinary T3 project questions should prefer durable accepted semantic authority',
    );

    const enrollment = await setSemanticPromotionEnrollment({
      project,
      state: 'enforced',
      actor: { kind: 'human', id: 'human:owner' },
      at: '2026-10-01T10:01:00.000Z',
      rationale: 'Owner established the reviewed Main semantic baseline.',
    });
    assert.equal(enrollment.state, 'stored');
    assert.equal(enrollment.enrollmentState, 'enforced');
    assert.equal(enrollment.enrollment?.baselineRevision, baseRevision);
    assert.ok((enrollment.baselineCandidateCount ?? 0) >= 1);

    const baseSurface = await semanticReviewSurface({ project, limit: 1000 }) as any;
    assert.equal(baseSurface.promotionAudit.gateStatus, 'ready');
    assert.equal(baseSurface.promotionAudit.semanticDeltaCount, 0);
    assert.equal(baseSurface.promotionAudit.readyForMainSemanticPromotion, true);

    const basePromotion = await promoteCanonicalAcceptedGraph({
      project,
      repository,
      revision: baseRevision,
      gate: baseSurface.promotionAudit,
    });
    assert.equal(basePromotion.state, 'stored');
    const acceptedBase = await loadCanonicalGraph({ project, repository, revision: baseRevision });
    assert.equal(acceptedBase.record?.accepted?.role, 'A');
    assert.equal(acceptedBase.record?.accepted?.repositoryRevision, baseRevision);

    await fs.mkdir(path.join(source, 'src', 'features', 'reporting'), { recursive: true });
    await fs.writeFile(path.join(source, 'src', 'features', 'reporting', 'api.ts'), `
export async function loadReport() {
  const response = await fetch('/api/reports');
  return await response.json();
}
`);
    await fs.writeFile(path.join(source, 'src', 'features', 'reporting', 'page.tsx'), `
import { useState } from 'react';
import { loadReport } from './api';

export function ReportingPage() {
  const [report, setReport] = useState(null);
  const refresh = async () => setReport(await loadReport());
  return <button onClick={refresh}>Refresh report</button>;
}
`);
    const previewRevision = await commit(source, 'add reporting capability');
    await push(source);
    clearGraphCache(project);
    const previewGraph = await scanGraph(project);
    assert.equal(previewGraph.repositoryRevision, previewRevision);

    const previewSurface = await semanticReviewSurface({ project, limit: 1000 }) as any;
    assert.equal(previewSurface.promotionAudit.gateStatus, 'semantic-review-required');
    assert.ok(previewSurface.promotionAudit.blockingPendingCount >= 1);
    const reportingCandidate = previewSurface.candidates.find((item: any) => item.scope === 'src/features/reporting');
    assert.ok(reportingCandidate, 'new reporting capability should be visible as an exact Preview semantic candidate');
    const reportingDelta = previewSurface.promotionAudit.items.find((item: any) => item.candidateId === reportingCandidate.id);
    assert.ok(reportingDelta, 'new reporting capability should appear in the exact Main→Preview semantic delta');
    assert.equal(reportingDelta.changeKind, 'added');

    const evidenceIds = reportingDelta.after?.evidenceIds?.length
      ? reportingDelta.after.evidenceIds
      : [`candidate:${reportingCandidate.id}`];
    const verified = await verifySemanticPromotionChange({
      project,
      auditRef: reportingDelta.auditRef,
      evidenceIds,
      actor: { kind: 'ai-model', id: 'model:semantic-verifier' },
      at: '2026-10-01T10:02:00.000Z',
      rationale: 'Current revision evidence supports the added reporting candidate.',
    });
    assert.equal(verified.state, 'stored');
    assert.equal(verified.verification.actor.kind, 'ai-model');

    const readySurface = await semanticReviewSurface({ project, limit: 1000 }) as any;
    assert.equal(readySurface.promotionAudit.blockingPendingCount, 0);
    assert.equal(readySurface.promotionAudit.gateStatus, 'ready');
    assert.equal(readySurface.promotionAudit.readyForMainSemanticPromotion, true);

    const previewPromotion = await promoteCanonicalAcceptedGraph({
      project,
      repository,
      revision: previewRevision,
      gate: readySurface.promotionAudit,
    });
    assert.equal(previewPromotion.state, 'stored');

    const promotedAuthority = await loadSemanticAuthority(project);
    assert.equal(promotedAuthority.ledger?.enrollment?.baselineRevision, previewRevision);
    assert.ok(promotedAuthority.ledger?.enrollment?.baselineCandidateIds.includes(reportingCandidate.id));
    assert.deepEqual(
      latestAcceptedMeanings(promotedAuthority.ledger).map(item => item.meaningId),
      [accepted.meaningId],
      'verification may clear a release gate without silently creating a second accepted meaning',
    );

    const promotedAnswer = await queryWorkbenchRequest({
      project,
      text: 'What does this project do?',
    }) as any;
    assert.equal(promotedAnswer.result.semanticUnderstanding.source, 'accepted-authority');
    assert.ok(promotedAnswer.result.semanticUnderstanding.meanings.some((item: any) => item.meaningId === accepted.meaningId));

    const storageApi = path.join(source, 'src', 'features', 'storage', 'api.ts');
    await fs.writeFile(storageApi, `
export async function saveItem(id: string) {
  const response = await fetch(\`/api/items/\${id}\`, { method: 'POST' });
  if (!response.ok) throw new Error('save failed');
  return await response.json();
}
`);
    const refactorRevision = await commit(source, 'refine storage realization');
    await push(source);
    clearGraphCache(project);
    await scanGraph(project);

    const evolvedSurface = await semanticReviewSurface({ project, limit: 1000 }) as any;
    const evolvedStorage = evolvedSurface.candidates.find((item: any) => item.scope === 'src/features/storage');
    assert.ok(evolvedStorage);
    assert.equal(evolvedStorage.continuity.state, 'inherited');
    assert.equal(evolvedStorage.continuity.meaningId, accepted.meaningId);
    const meaningDelta = evolvedSurface.promotionAudit.items.find((item: any) => item.meaningId === accepted.meaningId);
    assert.ok(meaningDelta, 'implementation change should remain an addressable semantic evolution item');
    assert.equal(meaningDelta.sourceRevision, baseRevision);
    assert.equal(meaningDelta.targetRevision, refactorRevision);

    const finalAnswer = await queryWorkbenchRequest({ project, text: 'What does this project do?' }) as any;
    assert.equal(finalAnswer.result.semanticUnderstanding.source, 'accepted-authority');
    assert.ok(finalAnswer.result.semanticUnderstanding.meanings.some((item: any) => item.meaningId === accepted.meaningId));
  } finally {
    clearGraphCache(project);
    delete process.env.DEVINT_PROJECTS_FILE;
    delete process.env.DEVINT_SCRATCH_DIR;
    delete process.env.DEVINT_CANONICAL_GRAPH_DIR;
    delete process.env.DEVINT_GRAPH_CACHE_SIZE;
    await fs.rm(root, { recursive: true, force: true });
  }
});
