import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../src/generate.js";
import { loadCatalog } from "../src/lib/catalog.js";

/**
 * A smoke test, not a correctness test of the underlying heuristic (that's covered by
 * match.test.ts and generate.test.ts, which this script re-derives the unresolved list
 * from). The point is to catch this script silently diverging from generate.ts's own logic
 * -- exactly what happened here for one commit (see CLAUDE.md's bug list) -- via CI, rather
 * than only when someone next runs it by hand.
 */
test("sample-unresolved.ts runs end-to-end against the real catalog and produces a well-shaped sample", () => {
  const dir = mkdtempSync(join(tmpdir(), "sample-unresolved-test-"));
  const outPath = join(dir, "unresolved-sample.json");
  try {
    const result = spawnSync("node", ["--import", "tsx", "eval/sample-unresolved.ts", outPath], { encoding: "utf-8" });
    assert.equal(result.status, 0, `sample-unresolved.ts exited ${result.status}: ${result.stderr}`);

    const sample = JSON.parse(readFileSync(outPath, "utf-8"));
    assert.equal(sample.seed, 424242);
    assert.equal(sample.entries.length, 60);
    assert.ok(sample.totalUnresolved >= 60, "totalUnresolved must be at least the sample size");
    for (const entry of sample.entries) {
      assert.equal(entry.verdict, null);
      assert.equal(typeof entry.field, "string");
      assert.ok(entry.consumer, `entry for field "${entry.field}" must have a consumer summary`);
      if (entry.nearMiss) {
        assert.equal(typeof entry.nearMiss.producer, "string");
        assert.equal(typeof entry.nearMiss.score, "number");
        assert.equal(typeof entry.nearMiss.excludedAsCircular, "boolean");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sample-unresolved.ts's totalUnresolved matches generate()'s own reported count", async () => {
  // The specific invariant that drifted for one commit: this script re-derives `unresolved`
  // independently of generate.ts, so nothing but running both and comparing catches them
  // silently disagreeing again in the future. Calls the real generate() function in-process
  // (capturing its console.error summary line) rather than spawning `node src/generate.ts`
  // as a subprocess -- that would write to the shared dependency_graph.json/graph.html paths
  // with no override of its own, racing generate.test.ts's CLI subprocess test on those exact
  // files (see the fix for the identical problem in sample-edges.test.ts).
  const dir = mkdtempSync(join(tmpdir(), "sample-unresolved-parity-test-"));
  const outPath = join(dir, "unresolved-sample.json");
  try {
    const sampleResult = spawnSync("node", ["--import", "tsx", "eval/sample-unresolved.ts", outPath], { encoding: "utf-8" });
    assert.equal(sampleResult.status, 0);
    const sample = JSON.parse(readFileSync(outPath, "utf-8"));

    const originalConsoleError = console.error;
    let captured = "";
    console.error = (...args: unknown[]) => {
      captured += args.join(" ") + "\n";
    };
    try {
      await generate(loadCatalog("github_catalog.json"));
    } finally {
      console.error = originalConsoleError;
    }
    const match = captured.match(/(\d+) unresolved by heuristics/);
    assert.ok(match, `expected generate()'s console.error output to report an unresolved count, got: ${captured}`);
    const generateUnresolvedCount = Number(match![1]);

    assert.equal(sample.totalUnresolved, generateUnresolvedCount);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sample-unresolved.ts is reproducible: re-running against the same catalog yields the same sample", () => {
  const dir = mkdtempSync(join(tmpdir(), "sample-unresolved-repro-test-"));
  const outA = join(dir, "a.json");
  const outB = join(dir, "b.json");
  try {
    spawnSync("node", ["--import", "tsx", "eval/sample-unresolved.ts", outA], { encoding: "utf-8" });
    spawnSync("node", ["--import", "tsx", "eval/sample-unresolved.ts", outB], { encoding: "utf-8" });
    const a = JSON.parse(readFileSync(outA, "utf-8"));
    const b = JSON.parse(readFileSync(outB, "utf-8"));
    assert.deepEqual(
      a.entries.map((e: { consumer: { slug: string }; field: string }) => `${e.consumer.slug}->${e.field}`),
      b.entries.map((e: { consumer: { slug: string }; field: string }) => `${e.consumer.slug}->${e.field}`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sample-unresolved.ts refuses to overwrite a target with hand-labeled entries, unless --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "sample-unresolved-guard-test-"));
  const outPath = join(dir, "unresolved-sample.json");
  writeFileSync(outPath, JSON.stringify({ entries: [{ verdict: "real_miss" }] }), "utf-8");
  try {
    const refused = spawnSync("node", ["--import", "tsx", "eval/sample-unresolved.ts", outPath], { encoding: "utf-8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /REFUSING to overwrite/);

    const forced = spawnSync("node", ["--import", "tsx", "eval/sample-unresolved.ts", outPath, "--force"], { encoding: "utf-8" });
    assert.equal(forced.status, 0, `--force run exited ${forced.status}: ${forced.stderr}`);
    const sample = JSON.parse(readFileSync(outPath, "utf-8"));
    assert.equal(sample.entries.length, 60);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sample-unresolved.ts defaults to eval/unresolved-sample.json when no output path is given", () => {
  const result = spawnSync("node", ["--import", "tsx", "eval/sample-unresolved.ts"], { encoding: "utf-8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REFUSING to overwrite eval\/unresolved-sample\.json/);
});
