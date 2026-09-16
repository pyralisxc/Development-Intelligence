import { listPublicProjects } from './source/git.js';
import { projectStatus } from './projectStatus.js';
import { scanGraph, graphStatus, clearGraphCache } from './intelligence/service.js';
import { diffAcceptedToWorking, diffRevisions, graphArchitecture, graphCoverage, graphEvidence, graphSchema, parityLens, searchGraph, traceGraph } from './intelligence/query.js';
import { getCodeSnippet, searchCode } from './intelligence/code.js';
import type { GraphNodeLayer } from './types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const integer = { type: 'integer' };
const strings = { type: 'array', items: string };
const layersSchema = { type: 'array', items: { enum: ['semantic', 'structural', 'representation'] } };
const projectOnly = objectSchema({ project: string }, ['project']);

function s(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}
function optString(args: Record<string, unknown>, key: string): string | undefined { const value = args[key]; return typeof value === 'string' && value ? value : undefined; }
function layers(args: Record<string, unknown>): GraphNodeLayer[] | undefined {
  return Array.isArray(args.layers) ? args.layers.filter((value): value is GraphNodeLayer => value === 'semantic' || value === 'structural' || value === 'representation') : undefined;
}

function validateAgainstSchema(schema: any, value: unknown, path = 'arguments'): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => Object.is(item, value))) throw new Error(`${path} must be one of: ${schema.enum.join(', ')}`);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!(required in record)) throw new Error(`${path}.${required} is required`);
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!(key in properties)) throw new Error(`${path}.${key} is not allowed`);
    for (const [key, child] of Object.entries(properties)) if (key in record) validateAgainstSchema(child, record[key], `${path}.${key}`);
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`${path} exceeds maxItems ${schema.maxItems}`);
    value.forEach((item, index) => validateAgainstSchema(schema.items, item, `${path}[${index}]`));
    return;
  }
  if (schema.type === 'string' && typeof value !== 'string') throw new Error(`${path} must be a string`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  if (schema.type === 'integer' && !Number.isInteger(value)) throw new Error(`${path} must be an integer`);
}

const queryProperties = {
  project: string,
  ref: string,
  query: string,
  kinds: strings,
  sourceIds: strings,
  status: { type: 'array', items: { enum: ['resolved', 'candidate', 'unresolved'] } },
  layers: layersSchema,
  limit: integer,
  offset: integer,
};

export const tools: ToolDefinition[] = [
  { name: 'list_projects', description: 'List project identities Development Intelligence may inspect. Git/source repositories remain authoritative.', inputSchema: objectSchema({}), handler: async () => await listPublicProjects() },
  { name: 'project_status', description: 'Report source revision and intrinsic Development Intelligence graph checkpoint/working status without assigning product intent.', inputSchema: objectSchema({ project: string, checkUpstream: boolean }, ['project']), handler: async args => await projectStatus(s(args, 'project'), args.checkUpstream !== false) },
  { name: 'scan_graph', description: 'Generate the working Development Intelligence graph from an exact allowlisted Git revision, optionally overlaying read-only runtime observations. The graph contains semantic entities, structural code, representations, relationships, and evidence.', inputSchema: objectSchema({ project: string, ref: string, urls: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 20 } }, ['project']), handler: async args => { const graph = await scanGraph(s(args, 'project'), { ref: optString(args, 'ref'), urls: Array.isArray(args.urls) ? args.urls.filter(value => typeof value === 'string') as string[] : [] }); return { project: graph.project, graphId: graph.graphId, role: graph.role, revision: graph.repositoryRevision, analyzerVersion: graph.analyzerVersion, sourceFingerprint: graph.sourceFingerprint, topologyFingerprint: graph.topologyFingerprint, sources: graph.sources, nodeCount: graph.nodes.length, semanticNodeCount: graph.nodes.filter(node => node.layer === 'semantic').length, edgeCount: graph.edges.length, evidenceCount: graph.evidence.length, coverage: graph.coverage, unavailableSourceIds: graph.unavailableSourceIds }; } },
  { name: 'graph_status', description: 'Report accepted semantic checkpoint A and freshly derived working graph W for the requested revision, including source/analyzer/topology currency.', inputSchema: objectSchema({ project: string, ref: string }, ['project']), handler: async args => await graphStatus(s(args, 'project'), optString(args, 'ref')) },
  { name: 'search_graph', description: 'Search entities, structural code, representations, and relationships in the intrinsic Development Intelligence graph.', inputSchema: objectSchema(queryProperties, ['project']), handler: async args => await searchGraph({ project: s(args, 'project'), ref: optString(args, 'ref'), query: optString(args, 'query'), kinds: Array.isArray(args.kinds) ? args.kinds as string[] : undefined, sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds as string[] : undefined, statuses: Array.isArray(args.status) ? args.status as Array<'resolved'|'candidate'|'unresolved'> : undefined, layers: layers(args), limit: typeof args.limit === 'number' ? args.limit : undefined, offset: typeof args.offset === 'number' ? args.offset : undefined }) },
  { name: 'query_graph', description: 'Query the intrinsic graph using text/kind/source/status/layer filters. This is a DI-owned query contract rather than a provider-specific database language.', inputSchema: objectSchema(queryProperties, ['project']), handler: async args => await searchGraph({ project: s(args, 'project'), ref: optString(args, 'ref'), query: optString(args, 'query'), kinds: Array.isArray(args.kinds) ? args.kinds as string[] : undefined, sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds as string[] : undefined, statuses: Array.isArray(args.status) ? args.status as Array<'resolved'|'candidate'|'unresolved'> : undefined, layers: layers(args), limit: typeof args.limit === 'number' ? args.limit : undefined, offset: typeof args.offset === 'number' ? args.offset : undefined }) },
  { name: 'trace_path', description: 'Traverse resolved relationships around one exact or unambiguous graph entity. Ambiguous names return candidates instead of silently guessing.', inputSchema: objectSchema({ project: string, ref: string, node: string, direction: { enum: ['inbound', 'outbound', 'both'] }, depth: integer, relationshipKinds: strings, layers: layersSchema, limit: integer }, ['project', 'node']), handler: async args => await traceGraph({ project: s(args, 'project'), ref: optString(args, 'ref'), node: s(args, 'node'), direction: args.direction as any, depth: typeof args.depth === 'number' ? args.depth : undefined, relationshipKinds: Array.isArray(args.relationshipKinds) ? args.relationshipKinds as string[] : undefined, layers: layers(args), limit: typeof args.limit === 'number' ? args.limit : undefined }) },
  { name: 'search_code', description: 'Search exact Git source directly without requiring a persistent code index.', inputSchema: objectSchema({ project: string, ref: string, pattern: string, filePattern: string, regex: boolean, context: integer, limit: integer }, ['project', 'pattern']), handler: async args => await searchCode({ project: s(args, 'project'), ref: optString(args, 'ref'), pattern: s(args, 'pattern'), filePattern: optString(args, 'filePattern'), regex: args.regex === true, context: typeof args.context === 'number' ? args.context : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }) },
  { name: 'get_code_snippet', description: 'Read source around an exact or unambiguous graph node from the exact Git revision that produced the graph. Ambiguity returns candidate node IDs.', inputSchema: objectSchema({ project: string, ref: string, node: string, context: integer }, ['project', 'node']), handler: async args => await getCodeSnippet({ project: s(args, 'project'), ref: optString(args, 'ref'), node: s(args, 'node'), context: typeof args.context === 'number' ? args.context : undefined }) },
  { name: 'get_graph_schema', description: 'Describe graph schema, layers, evidence fields, observed node kinds, and relationship kinds.', inputSchema: objectSchema({ project: string, ref: string }, ['project']), handler: async args => await graphSchema(s(args, 'project'), optString(args, 'ref')) },
  { name: 'get_architecture', description: 'Project the intrinsic graph into observed feature ownership/dependencies plus structural repository areas. Declared semantic owners remain distinct from inferred file clusters.', inputSchema: objectSchema({ project: string, ref: string }, ['project']), handler: async args => await graphArchitecture(s(args, 'project'), optString(args, 'ref')) },
  { name: 'check_graph_coverage', description: 'Report tracked/eligible/analyzed source coverage for the working graph.', inputSchema: objectSchema({ project: string, ref: string }, ['project']), handler: async args => await graphCoverage(s(args, 'project'), optString(args, 'ref')) },
  { name: 'get_evidence', description: 'Inspect first-class evidence supporting a semantic entity or relationship. Use exact IDs when a textual name is ambiguous.', inputSchema: objectSchema({ project: string, ref: string, node: string, edge: string, evidenceIds: strings }, ['project']), handler: async args => await graphEvidence({ project: s(args, 'project'), ref: optString(args, 'ref'), node: optString(args, 'node'), edge: optString(args, 'edge'), evidenceIds: Array.isArray(args.evidenceIds) ? args.evidenceIds as string[] : undefined }) },
  { name: 'diff_graph', description: 'Compare two Git revisions using the same current analyzer. If baseRef is omitted, returns the accepted semantic A→W checkpoint delta instead of pretending persisted A contains a full structural index.', inputSchema: objectSchema({ project: string, ref: string, baseRef: string, layers: layersSchema }, ['project']), handler: async args => optString(args, 'baseRef') ? await diffRevisions({ project: s(args, 'project'), ref: optString(args, 'ref'), baseRef: optString(args, 'baseRef'), layers: layers(args) }) : await diffAcceptedToWorking(s(args, 'project'), optString(args, 'ref')) },
  { name: 'scan_parity', description: 'Generate the same intrinsic graph with optional read-only runtime evidence, then summarize semantic entities and their representations. No separate Parity graph is created.', inputSchema: objectSchema({ project: string, ref: string, urls: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 20 } }, ['project']), handler: async args => { const graph = await scanGraph(s(args, 'project'), { ref: optString(args, 'ref'), urls: Array.isArray(args.urls) ? args.urls.filter(value => typeof value === 'string') as string[] : [] }); const semanticNodes = graph.nodes.filter(node => node.layer === 'semantic'); const semanticEdges = graph.edges.filter(edge => edge.layer === 'semantic'); return { project: graph.project, graphId: graph.graphId, revision: graph.repositoryRevision, topologyFingerprint: graph.topologyFingerprint, semanticNodeCount: semanticNodes.length, semanticEdgeCount: semanticEdges.length, semanticKinds: semanticNodes.reduce((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {} as Record<string, number>), relationshipCounts: semanticEdges.reduce((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {} as Record<string, number>), namingDivergenceCount: graph.namingDivergences.length, unmatchedNodeCount: graph.unmatchedNodeIds.length, unavailableSourceIds: graph.unavailableSourceIds }; } },
  { name: 'query_parity', description: 'Inspect semantic entities and their observed human/agent/API/provider representations over the canonical graph. This reports observed parity; it does not invent which representations should exist.', inputSchema: objectSchema(queryProperties, ['project']), handler: async args => await parityLens({ project: s(args, 'project'), ref: optString(args, 'ref'), query: optString(args, 'query'), kinds: Array.isArray(args.kinds) ? args.kinds as string[] : undefined, sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds as string[] : undefined, status: Array.isArray(args.status) ? args.status as Array<'resolved'|'candidate'|'unresolved'> : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined, offset: typeof args.offset === 'number' ? args.offset : undefined }) },
  { name: 'diff_parity', description: 'Compare semantic topology across revisions, or compare accepted semantic A to working W when baseRef is omitted.', inputSchema: objectSchema({ project: string, ref: string, baseRef: string }, ['project']), handler: async args => optString(args, 'baseRef') ? await diffRevisions({ project: s(args, 'project'), ref: optString(args, 'ref'), baseRef: optString(args, 'baseRef'), layers: ['semantic'] }) : await diffAcceptedToWorking(s(args, 'project'), optString(args, 'ref')) },
  { name: 'clear_cache', description: 'Clear only disposable in-process Development Intelligence graph acceleration for a project. Git-owned accepted graph history is untouched.', inputSchema: projectOnly, handler: async args => { clearGraphCache(s(args, 'project')); return { project: s(args, 'project'), cleared: true }; } },
];

function annotationsFor(name: string): Record<string, boolean> {
  if (name === 'clear_cache') return { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
}

export function listTools() { return tools.map(({ handler: _handler, ...tool }) => ({ ...tool, annotations: tool.annotations ?? annotationsFor(tool.name) })); }
export async function callTool(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  validateAgainstSchema(tool.inputSchema, args);
  return await tool.handler(args);
}
