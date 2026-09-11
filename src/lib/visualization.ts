import type { Graph } from "../types.js";

/**
 * Self-contained visualization: the graph data is embedded inline (not fetched), and layout
 * is a hand-rolled force simulation with no external library, so the file opens correctly
 * straight from disk (file://) with no server and no network access required.
 */
export function renderVisualizationHtml(graph: Graph): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Dependency Graph</title>
<style>
  html, body { margin:0; height:100%; background:#0b0d12; color:#e6e6e6; font-family:-apple-system,Segoe UI,sans-serif; overflow:hidden; }
  #toolbar { position:fixed; top:0; left:0; right:0; padding:10px 14px; background:#12151c; border-bottom:1px solid #262b36; display:flex; gap:16px; align-items:center; font-size:13px; z-index:10; flex-wrap:wrap; }
  #toolbar b { color:#8ab4ff; }
  #toolbar label { display:flex; gap:6px; align-items:center; cursor:pointer; color:#c3c9d4; }
  #wrap { position:absolute; top:46px; left:0; right:0; bottom:0; }
  canvas { display:block; cursor:grab; }
  #tooltip { position:fixed; pointer-events:none; background:#1b2028; border:1px solid #333c4a; padding:8px 10px; border-radius:6px; font-size:12px; display:none; max-width:380px; z-index:20; line-height:1.5; }
  #tooltip .slug { color:#8ab4ff; font-weight:600; }
  #search { background:#1b2028; border:1px solid #333c4a; color:#e6e6e6; padding:5px 9px; border-radius:6px; font-size:13px; width:260px; }
  #legend { position:fixed; bottom:10px; left:10px; font-size:11px; color:#8a93a6; background:#12151cd0; padding:8px 10px; border-radius:6px; max-width:220px; }
  #toolbar a { color:#8ab4ff; text-decoration:none; margin-left:auto; }
  #toolbar a:hover { text-decoration:underline; }
</style>
</head>
<body>
<div id="toolbar">
  <b>Dep Graph</b>
  <span id="counts"></span>
  <label><input type="checkbox" id="show-isolated" /> show tools with no edges</label>
  <input id="search" placeholder="filter by slug substring..." />
  <span id="match-count" style="color:#8a93a6"></span>
  <a href="https://github.com/ns-0437/dep-graph-generator" target="_blank" rel="noopener">View source on GitHub</a>
</div>
<div id="wrap"><canvas id="c"></canvas></div>
<div id="tooltip"></div>
<div id="legend">Drag background to pan · wheel to zoom · drag a node to reposition · click a node to inspect its edges.</div>
<script>
const GRAPH = ${JSON.stringify(graph)};
(function () {
  "use strict";
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const tooltip = document.getElementById("tooltip");
  const searchBox = document.getElementById("search");
  const showIsolatedBox = document.getElementById("show-isolated");
  const matchCountEl = document.getElementById("match-count");

  const degree = new Map();
  for (const n of GRAPH.nodes) degree.set(n.id, 0);
  for (const e of GRAPH.edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }
  document.getElementById("counts").textContent =
    GRAPH.nodes.length + " nodes total (" + [...degree.values()].filter((d) => d > 0).length +
    " with at least one edge) · " + GRAPH.edges.length + " edges";

  function serviceColor(service) {
    const s = service || "unknown";
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return "hsl(" + (h % 360) + ",55%,60%)";
  }

  let nodes = [];
  let nodeById = new Map();
  let edges = [];

  function buildDataset(includeIsolated) {
    const filtered = includeIsolated ? GRAPH.nodes : GRAPH.nodes.filter((n) => (degree.get(n.id) || 0) > 0);
    nodes = filtered.map((n) => ({
      id: n.id,
      service: n.service,
      color: serviceColor(n.service),
      x: (Math.random() - 0.5) * 800,
      y: (Math.random() - 0.5) * 800,
      vx: 0,
      vy: 0,
      degree: degree.get(n.id) || 0,
    }));
    nodeById = new Map(nodes.map((n) => [n.id, n]));
    edges = GRAPH.edges.filter((e) => nodeById.has(e.from) && nodeById.has(e.to));
  }

  function layout(iterations) {
    const n = nodes.length;
    if (n === 0) return;
    const area = Math.max(n * 4000, 200000);
    const k = Math.sqrt(area / n);
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < n; i++) {
        let fx = 0, fy = 0;
        const a = nodes[i];
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const rep = (k * k) / d2;
          const d = Math.sqrt(d2);
          fx += (dx / d) * rep;
          fy += (dy / d) * rep;
        }
        fx -= a.x * 0.002;
        fy -= a.y * 0.002;
        a.vx = (a.vx + fx) * 0.35;
        a.vy = (a.vy + fy) * 0.35;
      }
      for (const e of edges) {
        const a = nodeById.get(e.from), b = nodeById.get(e.to);
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const attr = (d * d) / k - k;
        const ux = dx / d, uy = dy / d;
        a.vx += ux * attr * 0.15;
        a.vy += uy * attr * 0.15;
        b.vx -= ux * attr * 0.15;
        b.vy -= uy * attr * 0.15;
      }
      for (const node of nodes) {
        node.x += Math.max(-30, Math.min(30, node.vx));
        node.y += Math.max(-30, Math.min(30, node.vy));
      }
    }
  }

  let view = { x: 0, y: 0, scale: 0.6 };
  let dragging = null;
  let panning = false;
  let panStart = null;
  let highlight = null;

  function resize() {
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = (window.innerHeight - 46) + "px";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight - 46;
  }
  window.addEventListener("resize", () => { resize(); draw(); });

  function toScreen(x, y) {
    return [canvas.width / 2 + (x + view.x) * view.scale, canvas.height / 2 + (y + view.y) * view.scale];
  }
  function toWorld(sx, sy) {
    return [(sx - canvas.width / 2) / view.scale - view.x, (sy - canvas.height / 2) / view.scale - view.y];
  }

  function draw() {
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 1;
    for (const e of edges) {
      const a = nodeById.get(e.from), b = nodeById.get(e.to);
      const dim = highlight && highlight !== e.from && highlight !== e.to;
      ctx.strokeStyle = dim ? "rgba(120,130,150,0.06)" : "rgba(140,170,220,0.35)";
      const [ax, ay] = toScreen(a.x, a.y);
      const [bx, by] = toScreen(b.x, b.y);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      if (!dim) {
        const angle = Math.atan2(by - ay, bx - ax);
        const headLen = 5;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - headLen * Math.cos(angle - 0.4), by - headLen * Math.sin(angle - 0.4));
        ctx.lineTo(bx - headLen * Math.cos(angle + 0.4), by - headLen * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fillStyle = "rgba(140,170,220,0.5)";
        ctx.fill();
      }
    }
    for (const node of nodes) {
      const [x, y] = toScreen(node.x, node.y);
      const r = Math.max(3, Math.min(10, 3 + node.degree * 0.6));
      const dim = highlight && highlight !== node.id && !edges.some((e) => (e.from === highlight && e.to === node.id) || (e.to === highlight && e.from === node.id));
      const matches = searchBox.value && node.id.toLowerCase().includes(searchBox.value.toLowerCase());
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = dim && !matches ? "rgba(120,130,150,0.15)" : node.color;
      ctx.fill();
      if (matches) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (view.scale > 0.9 || matches || node.id === highlight) {
        ctx.fillStyle = dim && !matches ? "rgba(120,130,150,0.3)" : "#c3c9d4";
        ctx.font = "10px -apple-system,Segoe UI,sans-serif";
        ctx.fillText(node.id, x + r + 3, y + 3);
      }
    }
  }

  function nodeAt(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const dx = node.x - wx, dy = node.y - wy;
      if (Math.sqrt(dx * dx + dy * dy) < 10) return node;
    }
    return null;
  }

  canvas.addEventListener("mousedown", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const hit = nodeAt(sx, sy);
    if (hit) {
      dragging = hit;
    } else {
      panning = true;
      panStart = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
    }
  });
  window.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    if (dragging) {
      const [wx, wy] = toWorld(sx, sy);
      dragging.x = wx;
      dragging.y = wy;
      draw();
      return;
    }
    if (panning) {
      view.x = panStart.vx + (ev.clientX - panStart.x) / view.scale;
      view.y = panStart.vy + (ev.clientY - panStart.y) / view.scale;
      draw();
      return;
    }
    const hit = nodeAt(sx, sy);
    if (hit) {
      canvas.style.cursor = "pointer";
      tooltip.style.display = "block";
      tooltip.style.left = ev.clientX + 12 + "px";
      tooltip.style.top = ev.clientY + 12 + "px";
      const out = edges.filter((e) => e.from === hit.id);
      const inc = edges.filter((e) => e.to === hit.id);
      tooltip.innerHTML =
        '<div class="slug">' + hit.id + "</div>" +
        (hit.service ? "service: " + hit.service + "<br/>" : "") +
        "supplies " + out.length + " field(s) to other tools<br/>" +
        "needs " + inc.length + " field(s) from other tools" +
        (inc.length ? "<br/><br/>" + inc.slice(0, 6).map((e) => e.label + " &larr; " + e.from).join("<br/>") : "");
    } else {
      canvas.style.cursor = "grab";
      tooltip.style.display = "none";
    }
  });
  window.addEventListener("mouseup", () => { dragging = null; panning = false; });
  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const hit = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
    highlight = hit ? hit.id : null;
    draw();
  });
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 0.9;
    view.scale = Math.max(0.05, Math.min(6, view.scale * factor));
    draw();
  });

  searchBox.addEventListener("input", () => {
    const q = searchBox.value.trim().toLowerCase();
    matchCountEl.textContent = q ? nodes.filter((n) => n.id.toLowerCase().includes(q)).length + " match(es)" : "";
    draw();
  });
  showIsolatedBox.addEventListener("change", () => {
    buildDataset(showIsolatedBox.checked);
    layout(showIsolatedBox.checked ? 120 : 220);
    draw();
  });

  resize();
  buildDataset(false);
  layout(220);
  draw();
})();
</script>
</body>
</html>
`;
}
