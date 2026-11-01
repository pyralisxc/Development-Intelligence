import { createHash, randomBytes } from 'node:crypto';
import { accessDenied, withProjectAccess, type ProjectAccessBinding } from '../config/projectAccess.js';

export interface VerifiedAccountIdentity { issuer: string; subject: string; }
export interface NetworkBinding {
  id: string; version: number; label: string; sourceRef: string; authorityRef: string; projectRef: string;
  state: 'requested' | 'active' | 'revoked';
}
export interface NetworkNode { id: string; label: string; publicKeyThumbprint: string; state: 'registered' | 'revoked'; }
export interface AccountNetwork {
  formatVersion: 1; accountId: string; version: number; bindings: NetworkBinding[]; nodes: NetworkNode[];
}
export interface AccountNetworkStore {
  read(accountId: string): Promise<{ document: unknown; etag: string } | null>;
  compareAndSwap(accountId: string, document: AccountNetwork, expectedEtag: string | null): Promise<boolean>;
}
export type BindingTarget = Omit<ProjectAccessBinding, 'accountId' | 'bindingId' | 'bindingVersion'>;
export type RequestedBinding = Pick<NetworkBinding, 'label' | 'sourceRef' | 'authorityRef' | 'projectRef'>;
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function invalid(): never { throw Object.assign(new Error('Invalid bounded account network configuration'), { status: 400 }); }
function text(value: unknown, max = 128): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
}
function fields(value: any, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function requested(value: any): asserts value is RequestedBinding {
  fields(value, ['label', 'sourceRef', 'authorityRef', 'projectRef']);
  text(value.label);
  for (const key of ['sourceRef', 'authorityRef', 'projectRef']) {
    text(value[key]);
    if (!/^[A-Za-z0-9._:/@-]+$/u.test(value[key]) || value[key].includes('://') || value[key].includes('..')) invalid();
  }
}
export function validateAccountNetwork(value: any, accountId: string): AccountNetwork {
  fields(value, ['formatVersion', 'accountId', 'version', 'bindings', 'nodes']);
  if (value.formatVersion !== 1 || value.accountId !== accountId || !Number.isSafeInteger(value.version) || value.version < 1
      || !Array.isArray(value.bindings) || !Array.isArray(value.nodes) || value.bindings.length > 100 || value.nodes.length > 100
      || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) invalid();
  const ids = new Set<string>();
  for (const binding of value.bindings) {
    fields(binding, ['id', 'version', 'label', 'sourceRef', 'authorityRef', 'projectRef', 'state']);
    requested({ label: binding.label, sourceRef: binding.sourceRef, authorityRef: binding.authorityRef, projectRef: binding.projectRef });
    if (!/^binding-[a-f0-9]{32}$/u.test(binding.id) || ids.has(binding.id) || !Number.isSafeInteger(binding.version) || binding.version < 1 || !['requested', 'active', 'revoked'].includes(binding.state)) invalid();
    ids.add(binding.id);
  }
  const keys = new Set<string>();
  for (const node of value.nodes) {
    fields(node, ['id', 'label', 'publicKeyThumbprint', 'state']); text(node.label);
    if (!/^node-[a-f0-9]{32}$/u.test(node.id) || ids.has(node.id) || !/^[a-f0-9]{64}$/u.test(node.publicKeyThumbprint) || keys.has(node.publicKeyThumbprint) || !['registered', 'revoked'].includes(node.state)) invalid();
    ids.add(node.id); keys.add(node.publicKeyThumbprint);
  }
  return JSON.parse(JSON.stringify(value));
}

/** Owns metadata, not login issuance, source grants, graph ownership or node execution. */
export class AccountNetworkService {
  constructor(private readonly store: AccountNetworkStore,
    private readonly authenticate: (session: string) => Promise<VerifiedAccountIdentity | null>,
    private readonly resolveTarget: (accountId: string, binding: Readonly<NetworkBinding>) => Promise<BindingTarget | null>) {}

  private async account(session: string): Promise<string> {
    const identity = await this.authenticate(session).catch(() => null);
    if (!identity) throw accessDenied();
    text(identity.issuer, 512); text(identity.subject, 512);
    let issuer: URL; try { issuer = new URL(identity.issuer); } catch { throw accessDenied(); }
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) throw accessDenied();
    return `account-${digest([identity.issuer, identity.subject])}`;
  }
  private async target(accountId: string, binding: Readonly<NetworkBinding>): Promise<BindingTarget | null> {
    return await this.resolveTarget(accountId, binding).catch(() => { throw accessDenied(); });
  }
  private async load(accountId: string): Promise<{ network: AccountNetwork; etag: string | null }> {
    const stored = await this.store.read(accountId);
    if (!stored) return { network: { formatVersion: 1, accountId, version: 0, bindings: [], nodes: [] }, etag: null };
    if (!stored.etag) throw new Error('Versioned network store did not supply a concurrency token');
    return { network: validateAccountNetwork(stored.document, accountId), etag: stored.etag };
  }
  async read(session: string): Promise<AccountNetwork> { return (await this.load(await this.account(session))).network; }

  private async change(session: string, expectedVersion: number, update: (network: AccountNetwork) => void | Promise<void>): Promise<AccountNetwork> {
    const accountId = await this.account(session);
    const { network, etag } = await this.load(accountId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== network.version) throw Object.assign(new Error('Network configuration changed; reload before saving'), { status: 409 });
    await update(network);
    network.version += 1;
    validateAccountNetwork(network, accountId);
    if (await this.account(session) !== accountId) throw accessDenied();
    if (!await this.store.compareAndSwap(accountId, network, etag)) throw Object.assign(new Error('Network configuration changed; reload before saving'), { status: 409 });
    return JSON.parse(JSON.stringify(network));
  }
  async addBinding(session: string, expectedVersion: number, input: RequestedBinding): Promise<AccountNetwork> {
    requested(input);
    const snapshot = JSON.parse(JSON.stringify(input));
    return await this.change(session, expectedVersion, network => { network.bindings.push({ ...snapshot, id: `binding-${randomBytes(16).toString('hex')}`, version: 1, state: 'requested' }); });
  }
  async replaceBinding(session: string, expectedVersion: number, bindingId: string, input: RequestedBinding): Promise<AccountNetwork> {
    requested(input); const snapshot = JSON.parse(JSON.stringify(input));
    return await this.change(session, expectedVersion, network => {
      const binding = network.bindings.find(item => item.id === bindingId);
      if (!binding || binding.state === 'revoked') throw accessDenied();
      Object.assign(binding, snapshot, { version: binding.version + 1, state: 'requested' });
    });
  }
  async activateBinding(session: string, expectedVersion: number, bindingId: string): Promise<AccountNetwork> {
    return await this.change(session, expectedVersion, async network => {
      const binding = network.bindings.find(item => item.id === bindingId);
      if (!binding || binding.state !== 'requested') throw accessDenied();
      const target = await this.target(network.accountId, Object.freeze({ ...binding }));
      if (!target || target.authorityId !== binding.authorityRef) throw accessDenied();
      binding.state = 'active'; binding.version += 1;
    });
  }
  async revokeBinding(session: string, expectedVersion: number, bindingId: string): Promise<AccountNetwork> {
    return await this.change(session, expectedVersion, network => {
      const binding = network.bindings.find(item => item.id === bindingId);
      if (!binding) throw accessDenied(); binding.state = 'revoked'; binding.version += 1;
    });
  }
  async registerNode(session: string, expectedVersion: number, input: { label: string; publicKeyThumbprint: string }): Promise<AccountNetwork> {
    fields(input, ['label', 'publicKeyThumbprint']); text(input.label);
    if (!/^[a-f0-9]{64}$/u.test(input.publicKeyThumbprint)) invalid();
    const snapshot = { ...input };
    return await this.change(session, expectedVersion, network => {
      if (network.nodes.some(node => node.publicKeyThumbprint === snapshot.publicKeyThumbprint)) throw accessDenied();
      network.nodes.push({ ...snapshot, id: `node-${randomBytes(16).toString('hex')}`, state: 'registered' });
    });
  }
  async revokeNode(session: string, expectedVersion: number, nodeId: string): Promise<AccountNetwork> {
    return await this.change(session, expectedVersion, network => {
      const node = network.nodes.find(item => item.id === nodeId);
      if (!node) throw accessDenied(); node.state = 'revoked';
    });
  }
  async nodeConfiguration(session: string, nodeId: string): Promise<{ nodeId: string; networkVersion: number; bindings: NetworkBinding[] }> {
    const network = await this.read(session);
    if (!network.nodes.some(node => node.id === nodeId && node.state === 'registered')) throw accessDenied();
    return { nodeId, networkVersion: network.version, bindings: network.bindings.filter(binding => binding.state === 'active') };
  }
  async withBinding<T>(session: string, bindingId: string, fn: (internalProject: string) => Promise<T>): Promise<T> {
    const accountId = await this.account(session);
    const network = (await this.load(accountId)).network;
    const binding = network.bindings.find(item => item.id === bindingId && item.state === 'active');
    if (!binding) throw accessDenied();
    const target = await this.target(accountId, Object.freeze({ ...binding }));
    if (!target || target.authorityId !== binding.authorityRef) throw accessDenied();
    const snapshot = JSON.parse(JSON.stringify(target)) as BindingTarget;
    const targetDigest = digest(snapshot);
    const current = async () => {
      if (await this.account(session) !== accountId) return false;
      const latest = (await this.load(accountId)).network.bindings.find(item => item.id === bindingId);
      if (!latest || latest.state !== 'active' || latest.version !== binding.version) return false;
      const resolved = await this.target(accountId, Object.freeze({ ...latest }));
      return Boolean(resolved && digest(resolved) === targetDigest);
    };
    return await withProjectAccess({ ...snapshot, accountId, bindingId, bindingVersion: binding.version }, current, async () => await fn(snapshot.internalProject));
  }
}
