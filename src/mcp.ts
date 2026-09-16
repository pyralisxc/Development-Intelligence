import { listPublicProjects } from './source/git.js';
import { projectStatus } from './projectStatus.js';
import { scanGraph } from './intelligence/service.js';
import { diffAcceptedToWorking, diffRevisions, graphArchitecture, graphCoverage, graphEvidence, graphSchema, parityLens, searchGraph, traceGraph } from './intelligence/query.js';
import { getCodeSnippet, searchCode } from './intelligence/code.js';
import type { GraphNodeLayer, GraphCoverageStatus, RelationshipStatus } from './types.js';

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
const relationshipStatusSchema = { type: 'array', items: { enum: ['resolved', 'candidate', 'unresolved'] } };
const coverageStatusSchema = { type: 'array', items: { enum: ['complete', 'partial', 'unsupported', 'skipped', 'failed'] } };

function s(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}
function optString(args: Record<string, unknown>, key: string): string | undefined { const value = args[key]; return typeof value === 'string' && value ? value : undefined; }
function layers(args: Record<string, unknown>): GraphNodeLayer[] | undefined {
  return Array.isArray(args.layers) ? args.layers.filter((value): value is GraphNodeLayer => value === 'semantic' || value === 'structural' || value === 'representation') : undefined;
}
function relationshipStatuses(args: Record<string, unknown>, key = 'status'): RelationshipStatus[] | undefined {
  return Array.isArray(args[key]) ? args[key].filter((value): value is RelationshipStatus => value === 'resolved' || value === 'candidate' || value === 'unresolved') : undefined;
}
function coverageStatuses(args: Record<string, unknown>): GraphCoverageStatus[] | undefined {
  return Array.isArray(args.status) ? args.status.filter((value): value is GraphCoverageStatus => ['complete', 'partial', 'unsupported', 'skipped', 'failed'].includes(String(value))) : undefined;
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
  graphId: string,
  query: string,
  kinds: strings,
  sourceIds: strings,
  status: relationshipStatusSchema,
  layers: layersSchema,
  limit: integer,
  offset: integer,
};

export const tools: ToolDefinition[] = [
  { name: 'list_projects', description: 'List project identities Development Intelligence is authorized to inspect. Access configuration grants technical reach; it does not define project meaning.', inputSchema: objectSchema({}), handler: async () => await listPublicProjects() },
  { name: 'project_status', description: 'Report repository revision plus accepted semantic checkpoint and working-graph currentness dimensions without assigning product intent.', inputSchema: objectSchema({ project: string, checkUpstream: boolean }, ['project']), handler: async args => await projectStatus(s(args, 'project'), args.checkUpstream !== false) },
  { name: 'scan_graph', description: 'Generate canonical source-derived W for an exact allowlisted Git revision, or an explicit ephemeral runtime-observation snapshot when urls are supplied. Runtime scans never replace later ordinary project/ref queries.', inputSchema: objectSchema({ project: string, ref: string, urls: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 20 } }, ['project']), handler: async args => { const graph = await scanGraph(s(args, 'project'), { ref: optString(args, 'ref'), urls: Array.isArray(args.urls) ? args.urls.filter(value => typeof value === 'string') as string[] : [] }); return { project: graph.project, graphId: graph.graphId, role: graph.role, revision: graph.repositoryRevision, analyzerVersion: graph.analyzerVersion, sourceFingerprint: graph.sourceFingerprint, topologyFingerprint: graph.topologyFingerprint, evidenceFingerprint: graph.evidenceFingerprint, sources: graph.sources, nodeCount: graph.nodes.length, semanticNodeCount: graph.nodes.filter(node => node.layer === 'semantic').length, edgeCount: graph.edges.length, evidenceCount: graph.evidence.length, explicitValueConflicts: graph.explicitValueConflicts, coverage: graph.coverage, unavailableSourceIds: graph.unavailableSourceIds }; } },
  { name: 'search_graph', description: 'Search entities, structural code, representations, relationships, conflicts, and evidence context in canonical W or an explicit graph snapshot.', inputSchema: objectSchema(queryProperties, ['project']), handler: async args => await searchGraph({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), query: optString(args, 'query'), kinds: Array.isArray(args.kinds) ? args.kinds as string[] : undefined, sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds as string[] : undefined, statuses: relationshipStatuses(args), layers: layers(args), limit: typeof args.limit === 'number' ? args.limit : undefined, offset: typeof args.offset === 'number' ? args.offset : undefined }) },
  { name: 'trace_path', description: 'Traverse graph relationships around one exact or unambiguous entity. Resolved relationships are traversed by default; callers may explicitly include candidate or unresolved relationships.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, node: string, direction: { enum: ['inbound', 'outbound', 'both'] }, depth: integer, relationshipKinds: strings, status: relationshipStatusSchema, layers: layersSchema, limit: integer }, ['project', 'node']), handler: async args => await traceGraph({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), node: s(args, 'node'), direction: args.direction as any, depth: typeof args.depth === 'number' ? args.depth : undefined, relationshipKinds: Array.isArray(args.relationshipKinds) ? args.relationshipKinds as string[] : undefined, statuses: relationshipStatuses(args), layers: layers(args), limit: typeof args.limit === 'number' ? args.limit : undefined }) },
  { name: 'search_code', description: 'Search exact Git source at one immutable graph/revision context without requiring a persistent code index.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, pattern: string, filePattern: string, regex: boolean, context: integer, limit: integer }, ['project', 'pattern']), handler: async args => await searchCode({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), pattern: s(args, 'pattern'), filePattern: optString(args, 'filePattern'), regex: args.regex === true, context: typeof args.context === 'number' ? args.context : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }) },
  { name: 'get_code_snippet', description: 'Read source around an exact or unambiguous graph node from the exact Git SHA that produced the selected graph.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, node: string, context: integer }, ['project', 'node']), handler: async args => await getCodeSnippet({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), node: s(args, 'node'), context: typeof args.context === 'number' ? args.context : undefined }) },
  { name: 'get_graph_schema', description: 'Describe graph schema, layers, coverage statuses, evidence fields, observed node kinds, and relationship kinds.', inputSchema: objectSchema({ project: string, ref: string, graphId: string }, ['project']), handler: async args => await graphSchema(s(args, 'project'), optString(args, 'ref'), optString(args, 'graphId')) },
  { name: 'get_architecture', description: 'Project the selected intrinsic graph into proven feature ownership/dependencies plus structural repository areas while preserving candidate/unresolved counts.', inputSchema: objectSchema({ project: string, ref: string, graphId: string }, ['project']), handler: async args => await graphArchitecture(s(args, 'project'), optString(args, 'ref'), optString(args, 'graphId')) },
  { name: 'check_graph_coverage', description: 'Report complete/partial/unsupported/skipped/failed source coverage. Use this before treating an absent result as evidence that something does not exist.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, pathPrefix: string, status: coverageStatusSchema }, ['project']), handler: async args => await graphCoverage(s(args, 'project'), optString(args, 'ref'), optString(args, 'graphId'), optString(args, 'pathPrefix'), coverageStatuses(args)) },
  { name: 'get_evidence', description: 'Inspect first-class evidence supporting a semantic entity or relationship. Use exact IDs when a textual name is ambiguous.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, node: string, edge: string, evidenceIds: strings }, ['project']), handler: async args => { const ref = optString(args, 'ref'); const graphId = optString(args, 'graphId'); const node = optString(args, 'node'); const edge = optString(args, 'edge'); const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds as string[] : undefined; return await graphEvidence({ project: s(args, 'project'), ...(ref ? { ref } : {}), ...(graphId ? { graphId } : {}), ...(node ? { node } : {}), ...(edge ? { edge } : {}), ...(evidenceIds?.length ? { evidenceIds } : {}) }); } },
  { name: 'diff_graph', description: 'Compare accepted semantic A to canonical W, or two Git revisions under the same current analyzer. Semantic diffs ignore provenance-only locator/evidence movement and report evidence/analyzer drift separately.', inputSchema: objectSchema({ project: string, ref: string, baseRef: string, layers: layersSchema }, ['project']), handler: async args => { const baseRef = optString(args, 'baseRef'); const ref = optString(args, 'ref'); const selectedLayers = layers(args); return baseRef ? await diffRevisions({ project: s(args, 'project'), baseRef, ...(ref ? { ref } : {}), ...(selectedLayers?.length ? { layers: selectedLayers } : {}) }) : await diffAcceptedToWorking(s(args, 'project'), ref); } },
  { name: 'query_parity', description: 'Inspect semantic entities and their observed human/agent/API/provider representations over the selected canonical graph. Only resolved relations populate confirmed representation lists; candidates and unresolved relations remain explicit.', inputSchema: objectSchema(queryProperties, ['project']), handler: async args => await parityLens({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), query: optString(args, 'query'), kinds: Array.isArray(args.kinds) ? args.kinds as string[] : undefined, sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds as string[] : undefined, status: relationshipStatuses(args), limit: typeof args.limit === 'number' ? args.limit : undefined, offset: typeof args.offset === 'number' ? args.offset : undefined }) },
];

function annotationsFor(name: string): Record<string, boolean> {
  return { readOnlyHint: true, destructiveHint: false, openWorldHint: name !== 'list_projects' };
}

export function listTools() { return tools.map(({ handler: _handler, ...tool }) => ({ ...tool, annotations: tool.annotations ?? annotationsFor(tool.name) })); }
export async function callTool(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  validateAgainstSchema(tool.inputSchema, args);
  return await tool.handler(args);
}
