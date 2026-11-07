/**
 * Bounded SCIP wire reader for the two evidence-bearing protobuf messages used
 * by DI: Index.metadata and Document.occurrences. It is not a SCIP writer or a
 * replacement for the official schema; unknown fields are skipped per protobuf.
 * Schema: https://github.com/scip-code/scip/blob/main/scip.proto
 */
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;
const MAX_DOCUMENTS = 1500;
const MAX_OCCURRENCES = 160000;
const MAX_SYMBOL = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ScipRange { line: number; start: number; end: number }
export interface ScipOccurrence { symbol: string; roles: number; range: ScipRange | null }
export interface ScipDocument { path: string; positionEncoding: number; occurrences: ScipOccurrence[] }
export interface ScipIndex {
  producer: { name: string; version: string };
  documents: ScipDocument[];
  occurrenceCount: number;
}

class Reader {
  offset = 0;
  constructor(readonly value: Uint8Array) {}

  next(): { field: number; wire: number } | null {
    if (this.offset === this.value.length) return null;
    const key = this.varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field < 1 || field > 536870911 || ![0, 1, 2, 5].includes(wire)) {
      throw new Error('SCIP protobuf field key or wire type is invalid');
    }
    return { field, wire };
  }

  varint(): number {
    let result = 0;
    for (let i = 0; i < 10; i += 1) {
      if (this.offset >= this.value.length) throw new Error('SCIP protobuf varint is truncated');
      const byte = this.value[this.offset++]!;
      result += (byte & 127) * 2 ** (i * 7);
      if (!Number.isSafeInteger(result)) throw new Error('SCIP protobuf integer exceeds supported range');
      if (!(byte & 128)) return result;
    }
    throw new Error('SCIP protobuf varint is overlong');
  }

  bytes(limit: number): Uint8Array {
    const size = this.varint();
    if (!Number.isSafeInteger(size) || size > limit || size > this.value.length - this.offset) {
      throw new Error('SCIP protobuf length is invalid or exceeds the byte bound');
    }
    const slice = this.value.subarray(this.offset, this.offset + size);
    this.offset += size;
    return slice;
  }

  string(limit: number): string { return decoder.decode(this.bytes(limit)); }

  skip(wire: number): void {
    if (wire === 0) { this.varint(); return; }
    if (wire === 2) { this.bytes(MAX_INDEX_BYTES); return; }
    const size = wire === 1 ? 8 : wire === 5 ? 4 : 0;
    if (!size || this.offset + size > this.value.length) throw new Error('SCIP protobuf field is truncated');
    this.offset += size;
  }
}

function parseToolInfo(value: Uint8Array): { name: string; version: string } {
  const r = new Reader(value);
  let name = '';
  let version = '';
  for (let k = r.next(); k; k = r.next()) {
    if (k.field === 1 && k.wire === 2) name = r.string(128);
    else if (k.field === 2 && k.wire === 2) version = r.string(128);
    else r.skip(k.wire);
  }
  if (!name.trim() || !version.trim()) throw new Error('SCIP producer name and version are required');
  return { name, version };
}

function parseMetadata(value: Uint8Array): { name: string; version: string } {
  const r = new Reader(value);
  let tool: { name: string; version: string } | null = null;
  for (let k = r.next(); k; k = r.next()) {
    if (k.field === 2 && k.wire === 2) {
      if (tool) throw new Error('SCIP metadata has duplicate producer identity');
      tool = parseToolInfo(r.bytes(1024));
    } else r.skip(k.wire);
  }
  if (!tool) throw new Error('SCIP index is missing producer metadata');
  return tool;
}

function singleLine(value: Uint8Array): ScipRange | null {
  const r = new Reader(value);
  let line = -1;
  let start = -1;
  let end = -1;
  for (let k = r.next(); k; k = r.next()) {
    if (k.field === 1 && k.wire === 0) line = r.varint();
    else if (k.field === 2 && k.wire === 0) start = r.varint();
    else if (k.field === 3 && k.wire === 0) end = r.varint();
    else r.skip(k.wire);
  }
  return line >= 0 && start >= 0 && end > start ? { line, start, end } : null;
}

function multiLine(value: Uint8Array): ScipRange | null {
  const r = new Reader(value);
  let line = -1, start = -1, endLine = -1, end = -1;
  for (let k = r.next(); k; k = r.next()) {
    if (k.field === 1 && k.wire === 0) line = r.varint();
    else if (k.field === 2 && k.wire === 0) start = r.varint();
    else if (k.field === 3 && k.wire === 0) endLine = r.varint();
    else if (k.field === 4 && k.wire === 0) end = r.varint();
    else r.skip(k.wire);
  }
  return line >= 0 && endLine === line && start >= 0 && end > start ? { line, start, end } : null;
}

function parseOccurrence(value: Uint8Array): ScipOccurrence {
  const r = new Reader(value);
  let symbol = '';
  let roles = 0;
  const oldRange: number[] = [];
  let typedRange: ScipRange | null = null;
  let typed = false;
  for (let k = r.next(); k; k = r.next()) {
    if (k.field === 1 && k.wire === 0) oldRange.push(r.varint());
    else if (k.field === 1 && k.wire === 2) {
      const packed = new Reader(r.bytes(64));
      while (packed.offset < packed.value.length) oldRange.push(packed.varint());
    } else if (k.field === 2 && k.wire === 2) symbol = r.string(MAX_SYMBOL);
    else if (k.field === 3 && k.wire === 0) roles = r.varint();
    else if (k.field === 8 && k.wire === 2) {
      if (typed) throw new Error('SCIP occurrence has duplicate typed range');
      typed = true;
      typedRange = singleLine(r.bytes(256));
    } else if (k.field === 9 && k.wire === 2) {
      if (typed) throw new Error('SCIP occurrence has duplicate typed range');
      typed = true;
      typedRange = multiLine(r.bytes(256));
    } else r.skip(k.wire);
    if (oldRange.length > 4) throw new Error('SCIP deprecated range contains too many positions');
  }
  const range = typed ? typedRange
    : oldRange.length === 3 && oldRange[2]! > oldRange[1]!
      ? { line: oldRange[0]!, start: oldRange[1]!, end: oldRange[2]! }
      : oldRange.length === 4 && oldRange[0] === oldRange[2] && oldRange[3]! > oldRange[1]!
        ? { line: oldRange[0]!, start: oldRange[1]!, end: oldRange[3]! }
        : null;
  return { symbol, roles, range };
}

function parseDocument(value: Uint8Array, room: number): ScipDocument {
  const r = new Reader(value);
  let path = '';
  let positionEncoding = 0;
  const occurrences: ScipOccurrence[] = [];
  for (let k = r.next(); k; k = r.next()) {
    if (k.field === 1 && k.wire === 2) path = r.string(2048);
    else if (k.field === 2 && k.wire === 2) {
      if (occurrences.length >= room) throw new Error('SCIP occurrence population exceeds the bound');
      occurrences.push(parseOccurrence(r.bytes(8192)));
    } else if (k.field === 6 && k.wire === 0) positionEncoding = r.varint();
    else r.skip(k.wire);
  }
  if (!path) throw new Error('SCIP document path is missing');
  return { path, positionEncoding, occurrences };
}

/**
 * Decode a bounded, complete SCIP Index. No partial success is reported for
 * malformed inputs; unknown/optional protobuf fields are safely skipped.
 */
export function decodeScipIndex(value: Uint8Array): ScipIndex {
  if (!value.length || value.length > MAX_INDEX_BYTES) throw new Error('SCIP index exceeds the bounded non-empty payload size');
  const r = new Reader(value);
  let producer: { name: string; version: string } | null = null;
  const documents: ScipDocument[] = [];
  let occurrenceCount = 0;
  for (let k = r.next(); k; k = r.next()) {
    if (!producer && (k.field !== 1 || k.wire !== 2)) {
      throw new Error('SCIP metadata must be the first index field');
    }
    if (k.field === 1 && k.wire === 2) {
      if (producer) throw new Error('SCIP index has duplicate metadata');
      producer = parseMetadata(r.bytes(16384));
    } else if (k.field === 2 && k.wire === 2) {
      if (documents.length >= MAX_DOCUMENTS) throw new Error('SCIP document population exceeds the bound');
      const doc = parseDocument(r.bytes(MAX_DOCUMENT_BYTES), MAX_OCCURRENCES - occurrenceCount);
      occurrenceCount += doc.occurrences.length;
      documents.push(doc);
    } else r.skip(k.wire);
  }
  if (!producer) throw new Error('SCIP index has no metadata');
  return { producer, documents, occurrenceCount };
}
