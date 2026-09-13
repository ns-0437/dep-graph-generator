import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * assertSafeToOverwrite calls process.exit(1), which would kill the test runner itself if
 * invoked in-process -- so, like the eval CLI scripts it protects, it's tested by running a
 * tiny real script as a subprocess and checking its exit code/output.
 */
function runProbe(args: string[], fileContent?: string): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "safe-write-test-"));
  const target = join(dir, "sample.json");
  if (fileContent !== undefined) writeFileSync(target, fileContent, "utf-8");
  const probe = join(dir, "probe.mjs");
  const moduleUrl = pathToFileURL(join(process.cwd(), "eval/lib/safe-write.js")).href;
  writeFileSync(
    probe,
    `
    import { assertSafeToOverwrite } from ${JSON.stringify(moduleUrl)};
    assertSafeToOverwrite(${JSON.stringify(target)});
    console.log("proceeded");
    `,
    "utf-8",
  );
  try {
    const result = spawnSync("node", ["--import", "tsx", probe, ...args], { encoding: "utf-8" });
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("assertSafeToOverwrite proceeds when the target file doesn't exist yet", () => {
  const { status } = runProbe([]);
  assert.equal(status, 0);
});

test("assertSafeToOverwrite proceeds when the target file exists but nothing is labeled", () => {
  const { status } = runProbe([], JSON.stringify({ entries: [{ verdict: null }, { verdict: null }] }));
  assert.equal(status, 0);
});

test("assertSafeToOverwrite refuses when the target file has hand-labeled entries", () => {
  const { status, stderr } = runProbe([], JSON.stringify({ entries: [{ verdict: "correct" }, { verdict: null }] }));
  assert.equal(status, 1);
  assert.match(stderr, /REFUSING to overwrite/);
  assert.match(stderr, /1 hand-labeled entry\b/); // singular, not "entries"
});

test("assertSafeToOverwrite pluralizes the count when more than one entry is labeled", () => {
  const { status, stderr } = runProbe([], JSON.stringify({ entries: [{ verdict: "correct" }, { verdict: "incorrect" }] }));
  assert.equal(status, 1);
  assert.match(stderr, /2 hand-labeled entries/);
});

test("assertSafeToOverwrite proceeds when the file has no entries array at all", () => {
  const { status } = runProbe([], JSON.stringify({ seed: 1 }));
  assert.equal(status, 0);
});

test("assertSafeToOverwrite proceeds anyway with --force, even over labeled entries", () => {
  const { status } = runProbe(["--force"], JSON.stringify({ entries: [{ verdict: "correct" }] }));
  assert.equal(status, 0);
});

test("assertSafeToOverwrite proceeds when the existing file is corrupt/unreadable JSON", () => {
  const { status } = runProbe([], "{ not valid json");
  assert.equal(status, 0);
});
