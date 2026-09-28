import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySemanticAuthorityMigration } from '../src/intelligence/semanticAuthorityInventory.js';

test('semantic authority portfolio classification distinguishes clean, removable, and blocked repositories', () => {
  assert.equal(classifySemanticAuthorityMigration({
    repositoryEntryCount: 0,
    canonicalDurable: false,
    canonicalLoadState: 'miss',
    acceptedPresent: false,
    acceptedCurrent: false,
  }), 'clean');

  assert.equal(classifySemanticAuthorityMigration({
    repositoryEntryCount: 17,
    canonicalDurable: true,
    canonicalLoadState: 'hit',
    acceptedPresent: true,
    acceptedCurrent: true,
  }), 'ready-to-remove');

  assert.equal(classifySemanticAuthorityMigration({
    repositoryEntryCount: 17,
    canonicalDurable: true,
    canonicalLoadState: 'hit',
    acceptedPresent: true,
    acceptedCurrent: false,
  }), 'blocked');

  assert.equal(classifySemanticAuthorityMigration({
    repositoryEntryCount: 17,
    canonicalDurable: false,
    canonicalLoadState: 'not-configured',
    acceptedPresent: false,
    acceptedCurrent: false,
  }), 'blocked');
});
