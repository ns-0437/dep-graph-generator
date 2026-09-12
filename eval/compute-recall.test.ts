import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runOn(sample: object): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-recall-test-"));
  const path = join(dir, "unresolved-sample.json");
  writeFileSync(path, JSON.stringify(sample), "utf-8");
  try {
    return execFileSync("node", ["--import", "tsx", "eval/compute-recall.ts", path], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("compute-recall reports the miss rate, excluding ambiguous from the denominator", () => {
  const out = runOn({
    totalUnresolved: 100,
    entries: [
      { verdict: "real_miss" },
      { verdict: "true_negative" },
      { verdict: "true_negative" },
      { verdict: "true_negative" },
      { verdict: "ambiguous" },
    ],
  });
  assert.match(out, /5 of 100 unresolved fields sampled: 1 real_miss, 3 true_negative, 1 ambiguous -> miss rate 25\.0%/);
});

test("compute-recall omits the rate entirely when nothing is decided", () => {
  const out = runOn({ totalUnresolved: 10, entries: [{ verdict: "ambiguous" }] });
  assert.match(out, /1 of 10 unresolved fields sampled: 0 real_miss, 0 true_negative, 1 ambiguous$/m);
  assert.doesNotMatch(out, /miss rate/);
});
