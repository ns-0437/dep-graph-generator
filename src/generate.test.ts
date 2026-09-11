import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { generate } from "./generate.js";

/**
 * End-to-end test: unlike lib/*.test.ts, which test each piece in isolation, this runs the
 * real generate() the CLI calls, against the synthetic non-GitHub fixture used earlier to
 * verify generalization (test-fixtures/fake_slack_catalog.json). Catches wiring bugs the
 * unit tests can't -- e.g. a module extraction that leaves two pieces silently disconnected.
 */
test("generate() end-to-end on the synthetic Slack catalog produces the one real edge", async () => {
  const catalog = JSON.parse(readFileSync("test-fixtures/fake_slack_catalog.json", "utf-8"));
  const graph = await generate(catalog);

  assert.deepEqual(
    graph.nodes.map((n) => n.id).sort(),
    ["SLACK_LIST_CHANNELS", "SLACK_SEND_MESSAGE"],
  );
  assert.deepEqual(graph.edges, [
    { from: "SLACK_LIST_CHANNELS", to: "SLACK_SEND_MESSAGE", label: "channel_id" },
  ]);
});

test("generate() end-to-end on the GitHub catalog meets the grading thresholds", async () => {
  const catalog = JSON.parse(readFileSync("github_catalog.json", "utf-8"));
  const graph = await generate(catalog);

  const slugs = new Set(catalog.map((t: any) => String(t.slug).toUpperCase()));
  const inCatalog = graph.nodes.filter((n) => slugs.has(n.id.toUpperCase())).length;
  const provenanceRatio = inCatalog / graph.nodes.length;

  assert.ok(provenanceRatio >= 0.8, `provenance_ratio ${provenanceRatio} must be >= 0.8`);
  assert.ok(graph.edges.length > 0, "must produce at least one edge");
  assert.ok(
    graph.edges.some((e) => e.label === "issue_number"),
    "must include the README's own issue_number example pattern",
  );
  assert.ok(
    graph.edges.some((e) => e.label === "pull_number"),
    "must include the README's own pull_number example pattern",
  );
});
