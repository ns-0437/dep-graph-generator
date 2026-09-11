import { test } from "node:test";
import assert from "node:assert/strict";
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

test("renderVisualizationHtml still embeds normal graph data intact", () => {
  const html = renderVisualizationHtml({
    nodes: [{ id: "GITHUB_CREATE_AN_ISSUE", service: "issues" }],
    edges: [{ from: "A", to: "B", label: "issue_number" }],
  });
  assert.ok(html.includes("GITHUB_CREATE_AN_ISSUE"));
  assert.ok(html.includes("issue_number"));
  assert.ok(html.startsWith("<!doctype html>"));
});
