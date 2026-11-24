import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { GraphFamilyMembership, IntelligenceGraph } from '../types.js';
import { normalizeName } from './model.js';

// These indexes are disposable references into a single retained generation.
// Graph records and coverage remain owned by the retained graph itself.
const require = createRequire(import.meta.url);
const filename = 'retrieval-index.sqlite';
const version = 9;
const bound = new WeakMap<IntelligenceGraph, { file: string; generation: string }>();
const textCandidates = new WeakMap<IntelligenceGraph, Map<string, Set<string>>>();
const selectedViews = new WeakSet<IntelligenceGraph>();
export function hasLocalGraphIndex(graph: IntelligenceGraph): boolean { return bound.has(graph); }


function sqlite(): any {
  return require('node:sqlite').DatabaseSync;
}
function identity(graph: IntelligenceGraph, generation: string, indexVersion = version): string {
  return JSON.stringify({ version: indexVersion, generation, project: graph.project, graphId: graph.graphId,
    analyzerVersion: graph.analyzerVersion, sourceFingerprint: graph.sourceFingerprint,
    topologyFingerprint: graph.topologyFingerprint, evidenceFingerprint: graph.evidenceFingerprint,
    repositoryRevision: graph.repositoryRevision, sourceState: graph.sourceState ?? null });
}
function searchText(node: IntelligenceGraph['nodes'][number]): string {
  const value = node.value && typeof node.value === 'object' && !Array.isArray(node.value)
    ? node.value as { qualifiedName?: unknown; argumentIdentifiers?: unknown } : {};
  return [node.name, node.locator, node.raw, node.kind, node.field, ...(node.tags ?? []),
    typeof value.qualifiedName === 'string' ? value.qualifiedName : '',
    ...(Array.isArray(value.argumentIdentifiers) ? value.argumentIdentifiers.filter((v): v is string => typeof v === 'string') : [])]
    .filter(Boolean).join(' ').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_./:#-]+/gu, ' ').toLowerCase();
}
function selectionBody(node: IntelligenceGraph['nodes'][number]): string {
  const value = node.value && typeof node.value === 'object' && !Array.isArray(node.value)
    ? node.value as { functionId?: unknown; description?: unknown; qualifiedName?: unknown; argumentIdentifiers?: unknown } : null;
  const selectionValue = value ? { ...(typeof value.functionId === 'string' ? { functionId: value.functionId } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.qualifiedName === 'string' ? { qualifiedName: value.qualifiedName } : {}),
    ...(Array.isArray(value.argumentIdentifiers) ? { argumentIdentifiers: value.argumentIdentifiers } : {}) } : node.value;
  return JSON.stringify({ id: node.id, sourceId: node.sourceId, kind: node.kind, locator: node.locator,
    ...(node.name !== undefined ? { name: node.name } : {}), ...(node.raw !== undefined ? { raw: node.raw } : {}),
    ...(node.tags !== undefined ? { tags: node.tags } : {}), value: selectionValue });
}

/** Called before catalog publication. Any failure leaves the old target active. */
export function buildLocalGraphIndex(directory: string, generation: string, graph: IntelligenceGraph, families: Map<string, GraphFamilyMembership[]>): Record<string, unknown> {
  const started = Date.now();
  const Database = sqlite();
  const file = `${directory}/${filename}`;
  const db = new Database(file);
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE nodes (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, name TEXT, name_folded TEXT, name_normalized TEXT, source TEXT NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL, owner TEXT, selection_body TEXT NOT NULL, part TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE edges (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, src TEXT, dst TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, part TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE evidence (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, source TEXT NOT NULL, locator TEXT NOT NULL, part TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE record_evidence (record_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(record_id,evidence_id)) WITHOUT ROWID;
      CREATE TABLE families (node_id TEXT NOT NULL, family_id TEXT NOT NULL, roles TEXT NOT NULL, via TEXT NOT NULL, PRIMARY KEY(node_id,family_id)) WITHOUT ROWID;
      CREATE TABLE node_aliases (alias_folded TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(alias_folded,node_id)) WITHOUT ROWID;
      CREATE VIRTUAL TABLE node_text USING fts5(text, content='', tokenize='unicode61');
      BEGIN IMMEDIATE`);
    const nodeInsert = db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const edgeInsert = db.prepare('INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?)');
    const evidenceInsert = db.prepare('INSERT INTO evidence VALUES (?,?,?,?,?,?,?)');
    const textInsert = db.prepare('INSERT INTO node_text(rowid,text) VALUES (?,?)');
    const linkInsert = db.prepare('INSERT OR IGNORE INTO record_evidence VALUES (?,?)');
    const familyInsert = db.prepare('INSERT INTO families VALUES (?,?,?,?)');
    const aliasInsert = db.prepare('INSERT OR IGNORE INTO node_aliases VALUES (?,?)');
    const aliasLengths = new Set<number>();
    const tagsByKind = new Map<string, Set<string>>();
    const position = (field: 'nodes' | 'edges' | 'evidence') => {
      let part = 0, size = 2, offset = 1;
      return (value: unknown): [string, number, number] => {
        const body = JSON.stringify(value), length = Buffer.byteLength(body), bytes = length + 1;
        if (offset > 1 && size + bytes > 8 * 1024 * 1024) { part += 1; size = 2; offset = 1; }
        const result: [string, number, number] = [`${field}-${part}.json`, offset, length];
        size += bytes; offset += bytes; return result;
      };
    };
    const nodePosition = position('nodes'), edgePosition = position('edges'), evidencePosition = position('evidence');
    graph.nodes.forEach((node, ordinal) => {
      const value = node.value && typeof node.value === 'object' && !Array.isArray(node.value) ? node.value as { functionId?: unknown } : null;
      nodeInsert.run(node.id, ordinal, node.name ?? null, node.name?.toLowerCase() ?? null, node.name ? normalizeName(node.name) : null, node.sourceId, node.kind, node.locator, typeof value?.functionId === 'string' ? value.functionId : null, selectionBody(node), ...nodePosition(node));
      if (node.name) {
        const qualified = node.value && typeof node.value === 'object' && !Array.isArray(node.value)
          ? (node.value as { qualifiedName?: unknown }).qualifiedName : null;
        const parts = typeof qualified === 'string' ? qualified.split('.') : [];
        const names = node.kind === 'file' ? [node.name, node.name.split(/[\\/]/u).at(-1) ?? '']
          : [node.name, ...(parts.length > 1 ? parts.slice(0, -1).map((_, i) => parts.slice(i).join('.')) : [])];
        for (const name of names) if (name.length > 1 && (/[.:#_]/u.test(name) || /[a-z][A-Z]/u.test(name) || /^[A-Z][\p{L}\p{N}_]*$/u.test(name))) {
          const folded = name.toLowerCase(); aliasInsert.run(folded, node.id); aliasLengths.add(folded.length);
        }
      }
      if (node.tags?.length) {
        const tags = tagsByKind.get(node.kind) ?? new Set<string>();
        for (const tag of node.tags) tags.add(tag);
        tagsByKind.set(node.kind, tags);
      }
      textInsert.run(ordinal + 1, searchText(node));
      for (const id of node.evidenceIds ?? []) linkInsert.run(node.id, id);
    });
    graph.edges.forEach((edge, ordinal) => {
      edgeInsert.run(edge.id, ordinal, edge.from, edge.to, edge.kind, edge.status, ...edgePosition(edge));
      for (const id of edge.evidenceIds ?? []) linkInsert.run(edge.id, id);
    });
    graph.evidence.forEach((item, ordinal) => evidenceInsert.run(item.id, ordinal, item.sourceId, item.locator, ...evidencePosition(item)));
    let familyCount = 0;
    for (const [nodeId, memberships] of families) for (const member of memberships) {
      familyInsert.run(nodeId, member.id, JSON.stringify(member.roles), JSON.stringify(member.via)); familyCount += 1;
    }
    const meta = db.prepare('INSERT INTO metadata VALUES (?,?)');
    meta.run('identity', identity(graph, generation));
    meta.run('counts', JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length, evidence: graph.evidence.length }));
    meta.run('nodeTags', JSON.stringify(Object.fromEntries([...tagsByKind].map(([kind, tags]) => [kind, [...tags].sort()]))));
    meta.run('aliasLengths', JSON.stringify([...aliasLengths].sort((a, b) => a - b)));
    // Questions do not inspect naming-divergence inventories. Retain their
    // owner in the manifest; the compact envelope never claims to contain them.
    meta.run('questionEnvelope', JSON.stringify({ ...graph, nodes: [], edges: [], evidence: [], namingDivergences: [] }));
    db.exec(`COMMIT;
      CREATE INDEX node_name ON nodes(name_folded,ordinal);
      CREATE INDEX node_normalized_name ON nodes(name_normalized,ordinal);
      CREATE UNIQUE INDEX node_ordinal ON nodes(ordinal);
      CREATE INDEX node_owner ON nodes(owner);
      CREATE INDEX node_source ON nodes(source, kind);
      CREATE INDEX node_locator ON nodes(locator);
      CREATE INDEX edge_src ON edges(src,kind,status);
      CREATE INDEX edge_dst ON edges(dst,kind,status);
      CREATE INDEX edge_kind ON edges(kind);
      CREATE INDEX evidence_source ON evidence(source,locator);
      CREATE INDEX evidence_reverse ON record_evidence(evidence_id)`);
    db.exec('CREATE INDEX family_members ON families(family_id,node_id)');
    const missingEvidence = Number(db.prepare('SELECT count(*) AS n FROM record_evidence r LEFT JOIN evidence e ON e.id=r.evidence_id WHERE e.id IS NULL').get().n);
    const unresolvedEndpoints = Number(db.prepare('SELECT count(*) AS n FROM edges e LEFT JOIN nodes s ON s.id=e.src LEFT JOIN nodes t ON t.id=e.dst WHERE (e.src IS NOT NULL AND s.id IS NULL) OR (e.dst IS NOT NULL AND t.id IS NULL)').get().n);
    const missingFamilyNodes = Number(db.prepare('SELECT count(*) AS n FROM families f LEFT JOIN nodes n ON n.id=f.node_id LEFT JOIN nodes a ON a.id=f.family_id WHERE n.id IS NULL OR a.id IS NULL').get().n);
    const missingFamilyRelationships = Number(db.prepare('SELECT count(*) AS n FROM families f, json_each(f.via) v LEFT JOIN edges e ON e.id=v.value WHERE e.id IS NULL').get().n);
    const report = { state: 'built', version, generation, graphId: graph.graphId,
      counts: { nodes: graph.nodes.length, edges: graph.edges.length, evidence: graph.evidence.length, familyMemberships: familyCount },
      missingEvidenceReferences: missingEvidence, missingEndpointReferences: unresolvedEndpoints,
      missingFamilyNodes, missingFamilyRelationships,
      durationMs: Date.now() - started, identitySha256: createHash('sha256').update(identity(graph, generation)).digest('hex') };
    meta.run('audit', JSON.stringify(report));
    return report;
  } finally { db.close(); }
}

/** Read the bounded metadata needed by graph questions. Full graph metadata
 * remains in the manifest and is loaded by the normal full-graph operation. */
export function readIndexedQuestionEnvelope(directory: string, project: string, generation: string, graphId: string, sourceFingerprint: string | null): IntelligenceGraph | null {
  const Database = sqlite(), db = new Database(path.join(directory, filename), { readOnly: true });
  try {
    const recorded = db.prepare("SELECT value FROM metadata WHERE key='identity'").get()?.value;
    if (typeof recorded !== 'string') throw new Error('Local retrieval index identity is missing');
    const indexVersion = JSON.parse(recorded)?.version;
    if (indexVersion !== 8 && indexVersion !== version) return null;
    const body = db.prepare("SELECT value FROM metadata WHERE key='questionEnvelope'").get()?.value;
    if (typeof body !== 'string') throw new Error('Local retrieval index envelope is missing');
    if (typeof db.prepare("SELECT value FROM metadata WHERE key='nodeTags'").get()?.value !== 'string') return null;
    if (typeof db.prepare("SELECT value FROM metadata WHERE key='aliasLengths'").get()?.value !== 'string') return null;
    const graph = JSON.parse(body) as IntelligenceGraph;
    if (graph.project !== project || graph.graphId !== graphId || graph.sourceFingerprint !== sourceFingerprint
      || graph.nodes.length || graph.edges.length || graph.evidence.length || recorded !== identity(graph, generation, indexVersion)) throw new Error('Local retrieval index identity mismatch');
    return graph;
  } finally { db.close(); }
}

/** Graph-wide vocabulary, including classifications outside a selected view. */
export function indexedNodeTags(graph: IntelligenceGraph, kinds: Iterable<string>): string[] | null {
  const index = bound.get(graph);
  if (!index) return null;
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  try {
    const body = db.prepare("SELECT value FROM metadata WHERE key='nodeTags'").get()?.value;
    if (typeof body !== 'string') return null;
    const byKind = JSON.parse(body) as Record<string, string[]>;
    return [...new Set([...kinds].flatMap(kind => Object.hasOwn(byKind, kind) && Array.isArray(byKind[kind]) ? byKind[kind]! : []))];
  } finally { db.close(); }
}

function exactAliasCandidates(db: any, question: string): Set<string> {
  const result = new Set<string>();
  const aliasLengths = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='aliasLengths'").get().value) as number[];
  const aliasLookup = db.prepare('SELECT node_id FROM node_aliases WHERE alias_folded=?');
  const word = (value: string) => /[\p{L}\p{N}_]/u.test(value);
  const lower = question.toLowerCase();
  for (let start = 0; start < lower.length; start += 1) {
    if (word(lower[start - 1] ?? '')) continue;
    for (const length of aliasLengths) {
      const end = start + length;
      if (end > lower.length) break;
      if (word(lower[end] ?? '')) continue;
      for (const row of aliasLookup.iterate(lower.slice(start, end))) result.add(row.node_id);
    }
  }
  return result;
}

/** Broad candidate lookup for the same language terms used by graph filtering.
 * Prefixes over-include lexical variants; graph filtering still scores the
 * actual records and decides relevance. Non-ASCII questions retain the full
 * scan until tokenizer and JS Unicode boundaries can be reconciled. */
export function indexedTextCandidates(graph: IntelligenceGraph, question: string, terms: string[]): Set<string> | null {
  const index = bound.get(graph);
  if (!index || !terms.length || !/^[\x00-\x7f]+$/u.test(question)) return null;
  const cacheKey = JSON.stringify([question, terms]);
  const cached = textCandidates.get(graph)?.get(cacheKey);
  if (cached) return cached;
  const tokens = new Set(terms.flatMap(value => value.toLowerCase().match(/[a-z0-9]+/gu) ?? []));
  const questionWords = question.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  // Name scoring also recognizes consecutive words from the question even if
  // they are stop words. Match pairs as phrases instead of loading every node
  // containing any common word; pairs are a superset of each longer run.
  const nameRuns = new Set(questionWords.slice(0, -1).map((word, i) => `"${word} ${questionWords[i + 1]}"`));
  const prefixes = new Set<string>();
  for (const token of tokens) {
    const bases = new Set([token]);
    if (token.length > 5 && token.endsWith('ing')) { const base = token.slice(0, -3); bases.add(base); bases.add(base + 'e'); }
    if (token.length > 4 && token.endsWith('ed')) { const base = token.slice(0, -2); bases.add(base); bases.add(base + 'e'); }
    for (const base of bases) { prefixes.add(base); if (base.endsWith('e') && base.length > 1) prefixes.add(base.slice(0, -1)); }
  }
  if (!prefixes.size) return null;
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  try {
    db.exec('CREATE TEMP TABLE matched_nodes(id TEXT PRIMARY KEY) WITHOUT ROWID');
    const terms = [...[...prefixes].map(prefix => `"${prefix}"*`), ...nameRuns];
    const insert = db.prepare('INSERT OR IGNORE INTO matched_nodes SELECT n.id FROM node_text JOIN nodes n ON n.ordinal=node_text.rowid-1 WHERE node_text MATCH ?');
    // Keep each FTS expression manageable without limiting the question or
    // dropping matches: union the results of every batch in the same table.
    for (let at = 0; at < terms.length; at += 128) insert.run(terms.slice(at, at + 128).join(' OR '));
    const result = new Set<string>();
    for (const row of db.prepare('SELECT n.id,n.owner FROM matched_nodes m JOIN nodes n ON n.id=m.id').iterate()) {
      result.add(row.id); if (row.owner) result.add(row.owner);
    }
    for (const row of db.prepare("SELECT e.src FROM matched_nodes m CROSS JOIN edges e INDEXED BY edge_dst ON e.dst=m.id WHERE e.status <> 'unresolved' AND e.kind IN ('has-source-occurrence','calls-site') AND e.src IS NOT NULL").iterate()) result.add(row.src);
    // Distinctive exact names and qualified aliases can be stop words for the
    // language model. Match every valid question boundary against the index so
    // those subjects remain available even when no FTS term selects them.
    for (const id of exactAliasCandidates(db, question)) result.add(id);
    let cache = textCandidates.get(graph);
    if (!cache) { cache = new Map(); textCandidates.set(graph, cache); }
    cache.set(cacheKey, result);
    return result;
  } finally { db.close(); }
}

/** Preserve the graph's original order and the same JS case/normalization rules. */
export function indexedNameMatches(graph: IntelligenceGraph, name: string, normalized = false, limit = 20): IntelligenceGraph['nodes'] | null {
  const ids = indexedNodeIdsByName(graph, name, normalized, limit);
  return ids ? indexedRecords(graph, 'nodes', ids) : null;
}

/** Resolve exact or normalized names without materializing the graph. */
export function indexedNodeIdsByName(graph: IntelligenceGraph, name: string, normalized = false, limit = 20): string[] | null {
  const index = bound.get(graph);
  if (!index) return null;
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  try {
    const field = normalized ? 'name_normalized' : 'name_folded';
    const needle = normalized ? normalizeName(name) : name.trim().toLowerCase();
    if (!needle) return [];
    const rows = db.prepare(`SELECT ordinal,id FROM nodes WHERE ${field}=? ORDER BY ordinal LIMIT ?`).all(needle, limit);
    return rows.map((row: any) => row.id);
  } finally { db.close(); }
}

export function openIndexedFamilyAccess(graph: IntelligenceGraph): { get(id: string): GraphFamilyMembership[]; members(ids: Iterable<string>): Array<{ nodeId: string; membership: GraphFamilyMembership }>; close(): void } | null {
  const index = bound.get(graph);
  if (!index) return null;
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  const byNode = db.prepare('SELECT family_id,roles,via FROM families WHERE node_id=? ORDER BY family_id');
  const byFamily = db.prepare('SELECT f.node_id,f.family_id,f.roles,f.via,n.ordinal FROM families f JOIN nodes n ON n.id=f.node_id WHERE f.family_id=?');
  const cache = new Map<string, GraphFamilyMembership[]>();
  return {
    get(id) {
      const cached = cache.get(id); if (cached) return cached;
      const records = [...byNode.iterate(id)].map((row: any) => ({ id: row.family_id, roles: JSON.parse(row.roles), via: JSON.parse(row.via) }));
      cache.set(id, records); return records;
    },
    members(ids) {
      const rows: Array<{ ordinal: number; nodeId: string; membership: GraphFamilyMembership }> = [];
      for (const id of new Set(ids)) for (const row of byFamily.iterate(id)) rows.push({ ordinal: Number(row.ordinal), nodeId: row.node_id,
        membership: { id: row.family_id, roles: JSON.parse(row.roles), via: JSON.parse(row.via) } });
      rows.sort((a, b) => a.ordinal - b.ordinal || a.membership.id.localeCompare(b.membership.id));
      return rows.map(({ nodeId, membership }) => ({ nodeId, membership }));
    },
    close() { db.close(); },
  };
}

/** A fully loaded graph can reuse the generation's precomputed memberships
 * as one in-memory view across investigations. */
export function indexedFamilyMemberships(graph: IntelligenceGraph): Map<string, GraphFamilyMembership[]> | null {
  const index = bound.get(graph);
  if (!index || selectedViews.has(graph)) return null;
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  try {
    const result = new Map<string, GraphFamilyMembership[]>();
    for (const row of db.prepare('SELECT node_id,family_id,roles,via FROM families ORDER BY node_id,family_id').iterate()) {
      const list = result.get(row.node_id) ?? [];
      list.push({ id: row.family_id, roles: JSON.parse(row.roles), via: JSON.parse(row.via) });
      result.set(row.node_id, list);
    }
    return result;
  } finally { db.close(); }
}

export function isIndexedSelectedView(graph: IntelligenceGraph): boolean { return selectedViews.has(graph); }

/** Attach only an identity-matched derived index to this exact graph instance. */
export function bindLocalGraphIndex(graph: IntelligenceGraph, generation: string, directory: string): boolean {
  const Database = sqlite();
  const file = `${directory}/${filename}`;
  const db = new Database(file, { readOnly: true });
  try {
    const recorded = db.prepare("SELECT value FROM metadata WHERE key='identity'").get()?.value;
    if (typeof recorded !== 'string') throw new Error('Local retrieval index identity is missing');
    const parsed = JSON.parse(recorded) as { version?: unknown };
    // A retained graph from an earlier software version is still usable; its
    // derived index can be regenerated on a later build of that generation.
    if (parsed.version !== 8 && parsed.version !== version) return false;
    if (recorded !== identity(graph, generation, parsed.version)) throw new Error('Local retrieval index identity mismatch');
    bound.set(graph, { file, generation });
    return true;
  } finally { db.close(); }
}

export function localIndexAudit(graph: IntelligenceGraph): Record<string, unknown> | null {
  const index = bound.get(graph);
  if (!index) return null;
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  try {
    const stored = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='audit'").get().value);
    const check = db.prepare('PRAGMA quick_check').get();
    const counts = { nodes: Number(db.prepare('SELECT count(*) n FROM nodes').get().n),
      edges: Number(db.prepare('SELECT count(*) n FROM edges').get().n), evidence: Number(db.prepare('SELECT count(*) n FROM evidence').get().n),
      familyMemberships: Number(db.prepare('SELECT count(*) n FROM families').get().n) };
    const mismatches = { nodes: 0, edges: 0, evidence: 0, selectionFields: 0 };
    for (const row of db.prepare('SELECT id,ordinal,selection_body FROM nodes').iterate()) {
      const node = graph.nodes[Number(row.ordinal)];
      if (!node || node.id !== row.id) mismatches.nodes += 1;
      else if (selectionBody(node) !== row.selection_body) mismatches.selectionFields += 1;
    }
    for (const row of db.prepare('SELECT id,ordinal,src,dst,kind,status FROM edges').iterate()) {
      const edge = graph.edges[Number(row.ordinal)];
      if (!edge || edge.id !== row.id || edge.from !== row.src || edge.to !== row.dst || edge.kind !== row.kind || edge.status !== row.status) mismatches.edges += 1;
    }
    for (const row of db.prepare('SELECT id,ordinal FROM evidence').iterate()) {
      if (graph.evidence[Number(row.ordinal)]?.id !== row.id) mismatches.evidence += 1;
    }
    const textEntries = Number(db.prepare('SELECT count(*) n FROM node_text').get().n);
    return { ...stored, counts, integrity: check.quick_check,
      countMatchesGraph: counts.nodes === graph.nodes.length && counts.edges === graph.edges.length && counts.evidence === graph.evidence.length,
      textEntries, textEntryCountMatchesGraph: textEntries === graph.nodes.length, mismatches,
      scope: 'Index identity, record references, selection fields and relationship endpoints compared with the retained graph; source coverage and answer quality are reported separately.' };
  } finally { db.close(); }
}

/** Return ordered graph ordinals from the indexed record IDs. */
export function indexedOrdinals(graph: IntelligenceGraph, kind: 'nodes' | 'edges' | 'evidence', ids: Iterable<string>): number[] | null {
  const index = bound.get(graph);
  if (!index) return null;
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  try {
    const lookup = db.prepare(`SELECT ordinal FROM ${kind} WHERE id=?`), ordinals: number[] = [];
    for (const id of new Set(ids)) {
      const row = lookup.get(id);
      if (row) {
        const ordinal = Number(row.ordinal);
        if (graph[kind][ordinal]?.id !== id) throw new Error(`Local retrieval index ${kind} record mismatch: ${id}`);
        ordinals.push(ordinal);
      }
    }
    return ordinals.sort((a, b) => a - b);
  } finally { db.close(); }
}

/** Read selected records directly from their retained graph parts, without
 * reconstructing other graph records. */
export function indexedRecords<K extends 'nodes' | 'edges' | 'evidence'>(graph: IntelligenceGraph, kind: K, ids: Iterable<string>): IntelligenceGraph[K] | null {
  const index = bound.get(graph);
  if (!index) return null;
  if (!selectedViews.has(graph) && graph[kind].length) {
    const ordinals = indexedOrdinals(graph, kind, ids);
    return ordinals ? ordinals.map(ordinal => graph[kind][ordinal]!) as IntelligenceGraph[K] : null;
  }
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  const fs = require('node:fs');
  const handles = new Map<string, number>();
  try {
    const lookup = db.prepare(`SELECT id,ordinal,part,byte_offset,byte_length FROM ${kind} WHERE id=?`);
    const rows: any[] = [];
    for (const id of new Set(ids)) { const row = lookup.get(id); if (row) rows.push(row); }
    rows.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    const perPart = new Map<string, number>();
    for (const row of rows) perPart.set(row.part, (perPart.get(row.part) ?? 0) + 1);
    let bufferedPart: string | null = null, partBuffer: any = null;
    return rows.map(row => {
      if (typeof row.part !== 'string' || !new RegExp(`^${kind}-[0-9]+\\.json$`, 'u').test(row.part)
        || !Number.isSafeInteger(Number(row.byte_offset)) || Number(row.byte_offset) < 1
        || !Number.isSafeInteger(Number(row.byte_length)) || Number(row.byte_length) < 1) throw new Error('Invalid indexed graph record location');
      let buffer: any;
      if ((perPart.get(row.part) ?? 0) >= 128) {
        if (bufferedPart !== row.part) { bufferedPart = row.part; partBuffer = fs.readFileSync(path.join(path.dirname(index.file), row.part)); }
        buffer = partBuffer.subarray(Number(row.byte_offset), Number(row.byte_offset) + Number(row.byte_length));
        if (buffer.length !== Number(row.byte_length)) throw new Error(`Incomplete indexed graph record: ${row.id}`);
      } else {
        let handle = handles.get(row.part);
        if (handle === undefined) { handle = fs.openSync(path.join(path.dirname(index.file), row.part), 'r'); handles.set(row.part, handle!); }
        buffer = Buffer.alloc(Number(row.byte_length));
        let read = 0;
        while (read < buffer.length) {
          const count = fs.readSync(handle, buffer, read, buffer.length - read, Number(row.byte_offset) + read);
          if (!count) throw new Error(`Incomplete indexed graph record: ${row.id}`);
          read += count;
        }
      }
      const record = JSON.parse(buffer.toString('utf8'));
      if (record?.id !== row.id) throw new Error(`Indexed graph record identity mismatch: ${row.id}`);
      return record;
    }) as IntelligenceGraph[K];
  } finally { for (const handle of handles.values()) fs.closeSync(handle); db.close(); }
}

/** In graph order, return every relationship touching the requested endpoints. */
export function indexedIncidentEdges(graph: IntelligenceGraph, ids: Iterable<string>, direction: 'inbound' | 'outbound' | 'both' = 'both'): IntelligenceGraph['edges'] | null {
  if (selectedViews.has(graph)) {
    const selected = new Set(ids);
    return graph.edges.filter(edge => (direction !== 'inbound' && edge.from && selected.has(edge.from))
      || (direction !== 'outbound' && edge.to && selected.has(edge.to)));
  }
  const index = bound.get(graph);
  if (!index) return null;
  if (!graph.edges.length) return indexedIncidentRecords(graph, ids, direction);
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  try {
    const outgoing = db.prepare('SELECT ordinal FROM edges WHERE src=?'), incoming = db.prepare('SELECT ordinal FROM edges WHERE dst=?');
    const ordinals = new Set<number>();
    for (const id of new Set(ids)) {
      if (direction !== 'inbound') for (const row of outgoing.iterate(id)) ordinals.add(Number(row.ordinal));
      if (direction !== 'outbound') for (const row of incoming.iterate(id)) ordinals.add(Number(row.ordinal));
    }
    return [...ordinals].sort((a, b) => a - b).map(ordinal => graph.edges[ordinal]!);
  } finally { db.close(); }
}

/** Retrieve incident relationship records directly, including for an envelope
 * where no complete graph arrays have been loaded. */
export function indexedIncidentRecords(graph: IntelligenceGraph, ids: Iterable<string>, direction: 'inbound' | 'outbound' | 'both' = 'both'): IntelligenceGraph['edges'] | null {
  const index = bound.get(graph);
  if (!index) return null;
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  let edgeIds: string[];
  try {
    const outgoing = db.prepare('SELECT id FROM edges WHERE src=?');
    const incoming = db.prepare('SELECT id FROM edges WHERE dst=?');
    const found = new Set<string>();
    for (const id of new Set(ids)) {
      if (direction !== 'inbound') for (const row of outgoing.iterate(id)) found.add(row.id);
      if (direction !== 'outbound') for (const row of incoming.iterate(id)) found.add(row.id);
    }
    edgeIds = [...found];
  } finally { db.close(); }
  return indexedRecords(graph, 'edges', edgeIds);
}

/** Whole-generation vocabulary is needed even for a selected view. */
export function indexedRelationshipKinds(graph: IntelligenceGraph): string[] | null {
  const index = bound.get(graph);
  if (!index) return null;
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  try { return db.prepare('SELECT DISTINCT kind FROM edges ORDER BY kind').all().map((row: any) => row.kind); }
  finally { db.close(); }
}

/** Materialize candidates, their requested neighborhood, and the source and
 * family handoffs used by graph filtering. If the selected view approaches a
 * full graph, load the complete generation instead. */
export function materializeIndexedQuestionGraph(graph: IntelligenceGraph, questions: Array<{ text: string; terms: string[] }>, options: {
  selectSubjects: (candidate: IntelligenceGraph) => { ids: string[]; selection: string };
  rememberSelection: (selected: IntelligenceGraph) => void;
  depth?: number; scope?: string; comparisonIds?: string[]; comparisonScope?: string; comparisonKinds?: string[];
}): IntelligenceGraph | null {
  const index = bound.get(graph);
  if (!index) return null;
  const initial = new Set<string>();
  let exactSubjects: string[] | null = null;
  const exactScope = options.scope ? indexedRecords(graph, 'nodes', [options.scope]) : null;
  if (exactScope?.length) initial.add(exactScope[0]!.id);
  else {
    // A distinctive name can bind through the existing alias index before
    // scanning full-text candidates. The shared planner decides whether those
    // aliases actually establish an exact subject; otherwise retain the
    // ordinary full-text plan and all of its broader matches.
    if (!options.scope && questions.length === 1 && questions[0]!.terms.length
      && /^[\x00-\x7f]+$/u.test(questions[0]!.text)) {
      const Database = sqlite(), aliasDb = new Database(index.file, { readOnly: true });
      try {
        const aliases = exactAliasCandidates(aliasDb, questions[0]!.text);
        const lookup = aliasDb.prepare('SELECT ordinal,selection_body FROM nodes WHERE id=?');
        const rows = [...aliases].flatMap(id => {
          const row = lookup.get(id);
          return row ? [row] : [];
        });
        rows.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
        const nodes = rows.map(row => JSON.parse(row.selection_body));
        if (nodes.length) {
          const candidate = { ...graph, nodes, edges: [], evidence: [] };
          bindLocalGraphIndex(candidate, index.generation, path.dirname(index.file));
          const planned = options.selectSubjects(candidate);
          if (planned.selection === 'exact-name') exactSubjects = planned.ids;
        }
      } finally { aliasDb.close(); }
    }
    if (!exactSubjects) {
      for (const question of questions) {
        const candidates = indexedTextCandidates(graph, question.text, question.terms);
        if (!candidates) return null;
        for (const id of candidates) initial.add(id);
      }
    }
  }
  if (options.scope) initial.add(options.scope);
  const Database = sqlite(), db = new Database(index.file, { readOnly: true });
  let nodeIds: string[], edgeIds: string[];
  try {
    db.exec('CREATE TEMP TABLE selected(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE expansion(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE comparison_nodes(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE subjects(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE visited(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE frontier(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE next_frontier(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE selected_edges(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE edge_delta(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE callbacks(id TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TEMP TABLE callback_delta(id TEXT PRIMARY KEY) WITHOUT ROWID;');
    const add = db.prepare('INSERT OR IGNORE INTO frontier SELECT id FROM nodes WHERE id=?');
    for (const id of initial) add.run(id);
    const addComparison = db.prepare('INSERT OR IGNORE INTO comparison_nodes SELECT id FROM nodes WHERE id=?');
    for (const id of options.comparisonIds ?? []) addComparison.run(id);
    if (options.comparisonScope || options.comparisonKinds?.length) {
      const scope = options.comparisonScope?.replace(/\/$/u, '');
      const conditions: string[] = [], parameters: unknown[] = [];
      if (scope) { conditions.push('(source = ? OR substr(source,1,length(?)) = ?)'); parameters.push('repo:' + scope, 'repo:' + scope + '/', 'repo:' + scope + '/'); }
      if (options.comparisonKinds?.length) { conditions.push(`kind IN (${options.comparisonKinds.map(() => '?').join(',')})`); parameters.push(...options.comparisonKinds); }
      db.prepare(`INSERT OR IGNORE INTO comparison_nodes SELECT id FROM nodes WHERE ${conditions.join(' AND ')}`).run(...parameters);
    }
    db.exec('INSERT INTO selected SELECT id FROM frontier');
    // Subject scoring needs source facts owned by candidates even when those
    // particular facts do not contain a question term, plus lexical occurrence
    // links for matched call and variable sites.
    db.exec(`INSERT OR IGNORE INTO selected SELECT n.id FROM frontier f CROSS JOIN nodes n INDEXED BY node_owner ON n.owner=f.id WHERE n.kind IN ('source-condition','source-effect');
      INSERT OR IGNORE INTO selected_edges SELECT e.id FROM frontier f CROSS JOIN edges e INDEXED BY edge_dst ON e.dst=f.id WHERE e.status <> 'unresolved' AND e.kind IN ('has-source-occurrence','calls-site');
      INSERT OR IGNORE INTO selected SELECT e.src FROM selected_edges x CROSS JOIN edges e ON e.id=x.id JOIN nodes n ON n.id=e.src WHERE e.src IS NOT NULL;`);
    let chosen = exactSubjects;
    if (!chosen) {
      const candidateNodes = db.prepare('SELECT n.selection_body FROM selected s CROSS JOIN nodes n ON n.id=s.id ORDER BY n.ordinal').all().map((row: any) => JSON.parse(row.selection_body));
      const candidateEdges = db.prepare('SELECT e.id,e.src,e.dst,e.kind,e.status FROM selected_edges s CROSS JOIN edges e ON e.id=s.id ORDER BY e.ordinal').all().map((row: any) => ({ id: row.id, from: row.src, to: row.dst, kind: row.kind, status: row.status, strategy: '', confidence: null, evidence: [] }));
      const candidate = { ...graph, nodes: candidateNodes, edges: candidateEdges, evidence: [] };
      bindLocalGraphIndex(candidate, index.generation, path.dirname(index.file));
      const candidateCache = textCandidates.get(graph); if (candidateCache) textCandidates.set(candidate, candidateCache);
      chosen = options.selectSubjects(candidate).ids;
    }
    const addSubject = db.prepare('INSERT OR IGNORE INTO subjects SELECT id FROM nodes WHERE id=?');
    for (const id of chosen) addSubject.run(id);
    db.exec('DELETE FROM selected; INSERT INTO selected SELECT id FROM subjects; INSERT OR IGNORE INTO selected SELECT id FROM comparison_nodes; INSERT INTO expansion SELECT id FROM subjects; DELETE FROM selected_edges');
    db.exec(`INSERT OR IGNORE INTO expansion SELECT m.node_id FROM subjects s CROSS JOIN families m INDEXED BY family_members ON m.family_id=s.id;
      INSERT OR IGNORE INTO expansion SELECT m.family_id FROM subjects s CROSS JOIN families m ON m.node_id=s.id;
      INSERT OR IGNORE INTO selected SELECT id FROM expansion;
      INSERT OR IGNORE INTO selected_edges SELECT v.value FROM subjects s CROSS JOIN families m INDEXED BY family_members ON m.family_id=s.id JOIN json_each(m.via) v JOIN edges e ON e.id=v.value;
      INSERT OR IGNORE INTO selected_edges SELECT v.value FROM subjects s CROSS JOIN families m ON m.node_id=s.id JOIN json_each(m.via) v JOIN edges e ON e.id=v.value;
      DELETE FROM frontier; INSERT INTO frontier SELECT id FROM subjects; INSERT INTO visited SELECT id FROM subjects;`);
    const depth = Math.max(1, Math.floor(options.depth ?? 1));
    if (!Number.isFinite(depth)) return null;
    for (let hop = 0; hop < depth; hop += 1) {
      db.exec(`INSERT OR IGNORE INTO selected_edges SELECT e.id FROM frontier f CROSS JOIN edges e INDEXED BY edge_src ON e.src=f.id;
        INSERT OR IGNORE INTO selected_edges SELECT e.id FROM frontier f CROSS JOIN edges e INDEXED BY edge_dst ON e.dst=f.id;
        INSERT OR IGNORE INTO next_frontier SELECT e.dst FROM frontier f CROSS JOIN edges e INDEXED BY edge_src ON e.src=f.id JOIN nodes n ON n.id=e.dst WHERE e.dst IS NOT NULL;
        INSERT OR IGNORE INTO next_frontier SELECT e.src FROM frontier f CROSS JOIN edges e INDEXED BY edge_dst ON e.dst=f.id JOIN nodes n ON n.id=e.src WHERE e.src IS NOT NULL;
        DELETE FROM next_frontier WHERE id IN (SELECT id FROM visited);
        DELETE FROM frontier; INSERT INTO frontier SELECT id FROM next_frontier; INSERT OR IGNORE INTO selected SELECT id FROM next_frontier; INSERT OR IGNORE INTO expansion SELECT id FROM next_frontier; INSERT OR IGNORE INTO visited SELECT id FROM next_frontier; DELETE FROM next_frontier;`);
      if (!Number(db.prepare('SELECT count(*) n FROM frontier').get().n)) break;
    }
    db.exec(`INSERT OR IGNORE INTO expansion SELECT e.src FROM selected_edges x CROSS JOIN edges e ON e.id=x.id JOIN nodes n ON n.id=e.src WHERE e.src IS NOT NULL;
      INSERT OR IGNORE INTO expansion SELECT e.dst FROM selected_edges x CROSS JOIN edges e ON e.id=x.id JOIN nodes n ON n.id=e.dst WHERE e.dst IS NOT NULL;
      INSERT OR IGNORE INTO selected SELECT id FROM expansion;
      DELETE FROM frontier; INSERT INTO frontier SELECT id FROM expansion; INSERT INTO edge_delta SELECT id FROM selected_edges`);
    for (;;) {
      db.exec(`INSERT OR IGNORE INTO callback_delta SELECT e.dst FROM edge_delta x CROSS JOIN edges e ON e.id=x.id WHERE e.dst IS NOT NULL AND (e.kind IN ('callback-argument','handled_by') OR (e.kind='binds_to' AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=e.src AND n.kind='interaction-handler')));
        DELETE FROM callback_delta WHERE id IN (SELECT id FROM callbacks);
        INSERT OR IGNORE INTO callbacks SELECT id FROM callback_delta;
        INSERT OR IGNORE INTO frontier SELECT id FROM callback_delta;
        DELETE FROM callback_delta; DELETE FROM edge_delta;
        INSERT OR IGNORE INTO edge_delta SELECT e.id FROM frontier s JOIN nodes n ON n.id=s.id CROSS JOIN edges e INDEXED BY edge_src ON e.src=s.id
        WHERE e.kind IN ('has-parameter','has-condition','has-effect','has-source-control','contains-source-span','has-source-occurrence','has-argument','argument-for','spreads-properties','has-interaction','registers-interaction','calls-site','callback-argument','declares','handled_by','requires-condition')
        OR (e.kind='contains' AND n.kind IN ('function','method','constructor') AND EXISTS(SELECT 1 FROM nodes t WHERE t.id=e.dst AND t.kind='ui-element'))
        OR (e.kind IN ('binds_to','resolves_to','potential-value-from','potentially-provided-by','calls','invokes') AND (n.kind IN ('call-reference','interaction-handler','component-prop-binding','jsx-prop-spread','ui-element') OR (n.kind='function' AND n.name='callback') OR EXISTS(SELECT 1 FROM callbacks c WHERE c.id=n.id)));
        DELETE FROM edge_delta WHERE id IN (SELECT id FROM selected_edges);
        INSERT OR IGNORE INTO selected_edges SELECT id FROM edge_delta;
        INSERT OR IGNORE INTO next_frontier SELECT e.src FROM edge_delta x CROSS JOIN edges e ON e.id=x.id CROSS JOIN nodes n ON n.id=e.src WHERE e.src IS NOT NULL;
        INSERT OR IGNORE INTO next_frontier SELECT e.dst FROM edge_delta x CROSS JOIN edges e ON e.id=x.id CROSS JOIN nodes n ON n.id=e.dst WHERE e.dst IS NOT NULL;
        INSERT OR IGNORE INTO next_frontier SELECT n.id FROM frontier s CROSS JOIN nodes n INDEXED BY node_owner ON n.owner=s.id;
        DELETE FROM next_frontier WHERE id IN (SELECT id FROM selected);`);
      const progress = db.prepare('SELECT (SELECT count(*) FROM selected) n, (SELECT count(*) FROM selected_edges) e, (SELECT count(*) FROM next_frontier) pending, (SELECT count(*) FROM edge_delta) new_edges').get();
      if (!Number(progress.pending) && !Number(progress.new_edges)) break;
      db.exec('INSERT OR IGNORE INTO selected SELECT id FROM next_frontier; DELETE FROM frontier; INSERT INTO frontier SELECT id FROM next_frontier; DELETE FROM next_frontier');
    }
    db.exec('INSERT OR IGNORE INTO selected_edges SELECT e.id FROM selected s CROSS JOIN edges e INDEXED BY edge_src ON e.src=s.id JOIN selected t ON t.id=e.dst');
    nodeIds = db.prepare('SELECT id FROM selected').all().map((row: any) => row.id);
    edgeIds = db.prepare('SELECT id FROM selected_edges').all().map((row: any) => row.id);
  } finally { db.close(); }
  const nodes = indexedRecords(graph, 'nodes', nodeIds), edges = indexedRecords(graph, 'edges', edgeIds);
  if (!nodes || !edges) return null;
  const selected = { ...graph, nodes, edges, evidence: [] };
  bindLocalGraphIndex(selected, index.generation, path.dirname(index.file));
  selectedViews.add(selected);
  const candidates = textCandidates.get(graph);
  if (candidates) textCandidates.set(selected, candidates);
  options.rememberSelection(selected);
  return selected;
}
