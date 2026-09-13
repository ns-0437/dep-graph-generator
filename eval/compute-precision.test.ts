import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * compute-precision.ts is a small standalone CLI, not a library -- so it's tested the way
 * it's actually used: written a fixture sample.json, run for real via `node --import tsx`,
 * and its stdout asserted on. This is the only one of the eval scripts with dedicated tests;
 * the sampling scripts (sample-edges.ts, sample-unresolved.ts) are exercised indirectly by
 * generate.test.ts's coverage of the same underlying lib functions and are re-run by hand
 * each time the graph changes, per eval/README.md.
 */
function runOn(sample: object): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "eval-precision-test-"));
  const path = join(dir, "sample.json");
  writeFileSync(path, JSON.stringify(sample), "utf-8");
  try {
    const result = spawnSync("node", ["--import", "tsx", "eval/compute-precision.ts", path], { encoding: "utf-8" });
    assert.equal(result.status, 0, `compute-precision.ts exited ${result.status}: ${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("compute-precision reports per-tier and overall precision, excluding ambiguous", () => {
  const { stdout } = runOn({
    entries: [
      { heuristicScore: 5, verdict: "correct" },
      { heuristicScore: 5, verdict: "correct" },
      { heuristicScore: 5, verdict: "incorrect" },
      { heuristicScore: 4, verdict: "correct" },
      { heuristicScore: 4, verdict: "ambiguous" },
    ],
  });
  assert.match(stdout, /Tier 5 .*: 3 sampled, 2 correct, 1 incorrect, 0 ambiguous -> precision 66\.7%/);
  assert.match(stdout, /Tier 4 .*: 2 sampled, 1 correct, 0 incorrect, 1 ambiguous -> precision 100\.0%/);
  assert.match(stdout, /Overall: 5 sampled, 3 correct, 1 incorrect, 1 ambiguous -> precision 75\.0%/);
});

test("compute-precision handles a tier with zero decided entries", () => {
  const { stdout } = runOn({ entries: [{ heuristicScore: 5, verdict: "ambiguous" }] });
  assert.match(stdout, /Tier 5 .*: 1 sampled, 0 correct, 0 incorrect, 1 ambiguous -> no decided entries/);
});

test("compute-precision warns on stderr about unlabeled entries but still reports the rest", () => {
  const { stdout, stderr } = runOn({
    entries: [
      { heuristicScore: 5, verdict: "correct" },
      { heuristicScore: 5, verdict: null },
    ],
  });
  assert.match(stderr, /WARNING: 1 of 2 entries have no verdict yet/);
  assert.match(stdout, /Tier 5 .*: 1 sampled, 1 correct, 0 incorrect, 0 ambiguous -> precision 100\.0%/);
});

test("compute-precision defaults to eval/sample.json when no path argument is given", () => {
  // The real, committed, already-labeled sample -- this only reads it, never writes, so
  // running against it is safe. Exercises the `process.argv[2] ?? "eval/sample.json"`
  // default path, which every other test bypasses by always passing an explicit path.
  const result = spawnSync("node", ["--import", "tsx", "eval/compute-precision.ts"], { encoding: "utf-8" });
  assert.equal(result.status, 0, `compute-precision.ts exited ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /Overall: \d+ sampled/);
});
