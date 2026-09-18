import type { GraphEdge, GraphNode } from '../types.js';
import { resolution } from './model.js';

function valueRecord(node: GraphNode): Record<string, unknown> | null {
  return node.value && typeof node.value === 'object' && !Array.isArray(node.value) ? node.value as Record<string, unknown> : null;
}

function textField(node: GraphNode, key: string): string | null {
  const value = valueRecord(node)?.[key];
  return typeof value === 'string' && value ? value : null;
}

function shortName(value: string): string { return value.toLowerCase().split('.').at(-1) ?? value.toLowerCase(); }

function add(output: GraphEdge[], seen: Set<string>, edge: GraphEdge): void {
  if (!seen.has(edge.id)) { seen.add(edge.id); output.push(edge); }
}

export function resolveEvidenceSpine(nodes: GraphNode[], existing: GraphEdge[]): GraphEdge[] {
  const output = [...existing];
  const seen = new Set(existing.map(edge => edge.id));

  const sqlFunctions = new Map<string, GraphNode[]>();
  for (const node of nodes.filter(node => node.kind === 'sql-function')) {
    const key = textField(node, 'shortName') ?? (node.name ? shortName(node.name) : null);
    if (!key) continue;
    const bucket = sqlFunctions.get(key) ?? [];
    bucket.push(node);
    sqlFunctions.set(key, bucket);
  }
  for (const rpc of nodes.filter(node => node.kind === 'rpc-call')) {
    const routine = textField(rpc, 'routine') ?? rpc.name;
    if (!routine) continue;
    const candidates = sqlFunctions.get(shortName(routine)) ?? [];
    if (candidates.length === 1) add(output, seen, resolution({
      from: rpc.id,
      to: candidates[0]!.id,
      kind: 'resolves_to',
      strategy: 'sql-rpc-name',
      confidence: 1,
      status: 'resolved',
      evidence: [rpc.locator, candidates[0]!.locator],
      layer: 'representation',
      checkpoint: false,
    }));
    else if (candidates.length > 1) add(output, seen, resolution({
      from: rpc.id,
      to: null,
      kind: 'resolves_to',
      strategy: 'sql-rpc-name',
      confidence: null,
      status: 'unresolved',
      evidence: [rpc.locator, `RPC routine ${routine} matches ${candidates.length} SQL routines`],
      layer: 'representation',
      checkpoint: false,
    }));
  }

  const tablesByQualified = new Map<string, GraphNode[]>();
  const tablesByShort = new Map<string, GraphNode[]>();
  for (const table of nodes.filter(node => node.kind === 'sql-table')) {
    const qualified = textField(table, 'qualifiedName') ?? table.name;
    if (!qualified) continue;
    const canonical = qualified.toLowerCase();
    const exact = tablesByQualified.get(canonical) ?? [];
    exact.push(table);
    tablesByQualified.set(canonical, exact);
    const short = shortName(canonical);
    const shortBucket = tablesByShort.get(short) ?? [];
    shortBucket.push(table);
    tablesByShort.set(short, shortBucket);
  }
  for (const ref of nodes.filter(node => node.kind === 'sql-reference')) {
    const qualified = textField(ref, 'qualifiedName') ?? ref.name;
    if (!qualified) continue;
    const exact = tablesByQualified.get(qualified.toLowerCase()) ?? [];
    const candidates = exact.length ? exact : tablesByShort.get(shortName(qualified)) ?? [];
    if (candidates.length === 1) add(output, seen, resolution({
      from: ref.id,
      to: candidates[0]!.id,
      kind: 'resolves_to',
      strategy: exact.length ? 'sql-qualified-name' : 'sql-short-name',
      confidence: 1,
      status: 'resolved',
      evidence: [ref.locator, candidates[0]!.locator],
      layer: 'representation',
      checkpoint: false,
    }));
    else if (candidates.length > 1) add(output, seen, resolution({
      from: ref.id,
      to: null,
      kind: 'resolves_to',
      strategy: 'sql-name',
      confidence: null,
      status: 'unresolved',
      evidence: [ref.locator, `SQL reference ${qualified} matches ${candidates.length} tables`],
      layer: 'representation',
      checkpoint: false,
    }));
  }

  const handlers = new Map<string, GraphNode[]>();
  for (const handler of nodes.filter(node => node.kind === 'component-prop-handler')) {
    const component = textField(handler, 'component');
    const prop = textField(handler, 'prop');
    if (!component || !prop) continue;
    const key = `${component}\u0000${prop}`;
    const bucket = handlers.get(key) ?? [];
    bucket.push(handler);
    handlers.set(key, bucket);
  }
  for (const binding of nodes.filter(node => node.kind === 'component-prop-binding')) {
    const component = textField(binding, 'component');
    const prop = textField(binding, 'prop');
    if (!component || !prop) continue;
    const matches = handlers.get(`${component}\u0000${prop}`) ?? [];
    if (matches.length === 1) add(output, seen, resolution({
      from: matches[0]!.id,
      to: binding.id,
      kind: 'bound_by',
      strategy: 'component-prop',
      confidence: 1,
      status: 'resolved',
      evidence: [matches[0]!.locator, binding.locator],
      layer: 'representation',
      checkpoint: false,
    }));
  }

  return output;
}
