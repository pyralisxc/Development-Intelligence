import assert from 'node:assert/strict';
import test from 'node:test';
import { observation, resolution } from '../src/intelligence/model.js';
import { resolveCrossSource } from '../src/intelligence/resolver.js';

function node(id: string, sourceId: string, kind: string, name: string, tags: string[] = []) {
  return observation({
    id,
    sourceId,
    kind,
    locator: sourceId + ':1',
    name,
    value: { name },
    tags,
    layer: 'structural',
    checkpoint: false,
  });
}

test('cross-source candidate generation suppresses reference-to-reference identity chatter', () => {
  const leftReference = node('ref:left', 'repo:a.cs', 'call-reference', 'Run', ['reference']);
  const rightReference = node('ref:right', 'repo:b.cs', 'call-reference', 'Run', ['reference']);
  const method = node('method:right', 'repo:c.cs', 'method', 'Run');
  const otherMethod = node('method:other', 'repo:d.cs', 'method', 'Run');

  const edges = resolveCrossSource([leftReference, rightReference, method, otherMethod], []);

  assert.equal(
    edges.some(edge => edge.status === 'candidate' && [edge.from, edge.to].includes(leftReference.id) && [edge.from, edge.to].includes(rightReference.id)),
    false,
    'two call/reference observations should not be treated as an identity hypothesis',
  );
  assert.ok(
    edges.some(edge => edge.status === 'candidate' && [edge.from, edge.to].includes(leftReference.id) && [edge.from, edge.to].includes(method.id)),
    'reference-to-declaration candidate must remain available',
  );
  assert.ok(
    edges.some(edge => edge.status === 'candidate' && [edge.from, edge.to].includes(method.id) && [edge.from, edge.to].includes(otherMethod.id)),
    'declaration-to-declaration candidate must remain available',
  );
});

test('candidate pruning never removes pre-existing resolved or unresolved relationships', () => {
  const leftReference = node('ref:left', 'repo:a.cs', 'call-reference', 'Run', ['reference']);
  const rightReference = node('ref:right', 'repo:b.cs', 'call-reference', 'Run', ['reference']);
  const resolved = resolution({
    id: 'resolved',
    from: leftReference.id,
    to: rightReference.id,
    kind: 'calls',
    strategy: 'compiler',
    confidence: 1,
    status: 'resolved',
    evidence: ['fixture'],
    layer: 'structural',
    checkpoint: false,
  });
  const unresolved = resolution({
    id: 'unresolved',
    from: leftReference.id,
    to: null,
    kind: 'resolves_to',
    strategy: 'compiler',
    confidence: null,
    status: 'unresolved',
    evidence: ['fixture'],
    layer: 'structural',
    checkpoint: false,
  });

  const edges = resolveCrossSource([leftReference, rightReference], [resolved, unresolved]);
  assert.ok(edges.some(edge => edge.id === resolved.id && edge.status === 'resolved'));
  assert.ok(edges.some(edge => edge.id === unresolved.id && edge.status === 'unresolved'));
  assert.equal(edges.some(edge => edge.status === 'candidate'), false);
});
