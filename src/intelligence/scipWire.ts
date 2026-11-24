import { fromBinary } from '@bufbuild/protobuf';
import { DocumentSchema, MetadataSchema, SymbolInformationSchema, type Occurrence } from '@scip-code/scip';
import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';

/** The source-range subset used by DI's source reconciliation. */
export interface ScipRange { line: number; start: number; end: number }
export interface ScipOccurrence { symbol: string; roles: number; range: ScipRange | null; documentOccurrence: boolean }
export interface ScipDocument { path: string; positionEncoding: number; occurrences: ScipOccurrence[] }
export interface ScipIndex {
  producer: { name: string; version: string };
  documents: ScipDocument[];
  externalSymbols: string[];
  occurrenceCount: number;
}

function sourceRange(occurrence: Occurrence): ScipRange | null {
  const typed = occurrence.typedRange;
  let line: number, start: number, end: number;
  if (typed.case === 'singleLineRange') {
    ({ line, startCharacter: start, endCharacter: end } = typed.value);
  } else if (typed.case === 'multiLineRange') {
    if (typed.value.startLine !== typed.value.endLine) return null;
    line = typed.value.startLine; start = typed.value.startCharacter; end = typed.value.endCharacter;
  } else {
    const range = occurrence.range;
    if (range.length === 3) [line, start, end] = range as [number, number, number];
    else if (range.length === 4 && range[0] === range[2]) {
      line = range[0]!; start = range[1]!; end = range[3]!;
    } else return null;
  }
  return line >= 0 && start >= 0 && end > start ? { line, start, end } : null;
}

/** Decode the maintained SCIP protocol, retaining unsupported ranges as unknown. */
export function decodeScipIndex(value: Uint8Array): ScipIndex {
  if (!value.length) throw new Error('SCIP index is empty');
  const reader = new BinaryReader(value);
  let producer: { name: string; version: string } | undefined;
  let occurrenceCount = 0;
  const documents: ScipDocument[] = [];
  const externalSymbols: string[] = [];
  // SCIP specifies field-by-field consumption of Index to avoid allocating a
  // second complete protobuf graph alongside the reduced source occurrences.
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if ((field === 1 || field === 2 || field === 3) && wire !== WireType.LengthDelimited) throw new Error('Malformed SCIP index field');
    if (field === 1) {
      if (producer || documents.length || externalSymbols.length) throw new Error('SCIP metadata must appear once at the start');
      const tool = fromBinary(MetadataSchema, reader.bytes()).toolInfo;
      if (!tool?.name || !tool.version) throw new Error('SCIP index has no producer identity');
      producer = { name: tool.name, version: tool.version };
    } else if (field === 2) {
      if (!producer) throw new Error('SCIP index has no producer identity');
      const document = fromBinary(DocumentSchema, reader.bytes());
      if (!document.relativePath) throw new Error('SCIP document path is missing');
      occurrenceCount += document.occurrences.length;
      documents.push({ path: document.relativePath, positionEncoding: document.positionEncoding,
        occurrences: document.occurrences.map(occurrence => ({
          symbol: occurrence.symbol, roles: occurrence.symbolRoles, range: sourceRange(occurrence),
          documentOccurrence: occurrence.range.length === 3 && occurrence.range.every(value => value === 0),
        })) });
    } else if (field === 3) {
      if (!producer) throw new Error('SCIP index has no producer identity');
      externalSymbols.push(fromBinary(SymbolInformationSchema, reader.bytes()).symbol);
    } else reader.skip(wire, field);
  }
  if (!producer) throw new Error('SCIP index has no producer identity');
  return { producer, documents, externalSymbols, occurrenceCount };
}
