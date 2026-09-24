import type { IntelligenceGraph } from '../types.js';

export interface RetentionItem {
  id: string;
  records: number;
  touchedAt: number;
  protected?: boolean;
}

export interface RetentionLimits {
  maxEntries: number;
  maxRecords: number;
}

export function positiveIntegerSetting(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function cacheEntryLimitSetting(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  // Preserve the original cache-bound contract: zero and negative values mean
  // the smallest supported warm cache, not an unbounded or disabled cache.
  return Math.max(1, parsed);
}

export function graphRecordWeight(graph: IntelligenceGraph | null): number {
  if (!graph) return 0;
  return graph.sources.length
    + graph.evidence.length
    + graph.nodes.length
    + graph.edges.length
    + graph.namingDivergences.length
    + graph.explicitValueConflicts.length
    + graph.unmatchedNodeIds.length
    + graph.unavailableSourceIds.length
    + (graph.coverage?.files.length ?? 0);
}

export function retentionEvictions(items: RetentionItem[], limits: RetentionLimits): string[] {
  const maxEntries = positiveIntegerSetting(String(limits.maxEntries), limits.maxEntries, 'maxEntries');
  const maxRecords = positiveIntegerSetting(String(limits.maxRecords), limits.maxRecords, 'maxRecords');
  const retained = new Map(items.map(item => [item.id, item]));
  let records = items.reduce((total, item) => total + item.records, 0);
  const candidates = items
    .filter(item => !item.protected)
    .sort((left, right) => left.touchedAt - right.touchedAt || left.id.localeCompare(right.id));
  const evicted: string[] = [];
  while ((retained.size > maxEntries || records > maxRecords) && candidates.length) {
    const candidate = candidates.shift()!;
    if (!retained.delete(candidate.id)) continue;
    records -= candidate.records;
    evicted.push(candidate.id);
  }
  return evicted;
}

export interface AsyncGateStatus {
  active: number;
  queued: number;
  limit: number;
}

export class AsyncGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly resolveLimit: () => number) {}

  status(): AsyncGateStatus {
    return { active: this.active, queued: this.waiters.length, limit: this.resolveLimit() };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.resolveLimit()) {
      this.active += 1;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}
