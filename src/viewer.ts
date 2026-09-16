import type { IntelligenceGraph } from './types.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function renderGraphViewer(graph: IntelligenceGraph, requestedRef?: string): string {
  const project = escapeHtml(graph.project);
  const revision = escapeHtml(graph.repositoryRevision ?? 'unknown revision');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${project} — Development Intelligence</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#070a10;color:#eef2ff}*{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden;background:#070a10}.app{display:grid;grid-template-rows:auto 1fr;height:100vh}.top{display:flex;gap:12px;align-items:center;padding:12px 14px;border-bottom:1px solid #202738;background:#0b1019;min-width:0}.identity{min-width:180px}.title{font-weight:750;font-size:14px}.meta{font-size:11px;color:#8f9bad;margin-top:2px}.views{display:flex;gap:6px}.views button,.candidate{border:1px solid #2b3448;background:#111827;color:#cbd5e1;border-radius:8px;padding:7px 10px;cursor:pointer}.views button.active{background:#24314a;color:#fff;border-color:#5b6f99}.search{margin-left:auto;display:flex;gap:8px;min-width:min(460px,45vw)}.search input{width:100%;border:1px solid #303a50;background:#0e1522;color:#fff;border-radius:8px;padding:9px 11px}.shell{display:grid;grid-template-columns:minmax(0,1fr) 360px;min-height:0}.graph-wrap{position:relative;min-width:0;min-height:0}.graph{position:absolute;inset:0}.status{position:absolute;left:12px;bottom:12px;background:#0b1019dd;border:1px solid #293247;border-radius:8px;padding:7px 10px;font-size:11px;color:#a9b5c7;pointer-events:none}.side{border-left:1px solid #202738;background:#0b1019;padding:14px;overflow:auto}.side h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8f9bad;margin:0 0 10px}.side pre{white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.45;color:#cbd5e1}.hint{font-size:12px;color:#93a1b5;line-height:1.5}.candidate{display:block;width:100%;text-align:left;margin:6px 0}.legend{display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:#8f9bad;margin-top:14px;padding-top:12px;border-top:1px solid #202738}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}.detail-card{border:1px solid #273247;background:#0e1522;border-radius:10px;padding:12px;margin-bottom:10px}.detail-title{font-size:15px;font-weight:700;line-height:1.3;word-break:break-word}.badges{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.badge{display:inline-flex;border:1px solid #334155;background:#111827;border-radius:999px;padding:3px 7px;font-size:10px;color:#cbd5e1}.detail-grid{display:grid;gap:8px;margin-top:10px}.kv{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px;font-size:11px;line-height:1.45}.kv .key{color:#7f8ca1}.kv .value{color:#dbe4f2;word-break:break-word}.detail-section{margin-top:12px}.detail-section h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8f9bad}.evidence-item{border-left:2px solid #334155;padding:6px 8px;margin:5px 0;font-size:11px;color:#cbd5e1;line-height:1.4}.raw{margin-top:10px;border-top:1px solid #202738;padding-top:8px}.raw summary{cursor:pointer;color:#8f9bad;font-size:11px}.muted{color:#7f8ca1}@media(max-width:820px){body{overflow:auto}.app{height:auto;min-height:100vh}.top{flex-wrap:wrap}.views{order:3;width:100%;overflow-x:auto}.search{margin-left:0;flex:1;min-width:180px}.shell{display:block}.graph-wrap{height:58vh}.side{border-left:0;border-top:1px solid #202738;min-height:35vh}}
</style>
</head>
<body>
<div class="app" data-project="${project}" data-revision="${revision}">
  <header class="top">
    <div class="identity"><div class="title">${project}</div><div class="meta">${revision}</div></div>
    <nav class="views" aria-label="Graph views">
      <button type="button" data-view="architecture" class="active">Architecture</button>
      <button type="button" data-view="parity">Parity</button>
      <button type="button" data-view="code">Code</button>
      <button type="button" data-view="change">Change</button>
    </nav>
    <form class="search" id="search-form"><input id="search" autocomplete="off" placeholder="Search the whole graph…" aria-label="Search Development Intelligence" /></form>
  </header>
  <main class="shell">
    <section class="graph-wrap"><div id="graph" class="graph" role="img" aria-label="Development Intelligence graph"></div><div id="status" class="status">Loading…</div></section>
    <aside class="side"><h2>Inspector</h2><div id="detail" class="hint">Search or select a node. Development Intelligence will load a bounded neighborhood from the same graph agents query and show the evidence behind it.</div><div class="legend"><span><i class="dot" style="background:#7dd3fc"></i>semantic</span><span><i class="dot" style="background:#a78bfa"></i>structural</span><span><i class="dot" style="background:#fbbf24"></i>representation</span></div></aside>
  </main>
</div>
<script>window.__DEVINT_VIEWER__={project:${JSON.stringify(graph.project)},ref:${JSON.stringify(requestedRef ?? '')}};</script>
<script src="/viewer.js" defer></script>
</body></html>`;
}
