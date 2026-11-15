import { createHash } from 'node:crypto';
import type { IntelligenceGraph, GraphNode } from '../types.js';

/**
 * Source-only correlation of a resolved TypeScript RPC invocation to all
 * tracked SQL routine declarations sharing its exact reported routine name.
 * It NEVER selects an active database definition or proves a SQL effect ran.
 */
export const RPC_SQL_SOURCE_LENS = 'rpc-sql-source-candidates.v1';

function nodeValue(node: GraphNode, key: string): string | null {
  if (!node.value || typeof node.value !== 'object') return null;
  const x = (node.value as Record<string, unknown>)[key];
  return typeof x === 'string' && x.trim() ? x : null;
}
function sourcePath(node: GraphNode): string | null {
  return node.sourceId.startsWith('repo:') ? node.sourceId.slice(5) : null;
}
export interface RpcSqlSourceCandidate {
  id: string;
  qualifiedName: string;
  signature: string;
  sourcePath: string;
  /** Source-syntax edges only; not a proof that a transaction committed. */
  declaredReferences: Array<{ kind: 'reads' | 'writes'; name: string; targetNodeId: string }>;
}
export interface RpcSqlSourceProjection {
  status: 'supported' | 'unproven';
  reason: string;
  mode: 'rpc-sql-source-candidates';
  project: string;
  revision: string | null;
  graphId: string;
  callerId: string;
  rpcNodeId: string | null;
  routineName: string;
  candidates: RpcSqlSourceCandidate[];
  counts: { total: number; returned: number; omitted: number; nextOffset: number | null;
    completeForTrackedSource: boolean };
  populationDigest: string | null;
  proof: {
    exactSourceRpcCallEstablished: boolean;
    sourceSqlDeclarationsOnly: true;
    appliedDatabaseFunctionEstablished: false;
    databaseRoleOrRlsEstablished: false;
    SQLConditionAndEffectEstablished: false;
    runtimeExecutionObserved: false;
    committedWriteObserved: false;
    canonicalGraphUnchanged: true;
  };
}
const MAX_POPULATION = 10000;

export function projectRpcSqlSourceCandidates(input: {
  graph: IntelligenceGraph;
  callerId: string;
  routineName: string;
  pageSize?: number;
  offset?: number;
  expectedDigest?: string;
}): RpcSqlSourceProjection {
  const { graph } = input;
  const pageSize = input.pageSize ?? 24;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_POPULATION) {
    throw new Error('RPC source candidate page size or offset is invalid');
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/u.test(input.routineName)) {
    throw new Error('RPC routine name requires one exact source identifier');
  }
  const base = {
    mode: 'rpc-sql-source-candidates' as const,
    version: RPC_SQL_SOURCE_LENS,
    project: graph.project, revision: graph.repositoryRevision, graphId: graph.graphId,
    callerId: input.callerId, routineName: input.routineName,
    proof: {
      exactSourceRpcCallEstablished: false,
      sourceSqlDeclarationsOnly: true as const,
      appliedDatabaseFunctionEstablished: false as const,
      databaseRoleOrRlsEstablished: false as const,
      SQLConditionAndEffectEstablished: false as const,
      runtimeExecutionObserved: false as const,
      committedWriteObserved: false as const,
      canonicalGraphUnchanged: true as const,
    },
  };
  const unknown = (reason: string): RpcSqlSourceProjection => ({
    ...base, status: 'unproven', reason, rpcNodeId: null,
    candidates: [], counts: { total: 0, returned: 0, omitted: 0,
      nextOffset: null, completeForTrackedSource: false },
    populationDigest: null,
  });
  if (!graph.repositoryRevision || !graph.graphId) return unknown('source-graph-identity-unavailable');
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const caller = nodes.get(input.callerId);
  if (!caller || caller.layer !== 'structural'
    || (caller.kind !== 'function' && caller.kind !== 'method')) {
    return unknown('exact-source-caller-unavailable');
  }
  const covered = new Set((graph.coverage?.files ?? [])
    .filter(file => file.status === 'complete').map(file => file.path));
  if (!sourcePath(caller) || !covered.has(sourcePath(caller)!)) return unknown('caller-source-coverage-incomplete');
  const rpcTargets = new Set(graph.nodes.filter(node => node.kind === 'rpc-call'
    && node.name === input.routineName
    && sourcePath(node) && covered.has(sourcePath(node)!)).map(node => node.id));
  const calls = graph.edges.filter(edge => edge.from === caller.id && edge.kind === 'invokes'
    && edge.status === 'resolved' && edge.to !== null && rpcTargets.has(edge.to));
  const distinctTargets = [...new Set(calls.map(edge => edge.to!))];
  if (distinctTargets.length !== 1 || calls.length !== 1) {
    return unknown(distinctTargets.length > 1
      ? 'ambiguous-resolved-source-rpc-invocation'
      : 'exact-source-rpc-invocation-unavailable');
  }
  const rpcId = distinctTargets[0]!;
  const sourceSql = graph.nodes.filter(node => node.kind === 'sql-function'
    && nodeValue(node, 'shortName') === input.routineName);
  if (sourceSql.length > MAX_POPULATION) return unknown('source-routine-candidate-population-exceeds-budget');
  if (!sourceSql.length) return unknown('no-tracked-sql-definition-proven');
  // Source declaration completeness requires a full tracked SQL census, not
  // merely complete files for the declarations we happened to discover.
  // Otherwise an omitted migration could make the observed set falsely unique.
  if (!graph.coverage?.files?.length
    || graph.coverage.files.some(file => /\.sql$/iu.test(file.path)
      && file.status !== 'complete')) {
    return unknown('tracked-sql-population-coverage-incomplete');
  }
  if (sourceSql.some(node => !sourcePath(node) || !covered.has(sourcePath(node)!))) {
    return unknown('sql-source-coverage-incomplete');
  }
  if (sourceSql.some(node => !nodeValue(node, 'qualifiedName')
    || !nodeValue(node, 'signature'))) return unknown('sql-definition-identity-incomplete');
  const candidates = sourceSql.map(node => {
    const refs = graph.edges.filter(edge => edge.from === node.id
      && edge.status === 'resolved'
      && edge.to !== null
      && (edge.kind === 'reads' || edge.kind === 'writes'))
      .map(edge => ({ kind: edge.kind as 'reads' | 'writes',
        name: nodes.get(edge.to!)?.name ?? '[unresolved reference]',
        targetNodeId: edge.to! }))
      .sort((a, b) => a.kind.localeCompare(b.kind)
        || a.name.localeCompare(b.name) || a.targetNodeId.localeCompare(b.targetNodeId));
    return {
      id: node.id,
      qualifiedName: nodeValue(node, 'qualifiedName')!,
      signature: nodeValue(node, 'signature')!,
      sourcePath: sourcePath(node)!,
      declaredReferences: refs,
    };
  }).sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)
    || a.signature.localeCompare(b.signature)
    || a.sourcePath.localeCompare(b.sourcePath)
    || a.id.localeCompare(b.id));
  const populationDigest = createHash('sha256').update(JSON.stringify([
    graph.project, graph.repositoryRevision, graph.graphId,
    caller.id, rpcId, candidates.map(node => [
      node.id, node.qualifiedName, node.signature, node.sourcePath,
      node.declaredReferences.map(ref => [ref.kind, ref.targetNodeId]),
    ]),
  ])).digest('hex');
  if (input.expectedDigest && input.expectedDigest !== populationDigest) {
    throw new Error('RPC source candidate population changed between pages');
  }
  const page = candidates.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length < candidates.length
    ? offset + page.length : null;
  return {
    ...base, status: 'supported',
    reason: 'resolved-rpc-and-tracked-sql-source-definitions',
    rpcNodeId: rpcId, candidates: page,
    counts: { total: candidates.length, returned: page.length,
      omitted: candidates.length - page.length, nextOffset,
      completeForTrackedSource: true },
    populationDigest,
    proof: { ...base.proof, exactSourceRpcCallEstablished: true },
  };
}
