import { MultiGraph } from 'graphology';
import Sigma from 'sigma';

declare global {
  interface Window {
    __DEVINT_VIEWER__?: { project: string; ref?: string; graphId?: string; section?: string; local?: boolean };
  }
}

type Section = 'overview' | 'explore' | 'semantics' | 'parity' | 'query' | 'sources' | 'changes' | 'local';
type ExploreMode = 'summary' | 'list' | 'table' | 'graph' | 'raw';
type GraphLens = 'architecture' | 'parity' | 'code';
type ProjectionNode = { id: string; kind: string; layer?: string; name?: string; locator?: string; value?: unknown; evidenceIds?: string[] };
type ProjectionEdge = { id: string; from: string | null; to: string | null; kind: string; status: string; strategy?: string; confidence?: number | null; evidenceIds?: string[] };
type Projection = { project: string; graphId?: string; revision?: string; selected?: string; ambiguous?: boolean; candidates?: Array<{ id: string; kind: string; layer: string; name: string | null; locator: string }>; nodes: ProjectionNode[]; edges: ProjectionEdge[]; evidence?: unknown[]; coverage?: unknown; truncated?: boolean };

const config = window.__DEVINT_VIEWER__;
if (!config?.project) throw new Error('Development Intelligence Workbench is missing project context');
const viewerConfig = config;

const sectionHead = document.getElementById('section-head') as HTMLElement;
const content = document.getElementById('content') as HTMLElement;
const inspectorContext = document.getElementById('inspector-context') as HTMLElement;
const inspectorTabs = document.getElementById('inspector-tabs') as HTMLElement;
const inspectorBody = document.getElementById('inspector-body') as HTMLElement;
const projectSelect = document.getElementById('project-select') as HTMLSelectElement;
const revisionForm = document.getElementById('revision-form') as HTMLFormElement;
const revisionInput = document.getElementById('revision-input') as HTMLInputElement;
const globalForm = document.getElementById('global-query') as HTMLFormElement;
const globalInput = document.getElementById('global-query-input') as HTMLInputElement;
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-section]'));

let section: Section = (['overview', 'explore', 'semantics', 'parity', 'query', 'sources', 'changes', 'local'].includes(viewerConfig.section ?? '') ? viewerConfig.section : 'overview') as Section;
let sectionEpoch = 0;
let exploreMode: ExploreMode = 'graph';
let graphLens: GraphLens = 'architecture';
let exploreQuery = '';
let graphSelected = '';
let lastExplore: any = null;
let selectedInspection: any = null;
let inspectorTab = 'summary';
let renderer: Sigma | null = null;
let preferredQuerySource = '';
let queryDraft = '';
let graphRenderSequence = 0;
let semanticFlash = '';
let parityContractText = `{
  "version": 1,
  "name": "Feature parity",
  "relationships": [
    {
      "from": "capability:example",
      "kind": "exposed-on",
      "to": "surface:example",
      "requirement": "required",
      "rationale": "Replace these IDs with the expected project relationship."
    }
  ]
}`;

const sectionCopy: Record<Section, { title: string; description: string }> = {
  overview: { title: 'Overview', description: 'Readable project intelligence: current state, quick notes, important concepts, coverage and meaningful change.' },
  explore: { title: 'Explore', description: 'Navigate connected source knowledge. Search for a subject, select a node, and inspect its evidence.' },
  semantics: { title: 'Semantics', description: 'Review evidence-derived project meaning before it becomes durable authority. Amend, accept, reject, verify and lineage changes are explicit, separately recorded actions.' },
  parity: { title: 'Parity Contracts', description: 'Compare caller-owned expected entities and relationships with observed project reality. Expectations remain ephemeral and never become accepted truth.' },
  query: { title: 'Query', description: 'Ask Development Intelligence about the project or run a bounded read-only query against a configured technical source.' },
  sources: { title: 'Sources', description: 'See what DI can actually inspect: Git, runtime origins, databases/log adapters, freshness, coverage and query capabilities.' },
  changes: { title: 'Changes', description: 'Compare accepted-to-working semantics or any two immutable historical revision selectors under the same current analyzer.' },
  local: { title: 'Local setup', description: 'Choose storage and manage the graphs used by the Workbench, terminal and local agents.' },
};

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function withContext(params: URLSearchParams): URLSearchParams {
  params.set('project', viewerConfig.project);
  if (viewerConfig.graphId) params.set('graphId', viewerConfig.graphId);
  else if (viewerConfig.ref) params.set('ref', viewerConfig.ref);
  return params;
}

async function getJson(path: string, params: URLSearchParams): Promise<any> {
  const response = await fetch(`${path}?${withContext(params).toString()}`, { headers: { accept: 'application/json' } });
  if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`); throw new Error('Authentication required'); }
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

async function postJson(path: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ project: viewerConfig.project, ...(viewerConfig.ref ? { ref: viewerConfig.ref } : {}), ...(viewerConfig.graphId ? { graphId: viewerConfig.graphId } : {}), ...body }) });
  if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`); throw new Error('Authentication required'); }
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

function setHead(actions = ''): void {
  const copy = sectionCopy[section];
  sectionHead.innerHTML = `<div><div class="section-title">${copy.title}</div><div class="section-description">${copy.description}</div></div><div class="section-actions">${actions}</div>`;
}

function metric(label: string, value: unknown): string {
  return `<div class="metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
}

function empty(title: string, message: string): string {
  return `<div class="empty"><div><strong>${esc(title)}</strong>${esc(message)}</div></div>`;
}

function nodeRow(node: any): string {
  return `<button class="row row-button" data-node="${esc(node.id)}"><span class="badge">${esc(node.kind)}</span><span class="row-main"><strong>${esc(node.name ?? node.id)}</strong><small>${esc(node.locator ?? node.layer ?? '')}</small></span><span>→</span></button>`;
}

function wireNodeButtons(root: ParentNode = content): void {
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-node]'))) {
    button.addEventListener('click', () => void openInspector(button.dataset.node!));
  }
}

function assessmentStatusClass(status: string): string {
  if (status === 'supported') return 'status-good';
  if (status === 'contradicted') return 'status-bad';
  return 'status-warn';
}

function renderAssessment(data: any, compact = false): string {
  if (!data?.claims || !Array.isArray(data.claims)) return '';
  const claims = data.claims as any[];
  const findings = Array.isArray(data.findings) ? data.findings as any[] : [];
  const hypotheses = Array.isArray(data.hypotheses?.items) ? data.hypotheses.items as any[] : [];
  const findingGroups = Array.isArray(data.findingSummary?.groups) ? data.findingSummary.groups as any[] : [];
  const facets = Object.entries(data.realization?.facets ?? {}) as Array<[string, any]>;
  const requiredFacets = new Set<string>(data.realization?.requiredFacets ?? []);
  const coverage = data.coverage;
  const coverageLabel = coverage?.completeForTrackedSources === true ? 'exhaustive tracked-source coverage' : coverage?.completeForEligibleSources === true ? 'eligible sources complete · tracked coverage not exhaustive' : coverage ? 'incomplete eligible-source coverage' : 'coverage unavailable';
  const facetRows = facets.map(([name, facet]) => {
    const required = requiredFacets.has(name);
    const statusClass = facet.observed ? 'status-good' : required ? 'status-warn' : '';
    const label = facet.observed ? 'proven' : required ? 'required · proof incomplete' : 'not proven';
    return `<div class="assessment-facet"><span class="badge ${statusClass}">${esc(label)}</span><strong>${esc(name)}</strong>${compact ? '' : `<small>${esc((facet.nodeIds ?? []).length)} supporting node(s)</small>`}</div>`;
  }).join('');
  const reachDimensions = (Object.entries(data.reach?.dimensions ?? {}) as Array<[string, any]>).filter(([, dimension]) => dimension?.observed);
  const reachRows = reachDimensions.map(([name, dimension]) => {
    const shortest = Array.isArray(dimension.paths) ? dimension.paths[0] : null;
    const pathLabel = shortest?.relationshipKinds?.length ? shortest.relationshipKinds.join(' → ') : 'resolved graph path';
    return `<div class="assessment-facet"><span class="badge status-good">resolved</span><strong>${esc(name)}</strong><small>${esc(dimension.count ?? dimension.targetIds?.length ?? 0)} reachable target(s)${compact ? '' : ` · shortest: ${esc(pathLabel)}`}</small></div>`;
  }).join('');
  const reachMechanisms = (Object.entries(data.reach?.mechanisms ?? {}) as Array<[string, unknown]>)
    .filter(([, count]) => Number(count) > 0)
    .map(([name, count]) => `<span class="badge">${esc(name)} · ${esc(Number(count))}</span>`)
    .join(' ');
  const reachExcluded = data.reach?.excludedRelationships;
  const reachSection = reachDimensions.length
    ? `<div class="assessment-section"><h3>Typed reach</h3><p class="muted">Resolved paths only · reach describes connection, not impact severity.</p><div class="assessment-facets">${reachRows}</div>${!compact && reachMechanisms ? `<p class="muted" style="margin-top:8px">Connection mechanisms</p><div>${reachMechanisms}</div>` : ''}${!compact && reachExcluded ? `<p class="muted" style="margin-top:8px">${esc(reachExcluded.candidate ?? 0)} candidate and ${esc(reachExcluded.unresolved ?? 0)} unresolved relationship(s) excluded from reach paths.</p>` : ''}</div>`
    : '';
  const claimRows = claims.map(item => {
    const proof = item.proof ?? {};
    const proofSummary = `${(proof.nodeIds ?? []).length} nodes · ${(proof.edgeIds ?? []).length} admissible relationships · ${(proof.evidenceIds ?? []).length} evidence records`;
    const scope = proof.coverage?.claimScope;
    const scopeLabel = scope ? `${scope.scope} scope · ${scope.completeForClaimScope ? 'coverage complete' : 'coverage incomplete'}${scope.supportsNegative ? ' · absence may support a bounded negative' : ''}` : 'claim coverage unavailable';
    const rejected = proof.admissibility?.rejectedEdgeIds?.length ? ` · ${proof.admissibility.rejectedEdgeIds.length} relationship(s) excluded for this proof purpose` : '';
    const evidence = (proof.evidence ?? []).map((record: any) => `<li>${esc(record.locator ?? record.id)}</li>`).join('');
    return `<div class="assessment-item"><div><span class="badge ${assessmentStatusClass(item.status)}">${esc(item.status)}</span> <span class="muted">${esc(proof.ruleId ?? item.type)}</span></div><strong>${esc(item.statement)}</strong><small>${esc(proofSummary + rejected)}</small><small>${esc(scopeLabel)}</small>${!compact && evidence ? `<details><summary class="muted">Evidence locations</summary><ul>${evidence}</ul></details>` : ''}</div>`;
  }).join('');
  const hypothesisRows = hypotheses.map(item => `<div class="assessment-item"><div><span class="badge status-warn">suggested · proof incomplete</span> <span class="muted">${esc(item.kind)}</span></div><strong>${esc((item.from ?? 'unknown') + ' → ' + (item.to ?? 'unresolved'))}</strong><small>Candidate relationship ${esc(item.edgeId)} · does not satisfy proof</small></div>`).join('');
  const findingRows = findings.map(item => `<div class="assessment-item"><div><span class="badge status-warn">${esc(item.category)}</span> <span class="muted">${esc(item.ruleId)}</span></div><strong>${esc(item.summary)}</strong><small>${esc((item.affectedIds ?? []).length)} affected graph record(s)</small></div>`).join('');
  const findingGroupRows = findingGroups.map(item => `<div class="assessment-item"><div><span class="badge status-warn">${esc(item.count)} finding${item.count === 1 ? '' : 's'}</span> <span class="muted">${esc(item.relationshipKind ?? item.ruleId)}</span></div><strong>${esc(item.ruleId)}</strong><small>${esc((item.affectedIds ?? []).length)} distinct affected graph record(s)</small></div>`).join('');
  const findingScope = data.findingSummary?.scope;
  const findingScopeLabel = findingScope ? `Resolved radius ${findingScope.resolvedDepth} from ${findingScope.rootId} · ${findingScope.nodeCount} nodes in scope` : 'Repository-wide or coverage-only scope';
  return `<div class="assessment"><div class="assessment-head"><div><h3>Evidence-backed assessment</h3><h2 class="${assessmentStatusClass(data.answerStatus)}">${esc(data.answerStatus)}</h2></div><div class="assessment-meta">Revision ${esc(data.revision ?? 'unknown')}<br>${esc(coverageLabel)}</div></div>${facets.length ? `<div class="assessment-section"><h3>Capability realization</h3><div class="assessment-facets">${facetRows}</div></div>` : ''}${reachSection}<div class="assessment-section"><h3>Claims and proof</h3><div class="list">${claimRows}</div></div>${hypotheses.length ? `<div class="assessment-section"><h3>Suggested relationships</h3><p class="muted">Candidates are hypotheses for follow-up inspection, not findings and not proof.</p><div class="list">${hypothesisRows}</div></div>` : ''}${findings.length ? `<div class="assessment-section"><h3>Finding groups</h3><p class="muted">${esc(findingScopeLabel)}</p><div class="list">${findingGroupRows}</div>${compact ? '' : `<details><summary class="muted">${esc(findings.length)} underlying findings</summary><div class="list" style="margin-top:8px">${findingRows}</div></details>`}</div>` : ''}${compact ? '' : `<details><summary class="muted">Raw assessment record</summary><pre class="raw">${esc(JSON.stringify(data, null, 2))}</pre></details>`}</div>`;
}

function setInspectorTabs(): void {
  const tabs = ['summary', 'connections', 'code', 'evidence', 'changes'];
  inspectorTabs.innerHTML = tabs.map(tab => `<button data-inspector-tab="${tab}" class="${inspectorTab === tab ? 'active' : ''}">${tab[0]!.toUpperCase()}${tab.slice(1)}</button>`).join('');
  for (const button of Array.from(inspectorTabs.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]'))) {
    button.addEventListener('click', () => { inspectorTab = button.dataset.inspectorTab!; setInspectorTabs(); renderInspector(); });
  }
}

function renderInspector(): void {
  if (!selectedInspection || selectedInspection.ambiguous) {
    inspectorContext.textContent = selectedInspection?.ambiguous ? 'Choose a result' : '';
    if (selectedInspection?.ambiguous) {
      inspectorTabs.innerHTML = '';
      inspectorBody.innerHTML = `<div class="list">${(selectedInspection.candidates ?? []).map((item: any) => nodeRow(item)).join('')}</div>`;
      wireNodeButtons(inspectorBody);
    }
    return;
  }
  const data = selectedInspection;
  const entity = data.entity;
  inspectorContext.textContent = entity.kind ?? '';
  setInspectorTabs();
  if (inspectorTab === 'summary') {
    inspectorBody.innerHTML = `<div class="inspector-title">${esc(entity.name ?? entity.id)}</div><div class="inspector-sub">${esc(entity.id)}<br>${esc(entity.locator ?? '')}</div><div style="margin:10px 0"><span class="badge">${esc(entity.kind)}</span> <span class="badge">${esc(entity.layer ?? 'structural')}</span></div>${(data.quickNotes ?? []).map((note: string) => `<div class="quick-note">${esc(note)}</div>`).join('')}${renderAssessment(data.assessment, true)}<details style="margin-top:12px"><summary class="muted">Technical record</summary><pre class="raw">${esc(JSON.stringify(entity, null, 2))}</pre></details>`;
    return;
  }
  if (inspectorTab === 'connections') {
    inspectorBody.innerHTML = (data.connections ?? []).length ? `<div class="list">${data.connections.map((item: any) => `<button class="row row-button" ${item.neighbor ? `data-node="${esc(item.neighbor.id)}"` : 'disabled'}><span class="badge ${item.status === 'resolved' ? 'status-good' : item.status === 'candidate' ? 'status-warn' : 'status-bad'}">${esc(item.status)}</span><span class="row-main"><strong>${esc(item.direction === 'outbound' ? '→' : '←')} ${esc(item.neighbor?.name ?? 'unresolved')}</strong><small>${esc(item.kind)} · ${esc(item.neighbor?.kind ?? '')}</small></span></button>`).join('')}</div>` : empty('No visible connections', 'This entity has no relationships in the selected graph context.');
    wireNodeButtons(inspectorBody);
    return;
  }
  if (inspectorTab === 'code') {
    const code = data.code;
    if (!code?.lines?.length) { inspectorBody.innerHTML = empty('No single code location', 'This entity does not map cleanly to one exact source snippet. Use Explore or Query to find related implementation.'); return; }
    inspectorBody.innerHTML = `<div class="quick-note">${esc(code.file)} · revision ${esc(code.revision)}</div><div class="raw">${code.lines.map((line: any) => `<div class="code-line">${esc(String(line.line).padStart(4, ' '))}  ${esc(line.text)}</div>`).join('')}</div>`;
    return;
  }
  if (inspectorTab === 'evidence') {
    inspectorBody.innerHTML = (data.evidence ?? []).length ? data.evidence.map((item: any) => `<div class="evidence-item"><strong>${esc(item.message ?? item.kind ?? 'evidence')}</strong><br><span class="muted">${esc(item.locator ?? item.sourceId ?? '')}</span></div>`).join('') : empty('No attached evidence', 'No first-class evidence records are attached to this entity or its visible relationships.');
    return;
  }
  const change = data.change;
  inspectorBody.innerHTML = change ? `<div class="card"><h3>Accepted → working</h3><h2 class="${change.state === 'unchanged' ? 'status-good' : 'status-warn'}">${esc(change.state)}</h2><p>${change.state === 'unchanged' ? 'No semantic topology change is currently recorded for this entity.' : 'This entity participates in the current accepted-to-working semantic delta.'}</p></div>${change.record ? `<pre class="raw">${esc(JSON.stringify(change.record, null, 2))}</pre>` : ''}` : empty('Change unavailable', 'Change inspection is unavailable for this snapshot context.');
}

async function openInspector(node: string): Promise<void> {
  inspectorContext.textContent = 'Loading…';
  inspectorBody.innerHTML = empty('Inspecting', 'Loading quick notes, connections, code, evidence and change context…');
  selectedInspection = await getJson('/workbench/data', new URLSearchParams({ action: 'inspect', node }));
  inspectorTab = 'summary';
  renderInspector();
}

function sectionIsCurrent(epoch: number, expected: Section): boolean {
  return sectionEpoch === epoch && section === expected;
}

async function renderOverview(epoch: number): Promise<void> {
  setHead();
  content.innerHTML = empty('Building overview', 'Synthesizing current project state from graph, coverage, checkpoint and sources…');
  const data = await getJson('/workbench/data', new URLSearchParams({ action: 'overview' }));
  if (!sectionIsCurrent(epoch, 'overview')) return;
  const counts = data.counts ?? {};
  const currentness = data.currentness ?? {};
  const overviewFindings = (data.findings ?? []).slice(0, 8);
  content.innerHTML = `<div class="hero-grid"><div class="card"><h3>Quick documentation</h3><h2>${esc(viewerConfig.project)}</h2><p>${esc(data.summary)}</p>${(data.quickNotes ?? []).map((note: string) => `<div class="note"><span class="note-dot"></span><span>${esc(note)}</span></div>`).join('')}</div><div class="card"><h3>Current state</h3><div class="metric-grid">${metric('semantic concepts', counts.semantic ?? 0)}${metric('code entities', counts.structural ?? 0)}${metric('representations', counts.representation ?? 0)}${metric('evidence records', counts.evidence ?? 0)}${metric('candidate relations', counts.relationships?.candidate ?? 0)}${metric('conflicts', counts.conflicts ?? 0)}</div><p class="muted">Accepted semantic current: ${currentness.acceptedSemanticCurrent === true ? 'yes' : currentness.acceptedSemanticCurrent === false ? 'no' : 'unknown'}</p></div></div>${overviewFindings.length ? `<div class="card" style="margin-top:14px"><h3>Evidence findings</h3><div class="list">${overviewFindings.map((item: any) => `<div class="assessment-item"><div><span class="badge status-warn">${esc(item.category)}</span> <span class="muted">${esc(item.ruleId)}</span></div><strong>${esc(item.summary)}</strong><small>${esc((item.affectedIds ?? []).length)} affected graph record(s)</small></div>`).join('')}</div></div>` : ''}<div class="hero-grid" style="margin-top:14px"><div class="card"><h3>Important concepts</h3><div class="list">${(data.highlights ?? []).slice(0, 12).map((item: any) => nodeRow(item)).join('') || '<p>No explicit semantic concepts were discovered. Structural intelligence is still available in Explore.</p>'}</div></div><div class="card"><h3>Repository areas</h3><div class="list">${(data.areas ?? []).map((area: any) => `<div class="row"><span class="row-main"><strong>${esc(area.name)}</strong><small>${esc(area.count)} mapped entities</small></span></div>`).join('')}</div></div></div><div class="card" style="margin-top:14px"><h3>Sources at a glance</h3><div class="grid">${(data.sources ?? []).map((source: any) => `<div class="source-card card"><span class="badge">${esc(source.type)}</span><h2 style="font-size:15px;margin-top:9px">${esc(source.label)}</h2><p>${esc((source.capabilities ?? []).join(' · '))}</p><div class="source-status status-good">${source.configured ? 'configured' : 'not configured'} · ${esc(source.access ?? 'read-only')}</div></div>`).join('')}</div></div>`;
  wireNodeButtons();
}

function exploreActions(): string {
  return `<div class="segmented" id="explore-modes">${(['summary', 'list', 'table', 'graph', 'raw'] as ExploreMode[]).map(mode => `<button data-mode="${mode}" class="${exploreMode === mode ? 'active' : ''}">${mode[0]!.toUpperCase()}${mode.slice(1)}</button>`).join('')}</div>`;
}

async function loadExplore(epoch: number, query = exploreQuery): Promise<void> {
  exploreQuery = query;
  setHead(exploreActions());
  for (const button of Array.from(sectionHead.querySelectorAll<HTMLButtonElement>('[data-mode]'))) button.addEventListener('click', () => { exploreMode = button.dataset.mode as ExploreMode; void renderExploreResult(epoch); });
  content.innerHTML = `<form id="explore-search" class="query-box" style="grid-template-columns:minmax(0,1fr) auto"><textarea id="explore-input" placeholder="Search a feature, tool, route, file, function, provider…">${esc(exploreQuery)}</textarea><button class="primary" type="submit">Search</button></form><div id="explore-result">${empty('Loading intelligence', 'Searching the selected graph context…')}</div>`;
  const form = document.getElementById('explore-search') as HTMLFormElement;
  form.addEventListener('submit', event => { event.preventDefault(); exploreQuery = (document.getElementById('explore-input') as HTMLTextAreaElement).value.trim(); graphSelected = ''; void fetchExplore(epoch); });
  await fetchExplore(epoch);
}

async function fetchExplore(epoch: number): Promise<void> {
  const result = await getJson('/workbench/data', new URLSearchParams({ action: 'explore', ...(exploreQuery ? { query: exploreQuery } : {}) }));
  if (!sectionIsCurrent(epoch, 'explore')) return;
  lastExplore = result;
  await renderExploreResult(epoch);
}

async function renderExploreResult(epoch: number): Promise<void> {
  if (!sectionIsCurrent(epoch, 'explore')) return;
  const root = document.getElementById('explore-result') as HTMLElement;
  for (const button of Array.from(sectionHead.querySelectorAll<HTMLButtonElement>('[data-mode]'))) button.classList.toggle('active', button.dataset.mode === exploreMode);
  if (!lastExplore) return;
  const nodes = lastExplore.nodes ?? [];
  if (exploreMode === 'summary') {
    root.innerHTML = `<div class="card"><h3>Search summary</h3><h2>${esc(lastExplore.summary)}</h2><p>${(lastExplore.topKinds ?? []).map((item: any) => `${esc(item.kind)} (${esc(item.count)})`).join(' · ') || 'No entity kinds to summarize.'}</p></div><div class="card" style="margin-top:12px"><h3>Top results</h3><div class="list">${nodes.slice(0, 30).map(nodeRow).join('') || empty('No results', 'Try a broader term or use Query for a question-shaped request.')}</div></div>`;
    wireNodeButtons(root); return;
  }
  if (exploreMode === 'list') { root.innerHTML = `<div class="list">${nodes.map(nodeRow).join('') || empty('No results', 'Nothing matched this search.')}</div>`; wireNodeButtons(root); return; }
  if (exploreMode === 'table') {
    root.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Kind</th><th>Layer</th><th>Source</th></tr></thead><tbody>${nodes.map((node: any) => `<tr class="row-button" data-node="${esc(node.id)}"><td>${esc(node.name ?? node.id)}</td><td>${esc(node.kind)}</td><td>${esc(node.layer ?? 'structural')}</td><td>${esc(node.locator ?? '')}</td></tr>`).join('')}</tbody></table></div>`; wireNodeButtons(root); return;
  }
  if (exploreMode === 'raw') { root.innerHTML = `<pre class="raw">${esc(JSON.stringify(lastExplore, null, 2))}</pre>`; return; }
  await renderGraph(root, epoch);
}

function hash(value: string): number { let output = 2166136261; for (let i = 0; i < value.length; i += 1) output = Math.imul(output ^ value.charCodeAt(i), 16777619); return output >>> 0; }
function graphColor(node: ProjectionNode): string { return node.layer === 'semantic' ? '#67d3f5' : node.layer === 'representation' ? '#ffc857' : '#aa91ff'; }
function graphPoint(node: ProjectionNode, index: number, total: number): { x: number; y: number } {
  const h = hash(`${node.kind}:${node.id}`);
  if (graphLens === 'architecture') {
    const xByKind: Record<string, number> = { route: -1.25, api: -1.05, feature: -0.15, capability: -0.15, mcp: 0.65, tool: 0.7, provider: 1.25, surface: -0.65 };
    const x = xByKind[node.kind] ?? (node.layer === 'semantic' ? 0 : node.layer === 'representation' ? 1.4 : -1.4);
    return { x: x + (((h >>> 8) % 100) / 100 - 0.5) * .18, y: (((h % 1000) / 1000) - .5) * 2 };
  }
  const angle = ((h % 100000) / 100000) * Math.PI * 2 + index / Math.max(total, 1);
  const radius = graphLens === 'parity' ? (node.layer === 'semantic' ? .7 : node.layer === 'representation' ? 1.15 : 1.45) : (node.kind === 'file' ? 1.25 : .9);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

async function renderGraph(root: HTMLElement, epoch: number): Promise<void> {
  const sequence = ++graphRenderSequence;
  renderer?.kill(); renderer = null;
  root.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px"><div class="segmented">${(['architecture', 'parity', 'code'] as GraphLens[]).map(lens => `<button data-lens="${lens}" class="${graphLens === lens ? 'active' : ''}">${lens}</button>`).join('')}</div><button id="graph-reset" type="button">Reset view</button><span class="muted">Drag to pan · scroll to zoom · select a node to inspect</span></div><div class="graph-shell"><div id="graph" class="graph" role="img" aria-label="Development Intelligence graph"></div><div id="graph-status" class="graph-status">Loading graph…</div></div><div id="graph-choices"></div>`;
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-lens]'))) button.addEventListener('click', () => { graphLens = button.dataset.lens as GraphLens; void renderGraph(root, epoch); });
  const projection = await getJson('/graph/data', new URLSearchParams({ view: graphLens, ...(graphSelected ? { node: graphSelected } : exploreQuery ? { query: exploreQuery } : {}), limit: '700', depth: '2' })) as Projection;
  if (!sectionIsCurrent(epoch, 'explore') || sequence !== graphRenderSequence || exploreMode !== 'graph') return;
  const container = document.getElementById('graph') as HTMLElement;
  const graphStatus = document.getElementById('graph-status') as HTMLElement;
  if (projection.ambiguous) {
    container.innerHTML = empty('Choose a subject', 'Several graph subjects match. Select one below to see its neighborhood.');
    graphStatus.textContent = `${projection.candidates?.length ?? 0} candidates`;
    const choices = document.getElementById('graph-choices')!;
    choices.innerHTML = `<div class="card"><h3>Matching subjects</h3><div class="list">${(projection.candidates ?? []).map(node => `<button class="row row-button" data-graph-choice="${esc(node.id)}"><span class="badge">${esc(node.kind)}</span><span class="row-main"><strong>${esc(node.name ?? node.id)}</strong><small>${esc(node.locator)}</small></span><span>→</span></button>`).join('')}</div></div>`;
    for (const button of Array.from(choices.querySelectorAll<HTMLButtonElement>('[data-graph-choice]'))) button.addEventListener('click', () => { graphSelected = button.dataset.graphChoice!; void renderGraph(root, epoch); });
    return;
  }
  if (!projection.nodes.length) { container.innerHTML = empty('No graph subjects found', 'Try another search or choose a different view.'); graphStatus.textContent = '0 nodes'; return; }
  const graph = new MultiGraph({ allowSelfLoops: false });
  projection.nodes.forEach((node, index) => { const point = graphPoint(node, index, projection.nodes.length); graph.addNode(node.id, { label: node.name ?? node.id, x: point.x, y: point.y, size: node.layer === 'semantic' ? 8 : node.kind === 'file' ? 6 : 4, color: graphColor(node), node }); });
  for (const edge of projection.edges) {
    if (!edge.from || !edge.to || !graph.hasNode(edge.from) || !graph.hasNode(edge.to) || edge.from === edge.to) continue;
    try { graph.addEdgeWithKey(edge.id, edge.from, edge.to, { size: edge.status === 'resolved' ? 1.2 : .75, color: edge.status === 'resolved' ? '#53667e' : edge.status === 'candidate' ? '#b9823c' : '#b94f56', edge }); } catch { /* graph truth stays inspectable in list/raw modes */ }
  }
  renderer = new Sigma(graph, container, { renderEdgeLabels: projection.nodes.length < 120, labelColor: { color: '#dcecff' }, edgeLabelColor: { color: '#aabed3' }, labelDensity: .35, labelGridCellSize: 85, labelRenderedSizeThreshold: 5, zIndex: true });
  renderer.on('clickNode', event => void openInspector(event.node));
  root.querySelector<HTMLButtonElement>('#graph-reset')?.addEventListener('click', () => void renderer?.getCamera().animatedReset());
  graphStatus.textContent = `${projection.nodes.length} nodes · ${graph.size} drawn relationships${projection.edges.length !== graph.size ? ` · ${projection.edges.length - graph.size} not drawable` : ''}${projection.truncated ? ' · bounded' : ''}`;
}

async function renderQuery(epoch: number, prefill = ''): Promise<void> {
  setHead();
  content.innerHTML = empty('Loading sources', 'Preparing Development Intelligence and configured read-only technical sources…');
  const sourceData = await getJson('/workbench/data', new URLSearchParams({ action: 'sources' }));
  if (!sectionIsCurrent(epoch, 'query')) return;
  const queryable = (sourceData.sources ?? []).filter((source: any) => source.type === 'read-only-http');
  if (prefill) queryDraft = prefill;
  prefill = queryDraft;
  content.innerHTML = `<div class="card"><h3>Ask / query</h3><div class="query-box"><textarea id="query-text" placeholder="Try: How is assessment intelligence realized? What changed? What depends on query_parity? Show code for ownerPasswordMatches.">${esc(prefill)}</textarea><select id="query-source"><option value="">Development Intelligence</option>${queryable.map((source: any) => `<option value="${esc(source.id)}"${preferredQuerySource === source.id ? ' selected' : ''}>${esc(source.label)} · ${esc((source.capabilities ?? []).join('/'))}</option>`).join('')}</select><button class="primary" id="run-query">Run</button></div><details><summary>Refine graph selection</summary><div class="query-box"><input id="query-scope" aria-label="Scope" placeholder="File, directory or graph ID"><input id="query-node-kinds" aria-label="Node kinds" placeholder="Node kinds, comma-separated"><input id="query-edge-kinds" aria-label="Relationship kinds" placeholder="Relationship kinds, comma-separated"><select id="query-direction" aria-label="Relationship direction"><option value="">From the question</option><option value="both">Both directions</option><option value="outbound">Outbound</option><option value="inbound">Inbound</option></select><input id="query-comparison-ids" aria-label="Comparison IDs" placeholder="Comparison graph IDs, comma-separated"><input id="query-comparison-scope" aria-label="Comparison scope" placeholder="Comparison file or directory"><input id="query-comparison-kinds" aria-label="Comparison node kinds" placeholder="Comparison node kinds, comma-separated"><input id="query-condition" aria-label="Condition contains" placeholder="Condition contains"><select id="query-condition-truth" aria-label="Condition truth"><option value="">Either condition value</option><option value="true">Condition true</option><option value="false">Condition false</option></select><input id="query-effect-kinds" aria-label="Effect kinds" placeholder="Effect kinds, comma-separated"><input id="query-depth" aria-label="Relationship depth" type="number" min="1" value="1"></div></details><p class="muted">Questions and filters navigate the same source graph.</p></div><div id="query-result" class="query-result"></div>`;
  (document.getElementById('query-text') as HTMLTextAreaElement).addEventListener('input', event => { queryDraft = (event.target as HTMLTextAreaElement).value; });
  const run = async (offset = 0) => {
    const text = (document.getElementById('query-text') as HTMLTextAreaElement).value.trim();
    const sourceId = (document.getElementById('query-source') as HTMLSelectElement).value;
    preferredQuerySource = sourceId;
    if (!text) return;
    const target = document.getElementById('query-result') as HTMLElement;
    target.innerHTML = empty('Running query', 'Gathering bounded evidence…');
    try {
      const scope = (document.getElementById('query-scope') as HTMLInputElement).value.trim();
      const splitKinds = (id: string) => (document.getElementById(id) as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean);
      const nodeKinds = splitKinds('query-node-kinds');
      const relationshipKinds = splitKinds('query-edge-kinds');
      const direction = (document.getElementById('query-direction') as HTMLSelectElement).value;
      const comparisonIds = splitKinds('query-comparison-ids');
      const comparisonScope = (document.getElementById('query-comparison-scope') as HTMLInputElement).value.trim();
      const comparisonKinds = splitKinds('query-comparison-kinds');
      const conditionContains = (document.getElementById('query-condition') as HTMLInputElement).value.trim();
      const conditionValue = (document.getElementById('query-condition-truth') as HTMLSelectElement).value;
      const effectKinds = splitKinds('query-effect-kinds');
      const depth = Number((document.getElementById('query-depth') as HTMLInputElement).value) || 1;
      const result = await postJson('/workbench/query', { text, offset, depth, ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}), ...(nodeKinds.length ? { nodeKinds } : {}),
        ...(relationshipKinds.length ? { relationshipKinds } : {}), ...(comparisonIds.length ? { comparisonIds } : {}), ...(comparisonScope ? { comparisonScope } : {}), ...(comparisonKinds.length ? { comparisonKinds } : {}), ...(conditionContains ? { conditionContains } : {}), ...(conditionValue ? { conditionTruth: conditionValue === 'true' } : {}), ...(effectKinds.length ? { effectKinds } : {}), ...(sourceId ? { sourceId } : {}) });
      if (!sectionIsCurrent(epoch, 'query')) return;
      const page = result.result?.page;
      target.innerHTML = `<div class="card"><h3>${esc(result.intent ?? 'query')}</h3><div class="answer">${esc(result.answer ?? '')}</div>${renderQueryResult(result.result)}${page ? `<div class="actions">${page.offset > 0 ? '<button id="query-previous" type="button">Previous</button>' : ''}${page.nextOffset !== null ? '<button id="query-next" type="button">Next</button>' : ''}</div>` : ''}</div>`;
      const visibleAnswer = (target.firstElementChild as HTMLElement).innerText;
      const copyActions = document.createElement('div');
      copyActions.className = 'actions';
      copyActions.innerHTML = `<button type="button" id="copy-query-answer">Copy question and visible answer</button><span id="copy-query-status" role="status">${page && (page.offset > 0 || page.nextOffset != null) ? 'Copies this page only.' : ''}</span>`;
      target.firstElementChild?.append(copyActions);
      target.querySelector<HTMLButtonElement>('#copy-query-answer')?.addEventListener('click', async () => {
        const copyText = `Question: ${text}\n\n${visibleAnswer}${page && (page.offset > 0 || page.nextOffset != null) ? '\n\nThis is one page of a paginated result.' : ''}`;
        const status = target.querySelector<HTMLElement>('#copy-query-status');
        let selection = copyActions.querySelector<HTMLTextAreaElement>('[aria-label="Copyable answer"]');
        if (!selection) {
          selection = document.createElement('textarea');
          selection.setAttribute('aria-label', 'Copyable answer');
          selection.readOnly = true;
          copyActions.append(selection);
        }
        selection.value = copyText;
        try {
          await navigator.clipboard.writeText(copyText);
          if (status) status.textContent = 'Copied in this browser. If paste does not work, select and copy the text below.';
        } catch {
          selection.select();
          if (status) status.textContent = 'Select and copy the text below.';
        }
      });
      wireNodeButtons(target);
      target.querySelector<HTMLButtonElement>('#query-previous')?.addEventListener('click', () => void run(Math.max(0, page.offset - page.limit)));
      target.querySelector<HTMLButtonElement>('#query-next')?.addEventListener('click', () => void run(page.nextOffset));
      if (result.intent === 'inspect' && result.result?.entity) { selectedInspection = result.result; inspectorTab = 'summary'; renderInspector(); }
    } catch (error) { target.innerHTML = `<div class="card"><h3>Query failed</h3><p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p></div>`; }
  };
  (document.getElementById('run-query') as HTMLButtonElement).addEventListener('click', () => void run());
}


function semanticStateClass(review: any): string {
  if (review?.accepted) return 'status-good';
  if (review?.state === 'rejected') return 'status-bad';
  if (review?.reviewed) return 'status-warn';
  return '';
}

function semanticStateLabel(review: any): string {
  if (!review) return 'proposed';
  if (review.accepted && review.verification) return 'accepted · verified';
  if (review.accepted) return 'accepted';
  if (review.verification) return 'verified · not accepted';
  return review.state ?? (review.reviewed ? 'reviewed' : 'proposed');
}

function semanticProposal(candidate: any): any {
  return candidate.review?.proposal ?? candidate.proposal ?? {};
}

function proposalName(candidate: any): string {
  return semanticProposal(candidate).name ?? candidate.id;
}

function semanticCandidateCard(candidate: any, index: number, writable: boolean, allCandidates: any[]): string {
  const proposal = semanticProposal(candidate);
  const review = candidate.review;
  const prefix = `semantic-${index}`;
  const evidenceIds = candidate.provenance?.evidenceIds ?? [];
  const evidenceFamilies = candidate.provenance?.evidenceFamilies ?? [];
  const alternatives = Array.isArray(proposal.alternatives) ? proposal.alternatives.join('\n') : '';
  const grouping = Array.isArray(proposal.grouping) ? proposal.grouping.join('\n') : '';
  const continuity = candidate.continuity ?? { state: 'new', sourceMeaningIds: [] };
  const sourceMeaningIds = Array.isArray(continuity.sourceMeaningIds) ? continuity.sourceMeaningIds : [];
  const sourceMeaningSet = new Set(sourceMeaningIds);
  const lineagePeerCandidateIds = continuity.state === 'ambiguous'
    ? allCandidates
        .filter(item => item?.continuity?.state === 'ambiguous'
          && (item.continuity.sourceMeaningIds ?? []).some((meaningId: string) => sourceMeaningSet.has(meaningId)))
        .map(item => item.id)
        .filter(Boolean)
        .sort()
    : [];
  const candidateWritable = writable && continuity.state !== 'ambiguous';
  const aiWritable = candidateWritable && !review;
  const lineageWritable = writable && continuity.state === 'ambiguous';
  const disabled = candidateWritable ? '' : ' disabled';
  const lineageDisabled = lineageWritable ? '' : ' disabled';
  const actor = review?.acceptance?.actor ?? review?.verification?.actor;
  const authorityLine = actor ? `${actor.kind ?? 'reviewer'} · ${actor.id ?? 'unknown'}` : 'No accepted authority recorded';
  const reviewAssessment = candidate.reviewAssessment ?? null;
  const assessmentClass = reviewAssessment?.factuality === 'supported' ? 'status-good' : 'status-warn';
  return `<article class="card semantic-card" data-semantic-candidate="${esc(candidate.id)}">
    <div class="semantic-card-head">
      <div>
        <div><span class="badge">${esc(proposal.kind ?? candidate.proposal?.kind ?? 'candidate')}</span> <span class="badge ${semanticStateClass(review)}">${esc(semanticStateLabel(review))}</span>${reviewAssessment ? ` <span class="badge ${assessmentClass}">${esc(reviewAssessment.classification ?? 'candidate')}</span>` : ''}</div>
        <h2>${esc(proposal.name ?? candidate.proposal?.name ?? candidate.id)}</h2>
        <p>${esc(proposal.description ?? candidate.proposal?.description ?? '')}</p>
      </div>
      <div class="semantic-meta"><strong>${esc(candidate.scope)}</strong><span>${esc(candidate.provenance?.origin ?? 'intrinsic-derivation')}</span><span>identity · ${esc(continuity.state)}${continuity.meaningId ? ` · ${esc(continuity.meaningId)}` : ''}</span></div>
    </div>
    <div class="semantic-proof">
      <span>${esc(evidenceFamilies.length)} evidence families</span>
      <span>${esc(candidate.provenance?.nodeIds?.length ?? 0)} nodes</span>
      <span>${esc(candidate.provenance?.edgeIds?.length ?? 0)} relationships</span>
      <span>${esc(evidenceIds.length)} evidence records</span>
    </div>
    ${reviewAssessment?.explanation ? `<p><strong>What this means:</strong> ${esc(reviewAssessment.explanation)}</p>` : ''}
    <p class="muted">Revision ${esc(candidate.provenance?.revision ?? 'unknown')} · ${esc(authorityLine)}. Acceptance and verification are independent.</p>
    ${continuity.state === 'ambiguous' ? `<p class="status-warn">Identity continuity is ambiguous. Review is read-only until explicit split/merge/replacement lineage resolves it.</p>` : continuity.state === 'inherited' ? `<p class="status-good">Stable semantic identity inherited from ${esc(continuity.sourceRevision ?? 'an earlier accepted revision')}.</p>` : ''}
    ${continuity.state === 'ambiguous' ? `<details class="semantic-lineage-editor" open>
      <summary>Resolve semantic lineage</summary>
      <p class="muted">This authority change is atomic: source meanings and successor proposals are written together or not at all.</p>
      <label>Source meaning IDs<textarea id="${prefix}-lineage-sources" class="semantic-input" rows="2"${lineageDisabled}>${esc(sourceMeaningIds.join('\n'))}</textarea></label>
      <label>Split successor candidate IDs<textarea id="${prefix}-lineage-successors" class="semantic-input" rows="3"${lineageDisabled}>${esc(lineagePeerCandidateIds.join('\n'))}</textarea></label>
      <div class="semantic-actions">
        <button type="button" data-semantic-lineage-action="replace" data-semantic-index="${index}"${lineageDisabled}>Replace source with this candidate</button>
        <button type="button" data-semantic-lineage-action="split" data-semantic-index="${index}"${lineageDisabled}>Split source across candidate group</button>
        <button type="button" data-semantic-lineage-action="merge" data-semantic-index="${index}"${lineageDisabled}>Merge sources into this candidate</button>
      </div>
    </details>` : ''}
    <details class="semantic-editor">
      <summary>Edit / review meaning</summary>
      <div class="semantic-form">
        <label>Name<input id="${prefix}-name" class="semantic-input" value="${esc(proposal.name ?? '')}"${disabled}></label>
        <label>Kind<select id="${prefix}-kind" class="semantic-input"${disabled}>
          ${(['feature','capability','surface','domain'] as const).map(kind => `<option value="${kind}"${proposal.kind === kind ? ' selected' : ''}>${kind}</option>`).join('')}
        </select></label>
        <label class="semantic-wide">Description<textarea id="${prefix}-description" class="semantic-input" rows="3"${disabled}>${esc(proposal.description ?? '')}</textarea></label>
        <label class="semantic-wide">Alternatives <span class="muted">(one per line)</span><textarea id="${prefix}-alternatives" class="semantic-input" rows="2"${disabled}>${esc(alternatives)}</textarea></label>
        <label class="semantic-wide">Grouping / ownership suggestions <span class="muted">(one per line)</span><textarea id="${prefix}-grouping" class="semantic-input" rows="2"${disabled}>${esc(grouping)}</textarea></label>
        <label class="semantic-wide">Review rationale <span class="muted">(optional)</span><textarea id="${prefix}-rationale" class="semantic-input" rows="2"${disabled}></textarea></label>
      </div>
      <div class="semantic-actions">
        <button class="primary" type="button" data-semantic-action="amend" data-semantic-index="${index}"${disabled}>Save amendment</button>
        <button class="primary" type="button" data-semantic-action="accept" data-semantic-index="${index}"${disabled}>Accept meaning</button>
        <button class="semantic-danger" type="button" data-semantic-action="reject" data-semantic-index="${index}"${disabled}>Reject proposal</button>
      </div>
      <div class="semantic-verify">
        <label>Evidence IDs used for independent verification<textarea id="${prefix}-evidence" class="semantic-input" rows="3"${disabled}>${esc(evidenceIds.join('\n'))}</textarea></label>
        <button class="primary" type="button" data-semantic-action="verify" data-semantic-index="${index}"${disabled}>Verify with evidence</button>
      </div>
      <details class="semantic-ai-proposal">
        <summary>AI proposal packet / import</summary>
        <p class="muted">DI supplies bounded evidence; the model supplies wording/grouping. Importing the result records ai-model provenance but does not accept or verify it.</p>
        <details><summary class="muted">Bounded AI proposal packet</summary><pre class="raw">${esc(JSON.stringify(candidate.aiProposalPacket ?? {}, null, 2))}</pre></details>
        <div class="semantic-form">
          <label>Model provider<input id="${prefix}-ai-provider" class="semantic-input" placeholder="openai / anthropic / local"${aiWritable ? '' : ' disabled'}></label>
          <label>Model ID<input id="${prefix}-ai-model" class="semantic-input" placeholder="model identifier"${aiWritable ? '' : ' disabled'}></label>
          <label class="semantic-wide">AI rationale tied to the packet<textarea id="${prefix}-ai-rationale" class="semantic-input" rows="3"${aiWritable ? '' : ' disabled'}></textarea></label>
        </div>
        <button type="button" data-semantic-ai-proposal data-semantic-index="${index}"${aiWritable ? '' : ' disabled'}>Record AI proposal from these editable fields</button>
      </details>
            <details><summary class="muted">Candidate provenance</summary><pre class="raw">${esc(JSON.stringify(candidate.provenance ?? {}, null, 2))}</pre></details>
    </details>
  </article>`;
}

function semanticLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/u).map(item => item.trim()).filter(Boolean))];
}

function semanticAuditSnapshot(snapshot: any): string {
  if (!snapshot) return 'none';
  return `${snapshot.name ?? snapshot.candidateId ?? 'unnamed'} · ${snapshot.kind ?? 'semantic'} · ${snapshot.scope ?? 'unknown scope'} · ${snapshot.revision ?? 'unknown revision'}`;
}

function semanticChangeAuditCard(item: any, index: number, writable: boolean): string {
  const reasons = Array.isArray(item.reasons) ? item.reasons : [];
  const alternatives = Array.isArray(item.alternatives) ? item.alternatives : [];
  const evidenceIds = [...new Set([
    ...(item.before?.evidenceIds ?? []),
    ...(item.after?.evidenceIds ?? []),
    ...(item.verification?.evidenceIds ?? []),
  ])];
  const changePrefix = `semantic-change-${index}`;
  return `<article class="card semantic-change-audit" data-semantic-change-ref="${esc(item.auditRef ?? '')}">
    <div class="semantic-card-head">
      <div>
        <div><span class="badge">${esc(item.auditRef ?? ('SEM-' + String(item.ordinal ?? '?')))}</span> <span class="badge">${esc(item.changeKind ?? 'change')}</span> <span class="badge ${item.approved ? 'status-good' : 'status-warn'}">${item.approved ? 'cleared' : 'review required'}</span></div>
        <h2>${esc(item.summary ?? item.name ?? item.changeId ?? 'Semantic change')}</h2>
      </div>
      <div class="semantic-meta"><strong>#${esc(item.ordinal ?? '?')}</strong><span>${esc(item.scope ?? '')}</span></div>
    </div>
    <p><strong>Before:</strong> ${esc(semanticAuditSnapshot(item.before))}</p>
    <p><strong>After:</strong> ${esc(semanticAuditSnapshot(item.after))}</p>
    ${reasons.length ? `<div><strong>Why DI says this changed</strong><ul>${reasons.map((reason: string) => `<li>${esc(reason)}</li>`).join('')}</ul></div>` : ''}
    ${alternatives.length ? `<div><strong>Competing current candidates</strong><ul>${alternatives.map((alternative: any) => `<li>${esc(semanticAuditSnapshot(alternative))}</li>`).join('')}</ul></div>` : ''}
    <details><summary class="muted">Exact audit identity / evidence delta</summary><pre class="raw">${esc(JSON.stringify({
      auditRef: item.auditRef,
      ordinal: item.ordinal,
      changeId: item.changeId,
      meaningId: item.meaningId,
      candidateId: item.candidateId,
      sourceRevision: item.sourceRevision,
      targetRevision: item.targetRevision,
      approvalBases: item.approvalBases,
      verification: item.verification,
      evolution: item.evolution,
    }, null, 2))}</pre></details>
    <details class="semantic-change-verification">
      <summary>Verify this SEM change</summary>
      <p class="muted">Verification says the observed change is factually supported by the cited evidence. It does not say the change was desirable.</p>
      <label>Evidence IDs<textarea id="${changePrefix}-evidence" class="semantic-input" rows="3"${writable ? '' : ' disabled'}>${esc(evidenceIds.join('\n'))}</textarea></label>
      <label>Verification rationale<textarea id="${changePrefix}-rationale" class="semantic-input" rows="2"${writable ? '' : ' disabled'}></textarea></label>
      <button type="button" data-semantic-change-verify data-semantic-change-index="${index}"${writable ? '' : ' disabled'}>Verify ${esc(item.auditRef ?? 'SEM change')}</button>
    </details>
  </article>`;
}

async function renderSemantics(epoch: number): Promise<void> {
  setHead();
  content.innerHTML = empty('Loading semantic meaning', 'Loading evidence-derived candidates and DI-owned review authority…');
  const data = await getJson('/workbench/data', new URLSearchParams({ action: 'semantics', limit: '100' }));
  if (!sectionIsCurrent(epoch, 'semantics')) return;
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const authority = data.authority ?? {};
  const promotionAudit = data.promotionAudit ?? null;
  const promotionItems = Array.isArray(promotionAudit?.items) ? promotionAudit.items : [];
  const enrollmentState = authority.enrollmentState ?? promotionAudit?.enrollmentState ?? 'not-enrolled';
  const gateStatus = promotionAudit?.gateStatus ?? 'non-blocking';
  const gateExplanation = data.gateExplanation ?? {};
  const recommendedBaselineCandidateIds = Array.isArray(gateExplanation.recommendedBaselineCandidateIds)
    ? gateExplanation.recommendedBaselineCandidateIds
    : [];
  const recommendedBaselineCandidates = candidates.filter((candidate: any) => recommendedBaselineCandidateIds.includes(candidate.id));
  const blockingPendingCount = Number(promotionAudit?.blockingPendingCount ?? 0);
  const writable = authority.state !== 'not-configured' && authority.state !== 'invalid';
  const accepted = candidates.filter((candidate: any) => candidate.review?.accepted).length;
  const verified = candidates.filter((candidate: any) => Boolean(candidate.review?.verification)).length;
  const reviewed = candidates.filter((candidate: any) => Boolean(candidate.review?.reviewed)).length;
  const flash = semanticFlash;
  semanticFlash = '';
  const storageMessage = authority.state === 'not-configured'
    ? 'Semantic authority storage is not configured for this deployment. Candidates remain inspectable, but review writes are disabled.'
    : authority.state === 'invalid'
      ? `Semantic authority is invalid: ${authority.error ?? 'unknown error'}. Writes are disabled until repaired.`
      : `DI semantic authority: ${authority.state ?? 'unknown'} · generation ${authority.generation ?? 0} · ${authority.durable ? 'durable' : 'non-durable'}.`;
  content.innerHTML = `${flash ? `<div class="card semantic-flash"><strong>${esc(flash)}</strong></div>` : ''}
    <div class="hero-grid">
      <div class="card">
        <h3>Semantic authority</h3>
        <h2>Evidence → proposal → explicit review</h2>
        <p>${esc(storageMessage)}</p>
        <p><span class="badge">${esc(enrollmentState)}</span> <span class="badge ${gateStatus === 'semantic-review-required' ? 'status-warn' : 'status-good'}">${esc(gateStatus)}</span> ${blockingPendingCount ? `<span class="badge status-warn">${esc(blockingPendingCount)} blocking</span>` : '<span class="badge status-good">non-blocking</span>'}</p>
        <p class="muted">This workspace never silently promotes a proposal. Acceptance records human authority; verification separately records evidence support. Current revision: ${esc(data.revision ?? 'unknown')}.</p>
        ${gateExplanation.behavior ? `<div class="semantic-proof"><span>Accepted A · ${esc(gateExplanation.acceptedGraphRevision ?? 'none')}</span><span>Working W · ${esc(gateExplanation.currentRevision ?? data.revision ?? 'unknown')}</span><span>${esc(gateExplanation.coreCandidateCount ?? 0)} core / ${esc(gateExplanation.supportingCandidateCount ?? 0)} supporting</span></div><p><strong>In plain language:</strong> ${esc(gateExplanation.behavior)} ${esc(gateExplanation.note ?? '')}</p>` : ''}
        ${writable && enrollmentState !== 'enforced' && recommendedBaselineCandidates.length ? `<div class="semantic-bootstrap" style="margin-top:12px">
          <h3>First semantic baseline</h3>
          <p>Recommended durable core meaning: <strong>${recommendedBaselineCandidates.map((candidate: any) => esc(proposalName(candidate))).join(', ')}</strong>. Supporting candidates remain visible context and are not auto-accepted.</p>
          <label>Bootstrap rationale<textarea id="semantic-bootstrap-rationale" class="semantic-input" rows="2">Establish the exact current Main revision as the first enforced semantic baseline using the evidence-supported core meaning while keeping supporting implementation candidates non-authoritative.</textarea></label>
          <button type="button" data-semantic-bootstrap class="primary">Bootstrap semantic gate on current Main</button>
          <p class="muted">Owner-only. This accepts only the explicitly listed core meaning(s), enrolls enforcement against the full current candidate census, and finalizes accepted A to this exact already-promoted Main revision.</p>
        </div>` : ''}
        ${writable ? `<div class="semantic-bootstrap" style="margin-top:12px">
          <h3>Portfolio first baseline</h3>
          <p>One owner action can establish independent semantic baselines across every currently authorized repository. DI accepts every current candidate whose factuality audit is supported, records human acceptance per repository, and leaves inaccessible or unsupported repositories untouched and explicitly reported.</p>
          <label>Portfolio rationale<textarea id="semantic-portfolio-bootstrap-rationale" class="semantic-input" rows="2">Establish first semantic authority across the authorized repository portfolio using DI's exact-revision factuality audit. Accept all source-supported current meanings, preserve separate authority per repository, and leave any unproven repository untouched.</textarea></label>
          <button type="button" data-semantic-portfolio-bootstrap class="primary">Bootstrap semantic authority across portfolio</button>
          <p class="muted">Owner-only. This may create many accepted meaning records. It never creates a cross-repository mega-graph or shared semantic authority.</p>
        </div>` : ''}
        ${writable ? `<div class="semantic-form">
          <label>Release enforcement<select id="semantic-enrollment-state" class="semantic-input">
            ${(['not-enrolled','advisory','enforced'] as const).map(state => `<option value="${state}"${enrollmentState === state ? ' selected' : ''}>${state}</option>`).join('')}
          </select></label>
          <label>Enrollment rationale<textarea id="semantic-enrollment-rationale" class="semantic-input" rows="2" placeholder="Why this release policy is changing"></textarea></label>
        </div>
        <button type="button" data-semantic-enrollment class="primary">Update semantic release policy</button>
        <p class="muted">Enforced mode is accepted only when DI has a durable accepted Main semantic baseline. Changing this policy does not approve Main.</p>` : ''}
      </div>
      <div class="card">
        <h3>Current review state</h3>
        <div class="metric-grid">
          ${metric('candidates', candidates.length)}
          ${metric('reviewed', reviewed)}
          ${metric('accepted', accepted)}
          ${metric('verified', verified)}
        </div>
        <p class="muted">${data.zeroMetadata ? 'Zero-metadata semantic bootstrap' : 'Repository semantic evidence present'} · ${esc(data.declaredSemanticCount ?? 0)} declared semantic concept(s).</p>
      </div>
    </div>
    ${!writable ? `<div class="card" style="margin-top:13px;border-color:#6d5130"><h3>Read-only review state</h3><p class="status-warn">${esc(storageMessage)}</p></div>` : ''}
    ${promotionAudit ? `<section class="semantic-change-manifest" style="margin-top:13px">
      <div class="card">
        <h3>Semantic change audit</h3>
        <h2>${esc(promotionAudit.semanticDeltaCount ?? 0)} individually addressable change(s)</h2>
        <p>Reference a change by its stable SEM ID when auditing with an agent. These items report what DI observes between accepted meaning and this revision; they do not infer whether the change was desirable.</p>
        <p class="muted">Enrollment ${esc(promotionAudit.enrollmentState ?? enrollmentState)} · semantic baseline ${esc(promotionAudit.baselineRevision ?? 'none')} · comparison base ${esc(promotionAudit.baseRevision ?? 'none')} → target ${esc(promotionAudit.previewRevision ?? data.revision ?? 'unknown')} · ${esc(promotionAudit.pendingCount ?? 0)} review pending / ${esc(promotionAudit.blockingPendingCount ?? 0)} blocking · digest ${esc(promotionAudit.digest ?? 'unavailable')} · full candidate census ${data.promotionAuditBasis?.candidateUniverseExhausted ? 'exhausted' : 'bounded'}.</p>
      </div>
      <div class="semantic-grid" style="margin-top:13px">
        ${promotionItems.map((item: any, index: number) => semanticChangeAuditCard(item, index, writable)).join('') || empty('No semantic delta', 'DI found no semantic change requiring an audit item for this target revision.')}
      </div>
    </section>` : ''}
    <div class="semantic-grid" style="margin-top:13px">
      ${candidates.map((candidate: any, index: number) => semanticCandidateCard(candidate, index, writable, candidates)).join('') || empty('No semantic candidates', 'This revision did not produce evidence-qualified semantic candidates.')}
    </div>`;

  const runPortfolioBootstrap = async () => {
    const rationale = (document.getElementById('semantic-portfolio-bootstrap-rationale') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    if (!rationale) {
      semanticFlash = 'Portfolio semantic bootstrap requires an explicit rationale.';
      await renderSemantics(epoch);
      return;
    }
    if (!window.confirm('Accept every factually supported current semantic candidate across all authorized repositories? Repositories that cannot be proven will be left untouched and reported.')) return;
    const button = content.querySelector<HTMLButtonElement>('[data-semantic-portfolio-bootstrap]');
    if (button) button.disabled = true;
    try {
      const result = await postJson('/workbench/semantics/portfolio-bootstrap', { rationale });
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      const blocked = Number(result.counts?.blocked ?? 0);
      const errors = Number(result.counts?.error ?? 0);
      const stored = Number(result.counts?.stored ?? 0);
      const current = Number(result.counts?.['already-current'] ?? 0);
      const problemNames = Array.isArray(result.items)
        ? result.items.filter((item: any) => item.outcome === 'blocked' || item.outcome === 'error').map((item: any) => item.project).slice(0, 5)
        : [];
      semanticFlash = `Portfolio semantic bootstrap: ${stored} stored, ${current} already current, ${blocked} blocked, ${errors} error.${problemNames.length ? ' Attention: ' + problemNames.join(', ') : ''}`;
      await renderSemantics(epoch);
    } catch (error) {
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `Portfolio semantic bootstrap failed: ${error instanceof Error ? error.message : String(error)}`;
      await renderSemantics(epoch);
    }
  };

  const runBootstrap = async () => {
    if (!recommendedBaselineCandidateIds.length) return;
    const rationale = (document.getElementById('semantic-bootstrap-rationale') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    if (!rationale) {
      semanticFlash = 'Semantic baseline bootstrap requires an explicit rationale.';
      await renderSemantics(epoch);
      return;
    }
    const button = content.querySelector<HTMLButtonElement>('[data-semantic-bootstrap]');
    if (button) button.disabled = true;
    try {
      const result = await postJson('/workbench/semantics/bootstrap', {
        candidateIds: recommendedBaselineCandidateIds,
        rationale,
        expectedDigest: promotionAudit?.digest ?? null,
      });
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `Semantic baseline established at ${result.acceptedGraphRevision ?? result.revision ?? 'current Main'} · gate ${result.enrollmentState ?? 'enforced'} / ${result.gateStatus ?? 'ready'}.`;
      await renderSemantics(epoch);
    } catch (error) {
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `Semantic baseline bootstrap failed: ${error instanceof Error ? error.message : String(error)}`;
      await renderSemantics(epoch);
    }
  };

  const runEnrollment = async () => {
    const select = document.getElementById('semantic-enrollment-state') as HTMLSelectElement | null;
    if (!select) return;
    const rationale = (document.getElementById('semantic-enrollment-rationale') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    const button = content.querySelector<HTMLButtonElement>('[data-semantic-enrollment]');
    if (button) button.disabled = true;
    try {
      const result = await postJson('/workbench/semantics/enrollment', {
        state: select.value,
        ...(rationale ? { rationale } : {}),
        expectedEtag: authority.etag ?? null,
      });
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `Semantic release policy: ${result.enrollmentState ?? select.value}. This policy does not approve Main.`;
      await renderSemantics(epoch);
    } catch (error) {
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `Semantic enrollment failed: ${error instanceof Error ? error.message : String(error)}`;
      await renderSemantics(epoch);
    }
  };
  const runChangeVerification = async (button: HTMLButtonElement) => {
    const index = Number(button.dataset.semanticChangeIndex);
    const item = promotionItems[index];
    if (!item) return;
    const prefix = `semantic-change-${index}`;
    const evidenceIds = semanticLines((document.getElementById(`${prefix}-evidence`) as HTMLTextAreaElement | null)?.value ?? '');
    const rationale = (document.getElementById(`${prefix}-rationale`) as HTMLTextAreaElement | null)?.value.trim() ?? '';
    if (!evidenceIds.length) {
      semanticFlash = `${item.auditRef ?? 'SEM change'} requires at least one explicit evidence ID.`;
      await renderSemantics(epoch);
      return;
    }
    for (const current of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-semantic-change-verify],[data-semantic-action],[data-semantic-lineage-action]'))) current.disabled = true;
    try {
      const result = await postJson('/workbench/semantics/change-verify', {
        auditRef: item.auditRef,
        evidenceIds,
        ...(rationale ? { rationale } : {}),
        expectedEtag: authority.etag ?? null,
      });
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `${item.auditRef}: verified with ${result.verification?.evidenceIds?.length ?? evidenceIds.length} evidence item(s). Gate status: ${result.item?.approved ? 'cleared' : 'pending'}.`;
      await renderSemantics(epoch);
    } catch (error) {
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `Semantic gate verification failed: ${error instanceof Error ? error.message : String(error)}`;
      await renderSemantics(epoch);
    }
  };

  const runAction = async (button: HTMLButtonElement) => {
    const index = Number(button.dataset.semanticIndex);
    const candidate = candidates[index];
    if (!candidate) return;
    const prefix = `semantic-${index}`;
    const action = button.dataset.semanticAction;
    const rationale = (document.getElementById(`${prefix}-rationale`) as HTMLTextAreaElement | null)?.value.trim() ?? '';
    let command: Record<string, unknown>;
    if (action === 'amend') {
      const name = (document.getElementById(`${prefix}-name`) as HTMLInputElement).value.trim();
      const kind = (document.getElementById(`${prefix}-kind`) as HTMLSelectElement).value;
      const description = (document.getElementById(`${prefix}-description`) as HTMLTextAreaElement).value.trim();
      const alternatives = semanticLines((document.getElementById(`${prefix}-alternatives`) as HTMLTextAreaElement).value);
      const grouping = semanticLines((document.getElementById(`${prefix}-grouping`) as HTMLTextAreaElement).value);
      command = { kind: 'amend', proposal: { name, kind, description, alternatives, grouping }, ...(rationale ? { rationale } : {}) };
    } else if (action === 'verify') {
      const evidenceIds = semanticLines((document.getElementById(`${prefix}-evidence`) as HTMLTextAreaElement).value);
      if (!evidenceIds.length) {
        semanticFlash = 'Verification requires at least one explicit evidence ID.';
        await renderSemantics(epoch);
        return;
      }
      command = { kind: 'verify', evidenceIds, ...(rationale ? { rationale } : {}) };
    } else if (action === 'accept' || action === 'reject') {
      command = { kind: action, ...(rationale ? { rationale } : {}) };
    } else {
      return;
    }

    for (const current of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-semantic-action]'))) current.disabled = true;
    try {
      const result = await postJson('/workbench/semantics/review', {
        candidateId: candidate.id,
        command,
        expectedEtag: authority.etag ?? null,
      });
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `${proposalName(candidate)}: ${result.review?.state ?? result.state}. Semantic authority generation ${result.generation ?? authority.generation ?? 0}.`;
      await renderSemantics(epoch);
    } catch (error) {
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `Semantic review failed: ${error instanceof Error ? error.message : String(error)}`;
      await renderSemantics(epoch);
    }
  };

  const runAiProposal = async (button: HTMLButtonElement) => {
    const index = Number(button.dataset.semanticIndex);
    const candidate = candidates[index];
    if (!candidate) return;
    const prefix = `semantic-${index}`;
    const provider = (document.getElementById(`${prefix}-ai-provider`) as HTMLInputElement | null)?.value.trim() ?? '';
    const modelId = (document.getElementById(`${prefix}-ai-model`) as HTMLInputElement | null)?.value.trim() ?? '';
    const rationale = (document.getElementById(`${prefix}-ai-rationale`) as HTMLTextAreaElement | null)?.value.trim() ?? '';
    const name = (document.getElementById(`${prefix}-name`) as HTMLInputElement).value.trim();
    const kind = (document.getElementById(`${prefix}-kind`) as HTMLSelectElement).value;
    const description = (document.getElementById(`${prefix}-description`) as HTMLTextAreaElement).value.trim();
    const alternatives = semanticLines((document.getElementById(`${prefix}-alternatives`) as HTMLTextAreaElement).value);
    const grouping = semanticLines((document.getElementById(`${prefix}-grouping`) as HTMLTextAreaElement).value);
    if (!modelId || !rationale) {
      semanticFlash = 'AI proposal import requires a model ID and evidence-tied rationale.';
      await renderSemantics(epoch);
      return;
    }
    for (const current of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-semantic-ai-proposal],[data-semantic-lineage-action],[data-semantic-action]'))) current.disabled = true;
    try {
      const result = await postJson('/workbench/semantics/ai-proposal', {
        candidateId: candidate.id,
        draft: {
          model: { id: modelId, ...(provider ? { provider } : {}) },
          proposal: { name, kind, description, alternatives, grouping },
          rationale,
        },
        expectedEtag: authority.etag ?? null,
      });
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `${proposalName(candidate)}: AI proposal recorded from ${result.review?.proposalProvenance?.producer ?? modelId}; it remains unaccepted.`;
      await renderSemantics(epoch);
    } catch (error) {
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `AI semantic proposal failed: ${error instanceof Error ? error.message : String(error)}`;
      await renderSemantics(epoch);
    }
  };

  const runLineage = async (button: HTMLButtonElement) => {
    const index = Number(button.dataset.semanticIndex);
    const candidate = candidates[index];
    if (!candidate) return;
    const prefix = `semantic-${index}`;
    const action = button.dataset.semanticLineageAction;
    const sourceMeaningIds = semanticLines((document.getElementById(`${prefix}-lineage-sources`) as HTMLTextAreaElement | null)?.value ?? '');
    const successorCandidateIds = semanticLines((document.getElementById(`${prefix}-lineage-successors`) as HTMLTextAreaElement | null)?.value ?? '');
    const rationale = (document.getElementById(`${prefix}-rationale`) as HTMLTextAreaElement | null)?.value.trim() ?? '';
    let command: Record<string, unknown>;
    if (action === 'replace') {
      if (sourceMeaningIds.length !== 1) {
        semanticFlash = 'Replace requires exactly one source meaning.';
        await renderSemantics(epoch);
        return;
      }
      command = { kind: 'replace', sourceMeaningId: sourceMeaningIds[0], successorCandidateId: candidate.id, ...(rationale ? { rationale } : {}) };
    } else if (action === 'split') {
      if (sourceMeaningIds.length !== 1 || successorCandidateIds.length < 2) {
        semanticFlash = 'Split requires exactly one source meaning and at least two successor candidates.';
        await renderSemantics(epoch);
        return;
      }
      command = { kind: 'split', sourceMeaningId: sourceMeaningIds[0], successorCandidateIds, ...(rationale ? { rationale } : {}) };
    } else if (action === 'merge') {
      if (sourceMeaningIds.length < 2) {
        semanticFlash = 'Merge requires at least two source meanings.';
        await renderSemantics(epoch);
        return;
      }
      command = { kind: 'merge', sourceMeaningIds, successorCandidateId: candidate.id, ...(rationale ? { rationale } : {}) };
    } else {
      return;
    }

    for (const current of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-semantic-lineage-action],[data-semantic-action]'))) current.disabled = true;
    try {
      const result = await postJson('/workbench/semantics/lineage', {
        command,
        expectedEtag: authority.etag ?? null,
      });
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `${proposalName(candidate)}: ${result.operation ?? action} lineage stored. Semantic authority generation ${result.generation ?? authority.generation ?? 0}.`;
      await renderSemantics(epoch);
    } catch (error) {
      if (!sectionIsCurrent(epoch, 'semantics')) return;
      semanticFlash = `Semantic lineage failed: ${error instanceof Error ? error.message : String(error)}`;
      await renderSemantics(epoch);
    }
  };

  const portfolioBootstrapButton = content.querySelector<HTMLButtonElement>('[data-semantic-portfolio-bootstrap]');
  if (portfolioBootstrapButton) portfolioBootstrapButton.addEventListener('click', () => void runPortfolioBootstrap());

  const bootstrapButton = content.querySelector<HTMLButtonElement>('[data-semantic-bootstrap]');
  if (bootstrapButton) bootstrapButton.addEventListener('click', () => void runBootstrap());

  const enrollmentButton = content.querySelector<HTMLButtonElement>('[data-semantic-enrollment]');
  if (enrollmentButton) enrollmentButton.addEventListener('click', () => void runEnrollment());

  for (const button of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-semantic-change-verify]'))) {
    button.addEventListener('click', () => void runChangeVerification(button));
  }

  for (const button of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-semantic-action]'))) {
    button.addEventListener('click', () => void runAction(button));
  }

  for (const button of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-semantic-lineage-action]'))) {
    button.addEventListener('click', () => void runLineage(button));
  }
  for (const button of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-semantic-ai-proposal]'))) {
    button.addEventListener('click', () => void runAiProposal(button));
  }
}

function parityStatusClass(status: string): string {
  if (status === 'satisfied') return 'status-good';
  if (status === 'unproven' || status === 'not-applicable') return 'status-warn';
  return 'status-bad';
}

function parityExpectationLabel(result: any): string {
  if (result.type === 'entity') return result.expectation?.id ?? 'entity';
  if (result.type === 'predicate') return result.predicate?.id ?? 'predicate';
  return `${result.expectation?.from ?? '?'} ${result.expectation?.kind ?? '?'} ${result.expectation?.to ?? '?'}`;
}

function renderParityEvaluation(data: any): string {
  const counts = data.counts ?? {};
  const results = data.results ?? [];
  return `<div class="hero-grid"><div class="card"><h3>Contract result</h3><h2 class="${data.passed ? 'status-good' : 'status-warn'}">${data.passed ? 'Expectation satisfied' : 'Attention required'}</h2><p>${esc(data.note ?? '')}</p><p class="muted">Revision ${esc(data.revision ?? 'unknown')}</p></div><div class="card"><h3>Obligations</h3><div class="metric-grid">${metric('satisfied', counts.satisfied ?? 0)}${metric('missing', counts.missing ?? 0)}${metric('forbidden present', counts.forbiddenPresent ?? 0)}${metric('unproven', counts.unproven ?? 0)}</div></div></div><div class="card" style="margin-top:13px"><h3>Evaluation detail</h3><div class="list">${results.map((result: any) => `<div class="row"><span class="badge ${parityStatusClass(result.status)}">${esc(result.status)}</span><span class="row-main"><strong>${esc(parityExpectationLabel(result))}</strong><small>${esc(result.explanation ?? '')}${result.expectation?.rationale ? ` · ${esc(result.expectation.rationale)}` : ''}</small></span></div>`).join('')}</div></div><details style="margin-top:12px"><summary class="muted">Raw evaluation</summary><pre class="raw">${esc(JSON.stringify(data, null, 2))}</pre></details>`;
}

async function renderParity(epoch: number): Promise<void> {
  setHead();
  content.innerHTML = `<div class="card"><h3>Expectation overlay E</h3><h2>Define what must be true</h2><p>Use stable graph IDs to describe required or forbidden entities and relationships. Development Intelligence evaluates this contract against the selected working graph without storing it or promoting it into A.</p><div class="query-box" style="grid-template-columns:minmax(0,1fr) auto;margin-top:13px"><textarea id="parity-contract" aria-label="Parity contract JSON" style="min-height:260px">${esc(parityContractText)}</textarea><button class="primary" id="evaluate-parity" type="button" style="align-self:start">Evaluate</button></div><p class="muted">Supported requirements: required and forbidden. Missing negative evidence becomes unproven when graph coverage is incomplete.</p></div><div id="parity-result" class="query-result"></div>`;
  const run = async () => {
    const textarea = document.getElementById('parity-contract') as HTMLTextAreaElement;
    const target = document.getElementById('parity-result') as HTMLElement;
    parityContractText = textarea.value;
    target.innerHTML = empty('Evaluating contract', 'Comparing expected parity with the selected graph context…');
    try {
      const contract = JSON.parse(parityContractText);
      const result = await postJson('/workbench/parity', { contract });
      if (!sectionIsCurrent(epoch, 'parity')) return;
      target.innerHTML = renderParityEvaluation(result);
    } catch (error) {
      target.innerHTML = `<div class="card"><h3>Parity evaluation failed</h3><p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p></div>`;
    }
  };
  (document.getElementById('evaluate-parity') as HTMLButtonElement).addEventListener('click', () => void run());
}

function renderQueryResult(result: any): string {
  if (!result) return '';
  if (result.projection?.kind === 'repository-semantic-summary') {
    const understanding = result.semanticUnderstanding ?? {};
    const items = understanding.meanings ?? understanding.concepts ?? understanding.candidates ?? [];
    const evidence = items.map((item: any) => `<div class="row"><span class="badge">${esc(item.kind ?? 'source evidence')}</span><span class="row-main"><strong>${esc(item.name ?? item.scope ?? item.id)}</strong>${item.description ? `<small>${esc(item.description)}</small>` : ''}${item.locator ? `<small>${esc(item.locator)}</small>` : ''}</span></div>`).join('');
    return `${evidence ? `<h4>Evidence-backed areas</h4><div class="list">${evidence}</div>` : '<p class="muted">No source-backed semantic areas were selected.</p>'}<details><summary class="muted">Evidence and coverage details</summary><pre class="raw">${esc(JSON.stringify(result, null, 2))}</pre></details>`;
  }
  if (Array.isArray(result.sourceFamilies)) {
    const language = result.interpretation?.negated
      ? `<p class="muted">Negative wording: ${esc((result.interpretation.negativeTerms ?? []).join(', ') || 'not')}</p>` : '';
    const relationships = (result.navigation?.relationships ?? []).map((item: any) => `<div class="row"><span class="badge">${esc(item.edge.kind)}</span><span class="row-main">${esc(item.from?.name ?? item.edge.from)} → ${esc(item.to?.name ?? item.edge.to)}<small>${esc(item.edge.status)}</small></span></div>`).join('');
    const comparison = (result.comparison?.items ?? []).map((item: any) => `<div class="row"><span class="badge">${esc(item.state)}</span><span class="row-main">${esc(item.node.name ?? item.node.id)}<small>${esc(item.node.locator)}</small></span></div>`).join('');
    const families = result.sourceFamilies.map((family: any) => `<details><summary>${esc(family.subjectName)} · ${family.facts.length} source facts${family.focusedFacts?.length ? ` · ${family.focusedFacts.length} match the wording` : ''}</summary><div class="list">${family.facts.map((fact: any) => `<div class="row"><span class="badge">${esc(fact.effectKind ?? fact.kind)}</span><span class="row-main"><code>${esc(fact.expression)}</code><small>${esc(fact.locator)}${fact.requirements?.length ? ` · requires ${esc(fact.requirements.map((requirement: any) => `${requirement.expectedTruth ? '' : 'not '}${requirement.predicate ?? requirement.conditionId}`).join(' and '))}` : ''}</small></span></div>`).join('')}</div></details>`).join('');
    return `${language}${relationships ? `<h4>Known relationships</h4><div class="list">${relationships}</div>` : ''}${comparison ? `<h4>Comparison</h4><div class="list">${comparison}</div>` : ''}${families}<div class="list">${(result.nodes ?? []).map(nodeRow).join('')}</div><details><summary class="muted">Graph details</summary><pre class="raw">${esc(JSON.stringify(result, null, 2))}</pre></details>`;
  }
  if (Array.isArray(result.claims) && result.answerStatus) return renderAssessment(result);
  if (result.entity) return `<div class="list">${nodeRow(result.entity)}</div>`;
  if (Array.isArray(result.nodes)) return `<div class="list">${result.nodes.slice(0, 30).map(nodeRow).join('')}</div><details><summary class="muted">Raw result</summary><pre class="raw">${esc(JSON.stringify(result, null, 2))}</pre></details>`;
  if (result.data !== undefined) return `<pre class="raw">${esc(JSON.stringify(result.data, null, 2))}</pre>`;
  return `<pre class="raw">${esc(JSON.stringify(result, null, 2))}</pre>`;
}

async function renderSources(epoch: number): Promise<void> {
  setHead();
  content.innerHTML = empty('Loading sources', 'Checking configured source capabilities and observed graph sources…');
  const data = await getJson('/workbench/data', new URLSearchParams({ action: 'sources' }));
  if (!sectionIsCurrent(epoch, 'sources')) return;
  content.innerHTML = `<div class="card"><h3>Source contract</h3><h2>What Development Intelligence can actually see</h2><p>${esc(data.note)}</p></div><div class="grid" style="margin-top:13px">${(data.sources ?? []).map((source: any) => `<div class="source-card card"><span class="badge">${esc(source.type)}</span><h2 style="font-size:16px;margin-top:9px">${esc(source.label)}</h2><p>${esc(source.endpoint ?? '')}</p><p><strong>Capabilities:</strong> ${esc((source.capabilities ?? []).join(' · '))}</p><div class="source-status status-good">${source.configured ? 'configured' : 'unconfigured'} · ${esc(source.access ?? 'read-only')}</div>${source.type === 'read-only-http' ? `<button class="primary" data-query-source="${esc(source.id)}" style="margin-top:10px">Query source</button>` : ''}</div>`).join('')}</div><div class="card" style="margin-top:13px"><h3>Observed graph sources</h3><div class="list">${(data.observedGraphSources ?? []).map((source: any) => `<div class="row"><span class="badge ${source.available ? 'status-good' : 'status-bad'}">${source.available ? 'available' : 'unavailable'}</span><span class="row-main"><strong>${esc(source.kind)}</strong><small>${esc(source.locator)}${source.error ? ` · ${esc(source.error)}` : ''}</small></span></div>`).join('')}</div></div>`;
  for (const button of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-query-source]'))) button.addEventListener('click', () => { preferredQuerySource = button.dataset.querySource!; void activateSection('query'); });
}

async function renderChanges(epoch: number): Promise<void> {
  setHead();
  const defaultHead = viewerConfig.ref || (viewerConfig.local ? 'working-tree' : 'HEAD');
  content.innerHTML = `<div class="card"><h3>Graph comparison</h3><h2>Compare repository states</h2><p>${viewerConfig.local ? 'Compare the retained main, preview and working graphs, or choose two targets below.' : 'Leave the base empty for accepted → working semantic change. Historical comparisons replay both exact revisions through the same current analyzer.'}</p>${viewerConfig.local ? '<button class="primary" id="compare-three" type="button">Compare main, preview and working</button>' : ''}<div class="query-box" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;margin-top:13px"><input id="change-base" aria-label="Base revision selector" placeholder="Base: commit:&lt;sha&gt; or pr:75/head" style="border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:10px;padding:9px 11px"><input id="change-head" aria-label="Head revision selector" value="${esc(defaultHead)}" placeholder="Head: HEAD or pr:243/head" style="border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:10px;padding:9px 11px"><button class="primary" id="compare-revisions" type="button">Compare two</button></div><p class="muted">Selectors: commit:&lt;full-sha&gt;, branch:&lt;name&gt;, tag:&lt;name&gt;, pr:&lt;number&gt;/head, /base, or /result.</p></div><div id="change-result" class="query-result"></div>`;
  let offset = 0;
  const detailPageSize = 10;
  let requestNumber = 0;
  const run = async () => {
    const request = ++requestNumber;
    const baseRef = (document.getElementById('change-base') as HTMLInputElement).value.trim();
    const headRef = (document.getElementById('change-head') as HTMLInputElement).value.trim();
    const target = document.getElementById('change-result') as HTMLElement;
    target.innerHTML = empty('Loading change intelligence', viewerConfig.local ? 'Comparing the selected graph targets…' : baseRef ? 'Resolving and comparing immutable historical revisions…' : 'Comparing accepted semantic topology with current working reality…');
    try {
      const data = await getJson('/workbench/data', new URLSearchParams({ action: 'changes', ...(baseRef ? { baseRef } : {}), ...(headRef ? { headRef } : {}), ...(viewerConfig.local ? { offset: String(offset), limit: String(detailPageSize) } : {}) }));
      if (!sectionIsCurrent(epoch, 'changes') || request !== requestNumber) return;
      const counts = data.counts ?? {};
      const baseIdentity = data.detail?.base?.identity;
      const headIdentity = data.detail?.head?.identity;
      const identity = baseIdentity && headIdentity ? `<p class="muted">${esc(baseIdentity.selector)} → ${esc(headIdentity.selector)}<br>${esc(baseIdentity.sha)} → ${esc(headIdentity.sha)}</p>` : '';
      target.innerHTML = `<div class="hero-grid"><div class="card"><h3>${data.mode === 'revision-to-revision' ? 'Graph comparison' : 'Semantic change'}</h3><h2>${esc(data.summary ?? 'Accepted → working')}</h2>${identity}<p>${data.mode === 'revision-to-revision' ? data.detail?.analyzerChanged ? 'These graphs use different analyzer versions; rebuild the targets to compare with one analyzer.' : 'Both graphs use the same analyzer.' : 'Accepted semantic comparison ignores line movement and provenance-only churn.'}</p>${data.detail?.comparisonNote ? `<p class="muted">${esc(data.detail.comparisonNote)}</p>` : ''}</div><div class="card"><h3>Delta</h3><div class="metric-grid">${metric('added', counts.added ?? 0)}${metric('removed', counts.removed ?? 0)}${metric('changed', counts.changed ?? 0)}</div></div></div><div class="card" style="margin-top:13px"><h3>Change detail</h3>${data.page ? `<p class="muted">Showing up to ${data.page.limit} items per change category, starting at ${data.page.offset + 1}.</p><button id="change-previous" ${offset === 0 ? 'disabled' : ''}>Previous</button> <button id="change-next" ${data.page.nextOffset === null ? 'disabled' : ''}>Next</button>` : ''}${renderChangeBucket(data.detail)}</div>`;
      wireNodeButtons(target);
      target.querySelector('#change-previous')?.addEventListener('click', () => { offset = Math.max(0, offset - detailPageSize); void run(); });
      target.querySelector('#change-next')?.addEventListener('click', () => { offset = data.page.nextOffset; void run(); });
    } catch (error) {
      if (request !== requestNumber) return;
      target.innerHTML = `<div class="card"><h3>Comparison failed</h3><p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p></div>`;
    }
  };
  const runAll = async () => {
    const request = ++requestNumber;
    const target = document.getElementById('change-result') as HTMLElement;
    target.innerHTML = empty('Comparing graph targets', 'Comparing each pair using the same graph operation…');
    try {
      const comparisons: any[] = [];
      const pairs = [['main', 'preview'], ['main', 'working-tree'], ['preview', 'working-tree']];
      for (const [baseRef, ref] of pairs) {
        const result = await getJson('/workbench/data', new URLSearchParams({ action: 'changes', baseRef: baseRef!, headRef: ref!, offset: '0', limit: '1' }));
        if (!sectionIsCurrent(epoch, 'changes') || request !== requestNumber) return;
        comparisons.push({ baseRef, ref, page: result.page, detail: result.detail });
        target.innerHTML = `<div class="card"><p>Source changes, moved records, analysis changes, ambiguous occurrences and provenance changes are separate. Select a pair to inspect all of its paged evidence.${comparisons.length < pairs.length ? ' Comparing remaining pairs…' : ''}</p></div>${comparisons.map((item: any) => { const t = item.page?.totals ?? {}; const count = (name: string) => Number(t['nodes.' + name] ?? 0) + Number(t['edges.' + name] ?? 0); const identity = (graph: any) => graph?.revision ?? `working ${String(graph?.sourceFingerprint ?? '').slice(0, 12)}`; return `<div class="card" style="margin-top:13px"><h3>${esc(item.baseRef)} → ${esc(item.ref)}</h3><p class="muted">${esc(identity(item.detail?.base))} → ${esc(identity(item.detail?.head))}${item.detail?.analyzerChanged ? ' · Different analyzers; rebuild targets' : ''}</p><div class="metric-grid">${metric('added', count('added'))}${metric('removed', count('removed'))}${metric('changed', count('changed'))}${metric('moved', count('moved'))}${metric('analysis added', count('analysisAdded'))}${metric('analysis removed', count('analysisRemoved'))}${metric('analysis changed', count('analysisChanged'))}${metric('ambiguous additions', count('ambiguousAdded'))}${metric('ambiguous removals', count('ambiguousRemoved'))}${metric('provenance', count('provenanceChanged'))}</div><button class="primary" data-change-base="${esc(item.baseRef)}" data-change-head="${esc(item.ref)}">Inspect this pair</button></div>`; }).join('')}`;
        for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>('[data-change-base]'))) button.addEventListener('click', () => {
          (document.getElementById('change-base') as HTMLInputElement).value = button.dataset.changeBase ?? '';
          (document.getElementById('change-head') as HTMLInputElement).value = button.dataset.changeHead ?? '';
          offset = 0; void run();
        });
      }
    } catch (error) { if (request === requestNumber) target.innerHTML = `<div class="card"><h3>Comparison failed</h3><p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p></div>`; }
  };
  (document.getElementById('compare-revisions') as HTMLButtonElement).addEventListener('click', () => { offset = 0; void run(); });
  document.getElementById('compare-three')?.addEventListener('click', () => { offset = 0; void runAll(); });
  if (viewerConfig.local) await runAll(); else await run();
}

function renderChangeBucket(detail: any): string {
  const semantic = detail?.semantic ?? (detail?.nodes && detail?.edges ? detail : null);
  if (!semantic) return `<pre class="raw">${esc(JSON.stringify(detail, null, 2))}</pre>`;
  const changes = ['added', 'removed', 'changed', 'moved', 'analysisAdded', 'analysisRemoved', 'analysisChanged', 'ambiguousAdded', 'ambiguousRemoved', 'provenanceChanged'];
  const nodes = changes.flatMap(change => (semantic.nodes?.[change] ?? []).map((item: any) => ({ ...(item.after ?? item.before ?? item), _change: change, _comparison: item.before && item.after ? item : null })));
  const edges = changes.flatMap(change => (semantic.edges?.[change] ?? []).map((item: any) => ({ ...(item.after ?? item.before ?? item), _change: change, _comparison: item.before && item.after ? item : null })));
  if (!nodes.length && !edges.length) return empty('No changes on this page', 'Use the page controls to inspect other changes.');
  const beforeAfter = (pair: any) => pair ? `<details><summary>Before and after</summary><pre class="raw">${esc(JSON.stringify(pair, null, 2))}</pre></details>` : '';
  return `<div class="list">${nodes.map((node: any) => `<div><button class="row row-button" data-node="${esc(node.id)}"><span class="badge ${node._change === 'added' ? 'status-good' : node._change === 'removed' ? 'status-bad' : 'status-warn'}">${esc(node._change)}</span><span class="row-main"><strong>${esc(node.name ?? node.id)}</strong><small>${esc(node.kind ?? '')}</small></span></button>${beforeAfter(node._comparison)}</div>`).join('')}${edges.map((edge: any) => `<div><div class="row"><span class="badge">${esc(edge._change)}</span><span class="row-main"><strong>${esc(edge.kind ?? 'relationship')}</strong><small>${esc(edge.from ?? '?')} → ${esc(edge.to ?? '?')}</small></span></div>${beforeAfter(edge._comparison)}</div>`).join('')}</div>`;
}

async function renderLocal(epoch: number): Promise<void> {
  setHead();
  const state = await getJson('/workbench/local', new URLSearchParams());
  if (!sectionIsCurrent(epoch, 'local')) return;
  const settings = state.settings;
  const field = (label: string, id: string, value: unknown) => `<label style="display:block;margin:10px 0"><span class="muted">${esc(label)}</span><input id="${id}" value="${esc(value)}" style="display:block;width:100%;border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:9px;padding:9px"></label>`;
  content.innerHTML = `<div class="card"><h3>Installation</h3><h2>Local files and storage</h2><p>Port changes apply on the next launch. Changing the data location selects that location; it does not move existing graphs.</p>${field('Repository checkout', 'local-repo', settings.repoPath)}${field('Graph data directory', 'local-data', settings.dataDir)}${field('Scratch directory', 'local-scratch', settings.scratchDir)}${field('Backup directory', 'local-backup', settings.backupDir ?? '')}${field('Retained generations', 'local-retain', settings.retain)}${field('Graphs cached in memory (0 disables cache)', 'local-cache', settings.cacheSize ?? 3)}${field('Workbench port', 'local-port', settings.port)}<button class="primary" id="local-save">Save settings</button></div><div class="card" style="margin-top:13px"><h3>Graphs</h3><p>Build current files and keep selected committed revisions as comparison targets.</p><button class="primary" data-local-action="build">Build current files</button>${field('Committed revision', 'local-ref', 'preview')}${field('Target name', 'local-target', 'preview')}<button data-local-action="build-revision">Build revision target</button> <button data-local-action="unpin">Unpin target</button><div id="local-history" class="muted"></div></div><div class="card" style="margin-top:13px"><h3>Recovery</h3><p>Backup and restore preserve retained graphs, not repository files or accepted semantic records. Restore uses an empty graph location.</p><button data-local-action="backup">Back up graphs</button> <button data-local-action="restore">Restore graphs</button></div><div class="card" style="margin-top:13px"><h3>Operation</h3><div id="local-job" class="muted"></div></div>`;
  const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  const show = (data: any) => {
    const history = document.getElementById('local-history');
    if (history) history.textContent = data.history?.targets ? `Retained targets: ${Object.keys(data.history.targets).join(', ')}` : 'No graphs built at this location yet.';
    const target = document.getElementById('local-job');
    if (target) target.textContent = data.job ? `${data.job.action}: ${data.job.state}${data.job.output ? `\n${data.job.output}` : ''}` : 'No operation running.';
  };
  show(state);
  const poll = async () => {
    if (!sectionIsCurrent(epoch, 'local')) return;
    try { const current = await getJson('/workbench/local', new URLSearchParams()); show(current); if (current.job?.state === 'running') window.setTimeout(() => void poll(), 2000); }
    catch (error) { const target = document.getElementById('local-job'); if (target) target.textContent = String(error); }
  };
  (document.getElementById('local-save') as HTMLButtonElement).addEventListener('click', async () => {
    try { await postJson('/workbench/local', { action: 'settings', repoPath: value('local-repo'), dataDir: value('local-data'), scratchDir: value('local-scratch'), backupDir: value('local-backup'), retain: Number(value('local-retain')), cacheSize: Number(value('local-cache')), port: Number(value('local-port')) }); await poll(); }
    catch (error) { const target = document.getElementById('local-job'); if (target) target.textContent = String(error); }
  });
  for (const button of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-local-action]'))) button.addEventListener('click', async () => {
    try { await postJson('/workbench/local', { action: button.dataset.localAction, ref: value('local-ref'), target: value('local-target'), backupDir: value('local-backup') }); await poll(); }
    catch (error) { const target = document.getElementById('local-job'); if (target) target.textContent = String(error); }
  });
  if (state.job?.state === 'running') window.setTimeout(() => void poll(), 2000);
}

async function activateSection(next: Section, queryPrefill = ''): Promise<void> {
  const epoch = ++sectionEpoch;
  section = next;
  for (const button of navButtons) button.classList.toggle('active', button.dataset.section === section);
  renderer?.kill(); renderer = null;
  try {
    if (section === 'overview') await renderOverview(epoch);
    else if (section === 'explore') await loadExplore(epoch);
    else if (section === 'semantics') await renderSemantics(epoch);
    else if (section === 'parity') await renderParity(epoch);
    else if (section === 'query') await renderQuery(epoch, queryPrefill);
    else if (section === 'sources') await renderSources(epoch);
    else if (section === 'local') await renderLocal(epoch);
    else await renderChanges(epoch);
  } catch (error) {
    if (!sectionIsCurrent(epoch, next)) return;
    setHead();
    content.innerHTML = `<div class="card"><h3>Workbench error</h3><p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p></div>`;
  }
}

for (const button of navButtons) button.addEventListener('click', () => void activateSection(button.dataset.section as Section));
projectSelect.addEventListener('change', () => { window.location.assign(`/workbench?project=${encodeURIComponent(projectSelect.value)}`); });
revisionForm.addEventListener('submit', event => { event.preventDefault(); const ref = revisionInput.value.trim(); if (!ref) return; window.location.assign(`/workbench?project=${encodeURIComponent(viewerConfig.project)}&ref=${encodeURIComponent(ref)}`); });
globalForm.addEventListener('submit', event => { event.preventDefault(); const value = globalInput.value.trim(); if (!value) return; void activateSection('query', value); });
document.addEventListener('keydown', event => { if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') { event.preventDefault(); globalInput.focus(); } });

void activateSection(section);
