import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeByTechnology } from '../src/intelligence/analyzers/index.js';
import { inspectRelationshipShape, relationshipKindContract } from '../src/intelligence/graphKnowledge.js';

test('source callback argument facts do not establish receiver invocation', () => {
  const content = [
    'function caller() {',
    '  ignore({ work: () => 1, work: () => 2, ...replacement });',
    '  accept(() => 3);',
    '  other(cached);',
    '}',
  ].join('\n');
  const result = analyzeByTechnology({
    source: { id: 'repo:src/callbacks.ts', kind: 'repository-file',
      locator: 'src/callbacks.ts', revision: 'a'.repeat(40),
      observedAt: '2026-11-14T00:00:00Z', available: true },
    text: content, locatorBase: 'src/callbacks.ts',
  });
  const caller = result.observations.find(node => node.kind === 'function' && node.name === 'caller');
  assert.ok(caller);
  const args = result.resolutions.filter(edge => edge.from === caller.id && edge.kind === 'callback-argument');
  assert.equal(args.length, 3);
  assert.equal(new Set(args.map(edge => edge.id)).size, 3);
  assert.ok(args.every(edge => edge.status === 'resolved' && edge.confidence === 1));
  assert.equal(result.resolutions.some(edge => edge.kind === 'invokes' && edge.from === caller.id), false);
  const nodes = new Map(result.observations.map(node => [node.id, node]));
  for (const edge of args) {
    assert.equal(inspectRelationshipShape(edge, nodes).status, 'valid');
    const record = result.evidence?.find(item => item.id === edge.evidenceIds?.[0]);
    assert.equal(record?.kind, 'source-callback-argument');
    const value = record?.value as {
      sourceSyntaxOnly: boolean; effectiveDeliveryProven: boolean;
      invokedByReceiverProven: boolean; runtimeObserved: boolean;
    };
    assert.equal(value?.sourceSyntaxOnly, true);
    assert.equal(value?.effectiveDeliveryProven, false);
    assert.equal(value?.invokedByReceiverProven, false);
    assert.equal(value?.runtimeObserved, false);
  }
  assert.equal(relationshipKindContract('callback-argument').realizationEligible, false);
});
