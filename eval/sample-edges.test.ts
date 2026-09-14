import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../src/generate.js";
import { loadCatalog } from "../src/lib/catalog.js";

/**
 * A smoke test, not a correctness test of the sampling/scoring logic itself (that's covered
 * by match.test.ts and generate.test.ts, which this script only re-derives evidence from).
 * The point is to catch this script silently diverging from generate.ts's own logic the
 * moment it happens -- exactly the class of bug sample-unresolved.ts had for one commit
 * (see CLAUDE.md's bug list) -- rather than only when someone next runs it by hand.
 */

// sample-edges.ts reads a dependency-graph JSON file (gitignored at its default path,
// generated on demand), unlike sample-unresolved.ts which re-derives everything from
// github_catalog.json directly -- so this file needs one to exist. Generated once, into an
// isolated temp copy that every test below points at via the graph-input-path argument,
// rather than the real dependency_graph.json: Node's test runner runs different test files
// concurrently by default, and generate.test.ts's CLI subprocess test also reads/writes/
// restores that exact same shared path around its own test -- pointing at a private copy
// instead avoids racing it, rather than hoping the timing never overlaps. Calling the real
// generate() function in-process (rather than spawning `node src/generate.ts` as a
// subprocess) sidesteps that race entirely -- no shared file is ever touched to produce
// this fixture -- and is simpler than juggling a subprocess cwd override just to redirect
// its hardcoded output path.
let graphDir: string;
let graphPath: string;

before(async () => {
  graphDir = mkdtempSync(join(tmpdir(), "sample-edges-graph-"));
  graphPath = join(graphDir, "dependency_graph.json");
  const graph = await generate(loadCatalog("github_catalog.json"));
  writeFileSync(graphPath, JSON.stringify(graph), "utf-8");
});

after(() => {
  rmSync(graphDir, { recursive: true, force: true });
});

test("sample-edges.ts runs end-to-end against the real catalog and produces a well-shaped sample", () => {
  const dir = mkdtempSync(join(tmpdir(), "sample-edges-test-"));
  const outPath = join(dir, "sample.json");
  try {
    const result = spawnSync("node", ["--import", "tsx", "eval/sample-edges.ts", outPath, graphPath], { encoding: "utf-8" });
    assert.equal(result.status, 0, `sample-edges.ts exited ${result.status}: ${result.stderr}`);

    const sample = JSON.parse(readFileSync(outPath, "utf-8"));
    assert.equal(sample.seed, 424242);
    assert.equal(sample.entries.length, 90);
    const tier5 = sample.entries.filter((e: { heuristicScore: number }) => e.heuristicScore === 5);
    const tier4 = sample.entries.filter((e: { heuristicScore: number }) => e.heuristicScore === 4);
    assert.equal(tier5.length, 45);
    assert.equal(tier4.length, 45);
    for (const entry of sample.entries) {
      assert.equal(entry.verdict, null);
      assert.equal(typeof entry.from, "string");
      assert.equal(typeof entry.to, "string");
      assert.equal(typeof entry.label, "string");
      assert.ok(entry.producer, `entry for ${entry.from}->${entry.to} must have a producer summary`);
      assert.ok(entry.consumer, `entry for ${entry.from}->${entry.to} must have a consumer summary`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sample-edges.ts is reproducible: re-running against the same graph yields the same sample", () => {
  const dir = mkdtempSync(join(tmpdir(), "sample-edges-repro-test-"));
  const outA = join(dir, "a.json");
  const outB = join(dir, "b.json");
  try {
    spawnSync("node", ["--import", "tsx", "eval/sample-edges.ts", outA, graphPath], { encoding: "utf-8" });
    spawnSync("node", ["--import", "tsx", "eval/sample-edges.ts", outB, graphPath], { encoding: "utf-8" });
    const a = JSON.parse(readFileSync(outA, "utf-8"));
    const b = JSON.parse(readFileSync(outB, "utf-8"));
    assert.deepEqual(
      a.entries.map((e: { from: string; to: string; label: string }) => `${e.from}->${e.to}->${e.label}`),
      b.entries.map((e: { from: string; to: string; label: string }) => `${e.from}->${e.to}->${e.label}`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sample-edges.ts defaults to eval/sample.json when no output path is given", () => {
  // The real, committed, already-labeled sample -- refused (not overwritten), but this
  // still exercises the `?? "eval/sample.json"` default-path branch, which every other test
  // bypasses by always passing an explicit path. Safe to leave the graph-path argument
  // defaulted here too: assertSafeToOverwrite refuses and exits before the script ever
  // reads a graph file, so this never touches the real dependency_graph.json either.
  const result = spawnSync("node", ["--import", "tsx", "eval/sample-edges.ts"], { encoding: "utf-8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REFUSING to overwrite eval\/sample\.json/);
});

test("sample-edges.ts refuses to overwrite a target with hand-labeled entries, unless --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "sample-edges-guard-test-"));
  const outPath = join(dir, "sample.json");
  writeFileSync(outPath, JSON.stringify({ entries: [{ verdict: "correct" }] }), "utf-8");
  try {
    const refused = spawnSync("node", ["--import", "tsx", "eval/sample-edges.ts", outPath, graphPath], { encoding: "utf-8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /REFUSING to overwrite/);

    const forced = spawnSync("node", ["--import", "tsx", "eval/sample-edges.ts", outPath, graphPath, "--force"], { encoding: "utf-8" });
    assert.equal(forced.status, 0, `--force run exited ${forced.status}: ${forced.stderr}`);
    const sample = JSON.parse(readFileSync(outPath, "utf-8"));
    assert.equal(sample.entries.length, 90);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
