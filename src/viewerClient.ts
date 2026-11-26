import { MultiGraph } from 'graphology';
import Sigma from 'sigma';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { oneDark } from '@codemirror/theme-one-dark';
import { createDockview, type DockviewApi } from 'dockview';
import dockviewCss from 'dockview/dist/styles/dockview.css';

declare global {
  interface Window {
    __DEVINT_VIEWER__?: { project: string; ref?: string; graphId?: string; accountGraphId?: string; section?: string; local?: boolean; machineBuild?: boolean; buildRevision?: string; revision?: string | null };
  }
}

type Section = 'overview' | 'explore' | 'semantics' | 'parity' | 'query' | 'sources' | 'changes' | 'local';
type ExploreMode = 'summary' | 'list' | 'table' | 'graph' | 'raw';
type GraphLens = 'architecture' | 'parity' | 'code';
type ProjectionNode = { id: string; kind: string; layer?: string; name?: string; locator?: string; value?: unknown; evidenceIds?: string[] };
type ProjectionEdge = { id: string; from: string | null; to: string | null; kind: string; status: string; strategy?: string; confidence?: number | null; evidenceIds?: string[] };
type Projection = { project: string; graphId?: string; revision?: string | null; sourceState?: { headRevision: string }; sourceFingerprint?: string | null; analyzerVersion?: string; selected?: string; ambiguous?: boolean; candidatesTruncated?: boolean; candidates?: Array<{ id: string; kind: string; layer: string; name: string | null; locator: string }>; nodes: ProjectionNode[]; edges: ProjectionEdge[]; evidence?: unknown[]; coverage?: any; truncated?: boolean };

const config = window.__DEVINT_VIEWER__;
if (!config?.project) throw new Error('Development Intelligence Workbench is missing project context');
const viewerConfig = config;

function savedPositiveSetting(name: string, fallback: number): number {
  try {
    const value = Number(window.localStorage.getItem(`di:${viewerConfig.project}:${name}`));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  } catch { return fallback; }
}
function savePositiveSetting(name: string, value: number): void {
  try { window.localStorage.setItem(`di:${viewerConfig.project}:${name}`, String(value)); } catch { /* session control remains usable */ }
}

const sectionHead = document.getElementById('section-head') as HTMLElement;
const content = document.getElementById('content') as HTMLElement;
const inspectorContext = document.getElementById('inspector-context') as HTMLElement;
const inspectorTabs = document.getElementById('inspector-tabs') as HTMLElement;
const inspectorBody = document.getElementById('inspector-body') as HTMLElement;
const inspectorProgress = document.createElement('div');
inspectorProgress.id = 'inspector-progress';
inspectorProgress.setAttribute('role', 'status');
inspectorProgress.setAttribute('aria-live', 'polite');
inspectorBody.before(inspectorProgress);
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
let graphLimit = savedPositiveSetting('graphNodes', 700);
let graphDepth = savedPositiveSetting('graphDepth', 2);
let queryPageSize = savedPositiveSetting('queryPageSize', 20);
let exploreQuery = '';
let auditOffset = 0;
let graphSelected = '';
let lastExplore: any = null;
let exploreSequence = 0;
let explorePending: { query: string; promise: Promise<void> } | null = null;
let querySequence = 0;
let graphIntentSequence = 0;
let selectedInspection: any = null;
let inspectionSequence = 0;
let inspectorTab = 'summary';
let renderer: Sigma | null = null;
let graphResizeObserver: ResizeObserver | null = null;
let graphKindFilter = '';
let graphStatusFilter = '';
let graphDirectionFilter = '';
let graphRelationshipFilter = '';
type GraphContext = { subject: string; query: string; investigation: boolean; direction: string; lens: GraphLens; kind: string; relationship: string; status: string; limit: number; depth: number; camera?: { x: number; y: number; ratio: number; angle: number } };
const graphHistory: GraphContext[] = [];
let preferredQuerySource = '';
let queryDraft = '';
const queryPanel = document.createElement('div');
const graphStyles = document.createElement('style');
graphStyles.textContent = `
  #inspector-progress:not(:empty),#explore-progress:not(:empty),#graph-progress:not(:empty),#query-progress:not(:empty){padding:7px 9px;color:#c6d8e8;font-size:12px;line-height:1.45}
  #inspector-progress:empty,#explore-progress:empty,#graph-progress:empty,#query-progress:empty{display:none}
  .inspector:has(#inspector-progress:not(:empty):not([hidden])){grid-template-rows:auto auto auto minmax(0,1fr)}
  .di-dockview .inspector:has(#inspector-progress:not(:empty):not([hidden])){grid-template-rows:auto auto auto auto minmax(0,1fr)}
  .graph-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:7px}
  .graph-toolbar button,.graph-toolbar summary,.graph-selection button{font-size:12px}
  .graph-filters{position:relative;color:#c6d8e8;font-size:12px}
  .graph-filters summary{cursor:pointer;list-style:none;border:1px solid #38516e;border-radius:6px;background:#14243a;padding:6px 9px}
  .graph-filter-menu{position:absolute;top:calc(100% + 5px);left:0;z-index:12;width:260px;max-height:min(260px,35vh);overflow:auto;padding:10px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px;background:#101c2b;border:1px solid #38516e;border-radius:8px;box-shadow:0 10px 30px #000a}
  .graph-filter-menu label{display:grid;gap:3px;min-width:0}.graph-filter-menu label:nth-child(-n+3){grid-column:1/-1}.graph-filter-menu select,.graph-filter-menu input{width:100%;min-width:0;background:#0d1624;color:#edf4ff;border:1px solid #38516e;border-radius:5px;padding:5px}
  .graph-selection{position:absolute;z-index:3;left:10px;top:10px;right:10px;display:flex;align-items:center;gap:5px;flex-wrap:wrap;pointer-events:none}
  .graph-selection>*{pointer-events:auto}.graph-selection [data-selection-name]{padding:6px 8px;border-radius:5px;background:#152a3b;color:#e8f7ff;font-size:12px;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .graph-shell{background:radial-gradient(ellipse at 50% 35%,#12283a 0%,#0a1523 55%,#070d15 100%)}
  .graph-shell canvas{outline-offset:-3px}.graph-status{max-width:calc(100% - 24px);line-height:1.4}
  .graph-toolbar button:focus-visible,.graph-filters summary:focus-visible,.graph-selection button:focus-visible{outline:2px solid #82dcff;outline-offset:2px}
  .graph-toolbar .active{border-color:#75d6f5;background:#1b3850;color:#fff}
  .graph-filter-summary{font-size:11px;color:#a9bed2;padding:0 0 5px;overflow-wrap:anywhere}
  .graph-selection [data-selection-name]{max-width:min(45%,320px)}
  @media(prefers-reduced-motion:reduce){.graph-shell *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;
document.head.append(graphStyles);
let queryPanelReady = false;
function updateQuestionScope(): void {
  const scope = queryPanel.querySelector<HTMLInputElement>('#query-scope');
  const label = queryPanel.querySelector<HTMLElement>('#query-active-scope');
  const clear = queryPanel.querySelector<HTMLButtonElement>('#query-clear-scope');
  if (!scope || !label || !clear) return;
  const value = scope.value.trim();
  label.textContent = value ? `Scoped to: ${scope.dataset.displayName || value}` : 'Scope: entire selected graph';
  clear.hidden = !value;
}
let graphRenderSequence = 0;
let activeInvestigation: any = null;
let investigationVisible = true;
let selectedGraphNodes = new Set<string>();
let selectedGraphEdges = new Set<string>();

function followInvestigation(selection: any): void {
  if (!selection?.graph?.graphId || !Array.isArray(selection.nodes) || !Array.isArray(selection.edges)) return;
  ++graphIntentSequence;
  graphHistory.length = 0;
  activeInvestigation = selection; investigationVisible = true; selectedGraphNodes.clear(); selectedGraphEdges.clear(); graphSelected = ''; graphDirectionFilter = '';
  exploreMode = 'graph';
  if (section === 'explore') void renderExploreResult(sectionEpoch);
  else void activateSection('explore');
}
function investigationGraphId(): string | undefined {
  return section === 'explore' && investigationVisible ? activeInvestigation?.graph?.graphId : undefined;
}
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
  parity: { title: 'Parity', description: 'Compare interaction paths across revisions and inspect their supporting graph evidence. Optional expectations can be evaluated separately.' },
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
  if (!params.has('graphId') && !params.has('ref')) {
    if (viewerConfig.graphId) params.set('graphId', viewerConfig.graphId);
    else if (viewerConfig.ref) params.set('ref', viewerConfig.ref);
  }
  return params;
}

type ProgressReporter = (message: string) => void;

async function getJson(path: string, params: URLSearchParams, progress?: ProgressReporter): Promise<any> {
  if (viewerConfig.accountGraphId) return await accountInvestigation({ path, method: 'GET', query: withContext(params).toString() }, progress);
  const response = await fetch(`${path}?${withContext(params).toString()}`, { headers: { accept: 'application/json' } });
  if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`); throw new Error('Authentication required'); }
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

async function postJson(path: string, body: Record<string, unknown>, progress?: ProgressReporter): Promise<any> {
  if (viewerConfig.accountGraphId) return await accountInvestigation({ path, method: 'POST', body }, progress);
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ project: viewerConfig.project, ...(!body.graphId && viewerConfig.ref ? { ref: viewerConfig.ref } : {}), ...(!body.graphId && viewerConfig.graphId ? { graphId: viewerConfig.graphId } : {}), ...body }) });
  if (response.status === 401) { window.location.assign(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`); throw new Error('Authentication required'); }
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

async function accountInvestigation(request: Record<string, unknown>, progress?: ProgressReporter): Promise<any> {
  progress?.('Starting request for the saved snapshot…');
  let created: Response;
  try { created = await fetch('/account/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'investigate-graph', graphId: viewerConfig.accountGraphId, snapshotGraphId: viewerConfig.graphId, request }) }); }
  catch { throw new Error('Could not confirm whether the request started. It may still be running; try again only if needed.'); }
  if (created.status === 401) { window.location.assign('/account'); throw new Error('Sign in to continue'); }
  const job = await created.json();
  if (!created.ok) throw new Error(job.error ?? 'Could not start investigation');
  let interruptions = 0;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, interruptions ? 3000 : 1000));
    let response: Response;
    try { response = await fetch(`/account/workspace?job=${encodeURIComponent(job.id)}`); }
    catch {
      progress?.('Connection interrupted; checking the same request again…');
      if (++interruptions < 4) continue;
      throw new Error('Lost the connection to this request. It may still be running; try again only if needed.');
    }
    if (response.status === 401) { window.location.assign('/account'); throw new Error('Sign in to continue'); }
    const current = await response.json();
    if (!response.ok || !current) throw new Error(current?.error ?? 'Investigation unavailable');
    interruptions = 0;
    const stage = current.progress?.stage;
    const stages: Record<string, string> = { 'starting-hosted-worker': 'Starting the hosted worker…', 'preparing-hosted-worker': 'Preparing the hosted worker…', starting: 'Starting the query service…', 'querying-snapshot': 'Reading the saved snapshot…', 'transferring-investigation': 'Transferring the result…' };
    progress?.(current.state === 'queued' ? 'Waiting for the query service…' : stages[stage] ?? 'Working with the saved snapshot…');
    if (current.state === 'complete') {
      if (!current.resultParts) return current.result;
      progress?.('Retrieving the result…');
      const chunks: Uint8Array[] = [];
      for (let index = 0; index < current.resultParts; index++) {
        const partResponse = await fetch(`/account/workspace?job=${encodeURIComponent(job.id)}&part=${index}`);
        if (!partResponse.ok) throw new Error('Could not retrieve investigation result');
        const { part } = await partResponse.json();
        const binary = atob(part);
        chunks.push(Uint8Array.from(binary, character => character.charCodeAt(0)));
      }
      const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0), bytes = new Uint8Array(length);
      let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    if (current.state === 'failed') throw new Error(current.error ?? 'Investigation failed');
  }
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

function preserveGraphSelection(): void {
  const progress = document.getElementById('graph-progress');
  if (progress?.textContent) {
    ++graphRenderSequence;
    progress.textContent = 'Selection changed. The previous graph request will not replace it.';
  }
}

function wireNodeButtons(root: ParentNode = content, graphId?: string): void {
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-node]'))) {
    button.addEventListener('click', () => {
      const id = button.dataset.node!;
      ++graphIntentSequence; preserveGraphSelection();
      const explicitGraph = button.dataset.graphId || graphId;
      if (section === 'explore' && renderer && (!explicitGraph || explicitGraph === investigationGraphId())) {
        const graph = renderer.getGraph();
        if (graph.hasNode(id)) {
          graphSelected = id; selectedGraphNodes.clear(); selectedGraphNodes.add(id);
          renderer.refresh();
          const scope = document.getElementById('graph-scope') as HTMLButtonElement | null;
          if (scope) { scope.disabled = false; scope.hidden = false; }
          const compare = document.getElementById('graph-compare-selection'); if (compare) compare.hidden = false;
          const label = document.getElementById('graph-selected-label');
          if (label) { label.textContent = `Selected: ${graph.getNodeAttribute(id, 'label')}`; label.hidden = false; }
          for (const id of ['graph-neighborhood', 'graph-clear-selection']) { const control = document.getElementById(id); if (control) control.hidden = false; }
          const neighborhood = document.getElementById('graph-neighborhood') as HTMLButtonElement | null; if (neighborhood) neighborhood.disabled = false;
        }
      }
      void openInspector(id, explicitGraph, button.querySelector('strong')?.textContent ?? undefined);
    });
  }
}

function assessmentStatusClass(status: string): string {
  if (status === 'supported') return 'status-good';
  if (status === 'contradicted') return 'status-bad';
  return 'status-warn';
}

function renderAssessment(data: any, compact = false, context?: any): string {
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
  return `<div class="assessment"><div class="assessment-head"><div><h3>Evidence-backed assessment</h3><h2 class="${assessmentStatusClass(data.answerStatus)}">${esc(data.answerStatus)}</h2></div><div class="assessment-meta">Revision ${esc(data.revision ?? (context?.sourceState?.headRevision ? `working files · HEAD ${context.sourceState.headRevision}` : context?.revision ?? 'unknown'))}<br>${esc(coverageLabel)}</div></div>${facets.length ? `<div class="assessment-section"><h3>Capability realization</h3><div class="assessment-facets">${facetRows}</div></div>` : ''}${reachSection}<div class="assessment-section"><h3>Claims and proof</h3><div class="list">${claimRows}</div></div>${hypotheses.length ? `<div class="assessment-section"><h3>Suggested relationships</h3><p class="muted">Candidates are hypotheses for follow-up inspection, not findings and not proof.</p><div class="list">${hypothesisRows}</div></div>` : ''}${findings.length ? `<div class="assessment-section"><h3>Finding groups</h3><p class="muted">${esc(findingScopeLabel)}</p><div class="list">${findingGroupRows}</div>${compact ? '' : `<details><summary class="muted">${esc(findings.length)} underlying findings</summary><div class="list" style="margin-top:8px">${findingRows}</div></details>`}</div>` : ''}${compact ? '' : `<details><summary class="muted">Raw assessment record</summary><pre class="raw">${esc(JSON.stringify(data, null, 2))}</pre></details>`}</div>`;
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
    const families = (data.families ?? []).filter((family: any) => family.subject && family.id !== entity.id);
    const facts = (data.facts ?? []).map((item: any) => `<button class="row row-button" data-node="${esc(item.fact.id)}"><span class="row-main"><strong>${esc(item.relationship.kind)}</strong><small>${esc(String(item.fact.raw ?? item.fact.name ?? '').split('\n')[0])}${String(item.fact.raw ?? item.fact.name ?? '').includes('\n') ? ' …' : ''}</small></span></button>`).join('');
    inspectorBody.innerHTML = `<div class="inspector-title">${esc(entity.name ?? entity.id)}</div><div class="inspector-sub">${esc(entity.locator ?? '')}</div><div style="margin:10px 0"><span class="badge">${esc(entity.kind)}</span> <span class="badge">${esc(entity.layer ?? 'structural')}</span></div>${(data.quickNotes ?? []).map((note: string) => `<div class="quick-note">${esc(note)}</div>`).join('')}${facts ? `<h3>Source facts</h3><div class="list">${facts}</div>` : ''}${families.length ? `<h3>Related subjects</h3><div class="list">${families.map((family: any) => `<button class="row row-button" data-node="${esc(family.id)}"><span class="row-main"><strong>${esc(family.subject.name)}</strong><small>${esc(family.roles.join(', '))} · ${esc(family.subject.locator)}</small></span></button>`).join('')}</div>` : ''}${(data.familyMembers ?? []).length ? `<details><summary>Connected context (${data.familyMembers.length})</summary><div class="list">${data.familyMembers.map((member: any) => `<button class="row row-button" data-node="${esc(member.id)}"><span class="row-main"><strong>${esc(member.name)}</strong><small>${esc(member.roles.join(', '))} · ${esc(member.locator)}</small></span></button>`).join('')}</div></details>` : ''}${(entity.contributions ?? []).length ? `<h3>Source analysis contributions</h3>${entity.contributions.map((item: any) => `<div class="quick-note">${esc(item.producer)} ${esc(item.version)} · ${esc(item.locator)}</div>`).join('')}` : ''}${renderAssessment(data.assessment, true, data)}<details style="margin-top:12px"><summary class="muted">Technical record</summary><pre class="raw">${esc(JSON.stringify(entity, null, 2))}</pre></details>`;
    wireNodeButtons(inspectorBody, data.graphId);
    if (data.investigation) { const button = document.createElement('button'); button.textContent = 'Show connections on graph'; button.addEventListener('click', () => followInvestigation(data.investigation)); inspectorBody.prepend(button); }
    return;
  }
  if (inspectorTab === 'connections') {
    inspectorBody.innerHTML = (data.connections ?? []).length ? `<div class="list">${data.connections.map((item: any) => `<div><button class="row row-button" ${item.neighbor ? `data-node="${esc(item.neighbor.id)}"` : 'disabled'}><span class="badge ${item.status === 'resolved' ? 'status-good' : item.status === 'candidate' ? 'status-warn' : 'status-bad'}">${esc(item.status)}</span><span class="row-main"><strong>${esc(item.direction === 'outbound' ? '→' : '←')} ${esc(item.neighbor?.name ?? 'unresolved')}</strong><small>${esc(item.kind)} · ${esc(item.neighbor?.kind ?? '')}</small></span></button><button type="button" data-relationship="${esc(item.edgeId)}">Inspect relationship</button></div>`).join('')}</div>` : empty('No visible connections', 'This entity has no relationships in the selected graph context.');
    wireNodeButtons(inspectorBody, data.graphId);
    for (const button of Array.from(inspectorBody.querySelectorAll<HTMLButtonElement>('[data-relationship]'))) button.addEventListener('click', () => {
      const item = data.connections.find((value: any) => value.edgeId === button.dataset.relationship);
      if (!item) return;
      const name = entity.name ?? entity.id, other = item.neighbor?.name ?? 'unresolved';
      void openRelationship({ id: item.edgeId, kind: item.kind, status: item.status, from: null, to: null },
        item.direction === 'outbound' ? name : other, item.direction === 'outbound' ? other : name, data.graphId);
    });
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

async function openInspector(node: string, selectedGraphId?: string, displayName?: string): Promise<void> {
  const sequence = ++inspectionSequence;
  const hasPrevious = Boolean(selectedInspection || inspectorContext.textContent === 'Relationship');
  const update = (message: string) => { if (sequence === inspectionSequence) inspectorProgress.textContent = message ? `Inspecting ${displayName ?? node}: ${message}${hasPrevious ? ' Previous details remain visible.' : ''}` : ''; };
  update('Starting…');
  const graphId = selectedGraphId ?? investigationGraphId();
  try {
    const result = await getJson('/workbench/data', new URLSearchParams({ action: 'inspect', node, ...(graphId ? { graphId } : {}) }), update);
    if (sequence !== inspectionSequence) return;
    selectedInspection = result; inspectorTab = 'summary'; update(''); renderInspector();
  } catch (error) {
    if (sequence !== inspectionSequence) return;
    inspectorProgress.textContent = `Could not inspect selection: ${error instanceof Error ? error.message : String(error)} `;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry inspection';
    retry.onclick = () => void openInspector(node, selectedGraphId, displayName); inspectorProgress.append(retry);
  }
}

async function openRelationship(edge: ProjectionEdge, from: string, to: string, selectedGraphId?: string): Promise<void> {
  const sequence = ++inspectionSequence;
  const update = (message: string) => { if (sequence === inspectionSequence) inspectorProgress.textContent = message ? `Inspecting ${from} → ${to}: ${message} Previous details remain visible.` : ''; };
  update('Starting…');
  const graphId = selectedGraphId ?? investigationGraphId();
  try {
    const data = await getJson('/workbench/data', new URLSearchParams({ action: 'relationship', edge: edge.id, ...(graphId ? { graphId } : {}) }), update) as any;
    if (sequence !== inspectionSequence) return;
    update(''); inspectorContext.textContent = 'Relationship'; inspectorTabs.innerHTML = '';
    const record = data.edge ?? edge;
    inspectorBody.innerHTML = `<div class="inspector-title">${esc(from)} → ${esc(to)}</div><div class="inspector-sub">${esc(record.kind)} · ${esc(record.status)}</div>${record.strategy ? `<div class="quick-note">Source: ${esc(record.strategy)}</div>` : ''}<h3>Evidence</h3>${(data.evidence ?? []).map((item: any) => `<div class="evidence-item"><strong>${esc(item.message ?? item.kind ?? 'evidence')}</strong><br><span class="muted">${esc(item.locator ?? item.sourceId ?? '')}</span></div>`).join('')}${(record.evidence ?? []).map((item: string) => `<div class="quick-note">${esc(item)}</div>`).join('') || (!(data.evidence ?? []).length ? '<p>No attached evidence records.</p>' : '')}<details><summary class="muted">Technical record</summary><pre class="raw">${esc(JSON.stringify(record, null, 2))}</pre></details>`;
  } catch (error) {
    if (sequence !== inspectionSequence) return;
    inspectorProgress.textContent = `Could not inspect relationship: ${error instanceof Error ? error.message : String(error)} `;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry relationship';
    retry.onclick = () => void openRelationship(edge, from, to, selectedGraphId); inspectorProgress.append(retry);
  }
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
  for (const button of Array.from(sectionHead.querySelectorAll<HTMLButtonElement>('[data-mode]'))) button.addEventListener('click', () => { exploreMode = button.dataset.mode as ExploreMode; if (exploreMode !== 'graph' && !lastExplore?.nodes) void fetchExplore(epoch); else void renderExploreResult(epoch); });
  content.innerHTML = `<form id="explore-search" class="query-box" style="grid-template-columns:minmax(0,1fr) auto auto"><input id="explore-input" aria-label="Search the graph" placeholder="Search the graph" value="${esc(exploreQuery)}"><button class="primary" type="submit">Search</button><button type="button" id="explore-audit">Audit</button></form><div id="explore-progress" role="status" aria-live="polite"></div><div id="graph-progress" role="status" aria-live="polite"></div><div class="investigation-layout"><div id="explore-result">${empty('Loading intelligence', 'Searching the selected graph context…')}</div><aside id="investigation-query" aria-label="Questions and answers"></aside></div>`;
  const form = document.getElementById('explore-search') as HTMLFormElement;
  form.addEventListener('submit', event => { event.preventDefault(); exploreQuery = (document.getElementById('explore-input') as HTMLInputElement).value.trim(); ++graphIntentSequence; graphHistory.length = 0; selectedGraphNodes.clear(); selectedGraphEdges.clear(); graphSelected = ''; graphDirectionFilter = ''; investigationVisible = false; if (exploreMode === 'graph') { ++exploreSequence; explorePending = null; lastExplore = {}; void renderExploreResult(epoch); } else void fetchExplore(epoch); });
  const showAudit = async () => {
    try {
      const result = await getJson('/workbench/data', new URLSearchParams({ action: 'audit', offset: String(auditOffset), ...(investigationGraphId() ? { graphId: investigationGraphId()! } : {}) }));
      const panel = document.getElementById('query-result');
      if (panel) {
        panel.innerHTML = `<div class="card"><h3>Repository audit</h3><p>${esc(result.findingSummary?.total ?? 0)} findings · ${(result.investigationTargets ?? []).length} investigation targets shown</p><div class="list">${(result.investigationTargets ?? []).map((item: any, index: number) => `<div class="row"><span class="row-main">${esc(item.summary ?? item.title ?? item.kind ?? '')}</span>${item.investigation?.nodes?.length ? `<button type="button" data-audit-target="${index}">Show on graph</button>` : ''}</div>`).join('')}</div>${result.interactionReachability?.page?.nextOffset != null ? '<button type="button" id="audit-next">More unconnected callables</button>' : ''}</div>`;
        panel.querySelectorAll<HTMLButtonElement>('[data-audit-target]').forEach(button => button.addEventListener('click', () => followInvestigation(result.investigationTargets[Number(button.dataset.auditTarget)].investigation)));
        panel.querySelector<HTMLButtonElement>('#audit-next')?.addEventListener('click', () => { auditOffset = result.interactionReachability.page.nextOffset; void showAudit(); });
      }
      if (result.investigation) followInvestigation(result.investigation);
    } catch (error) { const panel = document.getElementById('query-result'); if (panel) panel.textContent = String(error); }
  };
  document.getElementById('explore-audit')?.addEventListener('click', () => { auditOffset = 0; void showAudit(); });
  const queryHost = (document.getElementById('question-dock') ?? document.getElementById('investigation-query')) as HTMLElement;
  if (exploreMode === 'graph') { lastExplore = {}; await Promise.all([renderExploreResult(epoch), renderQuery(epoch, '', queryHost)]); }
  else await Promise.all([fetchExplore(epoch), renderQuery(epoch, '', queryHost)]);
}

async function fetchExplore(epoch: number): Promise<void> {
  const query = exploreQuery;
  if (explorePending?.query === query) return explorePending.promise;
  const sequence = ++exploreSequence;
  const status = document.getElementById('explore-progress');
  const current = () => sequence === exploreSequence && sectionIsCurrent(epoch, 'explore');
  const update = (message: string) => { if (current() && status?.isConnected) status.textContent = message ? `${query ? `Searching for “${query}”` : 'Loading graph list'}: ${message}` : ''; };
  update('Starting…');
  const promise = (async () => {
    try {
      const result = await getJson('/workbench/data', new URLSearchParams({ action: 'explore', ...(query ? { query } : {}) }), update);
      if (!current()) return;
      lastExplore = result;
      update('');
      await renderExploreResult(epoch);
    } catch (error) {
      if (!current() || !status?.isConnected) return;
      status.textContent = `Search unavailable: ${error instanceof Error ? error.message : String(error)} `;
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry search';
      retry.onclick = () => { explorePending = null; void fetchExplore(epoch); }; status.append(retry);
    } finally {
      if (sequence === exploreSequence) explorePending = null;
    }
  })();
  explorePending = { query, promise };
  return promise;
}

async function renderExploreResult(epoch: number): Promise<void> {
  if (!sectionIsCurrent(epoch, 'explore')) return;
  const root = document.getElementById('explore-result') as HTMLElement;
  for (const button of Array.from(sectionHead.querySelectorAll<HTMLButtonElement>('[data-mode]'))) button.classList.toggle('active', button.dataset.mode === exploreMode);
  if (!lastExplore) return;
  if (exploreMode !== 'graph') { graphResizeObserver?.disconnect(); graphResizeObserver = null; renderer?.kill(); renderer = null; }
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

async function renderGraph(root: HTMLElement, epoch: number, restoreCamera?: GraphContext['camera']): Promise<void> {
  const sequence = ++graphRenderSequence;
  const selected = investigationVisible && activeInvestigation;
  const displayedContext: GraphContext = { subject: graphSelected, query: exploreQuery, investigation: Boolean(selected), direction: graphDirectionFilter, lens: graphLens, kind: graphKindFilter, relationship: graphRelationshipFilter, status: graphStatusFilter, limit: graphLimit, depth: graphDepth };
  const progress = document.getElementById('graph-progress');
  const current = () => sectionIsCurrent(epoch, 'explore') && sequence === graphRenderSequence && exploreMode === 'graph';
  const graphRequest = graphSelected ? 'Loading selected subject' : exploreQuery ? `Searching graph for “${exploreQuery}”` : 'Loading graph';
  const update = (message: string) => { if (current() && progress?.isConnected) progress.textContent = message ? `${graphRequest}: ${message}` : ''; };
  update('Starting…');
  let allProjection: Projection;
  try {
    allProjection = selected ? { ...selected.graph, nodes: selected.nodes, edges: selected.edges, evidence: selected.evidence, coverage: selected.coverage } as Projection
      : await getJson('/graph/data', new URLSearchParams({ view: graphLens, ...(graphSelected ? { node: graphSelected } : exploreQuery ? { query: exploreQuery } : {}), limit: String(graphLimit), depth: String(graphDepth) }), update) as Projection;
  } catch (error) {
    if (!current() || !progress?.isConnected) return;
    progress.textContent = `Graph unavailable: ${error instanceof Error ? error.message : String(error)}${renderer ? ' Previous graph remains visible.' : ''} `;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry graph';
    retry.onclick = () => void renderGraph(root, epoch); progress.append(retry);
    return;
  }
  if (!current()) return;
  update('');
  graphResizeObserver?.disconnect(); graphResizeObserver = null;
  renderer?.kill(); renderer = null;
  root.innerHTML = `<div class="graph-toolbar"><div class="segmented" aria-label="Graph view">${(['architecture', 'parity', 'code'] as GraphLens[]).map(lens => `<button type="button" data-lens="${lens}" aria-pressed="${graphLens === lens}" class="${graphLens === lens ? 'active' : ''}">${lens}</button>`).join('')}</div><details class="graph-filters"><summary>Filters${graphKindFilter || graphStatusFilter || graphRelationshipFilter || graphDirectionFilter || graphLimit !== 700 || graphDepth !== 2 ? ' • active' : ''}</summary><div class="graph-filter-menu"><label>Subject kind<select id="graph-kind" aria-label="Subject kind"><option value="">All visible kinds</option></select></label><label>Relationship kind<select id="graph-edge-kind" aria-label="Relationship kind"><option value="">All visible relationships</option></select></label><label>Relationship status<select id="graph-edge-status" aria-label="Relationship status"><option value="">All statuses</option><option value="resolved">Resolved</option><option value="candidate">Candidate</option><option value="unresolved">Unresolved</option></select></label><label>Direction from selected subject<select id="graph-direction" aria-label="Direction from selected subject"><option value="">Both directions</option><option value="outbound">Outgoing</option><option value="inbound">Incoming</option></select></label><label>Maximum nodes<input id="graph-limit" aria-label="Graph node limit" type="number" min="1" value="${graphLimit}"></label><label>Traversal depth<input id="graph-depth" aria-label="Graph traversal depth" type="number" min="1" value="${graphDepth}"></label><button id="graph-apply" type="button">Apply</button><button id="graph-clear-filters" type="button">Clear filters</button></div></details><button id="graph-back" type="button" ${graphHistory.length ? '' : 'disabled'}>Back</button><button id="graph-zoom-in" type="button" aria-label="Zoom in">+</button><button id="graph-zoom-out" type="button" aria-label="Zoom out">−</button><button id="graph-reset" type="button">Fit graph</button>${activeInvestigation ? `<button id="graph-follow" type="button">${investigationVisible ? 'Show graph context' : 'Show investigation'}</button>` : ''}</div><div class="graph-filter-summary" id="graph-filter-summary"></div><div class="graph-shell"><div id="graph" class="graph" role="img" aria-label="Development Intelligence graph. Use the list view for keyboard navigation."></div><div class="graph-selection"><span id="graph-selected-label" data-selection-name hidden></span><button id="graph-neighborhood" type="button" hidden>Explore neighborhood</button><button id="graph-clear-selection" type="button" hidden>Clear selection</button><button id="graph-scope" type="button" disabled hidden>Use for question</button><button id="graph-compare-selection" type="button" hidden>Use for comparison</button></div><div id="graph-status" class="graph-status" role="status">Loading graph…</div></div><div id="graph-information"></div><div id="graph-choices"></div>`;
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-lens]'))) button.addEventListener('click', () => { ++graphIntentSequence; graphLens = button.dataset.lens as GraphLens; void renderGraph(root, epoch); });
  root.querySelector<HTMLButtonElement>('#graph-apply')?.addEventListener('click', () => {
    const size = Number(root.querySelector<HTMLInputElement>('#graph-limit')?.value);
    const depth = Number(root.querySelector<HTMLInputElement>('#graph-depth')?.value);
    if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(depth) || depth < 1) {
      const status = root.querySelector<HTMLElement>('#graph-status');
      if (status) status.textContent = 'Enter positive whole numbers for nodes and depth.';
      return;
    }
    const direction = root.querySelector<HTMLSelectElement>('#graph-direction')?.value ?? '';
    if (direction && !graphSelected) { const status = root.querySelector<HTMLElement>('#graph-status'); if (status) status.textContent = 'Select a subject before choosing a direction.'; return; }
    ++graphIntentSequence;
    graphKindFilter = root.querySelector<HTMLSelectElement>('#graph-kind')?.value ?? '';
    graphStatusFilter = root.querySelector<HTMLSelectElement>('#graph-edge-status')?.value ?? '';
    graphRelationshipFilter = root.querySelector<HTMLSelectElement>('#graph-edge-kind')?.value ?? '';
    graphDirectionFilter = direction;
    graphLimit = size; graphDepth = depth;
    savePositiveSetting('graphNodes', size); savePositiveSetting('graphDepth', depth);
    void renderGraph(root, epoch);
  });
  root.querySelector<HTMLButtonElement>('#graph-clear-filters')?.addEventListener('click', () => {
    ++graphIntentSequence;
    graphKindFilter = ''; graphStatusFilter = ''; graphRelationshipFilter = ''; graphDirectionFilter = ''; graphLimit = 700; graphDepth = 2;
    savePositiveSetting('graphNodes', graphLimit); savePositiveSetting('graphDepth', graphDepth);
    void renderGraph(root, epoch);
  });
  root.querySelector<HTMLButtonElement>('#graph-follow')?.addEventListener('click', () => { ++graphIntentSequence; graphHistory.length = 0; investigationVisible = !investigationVisible; graphSelected = ''; graphDirectionFilter = ''; selectedGraphNodes.clear(); selectedGraphEdges.clear(); void renderGraph(root, epoch); });
  root.querySelector<HTMLButtonElement>('#graph-back')?.addEventListener('click', () => {
    const previous = graphHistory.pop(); if (!previous) return;
    ++graphIntentSequence; graphSelected = previous.subject; exploreQuery = previous.query; investigationVisible = previous.investigation; graphDirectionFilter = previous.direction;
    graphLens = previous.lens; graphKindFilter = previous.kind; graphRelationshipFilter = previous.relationship; graphStatusFilter = previous.status; graphLimit = previous.limit; graphDepth = previous.depth;
    selectedGraphNodes.clear(); selectedGraphEdges.clear();
    const input = document.getElementById('explore-input') as HTMLInputElement | null; if (input) input.value = exploreQuery;
    void renderGraph(root, epoch, previous.camera);
  });
  const kindSelect = root.querySelector<HTMLSelectElement>('#graph-kind')!;
  for (const kind of [...new Set(allProjection.nodes.map(node => node.kind))].sort()) kindSelect.add(new Option(kind, kind));
  if (graphKindFilter && !Array.from(kindSelect.options).some(option => option.value === graphKindFilter)) kindSelect.add(new Option(`${graphKindFilter} (not in this view)`, graphKindFilter));
  kindSelect.value = graphKindFilter;
  const edgeKind = root.querySelector<HTMLSelectElement>('#graph-edge-kind')!;
  for (const kind of [...new Set(allProjection.edges.map(edge => edge.kind))].sort()) edgeKind.add(new Option(kind, kind));
  if (graphRelationshipFilter && !Array.from(edgeKind.options).some(option => option.value === graphRelationshipFilter)) edgeKind.add(new Option(`${graphRelationshipFilter} (not in this view)`, graphRelationshipFilter));
  edgeKind.value = graphRelationshipFilter;
  root.querySelector<HTMLSelectElement>('#graph-edge-status')!.value = graphStatusFilter;
  const filterSummary = root.querySelector<HTMLElement>('#graph-filter-summary')!;
  const activeFilters = [graphKindFilter && `subjects: ${graphKindFilter}`, graphRelationshipFilter && `relationships: ${graphRelationshipFilter}`, graphStatusFilter && `status: ${graphStatusFilter}`, graphDirectionFilter && `direction: ${graphDirectionFilter}`, graphLimit !== 700 && `limit: ${graphLimit}`, graphDepth !== 2 && `depth: ${graphDepth}`].filter(Boolean);
  filterSummary.textContent = activeFilters.length ? `Active filters: ${activeFilters.join(' · ')}` : '';
  root.querySelector<HTMLSelectElement>('#graph-direction')!.value = graphDirectionFilter;
  const visibleNodes = allProjection.nodes.filter(node => !graphKindFilter || node.kind === graphKindFilter || (!!graphDirectionFilter && node.id === graphSelected));
  const visibleIds = new Set(visibleNodes.map(node => node.id));
  const projection: Projection = { ...allProjection, nodes: visibleNodes, edges: allProjection.edges.filter(edge => (!graphStatusFilter || edge.status === graphStatusFilter) && (!graphRelationshipFilter || edge.kind === graphRelationshipFilter) && (!graphDirectionFilter || (graphDirectionFilter === 'outbound' ? edge.from === graphSelected : edge.to === graphSelected)) && !!edge.from && !!edge.to && visibleIds.has(edge.from) && visibleIds.has(edge.to)) };
  if (!selected && !allProjection.nodes.length && !projection.ambiguous && graphLens === 'architecture') {
    graphLens = 'code';
    await renderGraph(root, epoch);
    return;
  }
  const container = document.getElementById('graph') as HTMLElement;
  const graphStatus = document.getElementById('graph-status') as HTMLElement;
  const information = root.querySelector<HTMLElement>('#graph-information');
  if (information) {
    const coverage = projection.coverage;
    const source = projection.revision ?? (projection.sourceState ? `working files · HEAD ${projection.sourceState.headRevision}` : 'unknown');
    information.innerHTML = `<details><summary>Graph source and coverage</summary><p>Source: ${esc(source)}<br>Analyzer: ${esc(projection.analyzerVersion ?? 'unknown')}<br>Graph: ${esc(projection.graphId ?? 'unknown')}</p>${coverage ? `<p>Files: ${esc(coverage.analyzedFiles)} analyzed of ${esc(coverage.eligibleFiles)} eligible · ${esc(coverage.partialFiles)} partial · ${esc(coverage.failedFiles)} failed · ${esc(coverage.unsupportedFiles)} unsupported</p>${(coverage.producerCoverage ?? []).map((item: any) => `<p>${esc(item.producer)}: ${esc(item.state)}${item.reason ? ` — ${esc(item.reason)}` : ''}</p>`).join('')}` : '<p>Coverage is unavailable.</p>'}</details>`;
  }
  if (projection.ambiguous) {
    container.innerHTML = empty('Choose a subject', 'Several graph subjects match. Select one below to see its neighborhood.');
    graphStatus.textContent = `${projection.candidates?.length ?? 0} candidates${projection.candidatesTruncated ? ' shown · increase Nodes to see more' : ''}`;
    const choices = document.getElementById('graph-choices')!;
    choices.innerHTML = `<div class="card"><h3>Matching subjects</h3><div class="list">${(projection.candidates ?? []).map(node => `<button class="row row-button" data-graph-choice="${esc(node.id)}"><span class="badge">${esc(node.kind)}</span><span class="row-main"><strong>${esc(node.name ?? node.id)}</strong><small>${esc(node.locator)}</small></span><span>→</span></button>`).join('')}</div></div>`;
    for (const button of Array.from(choices.querySelectorAll<HTMLButtonElement>('[data-graph-choice]'))) button.addEventListener('click', () => { ++graphIntentSequence; graphSelected = button.dataset.graphChoice!; void renderGraph(root, epoch); });
    return;
  }
  if (!projection.nodes.length) { container.innerHTML = empty('No graph subjects visible', graphKindFilter ? 'Clear the subject filter or choose another kind.' : selected ? 'This result has no graph records to display. Its findings or missing expectations remain in the result.' : 'Try another search or choose a different view.'); graphStatus.textContent = `0 shown · ${allProjection.nodes.length} in this view`; return; }
  if (graphSelected && projection.nodes.some(node => node.id === graphSelected)) {
    selectedGraphNodes.add(graphSelected);
    const button = root.querySelector<HTMLButtonElement>('#graph-scope');
    if (button) { button.disabled = false; button.hidden = false; }
    const compare = root.querySelector<HTMLElement>('#graph-compare-selection'); if (compare) compare.hidden = false;
    const label = root.querySelector<HTMLElement>('#graph-selected-label');
    if (label) { label.textContent = `Selected: ${projection.nodes.find(node => node.id === graphSelected)?.name ?? graphSelected}`; label.hidden = false; }
    const neighborhood = root.querySelector<HTMLButtonElement>('#graph-neighborhood')!;
    neighborhood.hidden = false; neighborhood.disabled = displayedContext.subject === graphSelected && !displayedContext.investigation;
    root.querySelector<HTMLButtonElement>('#graph-clear-selection')!.hidden = false;
  }
  const graph = new MultiGraph({ allowSelfLoops: false });
  projection.nodes.forEach((node, index) => { const point = graphPoint(node, index, projection.nodes.length); graph.addNode(node.id, { label: node.name ?? node.id, x: point.x, y: point.y, size: node.layer === 'semantic' ? 8 : node.kind === 'file' ? 6 : 4, color: selected?.focusNodeIds?.includes(node.id) ? '#f6c95f' : graphColor(node), node }); });
  for (const edge of projection.edges) {
    if (!edge.from || !edge.to || !graph.hasNode(edge.from) || !graph.hasNode(edge.to) || edge.from === edge.to) continue;
    try { graph.addEdgeWithKey(edge.id, edge.from, edge.to, { size: edge.status === 'resolved' ? 1.2 : .75, color: edge.status === 'resolved' ? '#53667e' : edge.status === 'candidate' ? '#b9823c' : '#b94f56', edge }); } catch { /* graph truth stays inspectable in list/raw modes */ }
  }
  let hoveredNode = '';
  const focusedNodes = () => hoveredNode ? new Set([hoveredNode]) : new Set([...selectedGraphNodes].filter(id => graph.hasNode(id)));
  renderer = new Sigma(graph, container, { allowInvalidContainer: true, enableEdgeEvents: true, renderEdgeLabels: projection.nodes.length < 120, labelColor: { color: '#dcecff' }, edgeLabelColor: { color: '#aabed3' }, labelDensity: .35, labelGridCellSize: 85, labelRenderedSizeThreshold: 5, zIndex: true,
    nodeReducer: (id, data) => {
      const focus = focusedNodes();
      if (!focus.size) return { ...data, color: selected?.focusNodeIds?.includes(id) ? '#f6c95f' : data.color };
      const relevant = focus.has(id) || [...focus].some(node => graph.areNeighbors(node, id));
      return { ...data, color: focus.has(id) ? '#f6c95f' : relevant ? data.color : '#34414f', zIndex: focus.has(id) ? 2 : 0 };
    },
    edgeReducer: (id, data) => {
      const focus = focusedNodes();
      const explicit = selectedGraphEdges.has(id);
      if (!focus.size && !explicit) return data;
      const related = focus.has(graph.source(id)) || focus.has(graph.target(id));
      const edge = data.edge as ProjectionEdge;
      return { ...data, color: explicit ? '#f6c95f' : related ? (edge.status === 'resolved' ? '#a7ddf1' : edge.status === 'candidate' ? '#ffbd63' : '#ff858b') : '#293441', size: explicit || related ? 2.2 : .55, zIndex: explicit || related ? 1 : 0 };
    },
    defaultDrawNodeHover: (ctx, data) => {
      const label = String(data.label ?? ''); ctx.save(); ctx.font = '600 12px sans-serif';
      const x = data.x + data.size + 5, y = data.y - 12, width = ctx.measureText(label).width + 14;
      ctx.fillStyle = '#132a3c'; ctx.beginPath(); ctx.roundRect(x, y, width, 24, 5); ctx.fill();
      ctx.fillStyle = '#f2fbff'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + 7, data.y); ctx.restore();
    },
  });
  if (restoreCamera) renderer.getCamera().setState(restoreCamera);
  renderer.on('enterNode', ({ node }) => { hoveredNode = node; renderer?.refresh(); });
  renderer.on('leaveNode', () => { hoveredNode = ''; renderer?.refresh(); });
  renderer.on('clickNode', event => {
    ++graphIntentSequence; preserveGraphSelection();
    const directionChangedSubject = Boolean(graphDirectionFilter && graphSelected !== event.node);
    graphSelected = event.node;
    if (event.event.original.shiftKey) { if (selectedGraphNodes.has(event.node)) selectedGraphNodes.delete(event.node); else selectedGraphNodes.add(event.node); }
    else { selectedGraphNodes.clear(); selectedGraphNodes.add(event.node); }
    renderer?.refresh();
    const button = root.querySelector<HTMLButtonElement>('#graph-scope');
    if (button) { button.disabled = false; button.hidden = false; }
    const compare = root.querySelector<HTMLElement>('#graph-compare-selection'); if (compare) compare.hidden = false;
    const label = root.querySelector<HTMLElement>('#graph-selected-label');
    if (label) { label.textContent = `Selected: ${graph.getNodeAttribute(event.node, 'label')}${selectedGraphNodes.size > 1 ? ` · ${selectedGraphNodes.size} selected` : ''}`; label.hidden = false; }
    const neighborhood = root.querySelector<HTMLButtonElement>('#graph-neighborhood')!;
    neighborhood.hidden = false; neighborhood.disabled = displayedContext.subject === graphSelected && !displayedContext.investigation;
    root.querySelector<HTMLButtonElement>('#graph-clear-selection')!.hidden = false;
    void openInspector(event.node, undefined, String(graph.getNodeAttribute(event.node, 'label')));
    if (directionChangedSubject) void renderGraph(root, epoch);
  });
  renderer.on('clickEdge', event => {
    ++graphIntentSequence; preserveGraphSelection();
    if (event.event.original.shiftKey) { if (selectedGraphEdges.has(event.edge)) selectedGraphEdges.delete(event.edge); else selectedGraphEdges.add(event.edge); }
    else { selectedGraphEdges.clear(); selectedGraphEdges.add(event.edge); }
    renderer?.refresh();
    const edge = graph.getEdgeAttribute(event.edge, 'edge') as ProjectionEdge;
    const from = graph.getNodeAttribute(graph.source(event.edge), 'label') as string;
    const to = graph.getNodeAttribute(graph.target(event.edge), 'label') as string;
    void openRelationship(edge, from, to);
  });
  root.querySelector<HTMLButtonElement>('#graph-neighborhood')?.addEventListener('click', () => {
    if (!graphSelected || !graph.hasNode(graphSelected)) return;
    const camera = renderer?.getCamera().getState();
    ++graphIntentSequence; graphHistory.push({ ...displayedContext, ...(camera ? { camera } : {}) }); investigationVisible = false; graphDirectionFilter = '';
    selectedGraphNodes.clear(); selectedGraphEdges.clear(); void renderGraph(root, epoch);
  });
  root.querySelector<HTMLButtonElement>('#graph-clear-selection')?.addEventListener('click', () => {
    const directionWasActive = Boolean(graphDirectionFilter);
    ++graphIntentSequence; graphSelected = ''; graphDirectionFilter = ''; selectedGraphNodes.clear(); selectedGraphEdges.clear(); hoveredNode = '';
    if (directionWasActive) { void renderGraph(root, epoch); return; }
    root.querySelector<HTMLElement>('#graph-selected-label')!.hidden = true;
    for (const id of ['graph-neighborhood', 'graph-clear-selection', 'graph-scope', 'graph-compare-selection']) root.querySelector<HTMLButtonElement>(`#${id}`)!.hidden = true;
    renderer?.refresh();
  });
  root.querySelector<HTMLButtonElement>('#graph-scope')?.addEventListener('click', () => {
    const scope = queryPanel.querySelector<HTMLInputElement>('#query-scope');
    if (scope && graphSelected) { scope.value = graphSelected; scope.dataset.displayName = graph.getNodeAttribute(graphSelected, 'label'); updateQuestionScope(); document.dispatchEvent(new Event('di-show-questions')); requestAnimationFrame(() => queryPanel.querySelector<HTMLTextAreaElement>('#query-text')?.focus()); }
  });
  root.querySelector<HTMLButtonElement>('#graph-compare-selection')?.addEventListener('click', () => {
    const comparison = queryPanel.querySelector<HTMLInputElement>('#query-comparison-ids');
    if (comparison && selectedGraphNodes.size) { comparison.value = [...selectedGraphNodes].join(', '); comparison.closest('details')!.open = true; document.dispatchEvent(new Event('di-show-questions')); requestAnimationFrame(() => queryPanel.querySelector<HTMLTextAreaElement>('#query-text')?.focus()); }
  });
  const moveCamera = (factor?: number) => {
    const camera = renderer?.getCamera(); if (!camera) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (factor === undefined) { if (reduced) camera.setState({ x: .5, y: .5, angle: 0, ratio: 1 }); else void camera.animatedReset(); }
    else { const ratio = camera.getState().ratio * factor; if (reduced) camera.setState({ ratio }); else void camera.animate({ ratio }, { duration: 180 }); }
  };
  root.querySelector<HTMLButtonElement>('#graph-reset')?.addEventListener('click', () => moveCamera());
  root.querySelector<HTMLButtonElement>('#graph-zoom-in')?.addEventListener('click', () => moveCamera(.7));
  root.querySelector<HTMLButtonElement>('#graph-zoom-out')?.addEventListener('click', () => moveCamera(1.4));
  graphResizeObserver = new ResizeObserver(() => { if (renderer && container.isConnected && container.clientWidth && container.clientHeight) renderer.refresh(); });
  graphResizeObserver.observe(container);
  graphStatus.textContent = `${selected ? `Following ${selected.operation}${selected.page?.nextOffset != null ? ' · more results available' : ''} · ` : ''}${projection.nodes.length} of ${allProjection.nodes.length} shown · ${graph.size} relationships${graphDirectionFilter ? ` · ${graphDirectionFilter} from selected subject` : ''}${projection.edges.length !== graph.size ? ` · ${projection.edges.length - graph.size} not drawable` : ''}${projection.truncated ? ' · bounded' : ''}`;
}

async function renderQuery(epoch: number, prefill = '', host: HTMLElement = content): Promise<void> {
  if (host === content) setHead();
  if (prefill) queryDraft = prefill;
  host.append(queryPanel);
  if (queryPanelReady) {
    if (prefill) queryPanel.querySelector<HTMLTextAreaElement>('#query-text')!.value = prefill;
    return;
  }
  if (prefill) queryDraft = prefill;
  prefill = queryDraft;
  queryPanel.innerHTML = `<div class="card"><h3>Ask / query</h3><div class="query-box"><textarea id="query-text" aria-label="Question about the selected graph" placeholder="Ask about this graph…">${esc(prefill)}</textarea><select id="query-source" hidden aria-label="Question source"><option value="">Development Intelligence</option></select><button class="primary" id="run-query">Run</button></div><details><summary>Refine graph selection</summary><div class="query-box"><input id="query-scope" aria-label="Scope" placeholder="File, directory or graph ID"><input id="query-node-kinds" aria-label="Node kinds" placeholder="Node kinds, comma-separated"><input id="query-edge-kinds" aria-label="Relationship kinds" placeholder="Relationship kinds, comma-separated"><select id="query-direction" aria-label="Relationship direction"><option value="">From the question</option><option value="both">Both directions</option><option value="outbound">Outbound</option><option value="inbound">Inbound</option></select><input id="query-comparison-ids" aria-label="Comparison IDs" placeholder="Comparison graph IDs, comma-separated"><input id="query-comparison-scope" aria-label="Comparison scope" placeholder="Comparison file or directory"><input id="query-comparison-kinds" aria-label="Comparison node kinds" placeholder="Comparison node kinds, comma-separated"><input id="query-condition" aria-label="Condition contains" placeholder="Condition contains"><select id="query-condition-truth" aria-label="Condition truth"><option value="">Either condition value</option><option value="true">Condition true</option><option value="false">Condition false</option></select><input id="query-effect-kinds" aria-label="Effect kinds" placeholder="Effect kinds, comma-separated"><input id="query-depth" aria-label="Relationship depth" type="number" min="1" value="1"><input id="query-limit" aria-label="Results per page" type="number" min="1" value="${queryPageSize}"></div></details><p class="muted"><span id="query-active-scope" role="status">Scope: entire selected graph</span> <button type="button" id="query-clear-scope" hidden>Clear scope</button></p><p class="muted">Answers use the selected saved graph and its source state.</p></div><button type="button" id="load-query-sources">Choose a technical source</button><div id="query-source-status" role="status" class="muted"></div><div id="query-progress" role="status" aria-live="polite" class="muted"></div><div id="query-result" class="query-result" aria-live="polite"></div>`;
  queryPanelReady = true;
  queryPanel.querySelector<HTMLInputElement>('#query-scope')?.addEventListener('input', event => { delete (event.currentTarget as HTMLInputElement).dataset.displayName; updateQuestionScope(); });
  queryPanel.querySelector<HTMLButtonElement>('#query-clear-scope')?.addEventListener('click', () => { const scope = queryPanel.querySelector<HTMLInputElement>('#query-scope'); if (scope) { scope.value = ''; delete scope.dataset.displayName; } updateQuestionScope(); });
  updateQuestionScope();
  queryPanel.querySelector<HTMLButtonElement>('#load-query-sources')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    const status = queryPanel.querySelector<HTMLElement>('#query-source-status')!;
    button.disabled = true; status.textContent = 'Loading configured sources…';
    try {
      const sourceData = await getJson('/workbench/data', new URLSearchParams({ action: 'sources' }));
      const select = queryPanel.querySelector<HTMLSelectElement>('#query-source')!;
      for (const source of (sourceData.sources ?? []).filter((item: any) => item.type === 'read-only-http')) select.add(new Option(`${source.label} · ${(source.capabilities ?? []).join('/')}`, source.id));
      select.hidden = select.options.length === 1;
      status.textContent = select.hidden ? 'No additional query sources are available.' : '';
      button.hidden = true;
    } catch (error) { status.textContent = `Could not load sources: ${error instanceof Error ? error.message : String(error)}`; button.disabled = false; }
  });
  queryPanel.querySelector<HTMLInputElement>('#query-limit')?.addEventListener('change', event => {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isSafeInteger(value) && value > 0) { queryPageSize = value; savePositiveSetting('queryPageSize', value); }
  });
  (queryPanel.querySelector('#query-text') as HTMLTextAreaElement).addEventListener('input', event => { queryDraft = (event.target as HTMLTextAreaElement).value; });
  const run = async (offset = 0) => {
    const text = (document.getElementById('query-text') as HTMLTextAreaElement).value.trim();
    const sourceId = (document.getElementById('query-source') as HTMLSelectElement).value;
    preferredQuerySource = sourceId;
    if (!text) return;
    const target = document.getElementById('query-result') as HTMLElement;
    const status = document.getElementById('query-progress') as HTMLElement;
    const sequence = ++querySequence;
    const graphIntent = graphIntentSequence;
    const hasPreviousAnswer = target.hasChildNodes();
    const runButton = document.getElementById('run-query') as HTMLButtonElement;
    runButton.disabled = true;
    const update = (message: string) => { if (sequence === querySequence) status.textContent = message ? `Question “${text}”: ${message}${hasPreviousAnswer ? ' Previous answer remains visible.' : ''}` : ''; };
    update('Running question…');
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
      const limit = Number((document.getElementById('query-limit') as HTMLInputElement).value);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Results per page must be a positive whole number');
      queryPageSize = limit; savePositiveSetting('queryPageSize', limit);
      const result = await postJson('/workbench/query', { text, offset, depth, limit, ...(investigationGraphId() ? { graphId: investigationGraphId()! } : {}), ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}), ...(nodeKinds.length ? { nodeKinds } : {}),
        ...(relationshipKinds.length ? { relationshipKinds } : {}), ...(comparisonIds.length ? { comparisonIds } : {}), ...(comparisonScope ? { comparisonScope } : {}), ...(comparisonKinds.length ? { comparisonKinds } : {}), ...(conditionContains ? { conditionContains } : {}), ...(conditionValue ? { conditionTruth: conditionValue === 'true' } : {}), ...(effectKinds.length ? { effectKinds } : {}), ...(sourceId ? { sourceId } : {}) }, update);
      if (sequence !== querySequence) return;
      update('');
      const page = result.result?.page;
      const followResult = graphIntent === graphIntentSequence;
      if (followResult) {
        graphHistory.length = 0; activeInvestigation = result.investigation ?? null; investigationVisible = true; graphSelected = ''; selectedGraphNodes.clear(); selectedGraphEdges.clear();
        if (section === 'explore' && exploreMode === 'graph') void renderExploreResult(sectionEpoch);
      }
      const answer = String(result.answer ?? '');
      const longAnswer = answer.length > 2200;
      const incomplete = /Selection is incomplete/i.test(answer);
      // The shared answer already contains source paths in graph order. Give
      // each path its own expandable section so a long answer does not hide
      // the entire investigation behind one large disclosure.
      const pathParts = Array.isArray(result.result?.connectedGroups) ? answer.split('\n\nSource path:\n') : [];
      let answerView: string;
      if (pathParts.length > 1) {
        const introduction = pathParts.shift() ?? '';
        const last = pathParts[pathParts.length - 1]!;
        const footerAt = last.lastIndexOf('\n\nSource analysis:');
        const footer = footerAt < 0 ? '' : last.slice(footerAt + 2);
        if (footerAt >= 0) pathParts[pathParts.length - 1] = last.slice(0, footerAt);
        const paths = pathParts.map((part, index) => {
          const newline = part.indexOf('\n');
          const title = newline < 0 ? part : part.slice(0, newline);
          const body = newline < 0 ? '' : part.slice(newline + 1);
          return `<details${index === 0 ? ' open' : ''}><summary>${esc(title)}</summary><div class="answer">${esc(body)}</div></details>`;
        }).join('');
        answerView = `<div class="answer">${esc(introduction)}</div>${paths}${footer ? `<div class="answer">${esc(footer)}</div>` : ''}`;
      } else {
        answerView = longAnswer ? `<p class="muted">The full result is long. Expand it to read all of the source paths and limitations.</p><details><summary>Read full result</summary><div class="answer">${esc(answer)}</div></details>` : `<div class="answer">${esc(answer)}</div>`;
      }
      target.innerHTML = `<div class="card"><h3>${result.intent === 'graph-filter' ? 'Related source evidence' : esc(result.intent ?? 'Result')}</h3>${incomplete ? '<p class="status-warn">The selection is incomplete and may not answer the full question. Refine the scope or inspect the evidence below.</p>' : ''}${answerView}${renderQueryResult(result.result)}${page ? `<div class="actions">${page.offset > 0 ? '<button id="query-previous" type="button">Previous</button>' : ''}${page.nextOffset !== null ? '<button id="query-next" type="button">Next</button>' : ''}</div>` : ''}</div>`;
      if (result.investigation && (section !== 'explore' || !followResult)) {
        const follow = document.createElement('button'); follow.textContent = 'Show this result on the graph';
        follow.addEventListener('click', () => followInvestigation(result.investigation)); target.firstElementChild?.append(follow);
      }
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
      if (followResult && result.intent === 'inspect' && result.result?.entity) { selectedInspection = result.result; inspectorTab = 'summary'; renderInspector(); }
    } catch (error) {
      if (sequence !== querySequence) return;
      status.textContent = `Question unavailable: ${error instanceof Error ? error.message : String(error)} `;
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry question';
      retry.onclick = () => void run(offset); status.append(retry);
    } finally { if (sequence === querySequence) runButton.disabled = false; }
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
  content.innerHTML = `<div class="card"><h3>Semantic understanding</h3><h2>Understanding from the selected graph</h2><p>${esc(data.summary ?? 'No semantic understanding is available for this graph.')}</p><p class="muted">Semantic understanding is derived from source evidence. It is not edited or approved separately.</p><div class="list">${items.map((item: any) => item.declared && item.id ? nodeRow(item) : `<div class="row"><span class="badge">${esc(item.kind ?? 'source evidence')}</span><span class="row-main"><strong>${esc(item.name ?? item.scope ?? item.id)}</strong>${item.description ? `<small>${esc(item.description)}</small>` : ''}${item.locator ? `<small>${esc(item.locator)}</small>` : ''}</span></div>`).join('')}</div><details><summary>Evidence and coverage details</summary><pre class="raw">${esc(JSON.stringify(data, null, 2))}</pre></details></div>`;
  wireNodeButtons(content);
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

function parityChangeDetails(item: any): string {
  const render = (change: any, prefix: string) => {
    const detail = change.detail ?? {};
    const label = detail.node ? `${detail.node.name} (${detail.node.locator})`
      : `${detail.from?.name ?? '?'} ${detail.kind ?? 'relationship'}${detail.status === 'candidate' ? ' (candidate)' : ''} ${detail.to?.name ?? '?'}`;
    const location = detail.to?.locator ?? detail.node?.locator ?? '';
    const expression = detail.to?.raw ?? detail.node?.raw ?? '';
    return `<li><strong>${esc(prefix)}</strong> ${esc(label)}${location ? ` <small>${esc(location)}</small>` : ''}${expression ? ` <code>${esc(expression)}</code>` : ''}${change.occurrences > 1 ? ` · ${esc(change.occurrences)} occurrences` : ''}</li>`;
  };
  const entries = [...(item.changes?.added ?? []).map((change: any) => render(change, 'Added')),
    ...(item.changes?.removed ?? []).map((change: any) => render(change, 'Removed'))];
  return entries.length ? `<details><summary>View changed graph facts</summary><ul>${entries.join('')}</ul></details>` : '';
}

async function renderParity(epoch: number): Promise<void> {
  setHead();
  content.innerHTML = `<div class="card"><h3>Interaction parity</h3><h2>Compare connected behavior</h2><p>Compare interaction points and their captured graph paths across two revisions.</p><div class="query-box"><label>Base revision <input id="parity-base" value="${viewerConfig.local ? 'preview' : 'main'}"></label><label>Compare revision <input id="parity-head" value="${viewerConfig.local ? 'working-tree' : 'preview'}"></label><label>Filter by interaction or connected source or name <input id="parity-scope" placeholder="All interactions"></label><button id="compare-interactions" type="button">Compare</button></div><div id="interaction-parity-result" class="query-result"></div></div><details style="margin-top:13px"><summary>Optional expectation overlay</summary><div class="card"><h3>Expectation overlay E</h3><h2>Define what must be true</h2><p>Use stable graph IDs to describe required or forbidden entities and relationships. Development Intelligence evaluates this contract against the selected working graph without storing it or changing the selected graph.</p><div class="query-box" style="grid-template-columns:minmax(0,1fr) auto;margin-top:13px"><textarea id="parity-contract" aria-label="Parity contract JSON" style="min-height:260px">${esc(parityContractText)}</textarea><button class="primary" id="evaluate-parity" type="button" style="align-self:start">Evaluate</button></div><p class="muted">Supported requirements: required and forbidden. Missing negative evidence becomes unproven when graph coverage is incomplete.</p></div><div id="parity-result" class="query-result"></div></details>`;
  let parityOffset = 0;
  const compare = async () => {
    const target = document.getElementById('interaction-parity-result') as HTMLElement;
    target.innerHTML = empty('Comparing interactions', 'Following captured paths in both selected graphs…');
    try {
      const baseRef = (document.getElementById('parity-base') as HTMLInputElement).value;
      const headRef = (document.getElementById('parity-head') as HTMLInputElement).value;
      const scope = (document.getElementById('parity-scope') as HTMLInputElement).value.trim();
      if (viewerConfig.accountGraphId && (!baseRef || !headRef)) throw new Error('Choose two saved graphs');
      const result = await getJson('/workbench/data', new URLSearchParams({ action: 'interaction-parity', baseRef, headRef, ...(viewerConfig.accountGraphId ? { ref: headRef } : {}), ...(scope ? { scope } : {}), offset: String(parityOffset), limit: '10', detail: 'summary' }));
      if (!sectionIsCurrent(epoch, 'parity')) return;
      target.innerHTML = `<p>${esc(result.note)}</p><p class="muted">${esc(result.potentiallyAffected)} with potentially affected paths · ${esc(result.page.total)} interaction identities · showing ${esc(result.page.total ? result.page.offset + 1 : 0)}–${esc(Math.min(result.page.offset + result.page.limit, result.page.total))}</p><div class="list">${result.items.map((item: any, index: number) => `<div class="row"><span class="badge">${esc(item.status)}</span><div class="row-main"><strong>${esc(item.after?.name ?? item.before?.name ?? item.after?.[0]?.name ?? item.before?.[0]?.name ?? 'Ambiguous interaction')}</strong><small>${esc(item.after?.locator ?? item.before?.locator ?? item.after?.[0]?.locator ?? item.before?.[0]?.locator ?? item.reason ?? '')}${item.path ? ` · ${esc(item.path.addedFacts)} added and ${esc(item.path.removedFacts)} removed path facts · ${esc(item.path.afterUnresolved)} unresolved` : ''}</small>${item.path && (item.path.addedFacts || item.path.removedFacts) ? `<button type="button" data-parity-facts="${index}">View changed graph facts</button><div data-parity-detail="${index}"></div>` : ''}</div>${(Array.isArray(item.before) ? item.before.length : item.before) ? `<button type="button" data-parity-item="${index}" data-parity-side="0">Base graph</button>` : ''}${(Array.isArray(item.after) ? item.after.length : item.after) ? `<button type="button" data-parity-item="${index}" data-parity-side="1">Compared graph</button>` : ''}</div>`).join('')}</div><div><button type="button" id="parity-previous" ${result.page.offset === 0 ? 'disabled' : ''}>Previous</button><button type="button" id="parity-next" ${result.page.nextOffset == null ? 'disabled' : ''}>Next</button></div>`;
      const details = new Map<string, Promise<any>>();
      const loadDetail = (index: number, detail: 'facts' | 'base' | 'head') => {
        const key = `${index}:${detail}`;
        let pending = details.get(key);
        if (!pending) {
          pending = getJson('/workbench/data', new URLSearchParams({ action: 'interaction-parity', baseRef, headRef, ...(viewerConfig.accountGraphId ? { ref: headRef } : {}), ...(scope ? { scope } : {}), baseGraphId: result.base.graphId, headGraphId: result.head.graphId, offset: String(result.page.offset + index), limit: '1', detail })).then(data => data.items[0]);
          details.set(key, pending); pending.catch(() => details.delete(key));
        }
        return pending;
      };
      target.querySelectorAll<HTMLButtonElement>('[data-parity-item]').forEach(button => button.addEventListener('click', () => {
        button.disabled = true;
        void loadDetail(Number(button.dataset.parityItem), button.dataset.paritySide === '0' ? 'base' : 'head').then(item => followInvestigation(item.investigations[Number(button.dataset.paritySide)]))
          .catch(error => { button.title = error instanceof Error ? error.message : String(error); button.textContent = 'Could not load graph'; }).finally(() => { button.disabled = false; });
      }));
      target.querySelectorAll<HTMLButtonElement>('[data-parity-facts]').forEach(button => button.addEventListener('click', () => {
        button.disabled = true;
        void loadDetail(Number(button.dataset.parityFacts), 'facts').then(item => { const panel = target.querySelector<HTMLElement>(`[data-parity-detail="${button.dataset.parityFacts}"]`); if (panel) { panel.innerHTML = parityChangeDetails(item); panel.querySelector('details')?.setAttribute('open', ''); } button.hidden = true; })
          .catch(error => { button.title = error instanceof Error ? error.message : String(error); button.textContent = 'Could not load facts; retry'; }).finally(() => { button.disabled = false; });
      }));
      target.querySelector<HTMLButtonElement>('#parity-previous')?.addEventListener('click', () => { parityOffset = Math.max(0, parityOffset - 10); void compare(); });
      target.querySelector<HTMLButtonElement>('#parity-next')?.addEventListener('click', () => { parityOffset = result.page.nextOffset; void compare(); });
    } catch (error) { target.innerHTML = `<p class="status-bad">${esc(error instanceof Error ? error.message : String(error))}</p>`; }
  };
  (document.getElementById('compare-interactions') as HTMLButtonElement).addEventListener('click', () => { parityOffset = 0; void compare(); });
  if (viewerConfig.accountGraphId) {
    const targets = await getJson('/workbench/data', new URLSearchParams({ action: 'graph-targets' }));
    if (!sectionIsCurrent(epoch, 'parity')) return;
    for (const id of ['parity-base', 'parity-head']) { const input = document.getElementById(id) as HTMLInputElement; const select = document.createElement('select'); select.id = id; select.setAttribute('aria-label', id === 'parity-base' ? 'Base graph' : 'Compared graph'); select.add(new Option('Choose a saved graph', '')); for (const target of targets.targets ?? []) select.add(new Option(target.name, target.name)); input.replaceWith(select); }
  } else void compare();
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
      if (result.investigation) { const follow = document.createElement('button'); follow.textContent = 'Show observed parity on graph'; follow.addEventListener('click', () => followInvestigation(result.investigation)); target.prepend(follow); }
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
    const groupedPaths = Array.isArray(result.connectedGroups);
    const language = result.interpretation?.negated
      ? `<p class="muted">Negative wording: ${esc((result.interpretation.negativeTerms ?? []).join(', ') || 'not')}</p>` : '';
    // Grouped paths are already displayed above. Navigation's broad incident
    // edge page is not the same selection and can include unrelated subjects.
    const relationships = (groupedPaths ? [] : result.navigation?.relationships ?? []).map((item: any) => `<div class="row"><span class="badge">${esc(item.edge.kind)}</span><span class="row-main">${esc(item.from?.name ?? item.edge.from)} → ${esc(item.to?.name ?? item.edge.to)}<small>${esc(item.edge.status)}</small></span></div>`).join('');
    const comparison = (result.comparison?.items ?? []).map((item: any) => `<div class="row"><span class="badge">${esc(item.state)}</span><span class="row-main">${esc(item.node.name ?? item.node.id)}<small>${esc(item.node.locator)}</small></span></div>`).join('');
    const families = result.sourceFamilies.map((family: any) => `<details><summary>${esc(family.subjectName)} · ${family.facts.length} source facts${family.focusedFacts?.length ? ` · ${family.focusedFacts.length} match the wording` : ''}</summary><div class="list">${family.facts.map((fact: any) => `<div class="row"><span class="badge">${esc(fact.effectKind ?? fact.kind)}</span><span class="row-main"><code>${esc(fact.expression)}</code><small>${esc(fact.locator)}${fact.requirements?.length ? ` · requires ${esc(fact.requirements.map((requirement: any) => `${requirement.expectedTruth ? '' : 'not '}${requirement.predicate ?? requirement.conditionId}`).join(' and '))}` : ''}</small></span></div>`).join('')}</div></details>`).join('');
    return `${language}${relationships ? `<h4>Known relationships</h4><div class="list">${relationships}</div>` : ''}${comparison ? `<h4>Comparison</h4><div class="list">${comparison}</div>` : ''}${families}${groupedPaths ? '' : `<div class="list">${(result.nodes ?? []).map(nodeRow).join('')}</div>`}<details><summary class="muted">Graph details</summary><pre class="raw">${esc(JSON.stringify(result, null, 2))}</pre></details>`;
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
  const defaultHead = viewerConfig.accountGraphId ? '' : viewerConfig.ref || (viewerConfig.local ? 'working-tree' : 'HEAD');
  content.innerHTML = `<div class="card"><h3>Graph comparison</h3><h2>Compare repository states</h2><p>${viewerConfig.accountGraphId ? 'Choose two saved graphs available to this query service.' : viewerConfig.local ? 'Compare the retained main, preview and working graphs, or choose two targets below.' : 'Leave the base empty to compare the default source revision with the selected revision. Historical comparisons replay both exact revisions through the same current analyzer.'}</p>${viewerConfig.local ? '<button class="primary" id="compare-three" type="button">Compare main, preview and working</button>' : ''}<div class="query-box" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;margin-top:13px"><input id="change-base" aria-label="Base revision selector" placeholder="Base: commit:&lt;sha&gt; or pr:75/head" style="border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:10px;padding:9px 11px"><input id="change-head" aria-label="Head revision selector" value="${esc(defaultHead)}" placeholder="Head: HEAD or pr:243/head" style="border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:10px;padding:9px 11px"><button class="primary" id="compare-revisions" type="button">Compare two</button></div>${viewerConfig.local || viewerConfig.accountGraphId ? '<label>Results per page <input id="change-limit" type="number" min="1" max="500" value="10"></label>' : ''}${viewerConfig.accountGraphId ? '' : '<p class="muted">Selectors: commit:&lt;full-sha&gt;, branch:&lt;name&gt;, tag:&lt;name&gt;, pr:&lt;number&gt;/head, /base, or /result.</p>'}</div><div id="change-result" class="query-result"></div>`;
  let offset = 0;
  let detailPageSize = 10;
  let requestNumber = 0;
  const run = async () => {
    const request = ++requestNumber;
    const baseRef = (document.getElementById('change-base') as HTMLInputElement).value.trim();
    const headRef = (document.getElementById('change-head') as HTMLInputElement).value.trim();
    const pageSetting = document.getElementById('change-limit') as HTMLInputElement | null;
    if (pageSetting) { const n = Number(pageSetting.value); if (!Number.isSafeInteger(n) || n < 1 || n > 500) { pageSetting.setCustomValidity('Choose 1 to 500 results per page'); pageSetting.reportValidity(); return; } pageSetting.setCustomValidity(''); detailPageSize = n; }
    const target = document.getElementById('change-result') as HTMLElement;
    target.innerHTML = empty('Loading change intelligence', viewerConfig.accountGraphId || viewerConfig.local ? 'Comparing the selected saved graphs…' : baseRef ? 'Resolving and comparing immutable historical revisions…' : 'Comparing the default and selected source states…');
    try {
      if (viewerConfig.accountGraphId && (!baseRef || !headRef)) throw new Error('Choose two saved graphs');
      const data = await getJson('/workbench/data', new URLSearchParams({ action: 'changes', ...(baseRef ? { baseRef } : {}), ...(headRef ? { headRef, ...(viewerConfig.accountGraphId ? { ref: headRef } : {}) } : {}), ...(viewerConfig.local || viewerConfig.accountGraphId ? { offset: String(offset), limit: String(detailPageSize) } : {}) }));
      if (!sectionIsCurrent(epoch, 'changes') || request !== requestNumber) return;
      const counts = data.counts ?? {};
      const baseIdentity = data.detail?.base?.identity;
      const headIdentity = data.detail?.head?.identity;
      const identity = baseIdentity && headIdentity ? `<p class="muted">${esc(baseIdentity.selector)} → ${esc(headIdentity.selector)}<br>${esc(baseIdentity.sha)} → ${esc(headIdentity.sha)}</p>` : '';
      target.innerHTML = `<div class="hero-grid"><div class="card"><h3>${data.mode === 'revision-to-revision' ? 'Graph comparison' : 'Semantic change'}</h3><h2>${esc(data.summary ?? 'Default → selected')}</h2>${identity}<p>${data.mode === 'revision-to-revision' ? data.detail?.analyzerChanged ? 'These graphs use different analyzer versions; rebuild the targets to compare with one analyzer.' : 'Both graphs use the same analyzer.' : 'This compares semantic records from the default and selected source states.'}</p>${data.detail?.comparisonNote ? `<p class="muted">${esc(data.detail.comparisonNote)}</p>` : ''}</div><div class="card"><h3>Delta</h3><div class="metric-grid">${metric('added', counts.added ?? 0)}${metric('removed', counts.removed ?? 0)}${metric('changed', counts.changed ?? 0)}</div></div></div><div class="card" style="margin-top:13px"><h3>Change detail</h3>${data.page ? `<p class="muted">Showing up to ${data.page.limit} items per change category, starting at ${data.page.offset + 1}.</p><button id="change-previous" ${offset === 0 ? 'disabled' : ''}>Previous</button> <button id="change-next" ${data.page.nextOffset === null ? 'disabled' : ''}>Next</button>` : ''}${renderChangeBucket(data.detail)}</div>`;
      if (data.investigations?.length) {
        const actions = document.createElement('div'); actions.className = 'actions';
        for (const [index, selection] of data.investigations.entries()) { const button = document.createElement('button'); button.textContent = `Show ${index ? 'head' : 'base'} changes on graph`; button.addEventListener('click', () => followInvestigation(selection)); actions.append(button); }
        target.prepend(actions);
      }
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
  if (viewerConfig.accountGraphId) {
    const targets = await getJson('/workbench/data', new URLSearchParams({ action: 'graph-targets' }));
    if (!sectionIsCurrent(epoch, 'changes')) return;
    for (const id of ['change-base', 'change-head']) { const input = document.getElementById(id) as HTMLInputElement; const select = document.createElement('select'); select.id = id; select.setAttribute('aria-label', id === 'change-base' ? 'Base graph' : 'Compared graph'); select.add(new Option('Choose a saved graph', '')); for (const target of targets.targets ?? []) select.add(new Option(target.name, target.name)); input.replaceWith(select); }
    const target = document.getElementById('change-result'); if (target) target.textContent = 'Choose two saved graphs available to this query service.';
  } else if (viewerConfig.local) await runAll(); else await run();
}

function renderChangeBucket(detail: any): string {
  const semantic = detail?.semantic ?? (detail?.nodes && detail?.edges ? detail : null);
  if (!semantic) return `<pre class="raw">${esc(JSON.stringify(detail, null, 2))}</pre>`;
  const changes = ['added', 'removed', 'changed', 'moved', 'analysisAdded', 'analysisRemoved', 'analysisChanged', 'ambiguousAdded', 'ambiguousRemoved', 'provenanceChanged'];
  const nodes = changes.flatMap(change => (semantic.nodes?.[change] ?? []).map((item: any) => ({ ...(item.after ?? item.before ?? item), _change: change, _comparison: item.before && item.after ? item : null })));
  const edges = changes.flatMap(change => (semantic.edges?.[change] ?? []).map((item: any) => ({ ...(item.after ?? item.before ?? item), _change: change, _comparison: item.before && item.after ? item : null })));
  if (!nodes.length && !edges.length) return empty('No changes on this page', 'Use the page controls to inspect other changes.');
  const baseGraph = detail?.base?.graphId, headGraph = detail?.head?.graphId;
  const beforeAfter = (pair: any) => pair ? `<details><summary>Before and after</summary>${pair.before?.id && !('from' in pair.before) && baseGraph ? `<button data-node="${esc(pair.before.id)}" data-graph-id="${esc(baseGraph)}">Inspect before</button>` : ''}${pair.after?.id && !('from' in pair.after) && headGraph ? `<button data-node="${esc(pair.after.id)}" data-graph-id="${esc(headGraph)}">Inspect after</button>` : ''}<pre class="raw">${esc(JSON.stringify(pair, null, 2))}</pre></details>` : '';
  return `<div class="list">${nodes.map((node: any) => `<div><button class="row row-button" data-node="${esc(node.id)}" data-graph-id="${esc(['removed', 'analysisRemoved', 'ambiguousRemoved'].includes(node._change) ? baseGraph : headGraph)}"><span class="badge ${node._change === 'added' ? 'status-good' : node._change === 'removed' ? 'status-bad' : 'status-warn'}">${esc(node._change)}</span><span class="row-main"><strong>${esc(node.name ?? node.id)}</strong><small>${esc(node.kind ?? '')}</small></span></button>${beforeAfter(node._comparison)}</div>`).join('')}${edges.map((edge: any) => `<div><div class="row"><span class="badge">${esc(edge._change)}</span><span class="row-main"><strong>${esc(edge.kind ?? 'relationship')}</strong><small>${esc(edge.from ?? '?')} → ${esc(edge.to ?? '?')}</small></span></div>${beforeAfter(edge._comparison)}</div>`).join('')}</div>`;
}

async function renderLocal(epoch: number): Promise<void> {
  setHead();
  const state = await getJson('/workbench/local', new URLSearchParams());
  if (!sectionIsCurrent(epoch, 'local')) return;
  const settings = state.settings;
  const field = (label: string, id: string, value: unknown) => `<label style="display:block;margin:10px 0"><span class="muted">${esc(label)}</span><input id="${id}" value="${esc(value)}" style="display:block;width:100%;border:1px solid #30435e;background:#0d1624;color:#fff;border-radius:9px;padding:9px"></label>`;
  content.innerHTML = `<div class="card"><h3>Installation</h3><h2>Local files and storage</h2><p>Port changes apply on the next launch. Changing the data location selects that location; it does not move existing graphs.</p>${field('Repository checkout', 'local-repo', settings.repoPath)}${field('Graph data directory', 'local-data', settings.dataDir)}${field('Scratch directory', 'local-scratch', settings.scratchDir)}${field('Backup directory', 'local-backup', settings.backupDir ?? '')}${field('Retained generations', 'local-retain', settings.retain)}${field('Graphs cached in memory (0 disables cache)', 'local-cache', settings.cacheSize ?? 3)}${field('Workbench port', 'local-port', settings.port)}<button class="primary" id="local-save">Save settings</button></div><div class="card" style="margin-top:13px"><h3>Graphs</h3><p>Choose a graph name and build it from current files or a committed revision.</p>${field('Graph name', 'local-target', 'working')}<button class="primary" data-local-action="build">Build current files</button>${field('Committed revision', 'local-ref', 'preview')}<button data-local-action="build-revision">Build revision</button> <button data-local-action="unpin">Unpin target</button><div id="local-history" class="muted"></div></div><div class="card" style="margin-top:13px"><h3>Recovery</h3><p>Backup and restore preserve retained graphs, not repository files or accepted semantic records. Restore uses an empty graph location.</p><button data-local-action="backup">Back up graphs</button> <button data-local-action="restore">Restore graphs</button> <button data-local-action="reindex">Rebuild index for named graph</button></div><div class="card" style="margin-top:13px"><h3>Operation</h3><div id="local-job" class="muted"></div></div>`;
  const installation = content.querySelector('.card');
  if (installation) {
    const heapSettings = document.createElement('div');
    heapSettings.innerHTML = `${field('Graph worker heap in MiB (blank uses Node default)', 'local-worker-heap', settings.graphWorkerHeapMB ?? '')}${field('SCIP producer heap in MiB (blank uses Node default)', 'local-scip-heap', settings.scipHeapMB ?? '')}`;
    installation.insertBefore(heapSettings, document.getElementById('local-save'));
  }
  const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  const show = (data: any) => {
    const history = document.getElementById('local-history');
    if (history) {
      const selectedGraphId = history.querySelector('select')?.value ?? viewerConfig.graphId;
      history.replaceChildren();
      const targets = data.history?.targets ?? {};
      const entries = Array.isArray(data.history?.entries) ? data.history.entries : [];
      const available = Object.entries(targets).flatMap(([name, generation]) => {
        const entry = entries.find((item: any) => item.generation === generation);
        return entry?.graphId ? [{ name, graphId: String(entry.graphId) }] : [];
      });
      if (!available.length) history.textContent = 'No named graphs at this location yet.';
      else {
        const label = document.createElement('label');
        label.textContent = 'Open a named graph ';
        const select = document.createElement('select');
        for (const item of available) {
          const option = document.createElement('option'); option.value = item.graphId; option.textContent = item.name;
          if (item.graphId === selectedGraphId) option.selected = true;
          select.append(option);
        }
        const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open graph';
        open.addEventListener('click', () => {
          const params = new URLSearchParams({ project: viewerConfig.project, graphId: select.value });
          window.location.assign(`/workbench?${params.toString()}`);
        });
        label.append(select); history.append(label, open);
      }
      const storage = data.storage;
      if (storage?.generations?.length) {
        const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
        const details = document.createElement('div');
        details.textContent = `Stored graph generations: ${formatBytes(storage.totalBytes)}. Named and active graphs are protected; other history is pruned after a successful build.`;
        history.append(details);
        for (const entry of storage.generations) {
          const row = document.createElement('div');
          row.textContent = `${entry.names?.join(', ') || 'History'}${entry.active ? ' · active' : ''}: graph ${formatBytes(entry.graphBytes)}, index ${entry.indexPresent ? formatBytes(entry.indexBytes) : 'missing'}`;
          history.append(row);
        }
      }
    }
    const target = document.getElementById('local-job');
    if (target) target.textContent = data.job ? `${data.job.action}: ${data.job.state}${data.job.progress ? ` — ${data.job.progress.stage}${data.job.progress.total !== undefined ? ` (${data.job.progress.completed}/${data.job.progress.total} files)` : ''}` : ''}${data.job.output ? `\n${data.job.output}` : ''}` : 'No operation running.';
  };
  show(state);
  const capacityButton = document.createElement('button');
  capacityButton.textContent = 'Measure source and host capacity';
  const capacityOutput = document.createElement('pre');
  capacityOutput.className = 'raw';
  capacityButton.addEventListener('click', async () => {
    capacityOutput.textContent = 'Measuring current files and the configured scratch location…';
    try { capacityOutput.textContent = JSON.stringify(await getJson('/workbench/local', new URLSearchParams({ action: 'capacity' })), null, 2); }
    catch (error) { capacityOutput.textContent = String(error); }
  });
  content.querySelector('.card')?.append(capacityButton, capacityOutput);
  const poll = async () => {
    if (!sectionIsCurrent(epoch, 'local')) return;
    try { const current = await getJson('/workbench/local', new URLSearchParams()); show(current); if (current.job?.state === 'running') window.setTimeout(() => void poll(), 2000); }
    catch (error) { const target = document.getElementById('local-job'); if (target) target.textContent = String(error); }
  };
  (document.getElementById('local-save') as HTMLButtonElement).addEventListener('click', async () => {
    try { await postJson('/workbench/local', { action: 'settings', repoPath: value('local-repo'), dataDir: value('local-data'), scratchDir: value('local-scratch'), backupDir: value('local-backup'), retain: Number(value('local-retain')), cacheSize: Number(value('local-cache')), port: Number(value('local-port')), graphWorkerHeapMB: value('local-worker-heap') || null, scipHeapMB: value('local-scip-heap') || null }); await poll(); }
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
  ++exploreSequence; explorePending = null;
  section = next;
  for (const button of navButtons) button.classList.toggle('active', button.dataset.section === section);
  graphResizeObserver?.disconnect(); graphResizeObserver = null;
  renderer?.kill(); renderer = null;
  if (!document.getElementById('question-dock')) queryPanel.remove();
  content.replaceChildren();
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

// Account Workbench keeps source navigation and graph investigation in the same surface.
if (document.getElementById('question-dock')) {
  const inspector = document.querySelector<HTMLElement>('.inspector')!;
  const dock = document.getElementById('question-dock')!, shell = document.querySelector<HTMLElement>('.shell')!;
  let layoutReady = false, lastLayout = '', layoutTimer: number | undefined;
  let dockApi: DockviewApi;
  const compactMedia = window.matchMedia('(max-width: 720px)');
  let compact = compactMedia.matches;
  const layouts: { compact?: ReturnType<DockviewApi['toJSON']>; wide?: ReturnType<DockviewApi['toJSON']> } = {};
  const saveLayout = () => {
    if (!layoutReady || !dockApi) return;
    layouts[compact ? 'compact' : 'wide'] = dockApi.toJSON();
    const layout = { layouts };
    const next = JSON.stringify(layout); if (next === lastLayout) return; lastLayout = next;
    parent.postMessage({ type: 'di-layout', layout }, location.origin);
  };
  const tabs = document.createElement('div'); tabs.className = 'inspector-tabs';
  tabs.innerHTML = '<button type="button" data-pane="inspection">Inspector</button><button type="button" data-pane="files">Files</button>';
  const filesPane = document.createElement('div'); filesPane.className = 'inspector-body'; filesPane.hidden = true;
  inspector.prepend(tabs); inspector.append(filesPane);
  const original = [inspector.querySelector<HTMLElement>('.inspector-head')!, inspectorTabs, inspectorProgress, inspectorBody];
  const fileTabs = document.createElement('div'); fileTabs.className = 'inspector-tabs';
  const fileBody = document.createElement('div'); fileBody.className = 'raw'; fileBody.hidden = true; fileBody.style.cssText = 'flex:1;min-height:0;overflow:auto;margin:8px;';
  const fileStatus = document.createElement('div'); fileStatus.setAttribute('role', 'status');
  const fileEditor = document.createElement('div');
  fileBody.append(fileStatus, fileEditor);
  let editor: EditorView | undefined;
  const fileLanguage = (file: string) => {
    if (/\.(tsx?|jsx?)$/i.test(file)) return javascript({ typescript: /\.tsx?$/i.test(file), jsx: /\.[jt]sx$/i.test(file) });
    if (/\.py$/i.test(file)) return python();
    if (/\.html?$/i.test(file)) return html();
    if (/\.css$/i.test(file)) return css();
    return [];
  };
  const graphPane = document.querySelector<HTMLElement>('.workspace')!;
  const navigation = shell.querySelector<HTMLElement>('.nav')!;
  const sourcePane = document.createElement('section'); sourcePane.className = 'di-source-pane';
  const sourceEmpty = document.createElement('p'); sourceEmpty.className = 'muted'; sourceEmpty.textContent = 'Choose a file from Inspector & files.'; sourceEmpty.style.margin = '12px';
  sourcePane.append(fileTabs, sourceEmpty, fileBody);
  const host = document.createElement('div'); host.className = 'dockview-theme-dark di-dockview';
  const style = document.createElement('style'); style.textContent = dockviewCss + `
    .shell{display:flex;flex-direction:column;min-width:0;min-height:0}.di-dockview{flex:1;min-height:0;width:100%}
    .di-dockview .workspace,.di-dockview .inspector,.di-source-pane{height:100%;width:100%;min-width:0;min-height:0;overflow:auto}
    .di-source-pane{display:flex;flex-direction:column;background:#090f18}
    .di-dockview #question-dock{height:100%;max-height:none;resize:none;overflow:auto;padding:8px;background:#0b1420}
    .di-dockview #question-dock .query-box{grid-template-columns:minmax(0,1fr) minmax(90px,140px) auto;margin:0}
    .di-dockview #question-dock .query-box:has(#query-source[hidden]){grid-template-columns:minmax(0,1fr) auto}
    .di-dockview #question-dock button{background:#14243a;color:#dbe7f6;border:1px solid #334963;border-radius:5px;padding:5px 8px;cursor:pointer}
    .di-dockview .inspector{resize:none}
    .di-dockview .workspace #content:has(.graph-shell){display:flex;flex-direction:column;overflow:hidden}
    .di-dockview .investigation-layout:has(.graph-shell){flex:1;min-height:0;align-items:stretch}
    .di-dockview #explore-result:has(.graph-shell){display:flex;flex-direction:column;min-height:0}
    .di-dockview .graph-shell{flex:1;height:auto;min-height:0}
    .di-layout-toolbar{display:flex;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid #26364d;background:#0c131e}
    .di-layout-toolbar button,.di-source-pane .inspector-tabs button{font-size:12px;color:#dbe7f6;background:#14243a;border:1px solid #334963;border-radius:5px;padding:6px 9px;cursor:pointer}
    .di-layout-toolbar details{position:relative;color:#dbe7f6;font-size:12px}.di-layout-toolbar summary{cursor:pointer;padding:6px 9px;border:1px solid #334963;border-radius:5px;background:#14243a}
    .di-move-controls{position:absolute;z-index:20;right:0;min-width:220px;display:grid;gap:8px;padding:12px;background:#101b29;border:1px solid #334963;border-radius:6px;box-shadow:0 8px 24px #0008}
    .di-move-controls label{display:grid;gap:4px}.di-move-controls select{background:#0d1624;color:#edf4ff;border:1px solid #334963;border-radius:5px;padding:6px}
    .di-source-pane button[aria-current="true"]{border-color:#75d6f5;background:#1b3850}
  `; document.head.append(style);
  const parkedPanels = document.createElement('div'); parkedPanels.hidden = true;
  shell.replaceChildren(navigation, host, parkedPanels);
  const panes: Record<string, HTMLElement> = { graph: graphPane, questions: dock, inspector, source: sourcePane };
  dockApi = createDockview(host, { createComponent: ({ name }) => {
    const element = panes[name]; if (!element) throw new Error('Unknown workspace panel');
    return { element, init: () => {} };
  } });
  const addPanel = (id: string, placement?: 'left' | 'right' | 'above' | 'below' | 'within', size?: number) => {
    const existing = dockApi.getPanel(id); if (existing) { existing.api.setActive(); return; }
    const titles: Record<string, string> = { graph: 'Graph', questions: 'Questions', inspector: 'Inspector & files', source: 'Source' };
    const graphWidth = dockApi.getPanel('graph')?.group.api.width ?? host.clientWidth;
    // Dockview may take space from neighboring groups as well as the reference
    // group. Keep Source in the graph group unless the whole row has room for
    // Graph, Source and Inspector together.
    const sourceAsTab = id === 'source' && (host.clientWidth < 1600 || graphWidth < 1000);
    const direction = placement ?? ((compact && (id === 'inspector' || id === 'source')) || sourceAsTab ? 'within' : (id === 'questions' ? 'below' : 'right'));
    const savedSize = Number.isFinite(size) && size! >= 100 ? size! : undefined;
    const sourceWidth = Math.min(460, Math.max(300, Math.floor(graphWidth * .48)));
    const panel = dockApi.addPanel({ id, component: id, title: titles[id] ?? id, renderer: 'always', ...(direction === 'within' ? {} : id === 'questions' ? { initialHeight: savedSize ?? 220 } : id === 'inspector' ? { initialWidth: savedSize ?? 280 } : id === 'source' ? { initialWidth: sourceWidth } : {}), ...(id === 'graph' || !dockApi.getPanel('graph') ? {} : { position: { referencePanel: 'graph', direction } }) });
    if (direction !== 'within' && id !== 'graph') requestAnimationFrame(() => {
      if (dockApi.getPanel(id) !== panel) return;
      if (id === 'questions') panel.group.api.setSize({ height: savedSize ?? 220 });
      else panel.group.api.setSize({ width: savedSize ?? (id === 'source' ? sourceWidth : 280) });
    });
  };
  const resetLayout = () => { dockApi.clear(); addPanel('graph'); addPanel('questions'); addPanel('inspector'); dockApi.getPanel('graph')?.api.setActive(); };
  document.addEventListener('di-show-questions', () => addPanel('questions'));
  resetLayout();
  const layoutControls = document.createElement('div'); layoutControls.className = 'di-layout-toolbar';
  for (const [label, action] of [['Graph', () => addPanel('graph')], ['Questions', () => addPanel('questions')], ['Inspector & files', () => addPanel('inspector')], ['Reset layout', resetLayout]] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = action; layoutControls.append(button);
  }
  const moveMenu = document.createElement('details');
  moveMenu.innerHTML = '<summary>Move panel</summary><div class="di-move-controls"><label>Panel<select aria-label="Panel to move"><option value="questions">Questions</option><option value="inspector">Inspector & files</option><option value="source">Source</option></select></label><label>Position relative to graph<select aria-label="Position relative to graph"><option value="left">Left</option><option value="right">Right</option><option value="top">Above</option><option value="bottom">Below</option><option value="center">As a tab</option></select></label><button type="button">Move</button><span role="status"></span></div>';
  moveMenu.querySelector('button')!.onclick = () => {
    const panelId = moveMenu.querySelector<HTMLSelectElement>('[aria-label="Panel to move"]')!.value;
    const position = moveMenu.querySelector<HTMLSelectElement>('[aria-label="Position relative to graph"]')!.value as 'left' | 'right' | 'top' | 'bottom' | 'center';
    addPanel('graph'); addPanel(panelId);
    const panel = dockApi.getPanel(panelId), graph = dockApi.getPanel('graph');
    if (panel && graph) { panel.api.moveTo({ group: graph.group, position }); panel.api.setActive(); moveMenu.querySelector('[role="status"]')!.textContent = 'Panel moved.'; }
  };
  layoutControls.append(moveMenu);
  shell.prepend(layoutControls);
  dockApi.onDidLayoutChange(() => {
    if (layoutReady && compactMedia.matches === compact) layouts[compact ? 'compact' : 'wide'] = dockApi.toJSON();
    window.clearTimeout(layoutTimer); layoutTimer = window.setTimeout(saveLayout, 700);
  });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'di-layout') return;
    const savedLayouts = event.data.layout?.layouts;
    if (savedLayouts && typeof savedLayouts === 'object') { layouts.compact = savedLayouts.compact; layouts.wide = savedLayouts.wide; }
    const saved = layouts[compact ? 'compact' : 'wide'];
    if (saved) { try { dockApi.fromJSON(saved); } catch { resetLayout(); } }
    else if (!savedLayouts && event.data.layout && typeof event.data.layout === 'object' && ('inspectorSide' in event.data.layout || 'questionPosition' in event.data.layout)) {
      const legacy = event.data.layout;
      dockApi.clear(); addPanel('graph');
      addPanel('questions', legacy.questionPosition === 'top' ? 'above' : 'below', legacy.questionHeight);
      if (legacy.inspectorOpen !== false) addPanel('inspector', legacy.inspectorSide === 'left' ? 'left' : 'right', legacy.inspectorWidth);
      dockApi.getPanel('graph')?.api.setActive();
    }
    if (!dockApi.getPanel('graph')) addPanel('graph');
    requestAnimationFrame(() => { layoutReady = true; layouts[compact ? 'compact' : 'wide'] = dockApi.toJSON(); });
  });
  compactMedia.addEventListener('change', event => {
    if (!layouts[compact ? 'compact' : 'wide']) layouts[compact ? 'compact' : 'wide'] = dockApi.toJSON();
    compact = event.matches; layoutReady = false;
    const saved = layouts[compact ? 'compact' : 'wide'];
    if (saved) { try { dockApi.fromJSON(saved); } catch { resetLayout(); } } else resetLayout();
    if (!dockApi.getPanel('graph')) addPanel('graph');
    requestAnimationFrame(() => { layoutReady = true; saveLayout(); });
  });
  const graphTab = document.createElement('button'); graphTab.textContent = 'Return to graph'; fileTabs.append(graphTab);
  let activeFile = '', fileSequence = 0;
  const openFiles: string[] = [];
  dockApi.onDidRemovePanel(panel => { queueMicrotask(() => {
    if (dockApi.getPanel(panel.id) || !panes[panel.id]) return;
    parkedPanels.append(panes[panel.id]!);
  }); });
  const showGraph = () => { ++fileSequence; activeFile = ''; fileTabs.querySelectorAll<HTMLButtonElement>('[data-file]').forEach(item => item.setAttribute('aria-current', 'false')); fileBody.hidden = true; dockApi.getPanel('source')?.api.close(); addPanel('graph'); window.dispatchEvent(new Event('resize')); };
  graphTab.onclick = showGraph;
  for (const button of navButtons) button.addEventListener('click', showGraph);
  const openFile = async (file: string) => {
    let b = Array.from(fileTabs.querySelectorAll<HTMLButtonElement>('button')).find(item => item.dataset.file === file);
    if (!b) {
      const group = document.createElement('span'); b = document.createElement('button'); b.dataset.file = file; b.textContent = file.split('/').pop() ?? file; b.title = file;
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close ' + file);
      close.onclick = () => {
        const wasActive = activeFile === file; const index = openFiles.indexOf(file); if (index >= 0) openFiles.splice(index, 1); group.remove();
        if (wasActive) { ++fileSequence; const previous = openFiles.at(-1); if (previous) void openFile(previous); else showGraph(); }
      };
      group.append(b, close); fileTabs.append(group);
    }
    b.onclick = () => void openFile(file);
    const existing = openFiles.indexOf(file); if (existing >= 0) openFiles.splice(existing, 1); openFiles.push(file);
    activeFile = file; const sequence = ++fileSequence;
    fileTabs.querySelectorAll<HTMLButtonElement>('[data-file]').forEach(item => item.setAttribute('aria-current', item.dataset.file === file ? 'true' : 'false'));
    addPanel('source'); sourceEmpty.hidden = true; fileBody.hidden = false; editor?.destroy(); editor = undefined; fileEditor.replaceChildren(); fileStatus.textContent = 'Loading ' + file + '…';
    try {
      const result = await getJson('/workbench/source', new URLSearchParams({ file }), message => { if (sequence === fileSequence && activeFile === file) fileStatus.textContent = `${file}: ${message}`; });
      if (sequence !== fileSequence || activeFile !== file) return;
      if (result.file !== file || (viewerConfig.graphId && result.graphId !== viewerConfig.graphId) || (viewerConfig.revision && result.revision !== viewerConfig.revision)) throw new Error('Source identity does not match the selected file and graph. Reopen the graph and try again.');
      fileStatus.textContent = `${result.file} · ${result.revision ? 'revision ' + result.revision : 'working source snapshot'} · Read only`;
      editor = new EditorView({ parent: fileEditor, state: EditorState.create({ doc: result.content, extensions: [basicSetup, oneDark, fileLanguage(file), EditorState.readOnly.of(true), EditorView.editable.of(false)] }) });
    } catch (error) {
      if (sequence !== fileSequence || activeFile !== file) return;
      fileStatus.textContent = error instanceof Error ? error.message : String(error);
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.onclick = () => void openFile(file); fileStatus.append(' ', retry);
    }
  };
  let loaded = false, filesLoading = false;
  tabs.querySelectorAll<HTMLButtonElement>('[data-pane]').forEach(button => button.onclick = async () => {
    const files = button.dataset.pane === 'files'; original.forEach(item => { item.hidden = files; }); filesPane.hidden = !files;
    if (!files || loaded || filesLoading) return;
    filesLoading = true;
    filesPane.setAttribute('role', 'status');
    filesPane.textContent = 'Loading files…';
    try {
      const result = await getJson('/workbench/source', new URLSearchParams(), message => { filesPane.textContent = `Loading files: ${message}`; }); filesPane.removeAttribute('role'); filesPane.replaceChildren();
      const dirs = new Map<string, HTMLElement>(); dirs.set('', filesPane);
      for (const file of result.files as string[]) {
        const parts = file.split('/'); let parent = '', container: HTMLElement = filesPane;
        for (const part of parts.slice(0, -1)) {
          const key = parent ? parent + '/' + part : part;
          if (!dirs.has(key)) { const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = part; details.append(summary); container.append(details); dirs.set(key, details); }
          container = dirs.get(key)!; parent = key;
        }
        const link = document.createElement('button'); link.type = 'button'; link.textContent = parts.at(-1) ?? file; link.title = file; link.className = 'nav-button'; link.onclick = () => void openFile(file); container.append(link);
      }
      loaded = true;
    } catch (error) {
      filesPane.textContent = `Could not load files: ${error instanceof Error ? error.message : String(error)} `;
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.onclick = () => button.click(); filesPane.append(retry);
    } finally { filesLoading = false; }
  });
}

for (const button of navButtons) button.addEventListener('click', () => void activateSection(button.dataset.section as Section));
projectSelect.addEventListener('change', () => { window.location.assign(`/workbench?project=${encodeURIComponent(projectSelect.value)}`); });
revisionForm.addEventListener('submit', event => { event.preventDefault(); const ref = revisionInput.value.trim(); if (!ref) return; window.location.assign(`/workbench?project=${encodeURIComponent(viewerConfig.project)}&ref=${encodeURIComponent(ref)}`); });
globalForm.addEventListener('submit', event => { event.preventDefault(); const value = globalInput.value.trim(); if (!value) return; void activateSection('query', value); });
document.addEventListener('keydown', event => { if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && !(event.target instanceof Element && event.target.closest('.cm-editor'))) { event.preventDefault(); globalInput.focus(); } });

if (viewerConfig.machineBuild) {
  const status = document.getElementById('machine-build-status');
  let awaitingGraph = false;
  const pollBuild = async (): Promise<void> => {
    if (!status) return;
    try {
      const build = await getJson('/workbench/graph-build', new URLSearchParams(viewerConfig.buildRevision ? { revision: viewerConfig.buildRevision } : {}));
      if (build.state === 'complete') {
        status.textContent = `Graph ready · ${String(build.revision).slice(0, 12)}`;
        if (awaitingGraph) { awaitingGraph = false; void activateSection(section); }
        return;
      }
      if (build.state === 'failed') {
        status.textContent = `Graph build failed: ${build.error ?? 'unknown error'} `;
        const retry = document.createElement('button'); retry.textContent = 'Retry';
        retry.addEventListener('click', async () => {
          try { const restarted = await postJson('/workbench/graph-build', {}); viewerConfig.buildRevision = restarted.revision; awaitingGraph = true; void pollBuild(); }
          catch (error) { status.textContent = String(error); }
        });
        status.append(retry); return;
      }
      if (build.state === 'not-built') {
        const restarted = await postJson('/workbench/graph-build', {});
        viewerConfig.buildRevision = restarted.revision;
        awaitingGraph = true; window.setTimeout(() => void pollBuild(), 2000); return;
      }
      awaitingGraph = true;
      const progress = build.progress;
      status.textContent = `Graph ${build.state} · ${String(progress?.stage ?? 'waiting').replaceAll('-', ' ')}${progress?.total !== undefined ? ` ${progress.completed}/${progress.total}` : ''}`;
      window.setTimeout(() => void pollBuild(), 2000);
    } catch (error) { status.textContent = `Graph status unavailable: ${String(error)}`; }
  };
  void pollBuild();
}
void activateSection(section);
