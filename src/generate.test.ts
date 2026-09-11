import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { generate } from "./generate.js";
import type { ChatClient } from "./lib/llm.js";

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

/**
 * The tests above call generate() directly, never main() or the actual CLI entrypoint --
 * confirmed via a c8 cross-check against Node's own --experimental-test-coverage report
 * (which had been pointing at the wrong lines entirely) that main(), the argv-driven
 * catalog path, and the two writeFileSync calls were genuinely never exercised by anything
 * in this suite. These tests spawn the real CLI the way CI's selfcheck.ts and generator.json
 * both do, and check the actual files it writes.
 *
 * Deliberately does NOT run with cwd set to a scratch directory: --import tsx resolves the
 * tsx package relative to cwd, which fails outside this project's node_modules (verified --
 * that was the first version of this test, and it failed with ERR_MODULE_NOT_FOUND). So
 * this runs from the repo root like the real CLI does, which means it's about to overwrite
 * the real dependency_graph.json/graph.html -- back up and restore their prior content
 * around the test instead.
 */
test("CLI: writes dependency_graph.json and graph.html when run as a subprocess", () => {
  const catalogPath = resolve("test-fixtures/fake_slack_catalog.json");
  const generatorPath = resolve("src/generate.ts");
  const outPath = resolve("dependency_graph.json");
  const vizPath = resolve("graph.html");
  const originalOut = existsSync(outPath) ? readFileSync(outPath, "utf-8") : null;
  const originalViz = existsSync(vizPath) ? readFileSync(vizPath, "utf-8") : null;
  try {
    execFileSync("node", ["--import", "tsx", generatorPath, catalogPath], { stdio: "pipe" });
    const graph = JSON.parse(readFileSync(outPath, "utf-8"));
    assert.deepEqual(
      graph.nodes.map((n: { id: string }) => n.id).sort(),
      ["SLACK_LIST_CHANNELS", "SLACK_SEND_MESSAGE"],
    );
    const html = readFileSync(vizPath, "utf-8");
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("SLACK_LIST_CHANNELS"));
  } finally {
    if (originalOut !== null) writeFileSync(outPath, originalOut, "utf-8");
    else rmSync(outPath, { force: true });
    if (originalViz !== null) writeFileSync(vizPath, originalViz, "utf-8");
    else rmSync(vizPath, { force: true });
  }
});

/**
 * generate() itself never had a way to inject a fake LLM client, so the loop that merges
 * llmDisambiguate's results into the final edge list (lib/generate.ts, right after the
 * heuristic pass) was never actually exercised -- confirmed via coverage before this test
 * existed. A self-contained inline catalog here, not the shared Slack fixture: "sha" needs
 * a producer field literally named "commit_sha" that shares the "sha" token (so
 * looseCandidates surfaces it) but isn't a heuristic subset match (so it's genuinely
 * unresolved and actually reaches the LLM path), which the shared fixture doesn't have.
 */
test("generate(): merges an LLM-resolved edge via an injected fake client", async () => {
  const catalog = [
    {
      slug: "PRODUCER_TOOL",
      inputParameters: { required: [] },
      outputParameters: {
        properties: { data: { $ref: "#/$defs/ProducerResponse" } },
        $defs: {
          ProducerResponse: { type: "object", properties: { commit_sha: { type: "string" } } },
        },
      },
    },
    {
      slug: "CONSUMER_TOOL",
      inputParameters: { required: ["sha"] },
      outputParameters: { properties: {} },
    },
  ];
  const fakeClient: ChatClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: '[{"idx":0,"ci":0}]' } }] }),
      },
    },
  };
  const graph = await generate(catalog, fakeClient);
  assert.deepEqual(graph.edges, [{ from: "PRODUCER_TOOL", to: "CONSUMER_TOOL", label: "sha" }]);
});

test("CLI: exits non-zero with a clear error when no catalog path is given", () => {
  const generatorPath = resolve("src/generate.ts");
  // No output files are ever written on this path -- loadCatalog throws before
  // generate()/writeFileSync run -- so there's nothing to back up here.
  assert.throws(
    () => execFileSync("node", ["--import", "tsx", generatorPath], { stdio: "pipe" }),
    /pass the toolkit catalog path/,
  );
});
