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
  semantics: { title: 'Semantics', description: 'Explore evidence-derived understanding from the selected graph.' },
  parity: { title: 'Parity Contracts', description: 'Compare caller-owned expected entities and relationships with observed project reality. Expectations remain ephemeral and never become accepted truth.' },
  query: { title: 'Query', description: 'Ask Development Intelligence about the project or run a bounded read-only query against a configured technical source.' },
  sources: { title: 'Sources', description: 'See what DI can actually inspect: Git, runtime origins, databases/log adapters, freshness, coverage and query capabilities.' },
  changes: { title: 'Changes', description: 'Compare source states, including current files and selected revisions.' },
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
  inspectorBody.innerHTML = change ? `<div class="card"><h3>Default → selected</h3><h2 class="${change.state === 'unchanged' ? 'status-good' : 'status-warn'}">${esc(change.state)}</h2><p>${change.state === 'unchanged' ? 'No semantic topology change is currently recorded for this entity.' : 'This entity participates in the current source comparison.'}</p></div>${change.record ? `<pre class="raw">${esc(JSON.stringify(change.record, null, 2))}</pre>` : ''}` : empty('Change unavailable', 'Change inspection is unavailable for this snapshot context.');
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
  const overviewFindings = (data.findings ?? []).slice(0, 8);
  content.innerHTML = `<div class="hero-grid"><div class="card"><h3>Quick documentation</h3><h2>${esc(viewerConfig.project)}</h2><p>${esc(data.summary)}</p>${(data.quickNotes ?? []).map((note: string) => `<div class="note"><span class="note-dot"></span><span>${esc(note)}</span></div>`).join('')}</div><div class="card"><h3>Current state</h3><div class="metric-grid">${metric('semantic concepts', counts.semantic ?? 0)}${metric('code entities', counts.structural ?? 0)}${metric('representations', counts.representation ?? 0)}${metric('evidence records', counts.evidence ?? 0)}${metric('candidate relations', counts.relationships?.candidate ?? 0)}${metric('conflicts', counts.conflicts ?? 0)}</div></div></div>${overviewFindings.length ? `<div class="card" style="margin-top:14px"><h3>Evidence findings</h3><div class="list">${overviewFindings.map((item: any) => `<div class="assessment-item"><div><span class="badge status-warn">${esc(item.category)}</span> <span class="muted">${esc(item.ruleId)}</span></div><strong>${esc(item.summary)}</strong><small>${esc((item.affectedIds ?? []).length)} affected graph record(s)</small></div>`).join('')}</div></div>` : ''}<div class="hero-grid" style="margin-top:14px"><div class="card"><h3>Important concepts</h3><div class="list">${(data.highlights ?? []).slice(0, 12).map((item: any) => nodeRow(item)).join('') || '<p>No explicit semantic concepts were discovered. Structural intelligence is still available in Explore.</p>'}</div></div><div class="card"><h3>Repository areas</h3><div class="list">${(data.areas ?? []).map((area: any) => `<div class="row"><span class="row-main"><strong>${esc(area.name)}</strong><small>${esc(area.count)} mapped entities</small></span></div>`).join('')}</div></div></div><div class="card" style="margin-top:14px"><h3>Sources at a glance</h3><div class="grid">${(data.sources ?? []).map((source: any) => `<div class="source-card card"><span class="badge">${esc(source.type)}</span><h2 style="font-size:15px;margin-top:9px">${esc(source.label)}</h2><p>${esc((source.capabilities ?? []).join(' · '))}</p><div class="source-status status-good">${source.configured ? 'configured' : 'not configured'} · ${esc(source.access ?? 'read-only')}</div></div>`).join('')}</div></div>`;
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


async function renderSemantics(epoch: number): Promise<void> {
  setHead();
  content.innerHTML = empty('Loading semantic understanding', 'Reading evidence from the selected graph…');
  const data = await getJson('/workbench/data', new URLSearchParams({ action: 'semantics', limit: '100' }));
  if (!sectionIsCurrent(epoch, 'semantics')) return;
  const understanding = data.semanticUnderstanding ?? {};
  const items = understanding.meanings ?? understanding.concepts ?? understanding.candidates ?? [];
  content.innerHTML = `<div class="card"><h3>Semantic understanding</h3><h2>Understanding from the selected graph</h2><p>${esc(data.summary ?? 'No semantic understanding is available for this graph.')}</p><p class="muted">Semantic understanding is derived from source evidence. It is not edited or approved separately.</p><div class="list">${items.map((item: any) => `<div class="row"><span class="badge">${esc(item.kind ?? 'source evidence')}</span><span class="row-main"><strong>${esc(item.name ?? item.scope ?? item.id)}</strong>${item.description ? `<small>${esc(item.description)}</small>` : ''}${item.locator ? `<small>${esc(item.locator)}</small>` : ''}</span></div>`).join('')}</div><details><summary>Evidence and coverage details</summary><pre class="raw">${esc(JSON.stringify(data, null, 2))}</pre></details></div>`;
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
  content.innerHTML = `<div class="card"><h3>Graph comparison</h3><h2>Compare repository states</h2><p>${viewerConfig.local ? 'Compare the retained main, preview and working graphs, or choose two targets below.' : 'Leave the base empty to compare the default source revision with the selected revision. Historical comparisons replay both exact revisions through the same current analyzer.'}</p>${viewerConfig.local ? '<button class="primary" id="compare-three" type="button">Compare main, preview and working</button>' : ''}<div class="query-box" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;margin-top:13px"><input id="change-base" aria-label="Base revision selector" placeholder="Base: commit:&lt;sha&gt; or pr:75/head" style="border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:10px;padding:9px 11px"><input id="change-head" aria-label="Head revision selector" value="${esc(defaultHead)}" placeholder="Head: HEAD or pr:243/head" style="border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:10px;padding:9px 11px"><button class="primary" id="compare-revisions" type="button">Compare two</button></div><p class="muted">Selectors: commit:&lt;full-sha&gt;, branch:&lt;name&gt;, tag:&lt;name&gt;, pr:&lt;number&gt;/head, /base, or /result.</p></div><div id="change-result" class="query-result"></div>`;
  let offset = 0;
  const detailPageSize = 10;
  let requestNumber = 0;
  const run = async () => {
    const request = ++requestNumber;
    const baseRef = (document.getElementById('change-base') as HTMLInputElement).value.trim();
    const headRef = (document.getElementById('change-head') as HTMLInputElement).value.trim();
    const target = document.getElementById('change-result') as HTMLElement;
    target.innerHTML = empty('Loading change intelligence', viewerConfig.local ? 'Comparing the selected graph targets…' : baseRef ? 'Resolving and comparing immutable historical revisions…' : 'Comparing the default and selected source states…');
    try {
      const data = await getJson('/workbench/data', new URLSearchParams({ action: 'changes', ...(baseRef ? { baseRef } : {}), ...(headRef ? { headRef } : {}), ...(viewerConfig.local ? { offset: String(offset), limit: String(detailPageSize) } : {}) }));
      if (!sectionIsCurrent(epoch, 'changes') || request !== requestNumber) return;
      const counts = data.counts ?? {};
      const baseIdentity = data.detail?.base?.identity;
      const headIdentity = data.detail?.head?.identity;
      const identity = baseIdentity && headIdentity ? `<p class="muted">${esc(baseIdentity.selector)} → ${esc(headIdentity.selector)}<br>${esc(baseIdentity.sha)} → ${esc(headIdentity.sha)}</p>` : '';
      target.innerHTML = `<div class="hero-grid"><div class="card"><h3>${data.mode === 'revision-to-revision' ? 'Graph comparison' : 'Semantic change'}</h3><h2>${esc(data.summary ?? 'Default → selected')}</h2>${identity}<p>${data.mode === 'revision-to-revision' ? data.detail?.analyzerChanged ? 'These graphs use different analyzer versions; rebuild the targets to compare with one analyzer.' : 'Both graphs use the same analyzer.' : 'This compares semantic records from the default and selected source states.'}</p>${data.detail?.comparisonNote ? `<p class="muted">${esc(data.detail.comparisonNote)}</p>` : ''}</div><div class="card"><h3>Delta</h3><div class="metric-grid">${metric('added', counts.added ?? 0)}${metric('removed', counts.removed ?? 0)}${metric('changed', counts.changed ?? 0)}</div></div></div><div class="card" style="margin-top:13px"><h3>Change detail</h3>${data.page ? `<p class="muted">Showing up to ${data.page.limit} items per change category, starting at ${data.page.offset + 1}.</p><button id="change-previous" ${offset === 0 ? 'disabled' : ''}>Previous</button> <button id="change-next" ${data.page.nextOffset === null ? 'disabled' : ''}>Next</button>` : ''}${renderChangeBucket(data.detail)}</div>`;
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
