import type { IntelligenceGraph } from './types.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function renderGraphViewer(graph: IntelligenceGraph): string {
  const maxNodes = Math.max(50, Number(process.env.DEVINT_VIEWER_MAX_NODES ?? 450));
  const nodes = graph.nodes.slice(0, maxNodes);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => edge.from && edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to)).slice(0, maxNodes * 3);
  const data = JSON.stringify({ nodes, edges }).replace(/</g, '\\u003c');
  const shownSuffix = graph.nodes.length > nodes.length ? ` of ${graph.nodes.length}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(graph.project)} — Development Intelligence</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090b10;color:#f3f4f6}*{box-sizing:border-box}body{margin:0;display:grid;grid-template-rows:auto 1fr;height:100vh}.top{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid #242938;background:#0d1118}.title{font-weight:700}.meta{font-size:12px;color:#9ca3af}.top input{margin-left:auto;width:min(420px,45vw);border:1px solid #303749;background:#111827;color:#fff;border-radius:8px;padding:9px 11px}.shell{display:grid;grid-template-columns:1fr 300px;min-height:0}.canvas{position:relative;overflow:hidden}.side{border-left:1px solid #242938;padding:14px;overflow:auto;background:#0d1118}.side h2{font-size:13px;margin:0 0 10px;color:#cbd5e1}.side pre{white-space:pre-wrap;word-break:break-word;font-size:11px;color:#cbd5e1}svg{width:100%;height:100%;display:block}.edge{stroke:#374151;stroke-width:1;opacity:.5}.node{cursor:pointer}.node circle{fill:#172033;stroke:#64748b;stroke-width:1.2}.node text{font-size:10px;fill:#e5e7eb;pointer-events:none}.node.dim{opacity:.12}.node.selected circle{stroke:#fff;stroke-width:2.5}.legend{font-size:11px;color:#94a3b8;margin-top:8px}@media(max-width:800px){.shell{grid-template-columns:1fr}.side{display:none}.top input{width:42vw}}
</style>
</head>
<body>
<div class="top"><div><div class="title">${escapeHtml(graph.project)}</div><div class="meta">${escapeHtml(graph.role)} · ${escapeHtml(graph.repositoryRevision ?? 'unknown revision')} · ${graph.nodes.length} nodes · ${graph.edges.length} edges</div></div><input id="search" placeholder="Search nodes…" aria-label="Search graph nodes" /></div>
<div class="shell"><div class="canvas"><svg id="graph" role="img" aria-label="Development Intelligence graph"></svg></div><aside class="side"><h2>Selected node</h2><pre id="detail">Select a node to inspect its evidence.</pre><div class="legend">Showing ${nodes.length}${shownSuffix} nodes. The viewer is a projection of the same graph agents query.</div></aside></div>
<script>
const data=${data}; const svg=document.getElementById('graph'); const detail=document.getElementById('detail'); const search=document.getElementById('search');
const NS='http://www.w3.org/2000/svg'; const width=1200,height=850,cx=width/2,cy=height/2; svg.setAttribute('viewBox','0 0 '+width+' '+height);
const byId=new Map(data.nodes.map((n,i)=>[n.id,{...n,i}])); const positions=new Map();
const rings=Math.max(1,Math.ceil(Math.sqrt(data.nodes.length/18))); data.nodes.forEach((n,i)=>{const ring=1+(i%rings); const slot=Math.floor(i/rings); const slots=Math.ceil(data.nodes.length/rings); const angle=(slot/slots)*Math.PI*2+(ring%2)*.18; const radius=70+ring*(Math.min(width,height)*.42/rings); positions.set(n.id,{x:cx+Math.cos(angle)*radius,y:cy+Math.sin(angle)*radius});});
const edgeLayer=document.createElementNS(NS,'g'); svg.appendChild(edgeLayer); data.edges.forEach(e=>{const a=positions.get(e.from),b=positions.get(e.to); if(!a||!b)return; const line=document.createElementNS(NS,'line'); line.setAttribute('x1',a.x);line.setAttribute('y1',a.y);line.setAttribute('x2',b.x);line.setAttribute('y2',b.y);line.setAttribute('class','edge');line.dataset.kind=e.kind;edgeLayer.appendChild(line);});
const nodeLayer=document.createElementNS(NS,'g'); svg.appendChild(nodeLayer); const nodeEls=[]; data.nodes.forEach(n=>{const p=positions.get(n.id); const g=document.createElementNS(NS,'g');g.setAttribute('class','node');g.setAttribute('transform','translate('+p.x+' '+p.y+')');g.tabIndex=0;g.dataset.text=[n.id,n.kind,n.name,n.locator,n.raw].filter(Boolean).join(' ').toLowerCase(); const c=document.createElementNS(NS,'circle');c.setAttribute('r','7');g.appendChild(c);const t=document.createElementNS(NS,'text');t.setAttribute('x','10');t.setAttribute('y','4');t.textContent=(n.name||n.kind).slice(0,32);g.appendChild(t); const select=()=>{nodeEls.forEach(x=>x.classList.remove('selected'));g.classList.add('selected');detail.textContent=JSON.stringify(n,null,2)};g.addEventListener('click',select);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select()}});nodeLayer.appendChild(g);nodeEls.push(g);});
search.addEventListener('input',()=>{const q=search.value.trim().toLowerCase();nodeEls.forEach(el=>el.classList.toggle('dim',!!q&&!el.dataset.text.includes(q)));});
</script>
</body></html>`;
}
