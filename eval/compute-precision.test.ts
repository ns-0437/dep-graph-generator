import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
function runOn(sample: object): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-precision-test-"));
  const path = join(dir, "sample.json");
  writeFileSync(path, JSON.stringify(sample), "utf-8");
  try {
    return execFileSync("node", ["--import", "tsx", "eval/compute-precision.ts", path], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("compute-precision reports per-tier and overall precision, excluding ambiguous", () => {
  const out = runOn({
    entries: [
      { heuristicScore: 5, verdict: "correct" },
      { heuristicScore: 5, verdict: "correct" },
      { heuristicScore: 5, verdict: "incorrect" },
      { heuristicScore: 4, verdict: "correct" },
      { heuristicScore: 4, verdict: "ambiguous" },
    ],
  });
  assert.match(out, /Tier 5 .*: 3 sampled, 2 correct, 1 incorrect, 0 ambiguous -> precision 66\.7%/);
  assert.match(out, /Tier 4 .*: 2 sampled, 1 correct, 0 incorrect, 1 ambiguous -> precision 100\.0%/);
  assert.match(out, /Overall: 5 sampled, 3 correct, 1 incorrect, 1 ambiguous -> precision 75\.0%/);
});

test("compute-precision handles a tier with zero decided entries", () => {
  const out = runOn({ entries: [{ heuristicScore: 5, verdict: "ambiguous" }] });
  assert.match(out, /Tier 5 .*: 1 sampled, 0 correct, 0 incorrect, 1 ambiguous -> no decided entries/);
});
