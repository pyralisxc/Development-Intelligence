import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { AccountNetworkService, type BindingTarget } from '../src/accounts/network.js';
import { BlobAccountNetworkStore } from '../src/accounts/networkStore.js';
import { getProjectConfig, loadRegistry, listAuthorizedGithubOwners } from '../src/config/registry.js';
import { projectAccessCanonical, projectAccessScopeKey, projectAccessSecret, withProjectAccess } from '../src/config/projectAccess.js';
import { assertAuthorityWritesAllowed } from '../src/config/runtimeRole.js';
import { resolveRepositoryCredential } from '../src/source/repositoryCredential.js';
import { runChecked } from '../src/util/process.js';

function fixture() {
  const records = new Map<string, { body: string; version: number }>();
  const calls: string[] = [];
  const request = (async (input: any, init: any = {}) => {
    const url = new URL(String(input)); calls.push(String(url));
    assert.equal(url.hostname, 'account-fixture.invalid');
    assert.equal(init.redirect, 'error');
    const key = init.method === 'PUT' ? url.searchParams.get('pathname')! : url.pathname.slice(1);
    assert.ok(key.startsWith('development-intelligence/accounts/network-v1/'));
    const prior = records.get(key);
    if (init.method !== 'PUT') return prior ? new Response(prior.body, { headers: { etag: `"${prior.version}"` } }) : new Response(null, { status: 404 });
    if (prior ? init.headers['x-if-match'] !== `"${prior.version}"` : init.headers['x-allow-overwrite'] !== '0') return new Response(null, { status: 412 });
    records.set(key, { body: init.body, version: (prior?.version ?? 0) + 1 });
    return new Response('{}', { headers: { etag: `"${(prior?.version ?? 0) + 1}"` } });
  }) as typeof fetch;
  const config = { storeId: 'fixture', token: 'DISPOSABLE-STORAGE-TOKEN', baseUrl: 'https://account-fixture.invalid', apiUrl: 'https://account-fixture.invalid/api/blob' };
  const sessions = new Set(['alice', 'bob']);
  const targets = new Map<string, BindingTarget>();
  const service = () => new AccountNetworkService(new BlobAccountNetworkStore(config, request), async session => sessions.has(session) ? { issuer: 'https://identity-fixture.invalid', subject: session } : null,
    async (accountId, binding) => targets.get(`${accountId}:${binding.authorityRef}`) ?? null);
  const requested = { label: 'Example', sourceRef: 'source:fixture', authorityRef: 'authority:fixture', projectRef: 'project:fixture' };
  const target = (repository: string, secret = 'DISPOSABLE-SOURCE-TOKEN'): BindingTarget => ({
    authorityId: requested.authorityRef, internalProject: 'Example', canonical: null,
    config: { repository, defaultRef: 'HEAD', allowedRefs: ['HEAD'], credential: { type: 'token-env', tokenEnv: 'SOURCE_TOKEN' } },
    secretValues: { SOURCE_TOKEN: secret },
  });
  return { records, calls, config, request, sessions, targets, service, requested, target };
}

test('account network uses durable-provider CAS, separates accounts and refuses stale/forged state', async () => {
  const f = fixture(), service = f.service();
  const alice = await service.read('alice'), bob = await service.read('bob');
  assert.notEqual(alice.accountId, bob.accountId);
  const first = await service.addBinding('alice', 0, f.requested);
  assert.equal(first.bindings[0]!.state, 'requested');
  assert.equal((await f.service().read('alice')).version, 1, 'fresh service recovers provider-owned state');
  assert.equal((await service.read('bob')).bindings.length, 0);
  await assert.rejects(() => service.withBinding('alice', first.bindings[0]!.id, async () => 'not allowed'), /not authorized/);
  await assert.rejects(() => service.activateBinding('alice', 1, first.bindings[0]!.id), /not authorized/);
  await assert.rejects(() => service.addBinding('alice', 0, f.requested), (error: any) => error.status === 409);
  await assert.rejects(() => service.addBinding('bob', 0, { ...f.requested, accountId: alice.accountId } as any), /Invalid/);
  const results = await Promise.allSettled([service.addBinding('alice', 1, f.requested), service.addBinding('alice', 1, f.requested)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.ok([...f.records.values()].every(record => !record.body.includes('DISPOSABLE-STORAGE-TOKEN')));
  assert.ok(f.calls.every(url => !url.includes('/canonical/')));
});

test('resolved binding freezes registry, authority, secrets and concurrent operation scope', async () => {
  const f = fixture(), service = f.service();
  const alice = await service.read('alice'), bob = await service.read('bob');
  f.targets.set(`${alice.accountId}:${f.requested.authorityRef}`, f.target('https://github.com/alice/one.git', 'ALICE-FAKE'));
  f.targets.set(`${bob.accountId}:${f.requested.authorityRef}`, f.target('https://github.com/bob/two.git', 'BOB-FAKE'));
  const a = await service.addBinding('alice', 0, f.requested), b = await service.addBinding('bob', 0, f.requested);
  await service.activateBinding('alice', 1, a.bindings[0]!.id); await service.activateBinding('bob', 1, b.bindings[0]!.id);
  const scopes = await Promise.all([['alice', a.bindings[0]!.id, 'ALICE-FAKE'], ['bob', b.bindings[0]!.id, 'BOB-FAKE']].map(async ([session, id, token]) => await service.withBinding(session!, id!, async project => {
    const key = projectAccessScopeKey(); await Promise.resolve();
    const config = await getProjectConfig(project);
    assert.equal((await resolveRepositoryCredential(config))?.token, token);
    await assert.rejects(() => resolveRepositoryCredential({ ...config, repository: 'https://github.com/foreign/not-approved.git' }), /not authorized/);
    assert.equal(projectAccessSecret('UNRELATED_SECRET'), undefined);
    assert.equal(projectAccessCanonical(), null);
    assert.deepEqual(Object.keys(await loadRegistry()), ['Example']);
    assert.deepEqual(listAuthorizedGithubOwners(), []);
    await assert.rejects(() => getProjectConfig('Other'), /not authorized/);
    assert.throws(() => assertAuthorityWritesAllowed(), /compute-only/);
    assert.equal(Object.isFrozen(config.credential), true);
    return { key, repository: config.repository };
  })));
  assert.notEqual(scopes[0]!.key, scopes[1]!.key);
  assert.notEqual(scopes[0]!.repository, scopes[1]!.repository);
  await assert.rejects(() => service.withBinding('bob', a.bindings[0]!.id, async () => 'foreign'), /not authorized/);
  assert.equal(projectAccessScopeKey(), 'operator');
});

test('revocation and configuration replacement deny warm/in-flight results without changing a running snapshot', async () => {
  const f = fixture(), service = f.service();
  const account = await service.read('alice');
  const target = f.target('https://github.com/alice/one.git');
  f.targets.set(`${account.accountId}:${f.requested.authorityRef}`, target);
  const added = await service.addBinding('alice', 0, f.requested);
  const bindingId = added.bindings[0]!.id; await service.activateBinding('alice', 1, bindingId);
  await assert.rejects(() => service.withBinding('alice', bindingId, async project => {
    const snapshot = await getProjectConfig(project);
    target.config.repository = 'https://github.com/alice/replaced.git';
    assert.equal(snapshot.repository, 'https://github.com/alice/one.git');
    await assert.rejects(() => getProjectConfig(project), /not authorized/);
    return 'must-not-return';
  }), /not authorized/);
  await assert.rejects(() => service.withBinding('alice', bindingId, async () => {
    await service.revokeBinding('alice', 2, bindingId); return 'must-not-return';
  }), /not authorized/);
  await assert.rejects(() => service.withBinding('alice', bindingId, async () => 'warm'), /not authorized/);
});

test('replacement hardware has fresh identity; registration is not an issued execution grant', async () => {
  const f = fixture(), service = f.service();
  const old = await service.registerNode('alice', 0, { label: 'Old', publicKeyThumbprint: 'a'.repeat(64) });
  const oldId = old.nodes[0]!.id; await service.revokeNode('alice', 1, oldId);
  const replacement = await service.registerNode('alice', 2, { label: 'Replacement', publicKeyThumbprint: 'b'.repeat(64) });
  const newId = replacement.nodes[1]!.id;
  assert.notEqual(oldId, newId); assert.equal(replacement.nodes[1]!.state, 'registered');
  await assert.rejects(() => service.nodeConfiguration('alice', oldId), /not authorized/);
  await assert.rejects(() => service.nodeConfiguration('bob', newId), /not authorized/);
  await assert.rejects(() => service.registerNode('alice', 3, { label: 'Clone', publicKeyThumbprint: 'a'.repeat(64) }), /not authorized/);
  assert.equal((await f.service().nodeConfiguration('alice', newId)).networkVersion, 3);
  f.sessions.delete('alice'); await assert.rejects(() => service.read('alice'), /not authorized/);
});

test('binding subprocesses do not inherit deployment secrets; nested access cannot replace scope', async () => {
  const f = fixture(), service = f.service(); const account = await service.read('alice');
  f.targets.set(`${account.accountId}:${f.requested.authorityRef}`, f.target('https://github.com/alice/one.git'));
  const added = await service.addBinding('alice', 0, f.requested); await service.activateBinding('alice', 1, added.bindings[0]!.id);
  const previous = process.env.DEVINT_ACCOUNT_FAKE_LEAK_TEST;
  process.env.DEVINT_ACCOUNT_FAKE_LEAK_TEST = 'not-a-real-secret';
  try {
    await service.withBinding('alice', added.bindings[0]!.id, async () => {
      const child = await runChecked(process.execPath, ['-e', 'process.stdout.write(String(process.env.DEVINT_ACCOUNT_FAKE_LEAK_TEST))']);
      assert.equal(child.stdout, 'undefined');
      await assert.rejects(() => withProjectAccess({ ...f.target('https://github.com/bob/two.git'), accountId: account.accountId, bindingId: 'nested', bindingVersion: 1 }, async () => true, async () => null), /not authorized/);
    });
  } finally { if (previous === undefined) delete process.env.DEVINT_ACCOUNT_FAKE_LEAK_TEST; else process.env.DEVINT_ACCOUNT_FAKE_LEAK_TEST = previous; }
});

test('account store rejects mismatched records, missing concurrency tokens and secret-bearing transport errors', async () => {
  const f = fixture(), account = await f.service().read('alice');
  const malformed = new BlobAccountNetworkStore(f.config, (async () => new Response('{}', { headers: { etag: '"1"' } })) as typeof fetch);
  await assert.rejects(() => malformed.read(account.accountId), /Invalid/);
  const noEtag = new BlobAccountNetworkStore(f.config, (async () => new Response('{}')) as typeof fetch);
  await assert.rejects(() => noEtag.read(account.accountId), /concurrency token/);
  const failed = new BlobAccountNetworkStore(f.config, (async () => { throw new Error(f.config.token); }) as typeof fetch);
  await assert.rejects(() => failed.read(account.accountId), (error: unknown) => !String(error).includes(f.config.token));
});

test('missing authority selection and host SSH identities never fall back to operator configuration', async () => {
  const f = fixture();
  const base = { ...f.target('https://github.com/alice/one.git'), accountId: 'fixture-account', bindingId: 'fixture-binding', bindingVersion: 1 };
  for (const repository of ['ssh://git@github.com/alice/one.git', 'git@github.com:alice/one.git']) {
    await assert.rejects(() => withProjectAccess({ ...base, config: { ...base.config, repository, credential: { type: 'none' } } }, async () => true, async () => 'must-not-run'), /not authorized/);
  }
  await assert.rejects(() => withProjectAccess({ ...base, canonical: undefined } as any, async () => true, async () => 'must-not-run'), /not authorized/);
  await assert.rejects(() => withProjectAccess({ ...base, config: { ...base.config, repository: 'file://remote-fixture.invalid/share/repository' } }, async () => true, async () => 'must-not-run'), /not authorized/);
  await assert.rejects(() => withProjectAccess({ ...base, canonical: { kind: 'file', root: '\\\\remote-fixture.invalid\\share' } }, async () => true, async () => 'must-not-run'), /not authorized/);
});

test('scoped App exchanges remain bounded/read-only and token caches do not cross accounts', async () => {
  const f = fixture(), service = f.service();
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const target = f.target('https://github.com/fixture/project.git');
  target.config.credential = { type: 'github-app-env', appIdEnv: 'APP_ID', privateKeyEnv: 'APP_KEY' };
  target.secretValues = { APP_ID: '123', APP_KEY: key };
  const alice = await service.read('alice'), bob = await service.read('bob');
  for (const account of [alice, bob]) f.targets.set(`${account.accountId}:${f.requested.authorityRef}`, target);
  const a = await service.addBinding('alice', 0, f.requested), b = await service.addBinding('bob', 0, f.requested);
  await service.activateBinding('alice', 1, a.bindings[0]!.id); await service.activateBinding('bob', 1, b.bindings[0]!.id);
  const originalFetch = globalThis.fetch;
  let tokenName = 'ALICE-FAKE-TOKEN', invalidPermission = true, requests = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    requests += 1; const url = new URL(String(input)); assert.equal(url.hostname, 'api.github.com');
    assert.ok(init.signal); assert.equal(init.redirect, 'error');
    if (url.pathname.endsWith('/installation')) return new Response(JSON.stringify({ id: 1, account: { login: 'fixture' } }));
    assert.deepEqual(JSON.parse(init.body), { repositories: ['project'], permissions: { contents: 'read', pull_requests: 'read' } });
    return new Response(JSON.stringify({ token: tokenName, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), permissions: { contents: 'read', pull_requests: 'read', ...(invalidPermission ? { checks: 'read' } : {}) } }));
  }) as typeof fetch;
  try {
    const credential = (session: string, bindingId: string) => service.withBinding(session, bindingId, async project => await resolveRepositoryCredential(await getProjectConfig(project)));
    await assert.rejects(() => credential('alice', a.bindings[0]!.id), /unexpected read permission/);
    invalidPermission = false;
    assert.equal((await credential('alice', a.bindings[0]!.id))?.token, 'ALICE-FAKE-TOKEN');
    const beforeBob = requests; tokenName = 'BOB-FAKE-TOKEN';
    assert.equal((await credential('bob', b.bindings[0]!.id))?.token, 'BOB-FAKE-TOKEN');
    assert.equal(requests, beforeBob + 2);
    assert.ok([...f.records.values()].every(record => !record.body.includes('PRIVATE KEY') && !record.body.includes('FAKE-TOKEN')));
  } finally { globalThis.fetch = originalFetch; }
});
