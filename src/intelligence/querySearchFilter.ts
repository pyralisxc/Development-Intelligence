import { normalizeName } from './model.js';
import type { CanonicalEdgeSearchRecord, CanonicalNodeSearchRecord } from './queryArtifacts.js';

// A disposable segment filter. It may over-select, but it never establishes
// a match: records and source evidence remain the owner of the answer.
const FILTER_BYTES = 8 * 1024;
const GRAM = 4;

function gram(value: string, offset: number, mask: number): number {
  let hash = 2166136261;
  for (let i = 0; i < GRAM; i++) hash = Math.imul(hash ^ value.charCodeAt(offset + i), 16777619);
  return hash & mask;
}

function visit(value: string, mask: number, fn: (bit: number) => boolean): boolean {
  for (let i = 0; i + GRAM <= value.length; i++) if (!fn(gram(value, i, mask))) return false;
  return true;
}

function texts(record: CanonicalNodeSearchRecord | CanonicalEdgeSearchRecord, field: 'nodeSearch' | 'edgeSearch'): string[] {
  if (field === 'nodeSearch') {
    const [, id, kind, layer, tail] = record as CanonicalNodeSearchRecord;
    const normal = [id, kind, layer, tail].filter(Boolean).join(' ');
    return layer === 'structural' ? [normal, [id, kind, tail].filter(Boolean).join(' ')] : [normal];
  }
  const [, id, kind, strategy, status, layer, tail] = record as CanonicalEdgeSearchRecord;
  const normal = [id, kind, layer, strategy, status, tail].filter(Boolean).join(' ');
  return layer === 'structural' ? [normal, [id, kind, strategy, status, tail].filter(Boolean).join(' ')] : [normal];
}

export class QuerySourceSearchFilters {
  private readonly filters = new Map<string, { bucket: string; bits: Buffer }>();

  add(record: CanonicalNodeSearchRecord | CanonicalEdgeSearchRecord, field: 'nodeSearch' | 'edgeSearch', sources: Iterable<{ key: string; bucket: string }>): void {
    const targets = [...new Map([...sources].map(source => [source.key, source])).values()].map(source => {
      let filter = this.filters.get(source.key);
      if (!filter) { filter = { bucket: source.bucket, bits: Buffer.alloc(FILTER_BYTES) }; this.filters.set(source.key, filter); }
      if (filter.bucket !== source.bucket) throw new Error('Query source bucket identity changed');
      return filter.bits;
    });
    const add = (bit: number): boolean => {
      for (const bits of targets) bits[bit >>> 3] |= 1 << (bit & 7);
      return true;
    };
    for (const text of texts(record, field)) {
      visit(text.toLowerCase(), FILTER_BYTES * 8 - 1, add);
      visit(normalizeName(text), FILTER_BYTES * 8 - 1, add);
    }
  }

  encode(): Array<[string, string]> {
    return [...this.filters.values()].map(({ bucket, bits }) => [bucket, bits.toString('base64')]);
  }
}

/** False only when neither exact nor normalized matching can occur. */
export function querySearchFilterMayMatch(encoded: string, queries: string[]): boolean {
  const bits = Buffer.from(encoded, 'base64');
  if (bits.length !== FILTER_BYTES) return true;
  const mask = bits.length * 8 - 1;
  const exists = (bit: number): boolean => Boolean(bits[bit >>> 3]! & (1 << (bit & 7)));
  return queries.some(query => {
    const raw = query.trim().toLowerCase();
    const normalized = normalizeName(query.trim());
    if (!raw || raw.length < GRAM || (normalized && normalized.length < GRAM)
      || (!normalized && /\s/u.test(raw))) return true;
    return visit(raw, mask, exists) || Boolean(normalized && visit(normalized, mask, exists));
  });
}
