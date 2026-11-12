import type { IntelligenceGraph } from '../types.js';
import { projectRpcSqlSourceCandidates } from './rpcSqlSourceCandidates.js';

/**
 * Ordinary source-only question about RPC calls from an exact callable.
 * This is not a PostgreSQL live-catalog or execution observer.
 */
export const RPC_DISCOVERY_QUESTION = 'ordinary-source-rpc-discovery.v1';

export function parseRpcDiscoveryQuestion(question: string):
  { caller: string; environment: string | null } | null {
  const identifier = '([A-Za-z_$][A-Za-z0-9_$]*)';
  const pattern = new RegExp(
    '^\\s*which\\s+(?:database|sql)\\s+(?:functions?|routines?)\\s+'
      + '(?:(?:might|could|can|does)\\s+)?' + identifier
      + '\\s+(?:call|invoke|reach)'
      + '(?:\\s*,?\\s+and\\s+which\\s+(?:one\\s+)?is\\s+'
      + '(?:applied|active|deployed)\\s+in\\s+([A-Za-z][A-Za-z0-9_-]{0,63}))?'
      + '\\s*\\?\\s*$',
    'iu',
  );
  const match = pattern.exec(question);
  return match?.[1] ? {
    caller: match[1],
    environment: match[2] ?? null,
  } : null;
}

interface RoutineResult {
  name: string;
  candidates: Array<{
    qualifiedName: string; signature: string; sourcePath: string;
    declaredReferences: Array<{ kind: 'reads' | 'writes'; name: string }>;
  }>;
  total: number;
  omitted: number;
  populationDigest: string | null;
  nextOffset: number | null;
}

export function projectRpcDiscoveryQuestion(input: {
  graph: IntelligenceGraph; project: string; question: string; scope?: string;
}): Record<string, unknown> | null {
  const parsed = parseRpcDiscoveryQuestion(input.question);
  if (!parsed) return null;
  const started = performance.now();
  const graph = input.graph;
  const base = {
    mode: 'ordinary-source-rpc-discovery', version: RPC_DISCOVERY_QUESTION,
    project: input.project, revision: graph.repositoryRevision,
    graphId: graph.graphId, caller: parsed.caller,
    requestedEnvironment: parsed.environment,
    requestedQuestion: input.question,
    sourceOnly: true, runtimeObserved: false,
  };
  const proof = {
    sourceRpcInvocationEstablished: false,
    sourceSqlDeclarationsOnly: true,
    appliedDatabaseFunctionEstablished: false,
    activeDatabaseSnapshotAvailable: false,
    databaseRoleOrRlsEstablished: false,
    committedWriteObserved: false,
    testedRuntimeEstablished: false,
    canonicalGraphUnchanged: true,
  };
  const unproven = (reason: string) => ({
    ...base, status: 'unproven', reason,
    routines: [], totalRpcCalls: 0, proof,
    timing: { graphConstructionIncluded: false,
      existingGraphProjectionMs: Number((performance.now() - started).toFixed(2)) },
  });
  if (graph.project !== input.project || !graph.graphId
    || !/^[a-f0-9]{40}$/iu.test(graph.repositoryRevision ?? '')) {
    return unproven('exact-canonical-graph-identity-unavailable');
  }
  const scope = input.scope?.trim().replace(/^(?:repo:|file:)/u, '')
    .replace(/^\.\//u, '') ?? '';
  const callers = graph.nodes.filter(node => (node.kind === 'function' || node.kind === 'method')
    && node.layer === 'structural' && node.name === parsed.caller
    && node.sourceId.startsWith('repo:')
    && (!scope || node.sourceId.slice(5) === scope
      || node.sourceId.slice(5).startsWith(scope + '/')));
  if (callers.length !== 1) return unproven(callers.length
    ? 'ambiguous-exact-caller' : 'exact-caller-unavailable');
  const caller = callers[0]!;
  const coverage = graph.coverage?.files ?? [];
  if (coverage.find(file => file.path === caller.sourceId.slice(5))?.status !== 'complete') {
    return unproven('caller-source-coverage-incomplete');
  }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const rpcEdges = graph.edges.filter(edge => edge.from === caller.id
    && edge.kind === 'invokes' && edge.to !== null
    && nodes.get(edge.to)?.kind === 'rpc-call');
  if (rpcEdges.some(edge => edge.status !== 'resolved')) {
    return unproven('candidate-or-unresolved-rpc-transfer');
  }
  const ids = [...new Set(rpcEdges.map(edge => edge.to!))];
  if (ids.length === 0) return unproven('no-exact-source-rpc-transfer-established');
  if (ids.length > 12 || ids.length !== rpcEdges.length) {
    return unproven('bounded-rpc-call-identity-not-unique');
  }
  const routines: RoutineResult[] = [];
  const uniqueNames = new Set<string>();
  for (const id of ids) {
    const node = nodes.get(id);
    const name = node?.name;
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)
      || uniqueNames.has(name)) {
      return unproven('ambiguous-or-invalid-source-rpc-name');
    }
    uniqueNames.add(name);
    const found = projectRpcSqlSourceCandidates({
      graph, callerId: caller.id, routineName: name, pageSize: 100,
    });
    if (found.status !== 'supported') {
      return unproven('rpc-source-candidates-' + found.reason);
    }
    routines.push({
      name, candidates: found.candidates, total: found.counts.total,
      omitted: found.counts.omitted, nextOffset: found.counts.nextOffset,
      populationDigest: found.populationDigest,
    });
  }
  routines.sort((a,b) => a.name.localeCompare(b.name));
  const omitted = routines.reduce((sum,r)=>sum+r.omitted, 0);
  return {
    ...base, status: 'supported', reason: 'exact-caller-resolved-rpc-source-candidates',
    callerId: caller.id, totalRpcCalls: routines.length, routines,
    counts: { routines: routines.length,
      sourceSqlCandidates: routines.reduce((sum,r)=>sum+r.total, 0),
      candidateRowsReturned: routines.reduce((sum,r)=>sum+r.candidates.length, 0),
      omitted, completeForTrackedSource: omitted === 0 },
    proof: { ...proof, sourceRpcInvocationEstablished: true },
    timing: { graphConstructionIncluded: false,
      existingGraphProjectionMs: Number((performance.now()-started).toFixed(2)) },
  };
}

export function rpcDiscoveryAnswer(result: Record<string, unknown>): string {
  if (result.status !== 'supported') return 'No complete, uniquely resolved source RPC '
    + 'relationship could answer that question (' + String(result.reason ?? 'unknown') + '). '
    + 'This does not establish the absence of a routine or its deployed behavior.';
  const rs = result.routines as RoutineResult[];
  const labels = rs.slice(0, 8).map(r => {
    const src = r.candidates.slice(0, 4).map(c =>
      c.qualifiedName + ' (' + c.signature + ') in ' + c.sourcePath);
    return r.name + ': ' + r.total + ' tracked historical SQL definition candidate(s)'
      + (src.length ? ' — ' + src.join('; ') : '')
      + (r.omitted ? '; ' + r.omitted + ' additional source candidate(s) omitted from this page' : '');
  });
  const env = result.requestedEnvironment;
  const applied = typeof env === 'string' ? 'Which routine is applied in ' + env
    + ' remains unknown without authenticated environment-bound catalog evidence. '
    : 'The applied routine remains unknown without authenticated environment-bound catalog evidence. ';
  return 'The exact source caller ' + String(result.caller)
    + ' has ' + rs.length + ' uniquely resolved RPC invocation(s): '
    + labels.join('. ') + '. ' + applied
    + 'These are source declarations only: no database body, grant/RLS outcome, '
    + 'successful transaction, mocked test, or real runtime execution is proven.';
}
