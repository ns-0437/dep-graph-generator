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

/**
 * MAX_PRODUCERS_PER_FIELD's tie-breaking behavior had never been directly tested -- only
 * exercised indirectly through the full 893-tool catalog. Worth a focused test: measured
 * against the real catalog, fields with any candidates have an average of ~15 producers
 * tied at the best score (one field has 197), and the cap keeps only the first 3 by catalog
 * order among ties. This reconstructs that scenario at a scale you can actually reason
 * about by hand.
 */
test("generate(): caps tied producers at MAX_PRODUCERS_PER_FIELD, keeping the first 3 by catalog order", async () => {
  const producerFor = (slug: string) => ({
    slug,
    inputParameters: { required: [] },
    outputParameters: {
      properties: { data: { $ref: "#/$defs/Issue" } },
      $defs: { Issue: { type: "object", properties: { number: { type: "integer" } } } },
    },
  });
  const catalog = [
    producerFor("PRODUCER_A"),
    producerFor("PRODUCER_B"),
    producerFor("PRODUCER_C"),
    producerFor("PRODUCER_D"),
    producerFor("PRODUCER_E"),
    {
      slug: "CONSUMER",
      inputParameters: { required: ["issue_number"] },
      outputParameters: { properties: {} },
    },
  ];
  const graph = await generate(catalog);
  const producers = graph.edges
    .filter((e) => e.to === "CONSUMER" && e.label === "issue_number")
    .map((e) => e.from);
  assert.equal(producers.length, 3, "must cap at 3 even with 5 candidates tied at the same score");
  assert.deepEqual(producers, ["PRODUCER_A", "PRODUCER_B", "PRODUCER_C"]);
});

/**
 * Real finding while building the precision eval (eval/sample-edges.ts): 876 of 2101 edges
 * (42%) had a producer that itself required the same field name as one of its own inputs --
 * e.g. GITHUB_CLOSE_ISSUE requires issue_number to be called at all, so its response
 * describing "the issue I just closed" isn't a real discovery path for issue_number, it's an
 * echo. Reconstructs that pattern directly: a circular producer that would otherwise tie for
 * the best score must be excluded, while a genuine (non-circular) producer for the exact same
 * field is kept.
 */
test("generate(): excludes a producer that itself requires the same field it would supply", async () => {
  const catalog = [
    {
      // Mirrors GITHUB_CLOSE_ISSUE: needs issue_number to be called, so its own response
      // describing that issue can't be a real discovery path for issue_number.
      slug: "CIRCULAR_PRODUCER",
      inputParameters: { required: ["issue_number"] },
      outputParameters: {
        properties: { data: { $ref: "#/$defs/Issue" } },
        $defs: { Issue: { type: "object", properties: { number: { type: "integer" } } } },
      },
    },
    {
      // Mirrors GITHUB_CREATE_AN_ISSUE: the number is assigned by creation, not needed to
      // call it -- a genuine discovery.
      slug: "GENUINE_PRODUCER",
      inputParameters: { required: ["title"] },
      outputParameters: {
        properties: { data: { $ref: "#/$defs/Issue" } },
        $defs: { Issue: { type: "object", properties: { number: { type: "integer" } } } },
      },
    },
    {
      slug: "CONSUMER",
      inputParameters: { required: ["issue_number"] },
      outputParameters: { properties: {} },
    },
  ];
  const graph = await generate(catalog);
  const producers = graph.edges
    .filter((e) => e.to === "CONSUMER" && e.label === "issue_number")
    .map((e) => e.from);
  assert.deepEqual(producers, ["GENUINE_PRODUCER"]);
});

test("generate(): a duplicate required field name doesn't produce a duplicate heuristic edge", async () => {
  // A malformed-but-plausible catalog: `required` accidentally lists the same field name
  // twice. Both instances resolve to the same candidate, so the from->to->label key
  // collides -- the `seen` dedup guard must keep only one edge, not emit it twice.
  const catalog = [
    {
      slug: "PRODUCER",
      inputParameters: { required: [] },
      outputParameters: {
        properties: { data: { $ref: "#/$defs/Issue" } },
        $defs: { Issue: { type: "object", properties: { number: { type: "integer" } } } },
      },
    },
    {
      slug: "CONSUMER",
      inputParameters: { required: ["issue_number", "issue_number"] },
      outputParameters: { properties: {} },
    },
  ];
  const graph = await generate(catalog);
  const matching = graph.edges.filter((e) => e.from === "PRODUCER" && e.to === "CONSUMER" && e.label === "issue_number");
  assert.equal(matching.length, 1);
});

test("generate(): a duplicate unresolved field name doesn't produce a duplicate LLM-resolved edge", async () => {
  // Same duplicate-required-field scenario, but for a field the heuristic can't resolve at
  // all (zero candidates) -- both duplicate entries land in `unresolved` and are sent to
  // the (fake) LLM independently, which resolves both identically. The merge loop's `seen`
  // guard must still collapse them into one edge.
  const catalog = [
    {
      slug: "PRODUCER",
      inputParameters: { required: [] },
      outputParameters: {
        properties: { data: { $ref: "#/$defs/Channel" } },
        $defs: { Channel: { type: "object", properties: { id: { type: "string" } } } },
      },
    },
    {
      slug: "CONSUMER",
      // "workspace_id" shares the "id" token with Channel.id (so looseCandidates finds it),
      // but the leftover "workspace" token doesn't match the owning type "Channel" -- the
      // heuristic scores this 0 and it lands in `unresolved`, exactly the gap the LLM pass
      // exists for.
      inputParameters: { required: ["workspace_id", "workspace_id"] },
      outputParameters: { properties: {} },
    },
  ];
  const fakeClient: ChatClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: '[{"idx":0,"ci":0},{"idx":1,"ci":0}]' } }],
        }),
      },
    },
  };
  const graph = await generate(catalog, fakeClient);
  const matching = graph.edges.filter((e) => e.from === "PRODUCER" && e.to === "CONSUMER" && e.label === "workspace_id");
  assert.equal(matching.length, 1);
});

test("generate(): a catalog with __proto__/constructor keys can't pollute Object.prototype", async () => {
  // The one place a catalog-derived string is used as a plain-object key (not a Map key,
  // which is immune to this by construction) is schema.ts's `defs[refName]` -- a read, not a
  // write, so even a malicious refName can only retrieve a value that was legitimately
  // parsed there, never redirect into the actual prototype chain. Verified with a real
  // catalog exercising exactly that: a tool whose $ref points at a $defs entry literally
  // named "__proto__", containing a "constructor" property, plus a consumer requiring
  // "__proto__"/"constructor" as field names.
  //
  // Built via JSON.parse on real JSON text -- not a JS object literal -- because a literal
  // `{ __proto__: ... }` in source code is special-cased by the language to set the actual
  // prototype rather than create an own property, which would test something different from
  // what loadCatalog() actually does (JSON.parse on a catalog file's real file contents).
  const maliciousJson = JSON.stringify([
    {
      slug: "PRODUCER",
      inputParameters: { required: [] },
      outputParameters: {
        properties: { data: { $ref: "#/$defs/__proto__" } },
        $defs: {
          __proto__: { type: "object", properties: { constructor: { type: "string" }, polluted: { type: "string" } } },
        },
      },
    },
    {
      slug: "CONSUMER",
      inputParameters: { required: ["__proto__", "constructor"] },
      outputParameters: { properties: {} },
    },
  ]);
  const catalog = JSON.parse(maliciousJson);

  const protoKeysBefore = Object.keys(Object.prototype);
  const graph = await generate(catalog);
  assert.deepEqual(Object.keys(Object.prototype), protoKeysBefore, "Object.prototype must gain no new enumerable properties");
  assert.equal((({} as Record<string, unknown>)).polluted, undefined, "a fresh plain object must not inherit a polluted property");
  assert.deepEqual(
    graph.nodes.map((n) => n.id).sort(),
    ["CONSUMER", "PRODUCER"],
  );
});

test("generate(): throws a clear error instead of silently merging two tools with the same slug", async () => {
  // Regression guard: every map keyed by slug downstream (toolBySlug, outputsByTool,
  // requiredByTool) can only hold one definition per slug -- a plain Map.set on a repeated
  // key silently keeps the last one. Before this check, a duplicate slug produced a graph
  // with two same-id nodes and silently discarded the first definition's inputs/outputs
  // entirely, with no error. Confirmed directly: a duplicate GITHUB_CREATE_AN_ISSUE with
  // real required inputs, followed by one requiring only "owner", produced a graph where
  // the first definition's fields simply vanished from matching.
  const catalog = [
    { slug: "GITHUB_CREATE_AN_ISSUE", inputParameters: { required: ["repo", "title"] } },
    { slug: "GITHUB_CREATE_AN_ISSUE", inputParameters: { required: ["owner"] } },
  ];
  await assert.rejects(() => generate(catalog as never), /more than one tool with slug "GITHUB_CREATE_AN_ISSUE"/);
});

test("generate(): silently skips a tool with no slug/name/function.name instead of producing a bad node", async () => {
  const catalog = [
    // No slug, no name, no function.name -- slugOf() returns undefined for this one.
    { inputParameters: { required: [] }, outputParameters: { properties: {} } },
    {
      slug: "REAL_TOOL",
      inputParameters: { required: [] },
      outputParameters: { properties: {} },
    },
  ];
  const graph = await generate(catalog as never);
  assert.deepEqual(graph.nodes.map((n) => n.id), ["REAL_TOOL"]);
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
