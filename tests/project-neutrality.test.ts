import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRepositoryGraph } from '../src/intelligence/repository.js';
import { bootstrapSemanticCandidates } from '../src/intelligence/semanticBootstrap.js';
import { auditSemanticCandidates } from '../src/intelligence/semanticAudit.js';
import { runChecked } from '../src/util/process.js';

test('graph, semantic derivation, and audit are invariant to project identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-project-neutrality-'));
  await runChecked('git', ['init', '--initial-branch=main', root]);
  try {
    await fs.mkdir(path.join(root, 'src', 'features', 'identity'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'features', 'identity', 'service.go'), `package identity

type Service struct{}
func NewService() *Service { return &Service{} }
func (s *Service) Resolve() string { return "ok" }
`);
    await fs.writeFile(path.join(root, 'src', 'features', 'identity', 'handler.go'), `package identity

import "net/http"
func Handle(w http.ResponseWriter, r *http.Request) {}
`);
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
    const revision = (await runChecked('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();

    const first = await buildRepositoryGraph({
      project: 'owner-a/alpha-project',
      repository: root,
      revision,
      root,
      role: 'W',
    });
    const second = await buildRepositoryGraph({
      project: 'unrelated-org/completely-different-repo',
      repository: root,
      revision,
      root,
      role: 'W',
    });

    assert.equal(first.sourceFingerprint, second.sourceFingerprint);
    assert.equal(first.topologyFingerprint, second.topologyFingerprint);
    assert.equal(first.evidenceFingerprint, second.evidenceFingerprint);
    assert.deepEqual(first.nodes.map(node => node.id).sort(), second.nodes.map(node => node.id).sort());
    assert.deepEqual(first.edges.map(edge => edge.id).sort(), second.edges.map(edge => edge.id).sort());

    const firstSemantics = bootstrapSemanticCandidates(first, { limit: 1000 });
    const secondSemantics = bootstrapSemanticCandidates(second, { limit: 1000 });
    assert.deepEqual(
      firstSemantics.candidates.map(candidate => candidate.id),
      secondSemantics.candidates.map(candidate => candidate.id),
    );
    assert.deepEqual(firstSemantics.capacity, secondSemantics.capacity);

    const firstAudit = auditSemanticCandidates(first, firstSemantics, { limit: 1000 });
    const secondAudit = auditSemanticCandidates(second, secondSemantics, { limit: 1000 });
    assert.deepEqual(firstAudit.counts, secondAudit.counts);
    assert.deepEqual(
      firstAudit.items.map(item => ({ id: item.candidateId, factuality: item.factuality.status, core: item.coreness.classification })),
      secondAudit.items.map(item => ({ id: item.candidateId, factuality: item.factuality.status, core: item.coreness.classification })),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
