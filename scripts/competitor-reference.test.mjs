import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const OFFICIAL_HOSTS = new Set([
  'www.augmentcode.com',
  'www.greptile.com',
  'cursor.com',
  'sourcegraph.com',
]);

test('competitor benchmark reference snapshot is sourced and never manufactures a cross-benchmark ranking', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../benchmark/competitor-reference.json', import.meta.url), 'utf8'));
  assert.equal(snapshot.version, 1);
  assert.match(snapshot.snapshotDate, /^20\d{2}-\d{2}-\d{2}$/u);
  assert.equal(snapshot.policy.vendorPublishedClaims, true);
  assert.equal(snapshot.policy.independentlyVerifiedByDevelopmentIntelligence, false);
  assert.equal(snapshot.policy.directCrossBenchmarkRankingAllowed, false);
  assert.ok(Array.isArray(snapshot.references));
  assert.ok(snapshot.references.length >= 5);

  const ids = new Set();
  for (const reference of snapshot.references) {
    assert.equal(typeof reference.id, 'string');
    assert.equal(ids.has(reference.id), false, `duplicate competitor reference id: ${reference.id}`);
    ids.add(reference.id);
    const url = new URL(reference.sourceUrl);
    assert.equal(url.protocol, 'https:');
    assert.equal(OFFICIAL_HOSTS.has(url.hostname), true, `competitor claim must use an official vendor source: ${url.hostname}`);
    assert.equal(reference.directlyComparableToDI, false, 'published external claims are reference-only until the same evaluation protocol is replayed');
    assert.equal(typeof reference.comparabilityReason, 'string');
    assert.ok(reference.comparabilityReason.length >= 20);
    assert.equal(typeof reference.claim?.summary, 'string');
    assert.equal(/development intelligence (?:beats|wins|outperforms)/iu.test(reference.claim.summary), false);
  }
});
