import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLocalGraph } from '../src/intelligence/local.js';
import { evaluateParityContractGraph } from '../src/intelligence/parityContract.js';
import type { IntelligenceGraph } from '../src/types.js';
import { runChecked } from '../src/util/process.js';

function nodeId(graph: IntelligenceGraph, name: string, source: string): string {
  const matches = graph.nodes.filter(node => node.name === name && node.sourceId === `repo:${source}`);
  assert.equal(matches.length, 1, `expected one ${name} in ${source}, got ${matches.length}`);
  return matches[0]!.id;
}

function reachable(graph: IntelligenceGraph, from: string, to: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edge.from || !edge.to || edge.status !== 'resolved' || !['calls', 'invokes'].includes(edge.kind)) continue;
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const pending = [from];
  const seen = new Set(pending);
  while (pending.length) {
    const current = pending.shift()!;
    if (current === to) return true;
    for (const next of adjacency.get(current) ?? []) if (!seen.has(next)) { seen.add(next); pending.push(next); }
  }
  return false;
}

test('cross-file callback invocation preserves execution ownership, call-site isolation, and unresolved transfers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-callback-resolution-'));
  try {
    await fs.writeFile(path.join(root, 'wrapper.ts'), `let saved: (() => Promise<unknown>) | null = null;
export async function invoke<T>({ execute }: { execute: () => Promise<T> }): Promise<T> { return await execute(); }
export async function accept<T>({ execute: _execute }: { execute: () => Promise<T> }): Promise<string> { return 'unused'; }
export async function store<T>({ execute }: { execute: () => Promise<T> }): Promise<string> { saved = execute; return 'stored'; }
export async function reassigned<T>({ execute }: { execute: () => Promise<T> }): Promise<T | number> { execute = async () => 0; return await execute(); }
export async function blockShadow<T>({ execute }: { execute: () => Promise<T> }): Promise<T | number> { { const execute = async () => 0; return await execute(); } }
export async function adapterShadow<T>({ execute }: { execute: () => Promise<T> }): Promise<T> { return await invoke({ execute: async (execute = async () => 0) => execute() }); }
export async function sink<T>({ execute }: { execute: () => Promise<T> }, _other: unknown): Promise<T> { return await execute(); }
export async function wrongPosition<T>({ execute }: { execute: () => Promise<T> }): Promise<T> { return await sink({}, { execute }); }
export async function capture<T>({ execute }: { execute: () => Promise<T> }): Promise<() => Promise<T>> { return async () => execute(); }
export async function adapterEscape<T>({ execute }: { execute: () => Promise<T> }): Promise<unknown> { return await invoke({ execute: async () => async () => execute() }); }
export async function adapterDefault<T>({ execute }: { execute: () => Promise<T> }): Promise<unknown> { return await invoke({ execute: async (unused = execute()) => unused }); }
export async function consume(input: { execute: () => Promise<unknown> }): Promise<unknown> { return await input.execute(); }
export const opaque: (input: { execute: () => Promise<unknown> }) => unknown = globalThis.structuredClone;
export async function duplicateBinding<T>({ execute: _unused, "execute": invoked }: { execute: () => Promise<T> }): Promise<T> { return await invoked(); }
export async function quotedBinding<T>({ "execute": invoked }: { execute: () => Promise<T> }): Promise<T> { return await invoked(); }
`);
    await fs.writeFile(path.join(root, 'writes.ts'), `export async function writeA() { return 'a'; }
export async function writeB() { return 'b'; }
export async function writeUnused() { return 'unused'; }
export async function writeStored() { return 'stored'; }
export async function writeForwarded() { return 'forwarded'; }
export async function writeReassigned() { return 'reassigned'; }
export async function writeBlockShadow() { return 'block-shadow'; }
export async function writeAdapterShadow() { return 'adapter-shadow'; }
export async function writeWrongPosition() { return 'wrong-position'; }
export async function writeOverwritten() { return 'overwritten'; }
export async function writeEffective() { return 'effective'; }
export async function writeSpread() { return 'spread'; }
export async function writeImportShadow() { return 'import-shadow'; }
export async function writeCaptured() { return 'captured'; }
export async function writeDynamic() { return 'dynamic'; }
export async function writeAdapterEscape() { return 'adapter-escape'; }
export async function writeAdapterDefault() { return 'adapter-default'; }
export async function writeUnsupportedFormal() { return 'unsupported-formal'; }
export async function writeSwitch() { return 'switch'; }
export async function writeMethod() { return 'method'; }
export async function writeOpaque() { return 'opaque'; }
export async function writeDuplicateBinding() { return 'duplicate-binding'; }
export async function writeQuotedBinding() { return 'quoted-binding'; }
export async function writeComputedTransfer() { return 'computed-transfer'; }
export async function writeNestedSpread() { return 'nested-spread'; }
export async function writeNestedUnused() { return 'nested-unused'; }
export async function writeUnknownOld() { return 'unknown-old'; }
export async function writeUnknownNew() { return 'unknown-new'; }
`);
    await fs.writeFile(path.join(root, 'bridge.ts'), `import { invoke } from './wrapper';
export async function observe<T>({ execute }: { execute: () => Promise<T> }): Promise<T> {
  return await invoke({ execute: async () => execute() });
}
`);
    await fs.writeFile(path.join(root, 'owners.ts'), `import { invoke, accept, store, missing, reassigned, blockShadow, adapterShadow, wrongPosition, capture, adapterEscape, adapterDefault, consume, opaque, duplicateBinding, quotedBinding } from './wrapper';
import { observe } from './bridge';
import { writeA, writeB, writeUnused, writeStored, writeForwarded, writeReassigned, writeBlockShadow, writeAdapterShadow, writeWrongPosition, writeOverwritten, writeEffective, writeSpread, writeImportShadow, writeCaptured, writeDynamic, writeAdapterEscape, writeAdapterDefault, writeUnsupportedFormal, writeSwitch, writeMethod, writeOpaque, writeDuplicateBinding, writeQuotedBinding, writeComputedTransfer, writeNestedSpread, writeNestedUnused, writeUnknownOld, writeUnknownNew } from './writes';
export async function ownerA() { return await invoke({ execute: async () => writeA() }); }
export async function ownerB() { return await invoke({ execute: async () => writeB() }); }
export async function ownerUnused() { return await accept({ execute: async () => writeUnused() }); }
export async function ownerStored() { return await store({ execute: async () => writeStored() }); }
export async function ownerForwarded() { return await observe({ execute: async () => writeForwarded() }); }
export async function ownerAmbiguous() { return await missing({ execute: async () => writeUnused() }); }
export async function ownerReassigned() { return await reassigned({ execute: async () => writeReassigned() }); }
export async function ownerBlockShadow() { return await blockShadow({ execute: async () => writeBlockShadow() }); }
export async function ownerAdapterShadow() { return await adapterShadow({ execute: async () => writeAdapterShadow() }); }
export async function ownerWrongPosition() { return await wrongPosition({ execute: async () => writeWrongPosition() }); }
export async function ownerDuplicate() { return await invoke({ execute: async () => writeOverwritten(), execute: async () => writeEffective() }); }
export async function ownerSpread(replacement: object) { return await invoke({ execute: async () => writeSpread(), ...replacement }); }
export async function ownerImportShadow(invoke: (input: unknown) => unknown) { return await invoke({ execute: async () => writeImportShadow() }); }
export async function ownerCaptured() { return await capture({ execute: async () => writeCaptured() }); }
export async function ownerDynamic(transfer: (input: unknown) => unknown) { return await transfer({ execute: async () => writeDynamic() }); }
export async function ownerCatch() { try { throw new Error(); } catch (invoke) { return await invoke({ execute: async () => writeImportShadow() }); } }
export async function ownerLoop(transfers: Array<(input: unknown) => unknown>) { for (const invoke of transfers) return await invoke({ execute: async () => writeImportShadow() }); }
export const ownerNamed = async function invoke() { return await invoke({ execute: async () => writeImportShadow() }); };
export async function ownerVar() { if (true) { var invoke = (_input: unknown) => null; } return await invoke({ execute: async () => writeImportShadow() }); }
export async function ownerAdapterEscape() { return await adapterEscape({ execute: async () => writeAdapterEscape() }); }
export async function ownerAdapterDefault() { return await adapterDefault({ execute: async () => writeAdapterDefault() }); }
export async function ownerUnsupportedFormal() { return await consume({ execute: async () => writeUnsupportedFormal() }); }
export async function ownerSwitch() { switch (1) { case 1: const invoke = (_input: unknown) => 0; return invoke({ execute: async () => writeSwitch() }); } }
export class MethodOwner { async invoke() { return await invoke({ execute: async () => writeMethod() }); } }
export async function ownerOpaque() { return await opaque({ execute: async () => writeOpaque() }); }
export async function ownerDuplicateBinding() { return await duplicateBinding({ execute: async () => writeDuplicateBinding() }); }
export async function ownerQuotedBinding() { return await quotedBinding({ execute: async () => writeQuotedBinding() }); }
export async function ownerComputedTransfer(key: string) { return await invoke({ [key]: async () => writeComputedTransfer() }); }
export async function ownerNestedSpread() { return await invoke({ ...{ execute: async () => writeNestedSpread() } }); }
export async function ownerNestedUnused() { return await consume(accept({ execute: async () => writeNestedUnused() })); }
export async function ownerUnknownDuplicate() { return await missing({ execute: async () => writeUnknownOld(), execute: async () => writeUnknownNew() }); }
`);
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);

    const graph = await buildLocalGraph(root, 'callback-fixture', 'W');
    const ownerA = nodeId(graph, 'ownerA', 'owners.ts');
    const ownerB = nodeId(graph, 'ownerB', 'owners.ts');
    const ownerUnused = nodeId(graph, 'ownerUnused', 'owners.ts');
    const ownerStored = nodeId(graph, 'ownerStored', 'owners.ts');
    const ownerForwarded = nodeId(graph, 'ownerForwarded', 'owners.ts');
    const ownerAmbiguous = nodeId(graph, 'ownerAmbiguous', 'owners.ts');
    const ownerReassigned = nodeId(graph, 'ownerReassigned', 'owners.ts');
    const ownerBlockShadow = nodeId(graph, 'ownerBlockShadow', 'owners.ts');
    const ownerAdapterShadow = nodeId(graph, 'ownerAdapterShadow', 'owners.ts');
    const ownerWrongPosition = nodeId(graph, 'ownerWrongPosition', 'owners.ts');
    const ownerDuplicate = nodeId(graph, 'ownerDuplicate', 'owners.ts');
    const ownerSpread = nodeId(graph, 'ownerSpread', 'owners.ts');
    const ownerImportShadow = nodeId(graph, 'ownerImportShadow', 'owners.ts');
    const ownerCaptured = nodeId(graph, 'ownerCaptured', 'owners.ts');
    const ownerDynamic = nodeId(graph, 'ownerDynamic', 'owners.ts');
    const ownerCatch = nodeId(graph, 'ownerCatch', 'owners.ts');
    const ownerLoop = nodeId(graph, 'ownerLoop', 'owners.ts');
    const ownerNamed = nodeId(graph, 'ownerNamed', 'owners.ts');
    const ownerVar = nodeId(graph, 'ownerVar', 'owners.ts');
    const ownerAdapterEscape = nodeId(graph, 'ownerAdapterEscape', 'owners.ts');
    const ownerAdapterDefault = nodeId(graph, 'ownerAdapterDefault', 'owners.ts');
    const ownerUnsupportedFormal = nodeId(graph, 'ownerUnsupportedFormal', 'owners.ts');
    const ownerSwitch = nodeId(graph, 'ownerSwitch', 'owners.ts');
    const ownerMethodMatches = graph.nodes.filter(node => node.name === 'invoke' && node.kind === 'method' && node.sourceId === 'repo:owners.ts');
    assert.equal(ownerMethodMatches.length, 1, 'expected one invoke method in owners.ts');
    const ownerMethod = ownerMethodMatches[0]!.id;
    const ownerOpaque = nodeId(graph, 'ownerOpaque', 'owners.ts');
    const ownerDuplicateBinding = nodeId(graph, 'ownerDuplicateBinding', 'owners.ts');
    const ownerQuotedBinding = nodeId(graph, 'ownerQuotedBinding', 'owners.ts');
    const ownerComputedTransfer = nodeId(graph, 'ownerComputedTransfer', 'owners.ts');
    const ownerNestedSpread = nodeId(graph, 'ownerNestedSpread', 'owners.ts');
    const ownerNestedUnused = nodeId(graph, 'ownerNestedUnused', 'owners.ts');
    const ownerUnknownDuplicate = nodeId(graph, 'ownerUnknownDuplicate', 'owners.ts');
    const writeA = nodeId(graph, 'writeA', 'writes.ts');
    const writeB = nodeId(graph, 'writeB', 'writes.ts');
    const writeUnused = nodeId(graph, 'writeUnused', 'writes.ts');
    const writeStored = nodeId(graph, 'writeStored', 'writes.ts');
    const writeForwarded = nodeId(graph, 'writeForwarded', 'writes.ts');
    const writeReassigned = nodeId(graph, 'writeReassigned', 'writes.ts');
    const writeBlockShadow = nodeId(graph, 'writeBlockShadow', 'writes.ts');
    const writeAdapterShadow = nodeId(graph, 'writeAdapterShadow', 'writes.ts');
    const writeWrongPosition = nodeId(graph, 'writeWrongPosition', 'writes.ts');
    const writeOverwritten = nodeId(graph, 'writeOverwritten', 'writes.ts');
    const writeEffective = nodeId(graph, 'writeEffective', 'writes.ts');
    const writeSpread = nodeId(graph, 'writeSpread', 'writes.ts');
    const writeImportShadow = nodeId(graph, 'writeImportShadow', 'writes.ts');
    const writeCaptured = nodeId(graph, 'writeCaptured', 'writes.ts');
    const writeDynamic = nodeId(graph, 'writeDynamic', 'writes.ts');
    const writeAdapterEscape = nodeId(graph, 'writeAdapterEscape', 'writes.ts');
    const writeAdapterDefault = nodeId(graph, 'writeAdapterDefault', 'writes.ts');
    const writeUnsupportedFormal = nodeId(graph, 'writeUnsupportedFormal', 'writes.ts');
    const writeSwitch = nodeId(graph, 'writeSwitch', 'writes.ts');
    const writeMethod = nodeId(graph, 'writeMethod', 'writes.ts');
    const writeOpaque = nodeId(graph, 'writeOpaque', 'writes.ts');
    const writeDuplicateBinding = nodeId(graph, 'writeDuplicateBinding', 'writes.ts');
    const writeQuotedBinding = nodeId(graph, 'writeQuotedBinding', 'writes.ts');
    const writeComputedTransfer = nodeId(graph, 'writeComputedTransfer', 'writes.ts');
    const writeNestedSpread = nodeId(graph, 'writeNestedSpread', 'writes.ts');
    const writeNestedUnused = nodeId(graph, 'writeNestedUnused', 'writes.ts');
    const writeUnknownOld = nodeId(graph, 'writeUnknownOld', 'writes.ts');
    const writeUnknownNew = nodeId(graph, 'writeUnknownNew', 'writes.ts');

    assert.equal(reachable(graph, ownerA, writeA), true, 'invoked callback must expose its actual write');
    assert.equal(reachable(graph, ownerB, writeB), true, 'second call site must expose its own write');
    assert.equal(reachable(graph, ownerA, writeB), false, 'shared wrapper must not pool another call site callback');
    assert.equal(reachable(graph, ownerB, writeA), false, 'call-site isolation must be symmetric');
    assert.equal(reachable(graph, ownerUnused, writeUnused), false, 'passed-but-not-called callback must remain disconnected');
    const callbackArgs = (caller: string) => graph.edges.filter(edge =>
      edge.from === caller && edge.kind === 'callback-argument' && edge.status === 'resolved');
    assert.equal(callbackArgs(ownerUnused).length, 1,
      'the known-unused callback still has an independent source argument fact');
    assert.equal(callbackArgs(ownerStored).length, 1,
      'a stored callback has a source relationship even when invocation is unproven');
    assert.equal(callbackArgs(ownerA).length, 1);
    assert.equal(callbackArgs(ownerB).length, 1);
    assert.notEqual(callbackArgs(ownerA)[0]?.to, callbackArgs(ownerB)[0]?.to);
    const storedProofId = callbackArgs(ownerStored)[0]?.evidenceIds?.[0];
    const storedProof = graph.evidence.find(item => item.id === storedProofId);
    assert.equal(storedProof?.kind, 'source-callback-argument');
    assert.equal((storedProof?.value as { runtimeObserved?: boolean })?.runtimeObserved, false);
    assert.equal(reachable(graph, ownerStored, writeStored), false, 'stored callback transfer must not become resolved execution');
    assert.equal(reachable(graph, ownerForwarded, writeForwarded), true, 'resolved wrapper forwarding through an invoked inline adapter must preserve execution');
    assert.equal(reachable(graph, ownerReassigned, writeReassigned), false, 'reassignment must break original callback identity');
    assert.equal(reachable(graph, ownerBlockShadow, writeBlockShadow), false, 'block shadow must not invoke the parameter callback');
    assert.equal(reachable(graph, ownerAdapterShadow, writeAdapterShadow), false, 'adapter parameter shadow must not invoke the outer callback');
    assert.equal(reachable(graph, ownerWrongPosition, writeWrongPosition), false, 'second argument must not bind to the first formal parameter');
    assert.equal(reachable(graph, ownerDuplicate, writeOverwritten), false, 'overwritten duplicate callback must not resolve');
    assert.equal(reachable(graph, ownerDuplicate, writeEffective), true, 'last effective callback property must resolve');
    assert.equal(reachable(graph, ownerSpread, writeSpread), false, 'a later spread makes the callback identity unresolved');
    assert.equal(reachable(graph, ownerImportShadow, writeImportShadow), false, 'parameter-shadowed import must not resolve as the import');
    assert.equal(reachable(graph, ownerCaptured, writeCaptured), false, 'captured returned callback must remain unresolved');
    assert.equal(reachable(graph, ownerDynamic, writeDynamic), false, 'unsupported dynamic transfer must remain unresolved');
    for (const owner of [ownerCatch, ownerLoop, ownerNamed, ownerVar]) assert.equal(reachable(graph, owner, writeImportShadow), false, 'lexically shadowed import must not resolve');
    assert.equal(reachable(graph, ownerAdapterEscape, writeAdapterEscape), false, 'nested adapter capture must remain unresolved');
    assert.equal(reachable(graph, ownerAdapterDefault, writeAdapterDefault), false, 'adapter default capture must remain unresolved');
    assert.equal(reachable(graph, ownerUnsupportedFormal, writeUnsupportedFormal), false, 'unsupported known formal shape must remain unresolved');
    assert.equal(reachable(graph, ownerSwitch, writeSwitch), false, 'switch lexical binding must shadow the import');
    assert.equal(reachable(graph, ownerMethod, writeMethod), true, 'method name must not shadow a genuine import');
    assert.equal(reachable(graph, ownerOpaque, writeOpaque), false, 'resolved target without inspectable body must remain unresolved');
    assert.equal(reachable(graph, ownerDuplicateBinding, writeDuplicateBinding), false, 'ambiguous duplicate destructuring must remain unresolved');
    assert.equal(reachable(graph, ownerQuotedBinding, writeQuotedBinding), true, 'unique quoted binding must preserve invocation');
    assert.equal(reachable(graph, ownerComputedTransfer, writeComputedTransfer), false, 'computed callback transfer must remain unresolved');
    assert.equal(reachable(graph, ownerNestedSpread, writeNestedSpread), false, 'nested spread callback transfer must remain unresolved');
    assert.equal(reachable(graph, ownerNestedUnused, writeNestedUnused), false, 'outer call must not reclassify a proven-unused nested-call callback');
    assert.equal(graph.edges.some(edge => edge.from === ownerNestedUnused && edge.kind === 'invokes'), false, 'proven-unused nested callback must have no invocation edge');
    assert.equal(reachable(graph, ownerUnknownDuplicate, writeUnknownOld), false, 'overwritten callback for unknown callee must remain non-transferred');
    assert.equal(callbackArgs(ownerUnknownDuplicate).length, 2,
      'both distinct expressions exist in source even though only one object property is effective');
    assert.equal(new Set(callbackArgs(ownerUnknownDuplicate).map(edge => edge.id)).size, 2,
      'source occurrence IDs must not collapse distinct callback arguments');
    assert.equal(reachable(graph, ownerUnknownDuplicate, writeUnknownNew), false, 'effective callback for unknown callee must remain unresolved');
    assert.equal(graph.edges.filter(edge => edge.from === ownerUnknownDuplicate && edge.kind === 'invokes' && edge.status === 'unresolved').length, 1, 'unknown duplicate call must emit only the effective unresolved transfer');

    const unresolved = graph.edges.find(edge => edge.from === ownerStored && edge.kind === 'invokes' && edge.status === 'unresolved');
    assert.ok(unresolved, 'stored callback transfer must remain explicitly unresolved');
    assert.equal(unresolved.strategy, 'callback-transfer-unresolved');
    assert.equal(graph.edges.some(edge => edge.from === ownerUnused && edge.kind === 'invokes'), false);
    const ambiguous = graph.edges.find(edge => edge.from === ownerAmbiguous && edge.kind === 'invokes' && edge.status === 'unresolved');
    assert.ok(ambiguous, 'an unresolved imported callback transfer must remain explicit');
    assert.equal(ambiguous.strategy, 'callback-transfer-unresolved');
    for (const owner of [ownerReassigned, ownerWrongPosition, ownerSpread, ownerImportShadow, ownerCaptured, ownerDynamic, ownerCatch, ownerLoop, ownerNamed, ownerVar, ownerAdapterEscape, ownerAdapterDefault, ownerUnsupportedFormal, ownerSwitch, ownerOpaque, ownerDuplicateBinding, ownerComputedTransfer, ownerNestedSpread]) {
      assert.ok(graph.edges.some(edge => edge.from === owner && edge.kind === 'invokes' && edge.status === 'unresolved'), `expected explicit unresolved callback transfer from ${owner}`);
    }

    const parity = evaluateParityContractGraph(graph, {
      version: 1,
      predicates: [
        { id: 'invoked-write-forbidden', type: 'reachability', from: { ids: [ownerA] }, to: { ids: [writeA] }, requirement: 'forbidden', quantifier: 'any', relationshipKinds: ['calls', 'invokes'], maxDepth: 4 },
        { id: 'stored-write-forbidden', type: 'reachability', from: { ids: [ownerStored] }, to: { ids: [writeStored] }, requirement: 'forbidden', quantifier: 'any', relationshipKinds: ['calls', 'invokes'], maxDepth: 4 },
        { id: 'computed-write-forbidden', type: 'reachability', from: { ids: [ownerComputedTransfer] }, to: { ids: [writeComputedTransfer] }, requirement: 'forbidden', quantifier: 'any', relationshipKinds: ['calls', 'invokes'], maxDepth: 4 },
        { id: 'spread-write-forbidden', type: 'reachability', from: { ids: [ownerNestedSpread] }, to: { ids: [writeNestedSpread] }, requirement: 'forbidden', quantifier: 'any', relationshipKinds: ['calls', 'invokes'], maxDepth: 4 },
      ],
    }) as any;
    assert.equal(parity.results[0]?.status, 'forbidden-present', 'resolved invocation must surface forbidden-present evidence');
    assert.ok(parity.results[0]?.observed && 'counterexamples' in parity.results[0].observed && parity.results[0].observed.counterexamples.length > 0);
    assert.equal(parity.results[1]?.status, 'unproven', 'unresolved callback transfer must not satisfy forbidden absence');
    assert.equal(parity.results[2]?.status, 'unproven', 'computed callback transfer must not satisfy forbidden absence');
    assert.equal(parity.results[3]?.status, 'unproven', 'spread callback transfer must not satisfy forbidden absence');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fresh-array callback provenance resolves only an unmodified factory chain', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devint-fresh-array-callback-'));
  try {
    await fs.writeFile(path.join(root, 'factory.ts'), `export const makeBox = () => ({ items: [1, 2, 3] });
export const makeArray = () => [1, 2, 3];
export const makeSpreadBox = (opaque: object) => ({ items: [1, 2, 3], ...opaque });
export const makeMutatedArray = () => { const a = [1, 2, 3]; a.map = ((_callback: unknown) => []) as typeof a.map; return a; };
export const makeAliasedMutatedArray = () => { const a = [1, 2, 3]; const b = a; b.map = ((_callback: unknown) => []) as typeof b.map; return a; };
export const makeEscapedArray = (opaque: (value: number[]) => void) => { const a = [1, 2, 3]; opaque(a); return a; };
export const makeCapturedArray = (opaque: (value: number[]) => void) => { const a = [1, 2, 3]; function mutate() { opaque(a); } mutate(); return a; };
export const makePoisonBox = () => ({ items: [1, 2, 3], get poison() { this.items.map = ((_callback: unknown) => []) as typeof this.items.map; return 1; } });
export const makeFunctionBox = () => ({ items: [1, 2, 3], poison: function () { this.items.map = ((_callback: unknown) => []) as typeof this.items.map; } });
export const makeSeparatedBox = () => ({ items: [1, 2, 3], label: 'safe' });
export const makePrototypeBox = () => ({ items: [1, 2, 3], __proto__: { get poison() { return 1; } } });
export const makeAliasBox = () => { const items = [1, 2, 3]; return { items, sibling: items }; };
`);
    await fs.writeFile(path.join(root, 'writes.ts'), `export const writeFresh = () => 'fresh';
export const writeInvoking = () => 'invoking'; export const writeStoring = () => 'storing'; export const writeIgnoring = () => 'ignoring';
export const writeOpaque = () => 'opaque'; export const writeRebound = () => 'rebound'; export const writeOverride = () => 'override';
export const writeReassigned = () => 'reassigned'; export const writeSpread = () => 'spread'; export const writeNested = () => 'nested';
export const writeFactoryMutated = () => 'factory-mutated'; export const writeFactoryAliasMutated = () => 'factory-alias-mutated';
export const writeFactoryEscaped = () => 'factory-escaped';
export const writeBlockBorrow = () => 'block-borrow'; export const writeOpaqueBox = () => 'opaque-box'; export const writePropertyAlias = () => 'property-alias'; export const writeFactoryCaptured = () => 'factory-captured';
export const writePriorMap = () => 'prior-map'; export const writePoison = () => 'poison';
export const writeSiblingCall = () => 'sibling-call';
export const writeSeparated = () => 'separated'; export const writePrototype = () => 'prototype'; export const writeSiblingAlias = () => 'sibling-alias';
`);
    await fs.writeFile(path.join(root, 'owners.ts'), `import { makeBox, makeArray, makeSpreadBox, makeMutatedArray, makeAliasedMutatedArray, makeEscapedArray, makeCapturedArray, makePoisonBox, makeFunctionBox, makeSeparatedBox, makePrototypeBox, makeAliasBox } from './factory';
import { writeFresh, writeInvoking, writeStoring, writeIgnoring, writeOpaque, writeRebound, writeOverride, writeReassigned, writeSpread, writeNested, writeFactoryMutated, writeFactoryAliasMutated, writeFactoryEscaped, writeBlockBorrow, writeOpaqueBox, writePropertyAlias, writeFactoryCaptured, writePriorMap, writePoison, writeSiblingCall, writeSeparated, writePrototype, writeSiblingAlias } from './writes';
export function freshFactory() { const box = makeBox(); return box.items.map(() => writeFresh()); }
export function customInvoking() { const custom = { map: (callback: () => unknown) => callback() }; return custom.map(() => writeInvoking()); }
export function customStoring() { let saved: unknown; const custom = { map: (callback: () => unknown) => { saved = callback; return []; } }; return custom.map(() => writeStoring()); }
export function customIgnoring() { const custom = { map: (_callback: () => unknown) => [] }; return custom.map(() => writeIgnoring()); }
export function opaqueReceiver(items: { map(callback: () => unknown): unknown }) { return items.map(() => writeOpaque()); }
export function reboundMap() { const items = makeArray(); items.map = ((_callback: unknown) => []) as typeof items.map; return items.map(() => writeRebound()); }
export function propertyOverride() { const box = makeBox(); box.items.map = ((_callback: unknown) => []) as typeof box.items.map; return box.items.map(() => writeOverride()); }
export function reassignedBox() { let box = makeBox(); box = { items: { map: (_callback: unknown) => [] } } as unknown as ReturnType<typeof makeBox>; return box.items.map(() => writeReassigned()); }
export function spreadOverride() { const box = makeSpreadBox({ items: { map: (_callback: unknown) => [] } }); return box.items.map(() => writeSpread()); }
export function nestedBorrow(items: { map(callback: () => unknown): unknown }) { function unused() { const items = [1, 2, 3]; return items; } void unused; return items.map(() => writeNested()); }
export function factoryMutated() { const items = makeMutatedArray(); return items.map(() => writeFactoryMutated()); }
export function factoryAliasMutated() { const items = makeAliasedMutatedArray(); return items.map(() => writeFactoryAliasMutated()); }
export function factoryEscaped(opaque: (value: number[]) => void) { const items = makeEscapedArray(opaque); return items.map(() => writeFactoryEscaped()); }
export function blockBorrow(items: { map(callback: () => unknown): unknown }) { { const items = [1, 2, 3]; void items; } return items.map(() => writeBlockBorrow()); }
export function opaqueBox(opaque: (value: unknown) => void) { const box = makeBox(); opaque(box); return box.items.map(() => writeOpaqueBox()); }
export function propertyAlias() { const box = makeBox(); const items = box.items; items.map = ((_callback: unknown) => []) as typeof items.map; return box.items.map(() => writePropertyAlias()); }
export function factoryCaptured(opaque: (value: number[]) => void) { const items = makeCapturedArray(opaque); return items.map(() => writeFactoryCaptured()); }
export function priorMapMutation() { const items = makeArray(); items.map((_value, _index, array) => { array.map = ((_callback: unknown) => []) as typeof array.map; }); return items.map(() => writePriorMap()); }
export function poisonGetter() { const box = makePoisonBox(); void box.poison; return box.items.map(() => writePoison()); }
export function siblingCall() { const box = makeFunctionBox(); box.poison(); return box.items.map(() => writeSiblingCall()); }
export function separatedSibling() { const box = makeSeparatedBox(); void box.label; return box.items.map(() => writeSeparated()); }
export function prototypeCustomization() { const box = makePrototypeBox(); void box.poison; return box.items.map(() => writePrototype()); }
export function siblingAliasMutation() { const box = makeAliasBox(); box.sibling.map = ((_callback: unknown) => []) as typeof box.sibling.map; return box.items.map(() => writeSiblingAlias()); }
`);
    await runChecked('git', ['init', '--initial-branch=main', root]);
    await runChecked('git', ['-C', root, 'add', '.']);
    await runChecked('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture']);
    const graph = await buildLocalGraph(root, 'fresh-array-fixture', 'W');
    const cases: Array<[string, string, boolean]> = [
      ['freshFactory', 'writeFresh', true], ['customInvoking', 'writeInvoking', false], ['customStoring', 'writeStoring', false],
      ['customIgnoring', 'writeIgnoring', false], ['opaqueReceiver', 'writeOpaque', false], ['reboundMap', 'writeRebound', false], ['propertyOverride', 'writeOverride', false],
      ['reassignedBox', 'writeReassigned', false], ['spreadOverride', 'writeSpread', false], ['nestedBorrow', 'writeNested', false],
      ['factoryMutated', 'writeFactoryMutated', false], ['factoryAliasMutated', 'writeFactoryAliasMutated', false],
      ['factoryEscaped', 'writeFactoryEscaped', false],
      ['blockBorrow', 'writeBlockBorrow', false], ['opaqueBox', 'writeOpaqueBox', false], ['propertyAlias', 'writePropertyAlias', false], ['factoryCaptured', 'writeFactoryCaptured', false],
      ['priorMapMutation', 'writePriorMap', false], ['poisonGetter', 'writePoison', false],
      ['siblingCall', 'writeSiblingCall', false],
      ['separatedSibling', 'writeSeparated', true], ['prototypeCustomization', 'writePrototype', false], ['siblingAliasMutation', 'writeSiblingAlias', false],
    ];
    for (const [ownerName, writeName, expected] of cases) {
      const owner = nodeId(graph, ownerName, 'owners.ts');
      const write = nodeId(graph, writeName, 'writes.ts');
      const edges = graph.edges.filter(edge => edge.from === owner && edge.kind === 'invokes');
      assert.equal(reachable(graph, owner, write), expected, `${ownerName} reachability`);
      if (expected) assert.ok(edges.some(edge => edge.status === 'resolved' && edge.strategy === 'fresh-array-callback-invocation'));
      else assert.ok(edges.some(edge => edge.status === 'unresolved'));
    }
    const parity = evaluateParityContractGraph(graph, {
      version: 1,
      predicates: cases.map(([ownerName, writeName]) => ({
        id: `${ownerName}-forbidden`, type: 'reachability' as const,
        from: { ids: [nodeId(graph, ownerName, 'owners.ts')] }, to: { ids: [nodeId(graph, writeName, 'writes.ts')] },
        requirement: 'forbidden' as const, quantifier: 'any' as const, relationshipKinds: ['calls', 'invokes'], maxDepth: 4,
      })),
    }) as any;
    for (const [index, result] of parity.results.entries()) assert.equal(result.status,
      cases[index]?.[2] ? 'forbidden-present' : 'unproven', `${result.predicate.id} must preserve its proof boundary`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
