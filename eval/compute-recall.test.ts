import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runOn(sample: object): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "eval-recall-test-"));
  const path = join(dir, "unresolved-sample.json");
  writeFileSync(path, JSON.stringify(sample), "utf-8");
  try {
    const result = spawnSync("node", ["--import", "tsx", "eval/compute-recall.ts", path], { encoding: "utf-8" });
    assert.equal(result.status, 0, `compute-recall.ts exited ${result.status}: ${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("compute-recall reports the miss rate, excluding ambiguous from the denominator", () => {
  const { stdout } = runOn({
    totalUnresolved: 100,
    entries: [
      { verdict: "real_miss" },
      { verdict: "true_negative" },
      { verdict: "true_negative" },
      { verdict: "true_negative" },
      { verdict: "ambiguous" },
    ],
  });
  assert.match(stdout, /5 of 100 unresolved fields sampled: 1 real_miss, 3 true_negative, 1 ambiguous -> miss rate 25\.0%/);
});

test("compute-recall omits the rate entirely when nothing is decided", () => {
  const { stdout } = runOn({ totalUnresolved: 10, entries: [{ verdict: "ambiguous" }] });
  assert.match(stdout, /1 of 10 unresolved fields sampled: 0 real_miss, 0 true_negative, 1 ambiguous$/m);
  assert.doesNotMatch(stdout, /miss rate/);
});

test("compute-recall warns on stderr about unlabeled entries but still reports the rest", () => {
  const { stdout, stderr } = runOn({
    totalUnresolved: 2,
    entries: [{ verdict: "real_miss" }, { verdict: null }],
  });
  assert.match(stderr, /WARNING: 1 of 2 entries have no verdict yet/);
  assert.match(stdout, /1 of 2 unresolved fields sampled: 1 real_miss, 0 true_negative, 0 ambiguous -> miss rate 100\.0%/);
});
