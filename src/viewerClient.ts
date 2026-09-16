import { MultiGraph } from 'graphology';
import Sigma from 'sigma';

declare global {
  interface Window {
    __DEVINT_VIEWER__?: { project: string; ref?: string };
  }
}

type View = 'architecture' | 'parity' | 'code' | 'change';
type ProjectionNode = { id: string; kind: string; layer?: string; name?: string; locator?: string; value?: unknown; evidenceIds?: string[] };
type ProjectionEdge = { id: string; from: string | null; to: string | null; kind: string; status: string; strategy?: string; confidence?: number | null };
type Projection = { project: string; revision?: string; view: View; selected?: string; ambiguous?: boolean; candidates?: Array<{ id: string; kind: string; layer: string; name: string | null; locator: string }>; nodes: ProjectionNode[]; edges: ProjectionEdge[]; evidence?: unknown[]; truncated?: boolean };

const config = window.__DEVINT_VIEWER__;
if (!config?.project) throw new Error('Development Intelligence viewer is missing project context');
const viewerConfig: { project: string; ref?: string } = config;

const container = document.getElementById('graph') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const detail = document.getElementById('detail') as HTMLElement;
const search = document.getElementById('search') as HTMLInputElement;
const form = document.getElementById('search-form') as HTMLFormElement;
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'));
let view: View = 'architecture';
let renderer: Sigma | null = null;

function hash(value: string): number {
  let output = 2166136261;
  for (let i = 0; i < value.length; i += 1) output = Math.imul(output ^ value.charCodeAt(i), 16777619);
  return output >>> 0;
}

function color(node: ProjectionNode): string {
  if (node.layer === 'semantic') return '#7dd3fc';
  if (node.layer === 'representation') return '#fbbf24';
  return '#a78bfa';
}

function coordinates(node: ProjectionNode, index: number, total: number): { x: number; y: number } {
  const h = hash(`${node.kind}:${node.id}`);
  const semantic = node.layer === 'semantic';
  const ring = semantic ? 0.55 : node.layer === 'representation' ? 0.9 : 1.2;
  const angle = ((h % 100000) / 100000) * Math.PI * 2 + (index / Math.max(total, 1)) * 0.35;
  const jitter = 0.18 + ((h >>> 9) % 1000) / 5000;
  return { x: Math.cos(angle) * (ring + jitter), y: Math.sin(angle) * (ring + jitter) };
}

function show(value: unknown): void {
  detail.innerHTML = '';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(value, null, 2);
  detail.appendChild(pre);
}

function showCandidates(projection: Projection): void {
  detail.innerHTML = '<div class="hint">That name is ambiguous. Pick the exact entity you mean:</div>';
  for (const candidate of projection.candidates ?? []) {
    const button = document.createElement('button');
    button.className = 'candidate';
    button.textContent = `${candidate.name ?? candidate.id} · ${candidate.kind} · ${candidate.locator}`;
    button.addEventListener('click', () => void load(candidate.id, true));
    detail.appendChild(button);
  }
}

function render(projection: Projection): void {
  renderer?.kill();
  renderer = null;
  container.innerHTML = '';
  if (projection.ambiguous) {
    showCandidates(projection);
    status.textContent = `${projection.candidates?.length ?? 0} candidates`;
    return;
  }
  const graph = new MultiGraph({ allowSelfLoops: false });
  projection.nodes.forEach((node, index) => {
    const point = coordinates(node, index, projection.nodes.length);
    graph.addNode(node.id, {
      label: node.name ?? node.id,
      x: point.x,
      y: point.y,
      size: node.layer === 'semantic' ? 7 : node.layer === 'representation' ? 4 : 3.5,
      color: color(node),
      node,
    });
  });
  for (const edge of projection.edges) {
    if (!edge.from || !edge.to || !graph.hasNode(edge.from) || !graph.hasNode(edge.to) || edge.from === edge.to) continue;
    try {
      graph.addEdgeWithKey(edge.id, edge.from, edge.to, { label: edge.kind, size: edge.status === 'resolved' ? 1.2 : 0.7, color: edge.status === 'resolved' ? '#475569' : '#7c5f37', edge });
    } catch {
      // Duplicate or incompatible evidence should not make the human viewer unavailable.
    }
  }
  renderer = new Sigma(graph, container, {
    renderEdgeLabels: projection.nodes.length < 180,
    labelDensity: 0.12,
    labelGridCellSize: 90,
    labelRenderedSizeThreshold: 7,
    zIndex: true,
    enableEdgeEvents: true,
  });
  renderer.on('clickNode', event => void load(event.node, true));
  renderer.on('clickEdge', event => {
    const attrs = graph.getEdgeAttributes(event.edge);
    show(attrs.edge ?? attrs);
  });
  if (projection.selected) {
    const selected = projection.nodes.find(node => node.id === projection.selected);
    show({ selected, evidence: projection.evidence ?? [], neighborhood: { nodes: projection.nodes.length, edges: projection.edges.length } });
  } else {
    detail.innerHTML = `<div class="hint">${view[0]!.toUpperCase()}${view.slice(1)} projection. Select a node or search across the full graph to inspect its bounded neighborhood and evidence.</div>`;
  }
  status.textContent = `${projection.nodes.length} nodes · ${projection.edges.length} edges${projection.truncated ? ' · bounded view' : ''}`;
}

async function load(query?: string, exact = false): Promise<void> {
  status.textContent = 'Loading…';
  const params = new URLSearchParams({ project: viewerConfig.project, view, limit: '900', depth: '2' });
  if (viewerConfig.ref) params.set('ref', viewerConfig.ref);
  if (query) params.set(exact ? 'node' : 'query', query);
  const response = await fetch(`/graph/data?${params.toString()}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(await response.text());
  render(await response.json() as Projection);
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const value = search.value.trim();
  void load(value || undefined, false).catch(error => { status.textContent = 'Failed'; show({ error: error instanceof Error ? error.message : String(error) }); });
});

for (const button of viewButtons) {
  button.addEventListener('click', () => {
    view = button.dataset.view as View;
    for (const item of viewButtons) item.classList.toggle('active', item === button);
    void load(search.value.trim() || undefined, false).catch(error => { status.textContent = 'Failed'; show({ error: error instanceof Error ? error.message : String(error) }); });
  });
}

void load().catch(error => { status.textContent = 'Failed'; show({ error: error instanceof Error ? error.message : String(error) }); });
