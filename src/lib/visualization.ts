import { createHash } from "crypto";
import type { Graph } from "../types.js";

/**
 * JSON.stringify does not escape "</script>" -- if any node id, service, or edge label
 * ever contained that literal substring, embedding the graph directly into a <script> tag
 * would let it break out of the tag and inject arbitrary HTML/script. The current
 * github_catalog.json doesn't trigger this, but the generator explicitly promises to
 * generalize to any toolkit's catalog, so this has to hold for catalogs we've never seen.
 * Standard fix: escape "<" as its unicode escape, which is invisible to JSON.parse but
 * can't form a "</script>" sequence.
 */
export function escapeForInlineScript(json: string): string {
  return json.replace(/</g, "\\u003c");
}

/**
 * The page's entire client-side behavior, as a plain string -- kept separate from the HTML
 * shell specifically so renderVisualizationHtml can hash exactly this text for the
 * Content-Security-Policy script-src below, independent of the surrounding markup.
 */
function buildScriptContent(graph: Graph): string {
  return `
const GRAPH = ${escapeForInlineScript(JSON.stringify(graph))};
(function () {
  "use strict";
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const tooltip = document.getElementById("tooltip");
  const searchBox = document.getElementById("search");
  const showIsolatedBox = document.getElementById("show-isolated");
  const matchCountEl = document.getElementById("match-count");
  const loadingEl = document.getElementById("loading");

  // Node ids, service names, and edge labels all come from the catalog -- the generator
  // explicitly promises to generalize to any toolkit's catalog (see escapeForInlineScript's
  // own docs for the identical reasoning on the JSON-embedding side), so a malicious catalog
  // could name a tool an img tag with an onerror handler and have that string flow straight
  // into the tooltip. Every one of those values gets HTML-escaped through this before ever
  // touching tooltip.innerHTML below -- confirmed this was a real, working DOM XSS before
  // the fix (a hover on such a node executed arbitrary script), not just a theoretical one.
  // (No backticks in this comment block: it lives inside the outer template literal that
  // builds this whole script's content, so a literal backtick here would terminate it early.)
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

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

  // canvas.width/height are the drawing-buffer resolution (scaled up by devicePixelRatio
  // below, for crisp rendering on retina/high-DPI screens); cssWidth/cssHeight are the
  // logical size the layout math and screen<->world mapping actually reason in, matching
  // what the CSS/mouse-event coordinate space uses. Without this split, drawing at
  // canvas.width (post-DPR-scaling, e.g. 1.5x the CSS size) while a devicePixelRatio ctx
  // scale is also applied would double-scale everything.
  let cssWidth = 0, cssHeight = 0;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    cssWidth = window.innerWidth;
    cssHeight = window.innerHeight - 46;
    canvas.style.width = cssWidth + "px";
    canvas.style.height = cssHeight + "px";
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", () => { resize(); draw(); });

  function toScreen(x, y) {
    return [cssWidth / 2 + (x + view.x) * view.scale, cssHeight / 2 + (y + view.y) * view.scale];
  }
  function toWorld(sx, sy) {
    return [(sx - cssWidth / 2) / view.scale - view.x, (sy - cssHeight / 2) / view.scale - view.y];
  }

  function draw() {
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, cssWidth, cssHeight);
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
        '<div class="slug">' + escapeHtml(hit.id) + "</div>" +
        (hit.service ? "service: " + escapeHtml(hit.service) + "<br/>" : "") +
        "supplies " + out.length + " field(s) to other tools<br/>" +
        "needs " + inc.length + " field(s) from other tools" +
        (inc.length ? "<br/><br/>" + inc.slice(0, 6).map((e) => escapeHtml(e.label) + " &larr; " + escapeHtml(e.from)).join("<br/>") : "");
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
    if (loadingEl) loadingEl.style.display = "flex";
    setTimeout(() => {
      buildDataset(showIsolatedBox.checked);
      layout(showIsolatedBox.checked ? 120 : 220);
      draw();
      if (loadingEl) loadingEl.style.display = "none";
    }, 0);
  });

  resize();
  // The force layout for a few hundred nodes is O(n^2) per iteration and runs
  // synchronously -- on the full GitHub catalog it blocks the main thread for over a
  // second. setTimeout(fn, 0) defers that work to its own event-loop turn, after the
  // browser has already painted the "Laying out the graph..." message, instead of the
  // page appearing frozen/blank the whole time. (requestAnimationFrame would be the more
  // idiomatic choice, but isn't guaranteed to fire promptly in every embedding context --
  // setTimeout is the more universally reliable primitive for "yield, then run this".)
  setTimeout(() => {
    buildDataset(false);
    layout(220);
    draw();
    if (loadingEl) loadingEl.style.display = "none";
  }, 0);
})();
`;
}

/**
 * Self-contained visualization: the graph data is embedded inline (not fetched), and layout
 * is a hand-rolled force simulation with no external library, so the file opens correctly
 * straight from disk (file://) with no server and no network access required.
 */
export function renderVisualizationHtml(graph: Graph): string {
  const scriptContent = buildScriptContent(graph);
  // A CSP restricting script-src to exactly this script's own hash (no 'unsafe-inline') is
  // real defense-in-depth against the tooltip XSS class of bug found and fixed above: even
  // if a future change reintroduced an unescaped innerHTML sink, an attacker's injected
  // `<img onerror=...>` would still need its own execution authorization the browser won't
  // grant -- only script content matching this exact hash is allowed to run at all. The hash
  // has to be recomputed per render because the script's content differs per graph (it
  // embeds GRAPH inline) -- a fixed/hardcoded hash would go stale the moment the data
  // changed and silently block the page's own script.
  const scriptHash = createHash("sha256").update(scriptContent, "utf-8").digest("base64");
  const csp =
    "default-src 'none'; " +
    `script-src 'sha256-${scriptHash}'; ` +
    "style-src 'unsafe-inline'; " +
    "object-src 'none'; " +
    "base-uri 'none';";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
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
  #legend { position:fixed; bottom:10px; left:10px; font-size:11px; color:#8a93a6; background:#12151cd0; padding:8px 10px; border-radius:6px; max-width:220px; pointer-events:none; }
  #toolbar a { color:#8ab4ff; text-decoration:none; margin-left:auto; }
  #toolbar a:hover { text-decoration:underline; }
  #loading { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#8a93a6; font-size:14px; background:#0b0d12; z-index:5; }
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
<div id="wrap"><canvas id="c"></canvas><div id="loading">Laying out the graph…</div></div>
<div id="tooltip"></div>
<div id="legend">Drag background to pan · wheel to zoom · drag a node to reposition · click a node to inspect its edges.</div>
<script>${scriptContent}</script>
</body>
</html>
`;
}
