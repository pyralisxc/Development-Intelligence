import { listPublicProjects, resolveProjectRevision, revisionIdentity } from './source/git.js';
import { listAuthorizedGithubOwners } from './config/registry.js';
import { projectStatus } from './projectStatus.js';
import { scanGraph } from './intelligence/service.js';
import { analyzeImpact, diffAcceptedToWorking, diffRevisions, graphArchitecture, graphCoverage, graphEvidence, graphSchema, parityLens, searchGraph, traceGraph } from './intelligence/query.js';
import { getCodeSnippet, searchCode } from './intelligence/code.js';
import { inspectEntity, projectOverview, queryWorkbenchRequest, scopeOrientation, workbenchSources, type ScopeRankBy } from './intelligence/workbench.js';
import { queryIntelligence, type RealizationFacet } from './intelligence/assessment.js';
import { queryTechnicalSource } from './intelligence/technicalSources.js';
import { evaluateParityContract } from './intelligence/parityContract.js';
import { verifyTransition } from './intelligence/temporalVerification.js';
import { repositoryAudit } from './intelligence/repositoryAudit.js';
import { inspectPortfolio, tracePortfolio, type PortfolioParticipantInput } from './intelligence/portfolio.js';
import { stableHash } from './util/hash.js';
import type { GraphNodeLayer, GraphCoverageStatus, RelationshipStatus, TechnicalSourceCapability } from './types.js';

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
const boundedQueries = { type: 'array', items: string, maxItems: 20 };
const boundedSubjects = { type: 'array', items: string, maxItems: 10 };
const boundedQuestions = { type: 'array', items: string, maxItems: 10 };
const portfolioParticipantsSchema = { type: 'array', maxItems: 12, items: objectSchema({ key: string, project: string, ref: string, graphId: string }, ['project']) };
const layersSchema = { type: 'array', items: { enum: ['semantic', 'structural', 'representation'] } };
const relationshipStatusSchema = { type: 'array', items: { enum: ['resolved', 'candidate', 'unresolved'] } };
const coverageStatusSchema = { type: 'array', items: { enum: ['complete', 'partial', 'unsupported', 'skipped', 'failed'] } };
const technicalCapabilitySchema = { enum: ['query', 'logs', 'metrics'] };
const scopeRankSchema = { enum: ['fan-in', 'fan-out', 'cross-file', 'relationship-diversity', 'uncertainty'] };
const parityRequirementSchema = { enum: ['required', 'forbidden'] };
const parityContractSchema = objectSchema({
  version: { enum: [1] },
  name: string,
  description: string,
  entities: {
    type: 'array',
    maxItems: 200,
    items: objectSchema({ id: string, requirement: parityRequirementSchema, rationale: string }, ['id']),
  },
  relationships: {
    type: 'array',
    maxItems: 200,
    items: objectSchema({ from: string, kind: string, to: string, requirement: parityRequirementSchema, rationale: string }, ['from', 'kind', 'to']),
  },
}, ['version']);
const transitionContractSchema = objectSchema({
  version: { enum: [1] },
  name: string,
  description: string,
  head: parityContractSchema,
  preserve: parityContractSchema,
}, ['version']);

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

function compactCoverage(coverage: any): Record<string, unknown> | null {
  if (!coverage) return null;
  const { files: _files, ...summary } = coverage;
  return summary;
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
  queries: boundedQueries,
  kinds: strings,
  sourceIds: strings,
  status: relationshipStatusSchema,
  layers: layersSchema,
  limit: integer,
  offset: integer,
};

const realizationFacetsSchema = { type: 'array', items: { enum: ['human', 'agent', 'transport', 'implementation', 'persistence', 'provider'] }, maxItems: 6 };

export const tools: ToolDefinition[] = [
  { name: 'list_projects', description: 'List configured project identities and dynamic GitHub owner namespaces Development Intelligence is authorized to inspect. Repositories under an authorized owner are addressed as owner/repository. Access configuration grants technical reach; it does not define project meaning.', inputSchema: objectSchema({}), handler: async () => ({
    projects: await listPublicProjects(),
    githubOwnerNamespaces: listAuthorizedGithubOwners().map(owner => ({
      owner,
      projectPattern: `${owner}/<repository>`,
      defaultRef: 'HEAD',
      revisionPolicy: 'repository-history',
      selectors: ['commit:<full-sha>', 'branch:<name>', 'tag:<name>', 'pr:<number>/head', 'pr:<number>/base', 'pr:<number>/result'],
      access: 'read-only',
    })),
  }) },
  { name: 'resolve_revision', description: 'Resolve a repository revision selector to one immutable Git object id without building a graph. Historical selectors are commit:<full-sha>, branch:<name>, tag:<name>, pr:<number>/head, pr:<number>/base, and pr:<number>/result. Pull-request result exists only for merged PRs.', inputSchema: objectSchema({ project: string, ref: string }, ['project']), handler: async args => {
    const revision = await resolveProjectRevision(s(args, 'project'), optString(args, 'ref'));
    return { project: revision.project, repository: revision.repository, identity: revisionIdentity(revision) };
  }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'project_status', description: 'Report repository revision plus accepted semantic checkpoint and working-graph currentness dimensions without assigning product intent.', inputSchema: objectSchema({ project: string, checkUpstream: boolean }, ['project']), handler: async args => await projectStatus(s(args, 'project'), args.checkUpstream !== false) },
  { name: 'project_overview', description: 'Return a compact revision-bound project brief synthesized from one graph context. Pass up to 10 subjects to include bounded entity orientation/reach in the same response; use check_graph_coverage for per-file coverage detail.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, subjects: boundedSubjects }, ['project']), handler: async args => await projectOverview(s(args, 'project'), optString(args, 'ref'), optString(args, 'graphId'), Array.isArray(args.subjects) ? args.subjects.filter(value => typeof value === 'string') as string[] : []) },
  { name: 'investigate', description: 'Route one or up to 10 ordinary technical questions through the same deterministic investigation contract used by the human Workbench. Use questions[] as the canonical batch form; scope may pin exploratory questions to a file/path/entity and rankBy selects one explainable graph facet. Returns per-question intent, subject, chosen DI primitive, evidence result, and no repository mutations.', inputSchema: objectSchema({ project: string, question: string, questions: boundedQuestions, ref: string, graphId: string, sourceId: string, capability: technicalCapabilitySchema, scope: string, rankBy: scopeRankSchema }, ['project']), handler: async args => { const question = optString(args, 'question'); const questions = Array.isArray(args.questions) ? args.questions.filter(value => typeof value === 'string') as string[] : []; if (!question && !questions.length) throw new Error('question or questions is required'); if (question && questions.length) throw new Error('provide question or questions, not both'); return await queryWorkbenchRequest({ project: s(args, 'project'), ...(question ? { text: question } : {}), ...(questions.length ? { questions } : {}), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), sourceId: optString(args, 'sourceId'), capability: optString(args, 'capability') as TechnicalSourceCapability | undefined, scope: optString(args, 'scope'), rankBy: optString(args, 'rankBy') as ScopeRankBy | undefined }); }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'orient_scope', description: 'Return a bounded, evidence-linked orientation for a repository, path, file, or exact/unambiguous entity. Key entities are ranked only by the caller-selected graph facet (fan-in, fan-out, cross-file reach, relationship diversity, or uncertainty); no subjective importance or quality score is assigned.', inputSchema: objectSchema({ project: string, scope: string, ref: string, graphId: string, rankBy: scopeRankSchema, limit: integer }, ['project']), handler: async args => await scopeOrientation({ project: s(args, 'project'), scope: optString(args, 'scope'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), rankBy: optString(args, 'rankBy') as ScopeRankBy | undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'query_intelligence', description: 'Evaluate a bounded technical question as revision-bound claims, proof bundles, capability realization, and generic audit findings over the canonical graph. Assessments are deterministic derived projections and never become graph authority or product intent. Pass requiredFacets only for caller-owned realization expectations.', inputSchema: objectSchema({ project: string, question: string, ref: string, graphId: string, requiredFacets: realizationFacetsSchema }, ['project', 'question']), handler: async args => { const ref = optString(args, 'ref'); const graphId = optString(args, 'graphId'); const requiredFacets = Array.isArray(args.requiredFacets) ? args.requiredFacets as RealizationFacet[] : undefined; return await queryIntelligence({ project: s(args, 'project'), question: s(args, 'question'), ...(ref ? { ref } : {}), ...(graphId ? { graphId } : {}), ...(requiredFacets?.length ? { requiredFacets } : {}) }); } },
  { name: 'audit_repository', description: 'Run a bounded revision-bound technical audit over one repository graph. Returns deterministic findings, coverage blockers, candidate/unresolved relationship concentrations, checkpoint/currentness context, and evidence-linked investigation targets without modifying the repository or creating work items.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, limit: integer }, ['project']), handler: async args => {
    const ref = optString(args, 'ref');
    const graphId = optString(args, 'graphId');
    return await repositoryAudit({
      project: s(args, 'project'),
      ...(ref ? { ref } : {}),
      ...(graphId ? { graphId } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    });
  } },
  { name: 'inspect_portfolio', description: 'Compose 2-12 independently revision-bound repository graphs into one ephemeral cross-repository investigation. Preserves each repository authority, namespaces identities only in the portfolio result, surfaces resolved package/API dependencies, shared dependencies, typed technical correlations, unavailable participants, and bounded blast-radius evidence without persisting a mega-graph.', inputSchema: objectSchema({ participants: portfolioParticipantsSchema, limit: integer }, ['participants']), handler: async args => await inspectPortfolio({ participants: args.participants as PortfolioParticipantInput[], ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) }) },
  { name: 'trace_portfolio', description: 'Traverse bounded resolved/candidate technical relationships across 2-12 exact repository graphs without creating a durable combined graph. Start from a namespaced <participant-key>::<node-id>; every hop reports whether it came from an original repository edge or derived cross-repository evidence and preserves provenance.', inputSchema: objectSchema({ participants: portfolioParticipantsSchema, start: string, direction: { enum: ['inbound', 'outbound', 'both'] }, depth: integer, status: relationshipStatusSchema, limit: integer }, ['participants', 'start']), handler: async args => await tracePortfolio({ participants: args.participants as PortfolioParticipantInput[], start: s(args, 'start'), ...(typeof args.direction === 'string' ? { direction: args.direction as 'inbound' | 'outbound' | 'both' } : {}), ...(typeof args.depth === 'number' ? { depth: args.depth } : {}), ...(relationshipStatuses(args)?.length ? { statuses: relationshipStatuses(args)! } : {}), ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) }) },
  { name: 'inspect_entity', description: 'Inspect one exact or unambiguous entity with quick notes, connections, evidence, source context, and accepted-to-working change state.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, node: string }, ['project', 'node']), handler: async args => await inspectEntity({ project: s(args, 'project'), node: s(args, 'node'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId') }) },
  { name: 'list_sources', description: 'List Git, runtime, and configured read-only technical sources available to a project, including query/log/metrics capabilities.', inputSchema: objectSchema({ project: string, ref: string, graphId: string }, ['project']), handler: async args => await workbenchSources(s(args, 'project'), optString(args, 'ref'), optString(args, 'graphId')) },
  { name: 'query_source', description: 'Run a bounded read-only query against one explicitly configured technical source adapter. Query results are observations and never automatically become accepted topology.', inputSchema: objectSchema({ project: string, sourceId: string, capability: technicalCapabilitySchema, query: string, limit: integer, from: string, to: string }, ['project', 'sourceId', 'query']), handler: async args => await queryTechnicalSource({ project: s(args, 'project'), sourceId: s(args, 'sourceId'), capability: optString(args, 'capability') as TechnicalSourceCapability | undefined, query: s(args, 'query'), limit: typeof args.limit === 'number' ? args.limit : undefined, from: optString(args, 'from'), to: optString(args, 'to') }) },
  { name: 'scan_graph', description: 'Generate canonical source-derived W for an exact authorized Git revision selector, or an explicit ephemeral runtime-observation snapshot when urls are supplied. Returns compact coverage counts; use check_graph_coverage for file detail. Runtime scans never replace later ordinary project/ref queries.', inputSchema: objectSchema({ project: string, ref: string, urls: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 20 } }, ['project']), handler: async args => { const graph = await scanGraph(s(args, 'project'), { ref: optString(args, 'ref'), urls: Array.isArray(args.urls) ? args.urls.filter(value => typeof value === 'string') as string[] : [] }); return { project: graph.project, graphId: graph.graphId, role: graph.role, revision: graph.repositoryRevision, analyzerVersion: graph.analyzerVersion, sourceFingerprint: graph.sourceFingerprint, topologyFingerprint: graph.topologyFingerprint, evidenceFingerprint: graph.evidenceFingerprint, sources: graph.sources, nodeCount: graph.nodes.length, semanticNodeCount: graph.nodes.filter(node => node.layer === 'semantic').length, edgeCount: graph.edges.length, evidenceCount: graph.evidence.length, explicitValueConflicts: graph.explicitValueConflicts, coverage: compactCoverage(graph.coverage), unavailableSourceIds: graph.unavailableSourceIds }; } },
  { name: 'search_graph', description: 'Search entities, structural code, CSS representations, relationships, conflicts, and evidence context in canonical W or an explicit graph snapshot. Pass queries to evaluate up to 20 independent terms against one loaded graph and avoid repeated calls.', inputSchema: objectSchema(queryProperties, ['project']), handler: async args => await searchGraph({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), query: optString(args, 'query'), queries: Array.isArray(args.queries) ? args.queries as string[] : undefined, kinds: Array.isArray(args.kinds) ? args.kinds as string[] : undefined, sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds as string[] : undefined, statuses: relationshipStatuses(args), layers: layers(args), limit: typeof args.limit === 'number' ? args.limit : undefined, offset: typeof args.offset === 'number' ? args.offset : undefined }) },
  { name: 'trace_path', description: 'Traverse graph relationships around one exact or unambiguous entity. Resolved relationships are traversed by default; callers may explicitly include candidate or unresolved relationships.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, node: string, direction: { enum: ['inbound', 'outbound', 'both'] }, depth: integer, relationshipKinds: strings, status: relationshipStatusSchema, layers: layersSchema, limit: integer }, ['project', 'node']), handler: async args => await traceGraph({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), node: s(args, 'node'), direction: args.direction as any, depth: typeof args.depth === 'number' ? args.depth : undefined, relationshipKinds: Array.isArray(args.relationshipKinds) ? args.relationshipKinds as string[] : undefined, statuses: relationshipStatuses(args), layers: layers(args), limit: typeof args.limit === 'number' ? args.limit : undefined }) },
  { name: 'search_code', description: 'Search exact Git source at one immutable graph/revision context without requiring a persistent code index.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, pattern: string, filePattern: string, regex: boolean, context: integer, limit: integer }, ['project', 'pattern']), handler: async args => await searchCode({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), pattern: s(args, 'pattern'), filePattern: optString(args, 'filePattern'), regex: args.regex === true, context: typeof args.context === 'number' ? args.context : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined }) },
  { name: 'get_code_snippet', description: 'Read source around an exact or unambiguous graph node from the exact Git SHA that produced the selected graph.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, node: string, context: integer }, ['project', 'node']), handler: async args => await getCodeSnippet({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), node: s(args, 'node'), context: typeof args.context === 'number' ? args.context : undefined }) },
  { name: 'get_graph_schema', description: 'Describe graph schema, deployed source-analysis support, layers, coverage statuses, evidence fields, observed node kinds, and relationship kinds.', inputSchema: objectSchema({ project: string, ref: string, graphId: string }, ['project']), handler: async args => await graphSchema(s(args, 'project'), optString(args, 'ref'), optString(args, 'graphId')) },
  { name: 'get_architecture', description: 'Project the selected intrinsic graph into proven feature ownership/dependencies plus structural repository areas while preserving candidate/unresolved counts.', inputSchema: objectSchema({ project: string, ref: string, graphId: string }, ['project']), handler: async args => await graphArchitecture(s(args, 'project'), optString(args, 'ref'), optString(args, 'graphId')) },
  { name: 'check_graph_coverage', description: 'Report complete/partial/unsupported/skipped/failed source coverage. Use this before treating an absent result as evidence that something does not exist.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, pathPrefix: string, status: coverageStatusSchema }, ['project']), handler: async args => await graphCoverage(s(args, 'project'), optString(args, 'ref'), optString(args, 'graphId'), optString(args, 'pathPrefix'), coverageStatuses(args)) },
  { name: 'get_evidence', description: 'Inspect first-class evidence supporting a semantic entity or relationship. Use exact IDs when a textual name is ambiguous.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, node: string, edge: string, evidenceIds: strings }, ['project']), handler: async args => { const ref = optString(args, 'ref'); const graphId = optString(args, 'graphId'); const node = optString(args, 'node'); const edge = optString(args, 'edge'); const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds as string[] : undefined; return await graphEvidence({ project: s(args, 'project'), ...(ref ? { ref } : {}), ...(graphId ? { graphId } : {}), ...(node ? { node } : {}), ...(edge ? { edge } : {}), ...(evidenceIds?.length ? { evidenceIds } : {}) }); } },
  { name: 'diff_graph', description: 'Compare accepted semantic A to canonical W, or any two authorized historical selectors under the same current analyzer. The result discloses both immutable revision identities. Semantic diffs ignore provenance-only locator/evidence movement and report evidence/analyzer drift separately.', inputSchema: objectSchema({ project: string, ref: string, baseRef: string, layers: layersSchema }, ['project']), handler: async args => { const baseRef = optString(args, 'baseRef'); const ref = optString(args, 'ref'); const selectedLayers = layers(args); return baseRef ? await diffRevisions({ project: s(args, 'project'), baseRef, ...(ref ? { ref } : {}), ...(selectedLayers?.length ? { layers: selectedLayers } : {}) }) : await diffAcceptedToWorking(s(args, 'project'), ref); } },
  { name: 'analyze_impact', description: 'Compare two authorized Git revisions by actual changed files, map those paths into each revision graph, and trace bounded dependency impact. Inbound resolved relationships are used by default; direction, relationship kinds, relationship status, layers, depth, and result limit are caller-controlled.', inputSchema: objectSchema({ project: string, baseRef: string, ref: string, direction: { enum: ['inbound', 'outbound', 'both'] }, depth: integer, relationshipKinds: strings, status: relationshipStatusSchema, layers: layersSchema, limit: integer }, ['project', 'baseRef']), handler: async args => await analyzeImpact({ project: s(args, 'project'), baseRef: s(args, 'baseRef'), ref: optString(args, 'ref'), direction: args.direction as any, depth: typeof args.depth === 'number' ? args.depth : undefined, relationshipKinds: Array.isArray(args.relationshipKinds) ? args.relationshipKinds as string[] : undefined, statuses: relationshipStatuses(args), layers: layers(args), limit: typeof args.limit === 'number' ? args.limit : undefined }) },
  { name: 'verify_transition', description: 'Verify an exact repository transition from immutable A to immutable B under the current analyzer. Composes graph delta, changed-file impact, optional caller-owned head expectations and preserved invariants, unexpected-change review surface, and coverage-qualified uncertainty without approving or mutating the repository.', inputSchema: objectSchema({ project: string, baseRef: string, ref: string, contract: transitionContractSchema, direction: { enum: ['inbound', 'outbound', 'both'] }, depth: integer, relationshipKinds: strings, status: relationshipStatusSchema, layers: layersSchema, limit: integer }, ['project', 'baseRef', 'ref']), handler: async args => await verifyTransition({ project: s(args, 'project'), baseRef: s(args, 'baseRef'), ref: s(args, 'ref'), ...(args.contract === undefined ? {} : { contract: args.contract }), ...(typeof args.direction === 'string' ? { direction: args.direction as 'inbound' | 'outbound' | 'both' } : {}), ...(typeof args.depth === 'number' ? { depth: args.depth } : {}), ...(Array.isArray(args.relationshipKinds) ? { relationshipKinds: args.relationshipKinds as string[] } : {}), ...(relationshipStatuses(args)?.length ? { statuses: relationshipStatuses(args)! } : {}), ...(layers(args)?.length ? { layers: layers(args)! } : {}), ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) }) },
  { name: 'query_parity', description: 'Inspect semantic entities and their observed human/agent/API/provider representations over the selected canonical graph. Pass queries for up to 20 independent terms over one loaded graph. Only resolved relations populate confirmed representation lists; candidates and unresolved relations remain explicit.', inputSchema: objectSchema(queryProperties, ['project']), handler: async args => await parityLens({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), query: optString(args, 'query'), queries: Array.isArray(args.queries) ? args.queries as string[] : undefined, kinds: Array.isArray(args.kinds) ? args.kinds as string[] : undefined, sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds as string[] : undefined, status: relationshipStatuses(args), limit: typeof args.limit === 'number' ? args.limit : undefined, offset: typeof args.offset === 'number' ? args.offset : undefined }) },
  { name: 'evaluate_parity', description: 'Evaluate a caller-owned ephemeral expectation contract (E) against canonical W or an explicit graph snapshot. Reports satisfied, missing, forbidden-present, and unproven obligations without modifying accepted graph truth.', inputSchema: objectSchema({ project: string, ref: string, graphId: string, contract: parityContractSchema }, ['project', 'contract']), handler: async args => await evaluateParityContract({ project: s(args, 'project'), ref: optString(args, 'ref'), graphId: optString(args, 'graphId'), contract: args.contract }) },
];

function annotationsFor(name: string): Record<string, boolean> {
  return { readOnlyHint: true, destructiveHint: false, openWorldHint: name !== 'list_projects' };
}

export function listTools() { return tools.map(({ handler: _handler, ...tool }) => ({ ...tool, annotations: tool.annotations ?? annotationsFor(tool.name) })); }
export function toolContract(): { toolCount: number; contractFingerprint: string } {
  const definitions = listTools();
  return { toolCount: definitions.length, contractFingerprint: stableHash(definitions) };
}
export async function callTool(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  validateAgainstSchema(tool.inputSchema, args);
  return await tool.handler(args);
}
