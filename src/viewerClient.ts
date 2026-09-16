import { MultiGraph } from 'graphology';
import Sigma from 'sigma';

declare global {
  interface Window {
    __DEVINT_VIEWER__?: { project: string; ref?: string; graphId?: string };
  }
}

type View = 'architecture' | 'parity' | 'code' | 'change';
type ProjectionNode = { id: string; kind: string; layer?: string; name?: string; locator?: string; value?: unknown; evidenceIds?: string[] };
type ProjectionEdge = { id: string; from: string | null; to: string | null; kind: string; status: string; strategy?: string; confidence?: number | null; evidenceIds?: string[] };
type EvidenceItem = { id?: string; kind?: string; locator?: string; message?: string; [key: string]: unknown };
type Projection = { project: string; graphId?: string; revision?: string; view: View; selected?: string; ambiguous?: boolean; candidates?: Array<{ id: string; kind: string; layer: string; name: string | null; locator: string }>; nodes: ProjectionNode[]; edges: ProjectionEdge[]; evidence?: EvidenceItem[]; coverage?: unknown; truncated?: boolean };

const config = window.__DEVINT_VIEWER__;
if (!config?.project) throw new Error('Development Intelligence viewer is missing project context');
const viewerConfig: { project: string; ref?: string; graphId?: string } = config;

const container = document.getElementById('graph') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const detail = document.getElementById('detail') as HTMLElement;
const search = document.getElementById('search') as HTMLInputElement;
const form = document.getElementById('search-form') as HTMLFormElement;
const title = document.getElementById('workspace-title') as HTMLElement;
const description = document.getElementById('workspace-description') as HTMLElement;
const backButton = document.getElementById('history-back') as HTMLButtonElement;
const fitButton = document.getElementById('fit') as HTMLButtonElement;
const zoomInButton = document.getElementById('zoom-in') as HTMLButtonElement;
const zoomOutButton = document.getElementById('zoom-out') as HTMLButtonElement;
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'));
const jumpButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-jump]'));

const viewCopy: Record<View, { title: string; description: string; start: string }> = {
  architecture: {
    title: 'Architecture',
    description: 'Start with the system map, then select a concept to inspect its neighborhood and evidence.',
    start: 'Architecture is the high-level system map: features, routes, APIs, MCP tools and providers. Pick a named concept instead of trying to read every line at once.',
  },
  parity: {
    title: 'Parity',
    description: 'See how product concepts appear across human, agent, API, MCP and provider representations.',
    start: 'Parity is descriptive, not a checklist. Select a capability or surface to see which representations are proven, which are candidates and which remain unresolved.',
  },
  code: {
    title: 'Code',
    description: 'Navigate files, symbols, imports, definitions and provable calls without replacing your source editor.',
    start: 'Code is a technical neighborhood map. Search for a file or symbol, then move through its connections to understand callers, imports and containment.',
  },
  change: {
    title: 'Change',
    description: 'Review semantic topology change without treating line movement or evidence churn as product change.',
    start: 'Change highlights accepted-versus-working semantic differences. An empty graph can be a good result when only implementation/provenance moved.',
  },
};

let view: View = 'architecture';
let renderer: Sigma | null = null;
let activeProjection: Projection | null = null;
let selectedId: string | null = null;
const history: string[] = [];

function hash(value: string): number {
  let output = 2166136261;
  for (let i = 0; i < value.length; i += 1) output = Math.imul(output ^ value.charCodeAt(i), 16777619);
  return output >>> 0;
}

function color(node: ProjectionNode): string {
  if (node.layer === 'semantic') return '#67d3f5';
  if (node.layer === 'representation') return '#ffc857';
  return '#aa91ff';
}

function verticalPosition(node: ProjectionNode, index: number): number {
  const h = hash(node.id);
  return (((h % 1000) / 1000) - 0.5) * 1.9 + ((index % 7) - 3) * 0.015;
}

function coordinates(node: ProjectionNode, index: number, total: number): { x: number; y: number } {
  const h = hash(`${node.kind}:${node.id}`);
  if (view === 'architecture') {
    const xByKind: Record<string, number> = { route: -1.25, api: -1.05, feature: -0.15, capability: -0.15, mcp: 0.65, tool: 0.7, provider: 1.25, surface: -0.65, action: 0.15 };
    const base = xByKind[node.kind] ?? (node.layer === 'semantic' ? 0 : node.layer === 'representation' ? 1.45 : -1.45);
    return { x: base + (((h >>> 8) % 100) / 100 - 0.5) * 0.16, y: verticalPosition(node, index) };
  }
  if (view === 'code') {
    const x = node.kind === 'file' ? -1.3 : node.kind === 'import-binding' ? -0.6 : node.layer === 'representation' ? 1.25 : 0.35;
    return { x: x + (((h >>> 7) % 100) / 100 - 0.5) * 0.2, y: verticalPosition(node, index) };
  }
  if (view === 'parity') {
    const kindAngle = ((hash(node.kind) % 10000) / 10000) * Math.PI * 2;
    const offset = (((h >>> 9) % 1000) / 1000 - 0.5) * 0.38;
    const radius = node.layer === 'semantic' ? 0.75 : node.layer === 'representation' ? 1.2 : 1.45;
    return { x: Math.cos(kindAngle + offset) * radius, y: Math.sin(kindAngle + offset) * radius };
  }
  const angle = ((h % 100000) / 100000) * Math.PI * 2 + (index / Math.max(total, 1)) * 0.4;
  const radius = node.layer === 'semantic' ? 0.72 : 1.15;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function badge(value: string, className?: string): HTMLElement {
  const span = document.createElement('span');
  span.className = `badge${className ? ` ${className}` : ''}`;
  span.textContent = value;
  return span;
}

function field(parent: HTMLElement, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  const row = document.createElement('div');
  row.className = 'kv';
  const label = document.createElement('div');
  label.className = 'key';
  label.textContent = key;
  const body = document.createElement('div');
  body.className = 'value';
  body.textContent = text(value);
  row.append(label, body);
  parent.appendChild(row);
}

function rawDetails(value: unknown): HTMLElement {
  const wrapper = document.createElement('details');
  wrapper.className = 'raw';
  const summary = document.createElement('summary');
  summary.textContent = 'Technical record';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(value, null, 2);
  wrapper.append(summary, pre);
  return wrapper;
}

function evidenceSection(items: EvidenceItem[]): HTMLElement | null {
  if (!items.length) return null;
  const section = document.createElement('section');
  section.className = 'detail-section';
  const heading = document.createElement('h3');
  heading.textContent = `Evidence (${items.length})`;
  section.appendChild(heading);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'evidence-item';
    const message = item.message ?? item.kind ?? 'evidence';
    const locator = item.locator ? ` · ${item.locator}` : '';
    row.textContent = `${text(message)}${locator}`;
    section.appendChild(row);
  }
  return section;
}

function showStart(): void {
  selectedId = null;
  backButton.disabled = history.length === 0;
  const copy = viewCopy[view];
  detail.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'start-card';
  card.innerHTML = `<strong>Start here</strong><p>${copy.start}</p>`;
  detail.appendChild(card);
  const steps = [
    ['Search', 'Type a concept you recognize, or use one of the “Find…” shortcuts on the left.'],
    ['Focus', 'Select one result. The graph becomes a small neighborhood instead of a wall of nodes.'],
    ['Navigate', 'Use the Connections list here to move through the system; the graph gives spatial context.'],
  ];
  for (const [index, step] of steps.entries()) {
    const row = document.createElement('div');
    row.className = 'step';
    row.innerHTML = `<span class="step-num">${index + 1}</span><span class="hint"><strong>${step[0]}</strong><br>${step[1]}</span>`;
    detail.appendChild(row);
  }
}

function nodeLabel(id: string | null, projection: Projection): string {
  if (!id) return 'unresolved';
  const node = projection.nodes.find(item => item.id === id);
  return node?.name ?? node?.id ?? id;
}

function connectionSection(selected: ProjectionNode, projection: Projection): HTMLElement | null {
  const edges = projection.edges.filter(edge => edge.from === selected.id || edge.to === selected.id);
  if (!edges.length) return null;
  const section = document.createElement('section');
  section.className = 'detail-section';
  const heading = document.createElement('h3');
  heading.textContent = `Connections (${edges.length})`;
  section.appendChild(heading);
  for (const edge of edges.slice(0, 80)) {
    const outgoing = edge.from === selected.id;
    const neighborId = outgoing ? edge.to : edge.from;
    const button = document.createElement('button');
    button.className = 'connection';
    const direction = outgoing ? '→' : '←';
    button.innerHTML = `<span>${direction} ${escapeText(nodeLabel(neighborId, projection))}</span><small>${escapeText(edge.kind)} · <span class="status-${escapeText(edge.status)}">${escapeText(edge.status)}</span></small>`;
    if (!neighborId) button.disabled = true;
    else button.addEventListener('click', () => void load(neighborId, true, true));
    section.appendChild(button);
  }
  return section;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function showGeneric(value: unknown): void {
  detail.innerHTML = '';
  detail.appendChild(rawDetails(value));
}

function showEdge(edge: ProjectionEdge, projection: Projection): void {
  detail.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'detail-card';
  const titleElement = document.createElement('div');
  titleElement.className = 'detail-title';
  titleElement.textContent = `${nodeLabel(edge.from, projection)} → ${nodeLabel(edge.to, projection)}`;
  const badges = document.createElement('div');
  badges.className = 'badges';
  badges.append(badge(edge.kind), badge(edge.status, `status-${edge.status}`));
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  field(grid, 'Strategy', edge.strategy);
  field(grid, 'Confidence', edge.confidence);
  card.append(titleElement, badges, grid);
  detail.appendChild(card);
  const ids = new Set(edge.evidenceIds ?? []);
  const section = evidenceSection((projection.evidence ?? []).filter(item => Boolean(item.id && ids.has(item.id))));
  if (section) detail.appendChild(section);
  detail.appendChild(rawDetails(edge));
}

function showSelection(selected: ProjectionNode, projection: Projection): void {
  detail.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'detail-card';
  const titleElement = document.createElement('div');
  titleElement.className = 'detail-title';
  titleElement.textContent = selected.name ?? selected.id;
  const badges = document.createElement('div');
  badges.className = 'badges';
  badges.append(badge(selected.kind), badge(selected.layer ?? 'structural'));
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  field(grid, 'ID', selected.id);
  field(grid, 'Source', selected.locator);
  field(grid, 'Neighborhood', `${projection.nodes.length} nodes · ${projection.edges.length} edges`);
  if (selected.value !== undefined && selected.value !== selected.name && selected.value !== selected.id) field(grid, 'Value', selected.value);
  card.append(titleElement, badges, grid);
  detail.appendChild(card);

  const connections = connectionSection(selected, projection);
  if (connections) detail.appendChild(connections);
  const ids = new Set(selected.evidenceIds ?? []);
  const evidence = evidenceSection((projection.evidence ?? []).filter(item => Boolean(item.id && ids.has(item.id))));
  if (evidence) detail.appendChild(evidence);
  detail.appendChild(rawDetails({ selected, coverage: projection.coverage }));
}

function showCandidates(projection: Projection): void {
  selectedId = null;
  detail.innerHTML = '<div class="start-card"><strong>Choose the exact result</strong><p>Several graph entities match that search. Picking one narrows the graph to a useful neighborhood.</p></div>';
  for (const candidate of projection.candidates ?? []) {
    const button = document.createElement('button');
    button.className = 'candidate';
    button.innerHTML = `<span>${escapeText(candidate.name ?? candidate.id)}</span><small>${escapeText(candidate.kind)} · ${escapeText(candidate.locator)}</small>`;
    button.addEventListener('click', () => void load(candidate.id, true, true));
    detail.appendChild(button);
  }
}

function render(projection: Projection): void {
  activeProjection = projection;
  renderer?.kill();
  renderer = null;
  container.innerHTML = '';
  if (projection.ambiguous) {
    showCandidates(projection);
    status.textContent = `${projection.candidates?.length ?? 0} matching entities`;
    return;
  }
  const graph = new MultiGraph({ allowSelfLoops: false });
  projection.nodes.forEach((node, index) => {
    const point = coordinates(node, index, projection.nodes.length);
    graph.addNode(node.id, {
      label: node.name ?? node.id,
      x: point.x,
      y: point.y,
      size: node.layer === 'semantic' ? 8 : node.kind === 'file' ? 6 : node.layer === 'representation' ? 4.5 : 4,
      color: color(node),
      zIndex: node.layer === 'semantic' ? 3 : node.layer === 'representation' ? 2 : 1,
      node,
    });
  });
  for (const edge of projection.edges) {
    if (!edge.from || !edge.to || !graph.hasNode(edge.from) || !graph.hasNode(edge.to) || edge.from === edge.to) continue;
    try {
      graph.addEdgeWithKey(edge.id, edge.from, edge.to, {
        label: edge.kind,
        size: edge.status === 'resolved' ? 1.25 : 0.85,
        color: edge.status === 'resolved' ? '#52657d' : edge.status === 'candidate' ? '#b9823c' : '#b94f56',
        zIndex: edge.status === 'resolved' ? 1 : 2,
        edge,
      });
    } catch {
      // Rendering is a lens; graph truth remains available through agent tools.
    }
  }
  renderer = new Sigma(graph, container, {
    renderEdgeLabels: projection.nodes.length < 100,
    labelDensity: projection.nodes.length < 120 ? 0.35 : 0.16,
    labelGridCellSize: 78,
    labelRenderedSizeThreshold: projection.nodes.length < 120 ? 5 : 7,
    zIndex: true,
    enableEdgeEvents: true,
  });
  renderer.on('clickNode', event => void load(event.node, true, true));
  renderer.on('clickEdge', event => {
    const attrs = graph.getEdgeAttributes(event.edge);
    const edgeValue = attrs.edge as ProjectionEdge | undefined;
    if (edgeValue) showEdge(edgeValue, projection);
    else showGeneric(attrs);
  });
  renderer.on('enterNode', event => {
    const attrs = graph.getNodeAttributes(event.node);
    status.textContent = `${attrs.label ?? event.node} · click to inspect`;
  });
  renderer.on('leaveNode', () => {
    status.textContent = `${projection.nodes.length} nodes · ${projection.edges.length} edges${projection.truncated ? ' · bounded view' : ''}`;
  });
  selectedId = projection.selected ?? null;
  backButton.disabled = history.length === 0;
  if (projection.selected) {
    const selected = projection.nodes.find(node => node.id === projection.selected);
    if (selected) showSelection(selected, projection);
    else showStart();
  } else {
    showStart();
  }
  status.textContent = `${projection.nodes.length} nodes · ${projection.edges.length} edges${projection.truncated ? ' · bounded view' : ''}`;
  requestAnimationFrame(() => renderer?.getCamera().animatedReset({ duration: 350 }));
}

async function load(query?: string, exact = false, pushHistory = false): Promise<void> {
  if (pushHistory && selectedId && selectedId !== query) history.push(selectedId);
  status.textContent = 'Loading…';
  const params = new URLSearchParams({ project: viewerConfig.project, view, limit: '900', depth: '2' });
  if (viewerConfig.graphId) params.set('graphId', viewerConfig.graphId);
  else if (viewerConfig.ref) params.set('ref', viewerConfig.ref);
  if (query) params.set(exact ? 'node' : 'query', query);
  const response = await fetch(`/graph/data?${params.toString()}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(await response.text());
  render(await response.json() as Projection);
}

function setView(next: View): void {
  view = next;
  const copy = viewCopy[view];
  title.textContent = copy.title;
  description.textContent = copy.description;
  for (const item of viewButtons) item.classList.toggle('active', item.dataset.view === view);
  history.splice(0, history.length);
  search.value = '';
  void load().catch(error => { status.textContent = 'Failed'; showGeneric({ error: error instanceof Error ? error.message : String(error) }); });
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const value = search.value.trim();
  history.splice(0, history.length);
  void load(value || undefined, false, false).catch(error => { status.textContent = 'Failed'; showGeneric({ error: error instanceof Error ? error.message : String(error) }); });
});

for (const button of viewButtons) {
  button.addEventListener('click', () => {
    if (!button.disabled) setView(button.dataset.view as View);
  });
}

for (const button of jumpButtons) {
  button.addEventListener('click', () => {
    const value = button.dataset.jump ?? '';
    search.value = value;
    search.focus();
    history.splice(0, history.length);
    void load(value, false, false).catch(error => { status.textContent = 'Failed'; showGeneric({ error: error instanceof Error ? error.message : String(error) }); });
  });
}

backButton.addEventListener('click', () => {
  const previous = history.pop();
  if (!previous) return;
  void load(previous, true, false).catch(error => { status.textContent = 'Failed'; showGeneric({ error: error instanceof Error ? error.message : String(error) }); });
});

fitButton.addEventListener('click', () => renderer?.getCamera().animatedReset({ duration: 300 }));
zoomInButton.addEventListener('click', () => renderer?.getCamera().animatedZoom({ duration: 220 }));
zoomOutButton.addEventListener('click', () => renderer?.getCamera().animatedUnzoom({ duration: 220 }));

document.addEventListener('keydown', event => {
  if (event.key === '/' && document.activeElement !== search) {
    event.preventDefault();
    search.focus();
    search.select();
  }
  if (event.key === 'Escape' && document.activeElement === search) search.blur();
});

showStart();
void load().catch(error => { status.textContent = 'Failed'; showGeneric({ error: error instanceof Error ? error.message : String(error) }); });
