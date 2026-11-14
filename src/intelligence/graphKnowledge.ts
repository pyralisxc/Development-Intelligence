import type { GraphEdge, GraphNode, IntelligenceGraph } from '../types.js';

/**
 * The canonical graph owns facts. This vocabulary makes the meaning of its
 * existing relationships shared across construction, proof and navigation.
 * Physical query artifacts, view projections and semantic proposals are never
 * competing authorities.
 */
export type KnowledgeFamily = 'composition' | 'reference' | 'invocation'
  | 'condition' | 'effect' | 'state' | 'realization' | 'surface'
  | 'provider' | 'identity' | 'runtime' | 'unclassified';
export type KnowledgeMechanism = 'composition-context' | 'dependency'
  | 'execution' | 'identity-resolution' | 'surface' | 'persistence'
  | 'provider' | 'authority' | 'other';
export type NodeTrait = 'container' | 'callable' | 'symbol' | 'source-site'
  | 'predicate' | 'effect' | 'resource' | 'boundary' | 'technical-concept';
export type RealizationFacet = 'human' | 'agent' | 'transport'
  | 'implementation' | 'persistence' | 'provider';

export interface RelationshipKindContract {
  kind: string;
  family: KnowledgeFamily;
  mechanism: KnowledgeMechanism;
  /** Excludes pure containment, lexical correlation and name similarity. */
  realizationEligible: boolean;
  /** Proof records the source modality, not that a runtime path executed. */
  proof: 'syntax' | 'bound-source' | 'source-conditional' | 'observation' | 'not-established';
  fromTraits: NodeTrait[];
  toTraits: NodeTrait[];
}

const NODE_TRAITS: Record<string, NodeTrait[]> = {
  file: ['container'], module: ['container'], package: ['container'],
  class: ['container', 'symbol'], struct: ['container', 'symbol'],
  interface: ['symbol'], type: ['symbol'], declaration: ['symbol'],
  function: ['callable', 'container', 'symbol'], method: ['callable', 'container', 'symbol'],
  'constructor': ['callable', 'symbol'] as NodeTrait[],
  'sql-function': ['callable', 'resource'], 'sql-procedure': ['callable', 'resource'],
  'import-binding': ['symbol'], 'call-reference': ['source-site'],
  'css-class-reference': ['source-site'], 'css-selector': ['resource'],
  'unity-object': ['container', 'resource'], 'unity-asset-guid': ['resource'],
  'component-prop-handler': ['source-site', 'boundary'],
  'component-prop-binding': ['source-site'],
  'constructor-reference': ['source-site'], 'http-call': ['source-site', 'boundary'],
  'rpc-call': ['source-site', 'boundary'], 'navigation-call': ['source-site'],
  'source-try-return': ['source-site', 'effect'], 'source-catch-return': ['source-site', 'effect'],
  'state-write': ['source-site', 'effect'], 'state-binding': ['resource'],
  'sql-table': ['resource'], 'sql-reference': ['resource'],
  'ui-element': ['source-site', 'boundary'], 'mcp-tool': ['boundary'],
  feature: ['technical-concept'], capability: ['technical-concept'],
  domain: ['technical-concept'], surface: ['technical-concept', 'boundary'],
  action: ['technical-concept'], workflow: ['technical-concept'],
  api: ['boundary'], route: ['boundary'], provider: ['boundary'],
  mcp: ['boundary'], tool: ['boundary'],
};
const FACET_KINDS: Record<RealizationFacet, readonly string[]> = {
  human: ['surface', 'ui-element', 'component-prop-handler', 'component-prop-binding'],
  agent: ['mcp', 'tool', 'mcp-tool'],
  transport: ['api', 'route', 'http-call', 'rpc-call', 'navigation-call'],
  implementation: ['feature', 'function', 'method', 'class', 'sql-function'],
  persistence: ['sql-table', 'sql-reference', 'state-binding', 'state-write'],
  provider: ['provider'],
};
export function nodeTraits(kind: string): readonly NodeTrait[] {
  // Node kinds originate in heterogeneous sources. Never resolve names such
  // as "toString" through inherited Object prototype properties.
  return Object.prototype.hasOwnProperty.call(NODE_TRAITS, kind)
    ? NODE_TRAITS[kind]! : [];
}
export function nodeKindsForFacet(facet: RealizationFacet): readonly string[] {
  return FACET_KINDS[facet];
}

const RELATIONS = new Map<string, RelationshipKindContract>();
function define(kinds: readonly string[], family: KnowledgeFamily,
  mechanism: KnowledgeMechanism, realizationEligible: boolean,
  proof: RelationshipKindContract['proof'],
  fromTraits: NodeTrait[] = [], toTraits: NodeTrait[] = []): void {
  for (const kind of kinds) RELATIONS.set(kind, {
    kind, family, mechanism, realizationEligible, proof, fromTraits, toTraits,
  });
}
define(['contains', 'declares',
  'reexports', 'member-of', 'part-of'], 'composition', 'composition-context', false, 'syntax');
// An established state declaration is a positive technical realization fact,
// even though it is not evidence that state was changed in a runtime session.
define(['declares-state'], 'state', 'persistence', true, 'syntax');
define(['imports', 'resolves_to'], 'reference', 'dependency', false, 'bound-source');
// Source-identified module/file navigation and Unity links are technical facts
// rather than runtime evidence. Preserve their prior positive reachability.
define(['imports-file', 'targets-module', 'uses', 'requires',
  'describes', 'uses-script', 'references', 'used-by-unity-asset'],
  'reference', 'dependency', true, 'bound-source');
define(['declares-module'], 'composition', 'composition-context', true, 'syntax');
define(['has-component', 'attached-to', 'child-of'],
  'composition', 'composition-context', true, 'syntax');
// Actual bound references/dependencies contributed to accepted technical
// realization before this registry; preserve their factual reach.
define(['references-symbol', 'depends-on', 'links_to'],
  'reference', 'dependency', true, 'bound-source');
define(['binds_to', 'bound_by'], 'surface', 'surface', true, 'bound-source');
define(['uses_classes'], 'surface', 'surface', true, 'syntax', ['callable'], ['source-site']);
define(['styled_by'], 'surface', 'surface', true, 'bound-source', ['source-site'], ['resource']);
define(['composes', 'uses-feature'], 'reference', 'dependency', true, 'bound-source', ['boundary'], ['technical-concept']);
define(['handles-method'], 'realization', 'execution', true, 'bound-source', ['boundary'], ['callable']);
define(['registered-as'], 'realization', 'surface', true, 'bound-source', ['boundary'], ['boundary']);
// A resolved technical connection can carry a capability to an API or other
// concrete realization. Preserve the already-proven traversal contract.
define(['connected-to'], 'reference', 'dependency', true, 'bound-source');
define(['calls'], 'invocation', 'execution', true, 'bound-source', ['callable'], ['callable']);
define(['invokes', 'handled_by', 'dispatches', 'triggers', 'routes-to',
  'automated-by', 'constructs'], 'invocation', 'execution', true, 'bound-source');
define(['try-returns'], 'effect', 'execution', false, 'source-conditional',
  ['callable'], ['source-site']);
define(['catch-returns'], 'effect', 'execution', false, 'source-conditional',
  ['callable'], ['source-site']);
define(['guarded-by', 'requires-condition', 'under-condition'],
  'condition', 'execution', false, 'source-conditional');
define(['returns', 'throws', 'causes', 'effects'],
  'effect', 'execution', false, 'source-conditional');
define(['reads', 'writes', 'persists', 'state-write', 'loads', 'stores'],
  'state', 'persistence', true, 'syntax');
define(['implemented-by', 'realized-by', 'exposes'],
  'realization', 'execution', true, 'bound-source');
define(['exposed-on', 'available-on-surface', 'renders', 'presented', 'links-to'],
  'surface', 'surface', true, 'bound-source');
define(['integrates-with', 'provider-dependency'],
  'provider', 'provider', true, 'bound-source');
define(['same_observed_name', 'same_observed_value', 'similar_identifier',
  'equivalent-to', 'identity-match'],
  'identity', 'identity-resolution', false, 'not-established');
define(['observed-in', 'runtime-calls', 'runtime-emits', 'executes'],
  'runtime', 'execution', true, 'observation');

export function relationshipKindContract(kind: string): RelationshipKindContract {
  return RELATIONS.get(kind) ?? {
    kind, family: 'unclassified', mechanism: 'other', realizationEligible: false,
    proof: 'not-established', fromTraits: [], toTraits: [],
  };
}
export function observedRelationshipContracts(graph: IntelligenceGraph): RelationshipKindContract[] {
  return [...new Set(graph.edges.map(edge => edge.kind))].sort()
    .map(relationshipKindContract);
}
export function inspectRelationshipShape(edge: GraphEdge,
  nodesById: ReadonlyMap<string, GraphNode>): {
    status: 'valid' | 'unknown-kind' | 'unresolved' | 'missing-endpoint' | 'incompatible-endpoint';
    reason: string | null;
  } {
  const contract = relationshipKindContract(edge.kind);
  if (edge.status !== 'resolved' || !edge.from || !edge.to) {
    return { status: 'unresolved', reason: 'Only exact resolved relationships are eligible for positive shape validation' };
  }
  if (contract.family === 'unclassified') return { status: 'unknown-kind', reason: 'Relationship kind has no declared semantic contract' };
  const from = nodesById.get(edge.from), to = nodesById.get(edge.to);
  if (!from || !to) return { status: 'missing-endpoint', reason: 'Resolved endpoint is not in this graph' };
  if (contract.fromTraits.length && !contract.fromTraits.some(trait => nodeTraits(from.kind).includes(trait))) {
    return { status: 'incompatible-endpoint', reason: 'Source node does not satisfy the relationship domain' };
  }
  if (contract.toTraits.length && !contract.toTraits.some(trait => nodeTraits(to.kind).includes(trait))) {
    return { status: 'incompatible-endpoint', reason: 'Target node does not satisfy the relationship range' };
  }
  return { status: 'valid', reason: null };
}

type CapabilityFamily = 'declarations' | 'bindings' | 'calls' | 'conditions-effects' | 'persistence';
type Emission = 'supported-partial' | 'not-emitted';
const CAPABILITIES: Record<string, Record<CapabilityFamily, Emission>> = {
  typescript: {
    declarations: 'supported-partial', bindings: 'supported-partial',
    calls: 'supported-partial', 'conditions-effects': 'supported-partial',
    persistence: 'supported-partial',
  },
  go: {
    declarations: 'supported-partial', bindings: 'supported-partial',
    calls: 'not-emitted', 'conditions-effects': 'not-emitted', persistence: 'not-emitted',
  },
  java: {
    declarations: 'supported-partial', bindings: 'supported-partial',
    calls: 'not-emitted', 'conditions-effects': 'not-emitted', persistence: 'not-emitted',
  },
  csharp: {
    declarations: 'supported-partial', bindings: 'supported-partial',
    calls: 'supported-partial', 'conditions-effects': 'not-emitted', persistence: 'not-emitted',
  },
  python: {
    declarations: 'supported-partial', bindings: 'supported-partial',
    calls: 'not-emitted', 'conditions-effects': 'not-emitted', persistence: 'not-emitted',
  },
  rust: {
    declarations: 'supported-partial', bindings: 'supported-partial',
    calls: 'not-emitted', 'conditions-effects': 'not-emitted', persistence: 'not-emitted',
  },
  sql: {
    declarations: 'supported-partial', bindings: 'supported-partial',
    calls: 'not-emitted', 'conditions-effects': 'not-emitted', persistence: 'supported-partial',
  },
};
const FAMILIES: CapabilityFamily[] = ['declarations', 'bindings', 'calls', 'conditions-effects', 'persistence'];
function sourceLanguage(sourcePath: string): string | null {
  if (/\.(?:[cm]?[jt]sx?)$/iu.test(sourcePath)) return 'typescript';
  if (/\.go$/iu.test(sourcePath)) return 'go';
  if (/\.java$/iu.test(sourcePath)) return 'java';
  if (/\.cs$/iu.test(sourcePath)) return 'csharp';
  if (/\.py$/iu.test(sourcePath)) return 'python';
  if (/\.rs$/iu.test(sourcePath)) return 'rust';
  if (/\.sql$/iu.test(sourcePath)) return 'sql';
  return null;
}
/**
 * Capability emission is NOT whole-language completeness. A completed file
 * scan has no authority to assert that an unsupported relation never occurs.
 */
export function sourceCapabilityCoverage(graph: IntelligenceGraph) {
  const counts = new Map<string, { complete: number; partial: number; failedOrSkipped: number }>();
  for (const file of graph.coverage?.files ?? []) {
    const language = sourceLanguage(file.path);
    if (!language) continue;
    const c = counts.get(language) ?? { complete: 0, partial: 0, failedOrSkipped: 0 };
    if (file.status === 'complete') c.complete++;
    else if (file.status === 'partial') c.partial++;
    else c.failedOrSkipped++;
    counts.set(language, c);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).flatMap(([language, c]) =>
    FAMILIES.map(family => ({
      language, family,
      emitter: CAPABILITIES[language]?.[family] ?? 'not-emitted',
      completeFiles: c.complete,
      partialFiles: c.partial,
      unavailableFiles: c.failedOrSkipped,
      exhaustiveForNegativeClaims: false as const,
      source: 'intrinsic-frontend-contract' as const,
      note: CAPABILITIES[language]?.[family] === 'not-emitted'
        ? 'This frontend does not emit the relationship family; missing edges are not negative proof'
        : 'Positive facts can be source-backed, but language-wide exhaustiveness is not established',
    })));
}
