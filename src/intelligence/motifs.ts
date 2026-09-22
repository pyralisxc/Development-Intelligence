import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';
import { graphQueryContext } from './queryContext.js';

export type DerivedMotifKind = 'composition-root' | 'state-machine' | 'adapter' | 'pipeline' | 'persistence-owner';
export type MotifConfidence = 'medium' | 'high';

export interface MotifSignal {
  family: 'identity' | 'member' | 'relationship' | 'dependency' | 'persistence';
  summary: string;
  nodeIds: string[];
  edgeIds: string[];
}

export interface DerivedMotif {
  kind: DerivedMotifKind;
  status: 'derived';
  confidence: MotifConfidence;
  statement: string;
  subjectId: string;
  signals: MotifSignal[];
  limitations: string[];
  disambiguatingEvidence: string[];
  proofEligible: false;
  persisted: false;
}

function searchable(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function locatorPath(locator: string): string {
  return locator.replace(/:\d+(?::.*)?$/u, '').split('#', 1)[0] ?? locator;
}

function nodeText(node: GraphNode | undefined): string {
  if (!node) return '';
  return searchable([node.name ?? '', node.id, locatorPath(node.locator), node.raw].filter(Boolean).join(' '));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function resolved(edges: readonly GraphEdge[]): GraphEdge[] {
  return edges.filter(edge => edge.status === 'resolved');
}

function containingFile(graph: IntelligenceGraph, selected: GraphNode): GraphNode | undefined {
  if (selected.kind === 'file') return selected;
  const context = graphQueryContext(graph);
  for (const edge of resolved(context.incoming(selected.id))) {
    if (edge.kind !== 'contains' || !edge.from) continue;
    const source = context.node(edge.from);
    if (source?.kind === 'file') return source;
  }
  return undefined;
}

function members(graph: IntelligenceGraph, selected: GraphNode): GraphNode[] {
  const context = graphQueryContext(graph);
  return resolved(context.outgoing(selected.id))
    .filter(edge => edge.kind === 'contains' && edge.to)
    .map(edge => context.node(edge.to!))
    .filter((node): node is GraphNode => Boolean(node));
}

function fileDependencies(graph: IntelligenceGraph, file: GraphNode | undefined): GraphEdge[] {
  if (!file) return [];
  const context = graphQueryContext(graph);
  return resolved(context.outgoing(file.id))
    .filter(edge => ['imports', 'imports-file', 'targets-module', 'resolves_to'].includes(edge.kind));
}

function directExecutionEdges(graph: IntelligenceGraph, selected: GraphNode): GraphEdge[] {
  const context = graphQueryContext(graph);
  return resolved(context.outgoing(selected.id))
    .filter(edge => ['calls', 'invokes', 'dispatches', 'writes', 'reads', 'state-write'].includes(edge.kind));
}

function targetText(graph: IntelligenceGraph, edge: GraphEdge): string {
  const context = graphQueryContext(graph);
  return nodeText(edge.to ? context.node(edge.to) : undefined);
}

function signal(
  family: MotifSignal['family'],
  summary: string,
  nodes: readonly GraphNode[] = [],
  edges: readonly GraphEdge[] = [],
): MotifSignal {
  return {
    family,
    summary,
    nodeIds: unique(nodes.map(node => node.id)),
    edgeIds: unique(edges.map(edge => edge.id)),
  };
}

function motif(
  selected: GraphNode,
  kind: DerivedMotifKind,
  label: string,
  signals: MotifSignal[],
  limitations: string[],
  disambiguatingEvidence: string[],
): DerivedMotif {
  const familyCount = new Set(signals.map(item => item.family)).size;
  return {
    kind,
    status: 'derived',
    confidence: familyCount >= 3 ? 'high' : 'medium',
    statement: `${selected.name ?? selected.id} matches a derived ${label} motif from ${familyCount} independent structural evidence families.`,
    subjectId: selected.id,
    signals,
    limitations,
    disambiguatingEvidence,
    proofEligible: false,
    persisted: false,
  };
}

export function deriveMotifs(graph: IntelligenceGraph, selected: GraphNode): DerivedMotif[] {
  if ((selected.layer ?? 'structural') === 'semantic') return [];
  const file = containingFile(graph, selected);
  const localMembers = members(graph, selected);
  const fileMembers = file && file.id !== selected.id ? members(graph, file) : localMembers;
  const memberPool = selected.kind === 'file' ? localMembers : localMembers;
  const dependencyEdges = fileDependencies(graph, file);
  const executionEdges = directExecutionEdges(graph, selected);
  const identity = searchable([selected.name ?? '', locatorPath(selected.locator)].join(' '));
  const output: DerivedMotif[] = [];

  const compositionIdentity = /(bootstrap|composition root|lifetime scope|service registration|service installer|startup)/u.test(identity);
  const compositionMembers = memberPool.filter(node => /(awake|start|configure|register|install|initialize|setup|build|resolve|wire)/u.test(nodeText(node)));
  const distinctDependencies = unique(dependencyEdges.map(edge => edge.to ?? '')).length;
  if (compositionIdentity && compositionMembers.length) {
    const signals = [
      signal('identity', 'The selected identity/path explicitly names bootstrap, startup, lifetime-scope, composition-root, or service-registration intent.', [selected]),
      signal('member', 'The selected entity contains lifecycle or configuration members consistent with composition work.', compositionMembers),
    ];
    if (distinctDependencies >= 3) signals.push(signal('dependency', `The containing file has ${distinctDependencies} resolved dependency targets, consistent with composition fan-out.`, file ? [file] : [], dependencyEdges));
    output.push(motif(
      selected,
      'composition-root',
      'composition-root/bootstrap',
      signals,
      ['This does not prove process startup order, singleton ownership, or that every dependency is configured by this entity.'],
      ['Runtime startup observation or deterministic cross-file call binding would establish execution order beyond the structural composition motif.'],
    ));
  }

  const stateIdentity = /(state machine)/u.test(identity);
  const stateMembers = memberPool.filter(node => /(^| )(current )?state( |$)/u.test(nodeText(node)));
  const transitionMembers = memberPool.filter(node => /(transition|enter state|exit state|advance state|reset)/u.test(nodeText(node)));
  if (stateIdentity && stateMembers.length && transitionMembers.length) {
    output.push(motif(
      selected,
      'state-machine',
      'state-machine',
      [
        signal('identity', 'The selected identity/path explicitly names a state machine.', [selected]),
        signal('member', 'The selected entity exposes state-bearing members.', stateMembers),
        signal('relationship', 'The selected entity exposes explicit transition/reset behavior.', transitionMembers),
      ],
      ['This does not prove that every runtime transition is represented or that transition guards are complete.'],
      ['Bounded runtime transition observations or stronger call/control-flow evidence would validate exercised transition paths.'],
    ));
  }

  const adapterIdentity = /(adapter|bridge|relay|translator|mapper)/u.test(identity);
  const adapterMembers = memberPool.filter(node => /(handle|forward|relay|map|convert|translate|adapt|dispatch|bridge|route)/u.test(nodeText(node)));
  if (adapterIdentity && adapterMembers.length) {
    const signals = [
      signal('identity', 'The selected identity/path explicitly names adapter, bridge, relay, translator, or mapper intent.', [selected]),
      signal('member', 'The selected entity contains handling/translation/forwarding behavior consistent with adaptation.', adapterMembers),
    ];
    if (distinctDependencies >= 2) signals.push(signal('dependency', `The containing file crosses ${distinctDependencies} resolved dependency targets.`, file ? [file] : [], dependencyEdges));
    output.push(motif(
      selected,
      'adapter',
      'adapter/bridge',
      signals,
      ['This does not prove semantic equivalence between source and target contracts or that the adapter contains no domain logic.'],
      ['Observed input/output contract bindings or runtime message traces would disambiguate the exact adaptation boundary.'],
    ));
  }

  const pipelineIdentity = /(pipeline|workflow|processing chain)/u.test(identity);
  const stageMembers = memberPool.filter(node => /(stage|step|process|review|approve|submit|publish|execute|run|next|validate|classif)/u.test(nodeText(node)));
  const callFanout = unique(executionEdges.filter(edge => edge.kind === 'calls' || edge.kind === 'invokes' || edge.kind === 'dispatches').map(edge => edge.to ?? '')).length;
  if (pipelineIdentity && (callFanout >= 2 || stageMembers.length >= 2)) {
    const signals = [
      signal('identity', 'The selected identity/path explicitly names pipeline, workflow, or processing-chain intent.', [selected]),
    ];
    if (callFanout >= 2) signals.push(signal('relationship', `The selected entity has resolved execution fan-out to ${callFanout} distinct targets.`, [selected], executionEdges));
    if (stageMembers.length >= 2) signals.push(signal('member', 'The selected entity contains multiple stage/process/review-style members.', stageMembers));
    output.push(motif(
      selected,
      'pipeline',
      'pipeline/orchestration',
      signals,
      ['This does not prove strict stage ordering, transaction boundaries, retries, or that every called target is a pipeline stage.'],
      ['Control-flow ordering or bounded runtime traces would distinguish a strict staged pipeline from looser orchestration.'],
    ));
  }

  const persistenceIdentity = /(repository|store|persistence|storage|database| dao )/u.test(` ${identity} `);
  const persistenceMembers = (selected.kind === 'file' ? fileMembers : [selected, ...memberPool])
    .filter(node => /(save|load|read|write|fetch|get|list|count|insert|update|delete|upsert|persist|store)/u.test(nodeText(node)));
  const persistenceEdges = [
    ...dependencyEdges.filter(edge => /(database|supabase|sql|postgres|mongo|redis|storage)/u.test(targetText(graph, edge))),
    ...executionEdges.filter(edge => ['writes', 'reads', 'state-write'].includes(edge.kind) || /(database|supabase|sql|postgres|mongo|redis|storage)/u.test(targetText(graph, edge))),
  ];
  if (persistenceIdentity && persistenceMembers.length && persistenceEdges.length) {
    output.push(motif(
      selected,
      'persistence-owner',
      'persistence-owner',
      [
        signal('identity', 'The selected identity/path explicitly names repository, store, persistence, storage, database, or DAO intent.', [selected]),
        signal('member', 'The selected source exposes read/write/update/upsert-style persistence operations.', persistenceMembers),
        signal('persistence', 'Resolved dependencies or execution relationships reach database/storage infrastructure.', file ? [file] : [selected], persistenceEdges),
      ],
      ['This does not prove authoritative schema ownership, transaction semantics, durability guarantees, or exclusive write ownership.'],
      ['Database schema references, transaction evidence, or runtime write observations would establish the exact persistence authority boundary.'],
    ));
  }

  return output.sort((a, b) => a.kind.localeCompare(b.kind));
}
