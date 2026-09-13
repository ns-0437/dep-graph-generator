import { existsSync, readFileSync } from "fs";

/**
 * Guards against silently clobbering hand-labeled eval data. Real incident this exists
 * because of: re-running sample-edges.ts/sample-unresolved.ts directly against a changed
 * dependency_graph.json (to sanity-check an unrelated refactor) overwrote eval/sample.json
 * and eval/unresolved-sample.json with fresh, unlabeled samples -- caught only because the
 * overwrite happened to be noticed before it was committed (see git history around commit
 * 4d3323e). Labeling 90-150 entries by hand takes real time; losing it to a re-run typo
 * should require deliberate confirmation, not just happen.
 *
 * Pass `--force` on the command line to bypass this and overwrite anyway.
 */
export function assertSafeToOverwrite(path: string): void {
  if (process.argv.includes("--force")) return;
  if (!existsSync(path)) return;
  let existing: { entries?: { verdict: unknown }[] };
  try {
    existing = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return; // unreadable/corrupt -- nothing labeled to protect, let the overwrite proceed
  }
  const labeled = (existing.entries ?? []).filter((e) => e.verdict !== null && e.verdict !== undefined).length;
  if (labeled > 0) {
    console.error(
      `REFUSING to overwrite ${path}: it already has ${labeled} hand-labeled entr${labeled === 1 ? "y" : "ies"}.\n` +
        `Re-run with --force if you really mean to discard them (e.g. after intentionally re-sampling for a fresh labeling pass).`,
    );
    process.exit(1);
  }
}
