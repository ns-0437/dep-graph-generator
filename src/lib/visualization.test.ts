import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { escapeForInlineScript, renderVisualizationHtml } from "./visualization.js";

test("escapeForInlineScript neutralizes every '<' so no closing tag can form", () => {
  const malicious = JSON.stringify({ id: "X</script><script>alert(1)</script>" });
  const escaped = escapeForInlineScript(malicious);
  assert.ok(!escaped.includes("<"), "no literal '<' should survive escaping");
  assert.ok(escaped.includes("\\u003c"), "escaped form should use the unicode escape");
});

test("escapeForInlineScript also blocks case-insensitive close-tag variants", () => {
  // The HTML parser's script-data state matches </script case-insensitively -- a
  // regex that only targets the literal lowercase string would miss these.
  for (const variant of ["</script>", "</SCRIPT>", "</ScRiPt>"]) {
    const escaped = escapeForInlineScript(JSON.stringify({ x: `a${variant}b` }));
    assert.ok(!escaped.includes("<"), `must escape ${variant}`);
  }
});

test("escapeForInlineScript round-trips through JSON.parse unchanged", () => {
  const original = { id: "X</script><script>alert(1)</script>", n: 1, ok: true };
  const escaped = escapeForInlineScript(JSON.stringify(original));
  // < is a valid JSON string escape for '<' -- parsing it back must recover the
  // exact original value, proving the escape is invisible to JSON.parse itself.
  assert.deepEqual(JSON.parse(escaped), original);
});

test("renderVisualizationHtml produces exactly one script tag even with a malicious node id", () => {
  const html = renderVisualizationHtml({
    nodes: [{ id: "X</script><script>alert(document.domain)</script>" }],
    edges: [],
  });
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
});

test("renderVisualizationHtml escapes catalog-derived strings before the tooltip's innerHTML assignment", () => {
  // Regression guard for a real, confirmed-exploitable DOM XSS: hit.id/hit.service/e.label/
  // e.from are all catalog-derived (the generator explicitly promises to generalize to any
  // toolkit's catalog), and the tooltip is built via string-concatenated innerHTML, not
  // textContent or DOM methods. Verified live in a real browser before this fix: a tool
  // slug like an <img> tag with an onerror handler executed arbitrary script on hover
  // (confirmed via document.title/document.body.style.background actually changing), and
  // confirmed blocked after it (the payload rendered as escaped, inert text instead).
  // escapeForInlineScript (tested above) is a different, narrower fix for a different
  // problem -- it only protects the JSON-in-<script>-tag boundary, not this separate
  // innerHTML sink, which operates on values already parsed back to their original form.
  const html = renderVisualizationHtml({ nodes: [], edges: [] });
  assert.match(html, /function escapeHtml\(/, "an HTML-escaping helper must be defined");
  const tooltipAssignment = html.match(/tooltip\.innerHTML\s*=[\s\S]*?;\n/)?.[0];
  assert.ok(tooltipAssignment, "the tooltip.innerHTML assignment must exist");
  for (const expr of ["escapeHtml(hit.id)", "escapeHtml(hit.service)", "escapeHtml(e.label)", "escapeHtml(e.from)"]) {
    assert.ok(tooltipAssignment!.includes(expr), `tooltip.innerHTML must escape ${expr}`);
  }
});

test("renderVisualizationHtml gives the fixed legend overlay pointer-events:none", () => {
  // Regression guard: a position:fixed element paints above in-flow content regardless of
  // z-index, so without pointer-events:none the legend box silently swallowed mousedown/drag
  // events meant for the canvas underneath whenever a drag started over it -- confirmed
  // in-browser (a pan gesture starting on the legend produced zero movement before this).
  const html = renderVisualizationHtml({ nodes: [], edges: [] });
  const legendRule = html.match(/#legend\s*\{[^}]*\}/)?.[0];
  assert.ok(legendRule, "the #legend CSS rule must exist");
  assert.match(legendRule!, /pointer-events\s*:\s*none/);
});

test("renderVisualizationHtml sets a Content-Security-Policy restricting script-src to its own hash", () => {
  // Defense-in-depth against the tooltip XSS fixed above: even if a future change
  // reintroduced an unescaped innerHTML sink, an attacker's injected inline handler still
  // needs its own execution authorization the browser won't grant. Verified live in a real
  // browser (not just this static check): after this CSP was added, directly injecting
  // '<img src=x onerror="...">' into the tooltip's innerHTML (bypassing the app's own
  // escapeHtml entirely, simulating a hypothetical future regression) did NOT execute --
  // the browser's console logged "Executing inline event handler violates the following
  // Content Security Policy directive... The action has been blocked." Confirmed the page's
  // own legitimate script isn't collateral damage either: hover/tooltip, pan, click-to-
  // highlight, wheel-zoom, search filtering, and the "show isolated" checkbox (which
  // triggers a re-layout) all still worked with zero CSP violations logged.
  const graph = { nodes: [{ id: "A" }, { id: "B" }], edges: [{ from: "A", to: "B", label: "x" }] };
  const html = renderVisualizationHtml(graph);
  const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
  assert.ok(cspMatch, "a CSP meta tag must be present");
  const csp = cspMatch![1]!;
  assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/]+=*'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, "script-src must not also allow unsafe-inline, which would defeat the hash restriction");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);

  // The hash must match the ACTUAL script content this render produced -- not just be
  // present in some valid-looking form -- since a stale/mismatched hash would silently
  // block the page's own script the moment the embedded graph data changed.
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(scriptMatch, "the script tag must exist");
  const expectedHash = createHash("sha256").update(scriptMatch![1]!, "utf-8").digest("base64");
  assert.equal(csp.match(/script-src 'sha256-([^']+)'/)?.[1], expectedHash);
});

test("renderVisualizationHtml scales the canvas backing buffer by devicePixelRatio", () => {
  // Regression guard for a real bug (see git history): the canvas's drawing-buffer
  // resolution must be scaled by devicePixelRatio and matched with a ctx transform, or
  // the graph renders blurry on any HiDPI/retina display. This can't be verified by
  // executing the canvas logic here (no DOM/canvas in Node), but a revert that dropped
  // the scaling entirely would also drop these specific tokens from the embedded script.
  const html = renderVisualizationHtml({ nodes: [], edges: [] });
  assert.ok(html.includes("devicePixelRatio"), "must read devicePixelRatio somewhere");
  assert.ok(html.includes("cssWidth") && html.includes("cssHeight"), "must track logical size separately from the (DPR-scaled) canvas buffer size");
  assert.ok(html.includes("ctx.setTransform"), "must apply a matching context transform so drawing code stays in CSS-pixel units");
});

test("renderVisualizationHtml's nodeAt hit-test scales the hit radius with the current zoom", () => {
  // Regression guard for a real bug: nodeAt compared world-space distance against a fixed
  // "10" threshold meant to be a SCREEN-pixel hit tolerance (matching the largest rendered
  // node radius), but never scaled it by view.scale -- so the effective screen-space hit
  // radius silently shrank/grew with zoom. At the min zoom bound (0.05) it shrank to 0.5px
  // (a click square on a visibly rendered node missed); at the max zoom bound (6) it grew to
  // 60px (a click 50px away from a node still registered as a hit). Verified by extracting
  // the actual nodeAt function from the rendered script and running it with a mocked
  // toWorld/view -- not just checking the source text for a token.
  const html = renderVisualizationHtml({ nodes: [{ id: "A" }], edges: [] });
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "the script tag must exist");
  const nodeAtSrc = script!.match(/function nodeAt\(sx, sy\) \{[\s\S]*?\n {2}\}/)?.[0];
  assert.ok(nodeAtSrc, "nodeAt function must exist in the embedded script");

  function runNodeAt(scale: number, screenOffsetPx: number): unknown {
    const nodes = [{ x: 0, y: 0, id: "A" }];
    const view = { scale };
    const fn = new Function(
      "nodes",
      "view",
      `function toWorld(x, y) { return [x / view.scale, y / view.scale]; }
       ${nodeAtSrc}
       return nodeAt(${screenOffsetPx}, 0);`,
    );
    return fn(nodes, view);
  }

  // Sanity check: at scale 1, old and new formulas agree (multiplying by 1 changes nothing).
  assert.ok(runNodeAt(1, 8), "scale 1: an 8px-away click should hit");
  assert.equal(runNodeAt(1, 50), null, "scale 1: a 50px-away click should miss");

  assert.ok(runNodeAt(0.05, 8), "min zoom (0.05): an 8px-away click must still hit");
  assert.equal(runNodeAt(6, 50), null, "max zoom (6): a 50px-away click must not falsely hit");
});

test("renderVisualizationHtml still embeds normal graph data intact", () => {
  const html = renderVisualizationHtml({
    nodes: [{ id: "GITHUB_CREATE_AN_ISSUE", service: "issues" }],
    edges: [{ from: "A", to: "B", label: "issue_number" }],
  });
  assert.ok(html.includes("GITHUB_CREATE_AN_ISSUE"));
  assert.ok(html.includes("issue_number"));
  assert.ok(html.startsWith("<!doctype html>"));
});
