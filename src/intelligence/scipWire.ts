import { fromBinary } from '@bufbuild/protobuf';
import { IndexSchema, type Occurrence } from '@scip-code/scip';

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
  const index = fromBinary(IndexSchema, value);
  const producer = index.metadata?.toolInfo;
  if (!producer?.name || !producer.version) throw new Error('SCIP index has no producer identity');
  let occurrenceCount = 0;
  const documents = index.documents.map(document => {
    if (!document.relativePath) throw new Error('SCIP document path is missing');
    occurrenceCount += document.occurrences.length;
    return {
      path: document.relativePath, positionEncoding: document.positionEncoding,
      occurrences: document.occurrences.map(occurrence => ({
        symbol: occurrence.symbol, roles: occurrence.symbolRoles, range: sourceRange(occurrence),
        documentOccurrence: occurrence.range.length === 3 && occurrence.range.every(value => value === 0),
      })),
    };
  });
  return { producer: { name: producer.name, version: producer.version }, documents,
    externalSymbols: index.externalSymbols.map(symbol => symbol.symbol), occurrenceCount };
}
