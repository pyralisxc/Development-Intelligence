import { callCurrentCodebase } from './codebase/proxy.js';
import { indexStatus, listPublicProjects, refreshCodebase, removeDerivedProjectState } from './codebase/sourceManager.js';
import { diffParity } from './parity/diff.js';
import { queryParity, parityStatus } from './parity/query.js';
import { scanParity } from './parity/scanner.js';
import { projectStatus } from './projectStatus.js';

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
const projectOnly = objectSchema({ project: string }, ['project']);

function s(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}
function optString(args: Record<string, unknown>, key: string): string | undefined { const value = args[key]; return typeof value === 'string' ? value : undefined; }
function stripProject(args: Record<string, unknown>) { const { project: _project, ...rest } = args; return rest; }

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

export const tools: ToolDefinition[] = [
  { name: 'list_projects', description: 'List public project identities available to Development Intelligence. Internal artifact keys and ephemeral hydration paths are not exposed as project identities.', inputSchema: objectSchema({}), handler: async () => await listPublicProjects() },
  { name: 'project_status', description: 'Report independent upstream source, immutable revision bundle, indexing, and Parity Engine freshness/provenance. Does not trigger indexing.', inputSchema: objectSchema({ project: string, checkUpstream: boolean }, ['project']), handler: async args => await projectStatus(s(args, 'project'), args.checkUpstream !== false) },
  { name: 'refresh_codebase', description: 'Ensure an allowlisted repository ref has a validated immutable revision bundle. In managed hosting this queues a short-lived indexing job; failed indexing never replaces the selected last-known-good bundle.', inputSchema: objectSchema({ project: string, ref: string }, ['project']), handler: async args => await refreshCodebase(s(args, 'project'), optString(args, 'ref')) },
  { name: 'delete_project', description: 'Delete only Development Intelligence derived artifacts/control state for an allowlisted project. Does not modify the canonical repository.', inputSchema: projectOnly, handler: async args => await removeDerivedProjectState(s(args, 'project')) },
  { name: 'index_status', description: 'Get Development Intelligence indexing and selected revision-bundle status without hydrating Codebase Memory.', inputSchema: projectOnly, handler: async args => await indexStatus(s(args, 'project')) },
  { name: 'search_graph', description: 'Search the selected revision bundle Codebase Memory graph for functions, classes, routes, variables and related symbols.', inputSchema: objectSchema({ project: string, query: string, label: string, name_pattern: string, qn_pattern: string, file_pattern: string, relationship: string, min_degree: integer, max_degree: integer, exclude_entry_points: boolean, include_connected: boolean, semantic_query: strings, limit: integer, offset: integer, format: { enum: ['tree', 'json'] }, fields: strings, detail: { enum: ['ids', 'default'] } }, ['project']), handler: async args => await callCurrentCodebase(s(args, 'project'), 'search_graph', stripProject(args)) },
  { name: 'search_code', description: 'Search exact-revision bundled source text and enrich matches with current Codebase Memory graph context.', inputSchema: objectSchema({ project: string, pattern: string, file_pattern: string, path_filter: string, mode: { enum: ['compact', 'full', 'files'] }, context: integer, regex: boolean, debug: boolean, limit: integer }, ['project', 'pattern']), handler: async args => await callCurrentCodebase(s(args, 'project'), 'search_code', stripProject(args)) },
  { name: 'get_code_snippet', description: 'Read exact-revision bundled source for a symbol from the selected Codebase Memory graph.', inputSchema: objectSchema({ project: string, qualified_name: string, include_neighbors: boolean }, ['project', 'qualified_name']), handler: async args => await callCurrentCodebase(s(args, 'project'), 'get_code_snippet', stripProject(args)) },
  { name: 'trace_path', description: 'Trace callers, callees, data flow, or cross-service paths through the selected revision bundle graph.', inputSchema: objectSchema({ project: string, function_name: string, direction: { enum: ['inbound', 'outbound', 'both'] }, depth: integer, limit: integer, cursor: string, mode: { enum: ['calls', 'data_flow', 'cross_service'] }, parameter_name: string, edge_types: strings, risk_labels: boolean, include_tests: boolean, format: { enum: ['tree', 'json'] }, include_evidence: boolean }, ['project', 'function_name']), handler: async args => await callCurrentCodebase(s(args, 'project'), 'trace_path', stripProject(args)) },
  { name: 'query_graph', description: 'Run an advanced Cypher query against the selected revision bundle graph or missed-file graph.', inputSchema: objectSchema({ project: string, query: string, graph: { enum: ['code', 'missed'] }, max_rows: integer }, ['project', 'query']), handler: async args => await callCurrentCodebase(s(args, 'project'), 'query_graph', stripProject(args)) },
  { name: 'get_graph_schema', description: 'Get the Codebase Memory graph schema for the selected revision bundle.', inputSchema: projectOnly, handler: async args => await callCurrentCodebase(s(args, 'project'), 'get_graph_schema', {}) },
  { name: 'get_architecture', description: 'Get a high-level Codebase Memory architecture overview for the selected revision bundle.', inputSchema: objectSchema({ project: string, path: string, aspects: strings }, ['project']), handler: async args => await callCurrentCodebase(s(args, 'project'), 'get_architecture', stripProject(args)) },
  { name: 'check_index_coverage', description: 'Check Codebase Memory coverage metadata for exact files or bounded scopes in the selected revision bundle.', inputSchema: objectSchema({ project: string, paths: strings, scopes: strings, scope_limit: integer, scope_offset: integer }, ['project']), handler: async args => await callCurrentCodebase(s(args, 'project'), 'check_index_coverage', stripProject(args)) },
  { name: 'detect_changes', description: 'Map a bundled Git diff to its Codebase Memory blast radius. Revision bundles preserve bounded Git history for branch/PR analysis without a persistent mirror.', inputSchema: objectSchema({ project: string, scope: { enum: ['files', 'impact'] }, direction: { enum: ['inbound', 'outbound', 'both'] }, depth: integer, limit: integer, base_branch: string, since: string, format: { enum: ['tree', 'json'] } }, ['project']), handler: async args => await callCurrentCodebase(s(args, 'project'), 'detect_changes', stripProject(args)) },
  { name: 'scan_parity', description: 'Combine the selected revision bundle repository observations with optional read-only live runtime observations using generic technology analyzers only. No project-specific extractor or semantic configuration is used.', inputSchema: objectSchema({ project: string, urls: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 20 } }, ['project']), handler: async args => { const scan = await scanParity(s(args, 'project'), Array.isArray(args.urls) ? args.urls.filter(value => typeof value === 'string') as string[] : []); return { project: scan.project, scanId: scan.scanId, createdAt: scan.createdAt, repositoryRevision: scan.repositoryRevision, sources: scan.sources, observationCount: scan.observations.length, resolutionCounts: scan.resolutions.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }), {} as Record<string, number>), namingDivergenceCount: scan.namingDivergences.length, unmatchedObservationCount: scan.unmatchedObservationIds.length, unavailableSourceIds: scan.unavailableSourceIds }; } },
  { name: 'query_parity', description: 'Query observations and evidence-backed relationships from a parity scan. Raw observed names/values and provenance are preserved rather than semantically normalized.', inputSchema: objectSchema({ project: string, scanId: string, query: string, kinds: strings, sourceIds: strings, status: { type: 'array', items: { enum: ['resolved', 'candidate', 'unresolved'] } }, limit: integer, offset: integer }, ['project']), handler: async args => { const input: any = { project: s(args, 'project') }; const scanId = optString(args, 'scanId'); const query = optString(args, 'query'); if (scanId) input.scanId = scanId; if (query) input.query = query; if (Array.isArray(args.kinds)) input.kinds = args.kinds as string[]; if (Array.isArray(args.sourceIds)) input.sourceIds = args.sourceIds as string[]; if (Array.isArray(args.status)) input.status = args.status as Array<'resolved' | 'candidate' | 'unresolved'>; if (typeof args.limit === 'number') input.limit = args.limit; if (typeof args.offset === 'number') input.offset = args.offset; return await queryParity(input); } },
  { name: 'diff_parity', description: 'Compare two parity scans without assuming their source revisions are synchronized or interpreting differences as regressions/improvements.', inputSchema: objectSchema({ project: string, baseScanId: string, headScanId: string }, ['project', 'baseScanId', 'headScanId']), handler: async args => await diffParity(s(args, 'project'), s(args, 'baseScanId'), s(args, 'headScanId')) },
  { name: 'parity_status', description: 'Report the latest Parity Engine scan provenance/counts without performing a scan or assigning a health score.', inputSchema: projectOnly, handler: async args => await parityStatus(s(args, 'project')) },
];

function annotationsFor(name: string): Record<string, boolean> {
  if (name === 'delete_project') return { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  if (name === 'refresh_codebase' || name === 'scan_parity') return { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
}

export function listTools() { return tools.map(({ handler: _handler, ...tool }) => ({ ...tool, annotations: tool.annotations ?? annotationsFor(tool.name) })); }
export async function callTool(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  validateAgainstSchema(tool.inputSchema, args);
  return await tool.handler(args);
}
