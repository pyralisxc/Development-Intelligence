import { MultiGraph } from 'graphology';
import Sigma from 'sigma';

declare global {
  interface Window {
    __DEVINT_VIEWER__?: { project: string; ref?: string; graphId?: string; section?: string };
  }
}

type Section = 'overview' | 'explore' | 'parity' | 'query' | 'sources' | 'changes';
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

let section: Section = (['overview', 'explore', 'parity', 'query', 'sources', 'changes'].includes(viewerConfig.section ?? '') ? viewerConfig.section : 'overview') as Section;
let exploreMode: ExploreMode = 'summary';
let graphLens: GraphLens = 'architecture';
let exploreQuery = '';
let lastExplore: any = null;
let selectedInspection: any = null;
let inspectorTab = 'summary';
let renderer: Sigma | null = null;
let preferredQuerySource = '';
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
  explore: { title: 'Explore', description: 'Search the same intelligence as Summary, List, Table, Graph or Raw records. Use the Inspector for the details.' },
  parity: { title: 'Parity Contracts', description: 'Compare caller-owned expected entities and relationships with observed project reality. Expectations remain ephemeral and never become accepted truth.' },
  query: { title: 'Query', description: 'Ask Development Intelligence about the project or run a bounded read-only query against a configured technical source.' },
  sources: { title: 'Sources', description: 'See what DI can actually inspect: Git, runtime origins, databases/log adapters, freshness, coverage and query capabilities.' },
  changes: { title: 'Changes', description: 'Compare accepted-to-working semantics or any two immutable historical revision selectors under the same current analyzer.' },
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
    inspectorBody.innerHTML = `<div class="inspector-title">${esc(entity.name ?? entity.id)}</div><div class="inspector-sub">${esc(entity.id)}<br>${esc(entity.locator ?? '')}</div><div style="margin:10px 0"><span class="badge">${esc(entity.kind)}</span> <span class="badge">${esc(entity.layer ?? 'structural')}</span></div>${(data.quickNotes ?? []).map((note: string) => `<div class="quick-note">${esc(note)}</div>`).join('')}<details style="margin-top:12px"><summary class="muted">Technical record</summary><pre class="raw">${esc(JSON.stringify(entity, null, 2))}</pre></details>`;
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

async function renderOverview(): Promise<void> {
  setHead();
  content.innerHTML = empty('Building overview', 'Synthesizing current project state from graph, coverage, checkpoint and sources…');
  const data = await getJson('/workbench/data', new URLSearchParams({ action: 'overview' }));
  const counts = data.counts ?? {};
  const currentness = data.currentness ?? {};
  content.innerHTML = `<div class="hero-grid"><div class="card"><h3>Quick documentation</h3><h2>${esc(viewerConfig.project)}</h2><p>${esc(data.summary)}</p>${(data.quickNotes ?? []).map((note: string) => `<div class="note"><span class="note-dot"></span><span>${esc(note)}</span></div>`).join('')}</div><div class="card"><h3>Current state</h3><div class="metric-grid">${metric('semantic concepts', counts.semantic ?? 0)}${metric('code entities', counts.structural ?? 0)}${metric('representations', counts.representation ?? 0)}${metric('evidence records', counts.evidence ?? 0)}${metric('candidate relations', counts.relationships?.candidate ?? 0)}${metric('conflicts', counts.conflicts ?? 0)}</div><p class="muted">Accepted semantic current: ${currentness.acceptedSemanticCurrent === true ? 'yes' : currentness.acceptedSemanticCurrent === false ? 'no' : 'unknown'}</p></div></div><div class="hero-grid" style="margin-top:14px"><div class="card"><h3>Important concepts</h3><div class="list">${(data.highlights ?? []).slice(0, 12).map((item: any) => nodeRow(item)).join('') || '<p>No explicit semantic concepts were discovered. Structural intelligence is still available in Explore.</p>'}</div></div><div class="card"><h3>Repository areas</h3><div class="list">${(data.areas ?? []).map((area: any) => `<div class="row"><span class="row-main"><strong>${esc(area.name)}</strong><small>${esc(area.count)} mapped entities</small></span></div>`).join('')}</div></div></div><div class="card" style="margin-top:14px"><h3>Sources at a glance</h3><div class="grid">${(data.sources ?? []).map((source: any) => `<div class="source-card card"><span class="badge">${esc(source.type)}</span><h2 style="font-size:15px;margin-top:9px">${esc(source.label)}</h2><p>${esc((source.capabilities ?? []).join(' · '))}</p><div class="source-status status-good">${source.configured ? 'configured' : 'not configured'} · ${esc(source.access ?? 'read-only')}</div></div>`).join('')}</div></div>`;
  wireNodeButtons();
}

function exploreActions(): string {
  return `<div class="segmented" id="explore-modes">${(['summary', 'list', 'table', 'graph', 'raw'] as ExploreMode[]).map(mode => `<button data-mode="${mode}" class="${exploreMode === mode ? 'active' : ''}">${mode[0]!.toUpperCase()}${mode.slice(1)}</button>`).join('')}</div>`;
}

async function loadExplore(query = exploreQuery): Promise<void> {
  exploreQuery = query;
  setHead(exploreActions());
  for (const button of Array.from(sectionHead.querySelectorAll<HTMLButtonElement>('[data-mode]'))) button.addEventListener('click', () => { exploreMode = button.dataset.mode as ExploreMode; void renderExploreResult(); });
  content.innerHTML = `<form id="explore-search" class="query-box" style="grid-template-columns:minmax(0,1fr) auto"><textarea id="explore-input" placeholder="Search a feature, tool, route, file, function, provider…">${esc(exploreQuery)}</textarea><button class="primary" type="submit">Search</button></form><div id="explore-result">${empty('Loading intelligence', 'Searching the selected graph context…')}</div>`;
  const form = document.getElementById('explore-search') as HTMLFormElement;
  form.addEventListener('submit', event => { event.preventDefault(); exploreQuery = (document.getElementById('explore-input') as HTMLTextAreaElement).value.trim(); void fetchExplore(); });
  await fetchExplore();
}

async function fetchExplore(): Promise<void> {
  lastExplore = await getJson('/workbench/data', new URLSearchParams({ action: 'explore', ...(exploreQuery ? { query: exploreQuery } : {}) }));
  await renderExploreResult();
}

async function renderExploreResult(): Promise<void> {
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
  await renderGraph(root);
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

async function renderGraph(root: HTMLElement): Promise<void> {
  renderer?.kill(); renderer = null;
  root.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:8px"><div class="segmented">${(['architecture', 'parity', 'code'] as GraphLens[]).map(lens => `<button data-lens="${lens}" class="${graphLens === lens ? 'active' : ''}">${lens}</button>`).join('')}</div></div><div class="graph-shell"><div id="graph" class="graph" role="img" aria-label="Development Intelligence graph"></div><div id="graph-status" class="graph-status">Loading graph…</div></div>`;
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-lens]'))) button.addEventListener('click', () => { graphLens = button.dataset.lens as GraphLens; void renderGraph(root); });
  const projection = await getJson('/graph/data', new URLSearchParams({ view: graphLens, ...(exploreQuery ? { query: exploreQuery } : {}), limit: '700', depth: '2' })) as Projection;
  const container = document.getElementById('graph') as HTMLElement;
  const graphStatus = document.getElementById('graph-status') as HTMLElement;
  if (projection.ambiguous) { container.innerHTML = empty('Ambiguous search', 'Choose a result from Summary/List instead of forcing a combined graph.'); graphStatus.textContent = `${projection.candidates?.length ?? 0} candidates`; return; }
  const graph = new MultiGraph({ allowSelfLoops: false });
  projection.nodes.forEach((node, index) => { const point = graphPoint(node, index, projection.nodes.length); graph.addNode(node.id, { label: node.name ?? node.id, x: point.x, y: point.y, size: node.layer === 'semantic' ? 8 : node.kind === 'file' ? 6 : 4, color: graphColor(node), node }); });
  for (const edge of projection.edges) {
    if (!edge.from || !edge.to || !graph.hasNode(edge.from) || !graph.hasNode(edge.to) || edge.from === edge.to) continue;
    try { graph.addEdgeWithKey(edge.id, edge.from, edge.to, { size: edge.status === 'resolved' ? 1.2 : .75, color: edge.status === 'resolved' ? '#53667e' : edge.status === 'candidate' ? '#b9823c' : '#b94f56', edge }); } catch { /* graph truth stays inspectable in list/raw modes */ }
  }
  renderer = new Sigma(graph, container, { renderEdgeLabels: projection.nodes.length < 120, labelDensity: .15, labelGridCellSize: 85, labelRenderedSizeThreshold: 7, zIndex: true });
  renderer.on('clickNode', event => void openInspector(event.node));
  graphStatus.textContent = `${projection.nodes.length} nodes · ${projection.edges.length} relationships${projection.truncated ? ' · bounded' : ''}`;
}

async function renderQuery(prefill = ''): Promise<void> {
  setHead();
  content.innerHTML = empty('Loading sources', 'Preparing Development Intelligence and configured read-only technical sources…');
  const sourceData = await getJson('/workbench/data', new URLSearchParams({ action: 'sources' }));
  const queryable = (sourceData.sources ?? []).filter((source: any) => source.type === 'read-only-http');
  content.innerHTML = `<div class="card"><h3>Ask / query</h3><div class="query-box"><textarea id="query-text" placeholder="Try: What changed? What depends on query_parity? Show code for ownerPasswordMatches. Or choose a technical source and enter a database/log query.">${esc(prefill)}</textarea><select id="query-source"><option value="">Development Intelligence</option>${queryable.map((source: any) => `<option value="${esc(source.id)}"${preferredQuerySource === source.id ? ' selected' : ''}>${esc(source.label)} · ${esc((source.capabilities ?? []).join('/'))}</option>`).join('')}</select><button class="primary" id="run-query">Run</button></div><p class="muted">DI queries are deterministic projections over graph/code/change evidence. External technical sources are bounded read-only adapter requests and do not automatically become accepted topology.</p></div><div id="query-result" class="query-result"></div>`;
  const run = async () => {
    const text = (document.getElementById('query-text') as HTMLTextAreaElement).value.trim();
    const sourceId = (document.getElementById('query-source') as HTMLSelectElement).value;
    preferredQuerySource = sourceId;
    if (!text) return;
    const target = document.getElementById('query-result') as HTMLElement;
    target.innerHTML = empty('Running query', 'Gathering bounded evidence…');
    try {
      const result = await postJson('/workbench/query', { text, ...(sourceId ? { sourceId } : {}) });
      target.innerHTML = `<div class="card"><h3>${esc(result.intent ?? 'query')}</h3><div class="answer">${esc(result.answer ?? '')}</div>${renderQueryResult(result.result)}</div>`;
      wireNodeButtons(target);
      if (result.intent === 'inspect' && result.result?.entity) { selectedInspection = result.result; inspectorTab = 'summary'; renderInspector(); }
    } catch (error) { target.innerHTML = `<div class="card"><h3>Query failed</h3><p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p></div>`; }
  };
  (document.getElementById('run-query') as HTMLButtonElement).addEventListener('click', () => void run());
}

function parityStatusClass(status: string): string {
  if (status === 'satisfied') return 'status-good';
  if (status === 'unproven') return 'status-warn';
  return 'status-bad';
}

function parityExpectationLabel(result: any): string {
  if (result.type === 'entity') return result.expectation?.id ?? 'entity';
  return `${result.expectation?.from ?? '?'} ${result.expectation?.kind ?? '?'} ${result.expectation?.to ?? '?'}`;
}

function renderParityEvaluation(data: any): string {
  const counts = data.counts ?? {};
  const results = data.results ?? [];
  return `<div class="hero-grid"><div class="card"><h3>Contract result</h3><h2 class="${data.passed ? 'status-good' : 'status-warn'}">${data.passed ? 'Expectation satisfied' : 'Attention required'}</h2><p>${esc(data.note ?? '')}</p><p class="muted">Revision ${esc(data.revision ?? 'unknown')}</p></div><div class="card"><h3>Obligations</h3><div class="metric-grid">${metric('satisfied', counts.satisfied ?? 0)}${metric('missing', counts.missing ?? 0)}${metric('forbidden present', counts.forbiddenPresent ?? 0)}${metric('unproven', counts.unproven ?? 0)}</div></div></div><div class="card" style="margin-top:13px"><h3>Evaluation detail</h3><div class="list">${results.map((result: any) => `<div class="row"><span class="badge ${parityStatusClass(result.status)}">${esc(result.status)}</span><span class="row-main"><strong>${esc(parityExpectationLabel(result))}</strong><small>${esc(result.explanation ?? '')}${result.expectation?.rationale ? ` · ${esc(result.expectation.rationale)}` : ''}</small></span></div>`).join('')}</div></div><details style="margin-top:12px"><summary class="muted">Raw evaluation</summary><pre class="raw">${esc(JSON.stringify(data, null, 2))}</pre></details>`;
}

async function renderParity(): Promise<void> {
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
      target.innerHTML = renderParityEvaluation(result);
    } catch (error) {
      target.innerHTML = `<div class="card"><h3>Parity evaluation failed</h3><p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p></div>`;
    }
  };
  (document.getElementById('evaluate-parity') as HTMLButtonElement).addEventListener('click', () => void run());
}

function renderQueryResult(result: any): string {
  if (!result) return '';
  if (result.entity) return `<div class="list">${nodeRow(result.entity)}</div>`;
  if (Array.isArray(result.nodes)) return `<div class="list">${result.nodes.slice(0, 30).map(nodeRow).join('')}</div><details><summary class="muted">Raw result</summary><pre class="raw">${esc(JSON.stringify(result, null, 2))}</pre></details>`;
  if (result.data !== undefined) return `<pre class="raw">${esc(JSON.stringify(result.data, null, 2))}</pre>`;
  return `<pre class="raw">${esc(JSON.stringify(result, null, 2))}</pre>`;
}

async function renderSources(): Promise<void> {
  setHead();
  content.innerHTML = empty('Loading sources', 'Checking configured source capabilities and observed graph sources…');
  const data = await getJson('/workbench/data', new URLSearchParams({ action: 'sources' }));
  content.innerHTML = `<div class="card"><h3>Source contract</h3><h2>What Development Intelligence can actually see</h2><p>${esc(data.note)}</p></div><div class="grid" style="margin-top:13px">${(data.sources ?? []).map((source: any) => `<div class="source-card card"><span class="badge">${esc(source.type)}</span><h2 style="font-size:16px;margin-top:9px">${esc(source.label)}</h2><p>${esc(source.endpoint ?? '')}</p><p><strong>Capabilities:</strong> ${esc((source.capabilities ?? []).join(' · '))}</p><div class="source-status status-good">${source.configured ? 'configured' : 'unconfigured'} · ${esc(source.access ?? 'read-only')}</div>${source.type === 'read-only-http' ? `<button class="primary" data-query-source="${esc(source.id)}" style="margin-top:10px">Query source</button>` : ''}</div>`).join('')}</div><div class="card" style="margin-top:13px"><h3>Observed graph sources</h3><div class="list">${(data.observedGraphSources ?? []).map((source: any) => `<div class="row"><span class="badge ${source.available ? 'status-good' : 'status-bad'}">${source.available ? 'available' : 'unavailable'}</span><span class="row-main"><strong>${esc(source.kind)}</strong><small>${esc(source.locator)}${source.error ? ` · ${esc(source.error)}` : ''}</small></span></div>`).join('')}</div></div>`;
  for (const button of Array.from(content.querySelectorAll<HTMLButtonElement>('[data-query-source]'))) button.addEventListener('click', () => { preferredQuerySource = button.dataset.querySource!; void activateSection('query'); });
}

async function renderChanges(): Promise<void> {
  setHead();
  const defaultHead = viewerConfig.ref || 'HEAD';
  content.innerHTML = `<div class="card"><h3>Historical comparison</h3><h2>Compare any two repository states</h2><p>Leave the base empty for accepted → working semantic change. Historical comparisons replay both exact revisions through the same current analyzer.</p><div class="query-box" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;margin-top:13px"><input id="change-base" aria-label="Base revision selector" placeholder="Base: commit:&lt;sha&gt; or pr:75/head" style="border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:10px;padding:9px 11px"><input id="change-head" aria-label="Head revision selector" value="${esc(defaultHead)}" placeholder="Head: HEAD or pr:243/head" style="border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:10px;padding:9px 11px"><button class="primary" id="compare-revisions" type="button">Compare</button></div><p class="muted">Selectors: commit:&lt;full-sha&gt;, branch:&lt;name&gt;, tag:&lt;name&gt;, pr:&lt;number&gt;/head, /base, or /result.</p></div><div id="change-result" class="query-result"></div>`;
  const run = async () => {
    const baseRef = (document.getElementById('change-base') as HTMLInputElement).value.trim();
    const headRef = (document.getElementById('change-head') as HTMLInputElement).value.trim();
    const target = document.getElementById('change-result') as HTMLElement;
    target.innerHTML = empty('Loading change intelligence', baseRef ? 'Resolving and comparing immutable historical revisions…' : 'Comparing accepted semantic topology with current working reality…');
    try {
      const data = await getJson('/workbench/data', new URLSearchParams({ action: 'changes', ...(baseRef ? { baseRef } : {}), ...(headRef ? { headRef } : {}) }));
      const counts = data.counts ?? {};
      const baseIdentity = data.detail?.base?.identity;
      const headIdentity = data.detail?.head?.identity;
      const identity = baseIdentity && headIdentity ? `<p class="muted">${esc(baseIdentity.selector)} → ${esc(headIdentity.selector)}<br>${esc(baseIdentity.sha)} → ${esc(headIdentity.sha)}</p>` : '';
      target.innerHTML = `<div class="hero-grid"><div class="card"><h3>${data.mode === 'revision-to-revision' ? 'Historical replay' : 'Semantic change'}</h3><h2>${esc(data.summary ?? 'Accepted → working')}</h2>${identity}<p>${data.mode === 'revision-to-revision' ? 'Both revisions use the same current analyzer so project change is not confused with analyzer evolution.' : 'Accepted semantic comparison ignores line movement and provenance-only churn.'}</p></div><div class="card"><h3>Delta</h3><div class="metric-grid">${metric('added', counts.added ?? 0)}${metric('removed', counts.removed ?? 0)}${metric('changed', counts.changed ?? 0)}</div></div></div><div class="card" style="margin-top:13px"><h3>Change detail</h3>${renderChangeBucket(data.detail)}</div>`;
      wireNodeButtons(target);
    } catch (error) {
      target.innerHTML = `<div class="card"><h3>Comparison failed</h3><p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p></div>`;
    }
  };
  (document.getElementById('compare-revisions') as HTMLButtonElement).addEventListener('click', () => void run());
  await run();
}

function renderChangeBucket(detail: any): string {
  const semantic = detail?.semantic ?? (detail?.nodes && detail?.edges ? detail : null);
  if (!semantic) return `<pre class="raw">${esc(JSON.stringify(detail, null, 2))}</pre>`;
  const nodes = [
    ...(semantic.nodes?.added ?? []).map((item: any) => ({ ...item, _change: 'added' })),
    ...(semantic.nodes?.removed ?? []).map((item: any) => ({ ...item, _change: 'removed' })),
    ...(semantic.nodes?.changed ?? []).map((item: any) => ({ ...(item.after ?? item.before), _change: 'changed' })),
  ];
  if (!nodes.length) return empty('No semantic entity changes', 'Accepted and working semantic topology agree. Structural/code differences can still exist.');
  return `<div class="list">${nodes.map((node: any) => `<button class="row row-button" data-node="${esc(node.id)}"><span class="badge ${node._change === 'added' ? 'status-good' : node._change === 'removed' ? 'status-bad' : 'status-warn'}">${esc(node._change)}</span><span class="row-main"><strong>${esc(node.name ?? node.id)}</strong><small>${esc(node.kind ?? '')}</small></span></button>`).join('')}</div>`;
}

async function activateSection(next: Section): Promise<void> {
  section = next;
  for (const button of navButtons) button.classList.toggle('active', button.dataset.section === section);
  renderer?.kill(); renderer = null;
  try {
    if (section === 'overview') await renderOverview();
    else if (section === 'explore') await loadExplore();
    else if (section === 'parity') await renderParity();
    else if (section === 'query') await renderQuery();
    else if (section === 'sources') await renderSources();
    else await renderChanges();
  } catch (error) {
    setHead();
    content.innerHTML = `<div class="card"><h3>Workbench error</h3><p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p></div>`;
  }
}

for (const button of navButtons) button.addEventListener('click', () => void activateSection(button.dataset.section as Section));
projectSelect.addEventListener('change', () => { window.location.assign(`/workbench?project=${encodeURIComponent(projectSelect.value)}`); });
revisionForm.addEventListener('submit', event => { event.preventDefault(); const ref = revisionInput.value.trim(); if (!ref) return; window.location.assign(`/workbench?project=${encodeURIComponent(viewerConfig.project)}&ref=${encodeURIComponent(ref)}`); });
globalForm.addEventListener('submit', event => { event.preventDefault(); const value = globalInput.value.trim(); if (!value) return; section = 'query'; for (const button of navButtons) button.classList.toggle('active', button.dataset.section === 'query'); void renderQuery(value); });
document.addEventListener('keydown', event => { if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') { event.preventDefault(); globalInput.focus(); } });

void activateSection(section);
