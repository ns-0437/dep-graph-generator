/**
 * Reads a labeled eval/sample.json and reports precision per heuristic-score tier and
 * overall. Ambiguous verdicts are excluded from the denominator by default and reported
 * separately, not silently folded into either bucket.
 *
 * Run: node --import tsx eval/compute-precision.ts [path-to-sample.json]
 */
import { readFileSync } from "fs";

interface Entry {
  heuristicScore: number;
  verdict: "correct" | "incorrect" | "ambiguous" | null;
}

interface Sample {
  entries: Entry[];
}

const path = process.argv[2] ?? "eval/sample.json";
const sample: Sample = JSON.parse(readFileSync(path, "utf-8"));

const unlabeled = sample.entries.filter((e) => e.verdict === null);
if (unlabeled.length > 0) {
  console.error(`WARNING: ${unlabeled.length} of ${sample.entries.length} entries have no verdict yet -- excluded from all counts below.`);
}

function report(label: string, entries: Entry[]) {
  const correct = entries.filter((e) => e.verdict === "correct").length;
  const incorrect = entries.filter((e) => e.verdict === "incorrect").length;
  const ambiguous = entries.filter((e) => e.verdict === "ambiguous").length;
  const decided = correct + incorrect;
  const precision = decided > 0 ? correct / decided : null;
  console.log(
    `${label}: ${entries.length} sampled, ${correct} correct, ${incorrect} incorrect, ${ambiguous} ambiguous` +
      (precision !== null ? ` -> precision ${(precision * 100).toFixed(1)}% (of ${decided} decided, ambiguous excluded)` : " -> no decided entries"),
  );
  return { correct, incorrect, ambiguous, precision };
}

const labeled = sample.entries.filter((e) => e.verdict !== null);
const tier5 = labeled.filter((e) => e.heuristicScore === 5);
const tier4 = labeled.filter((e) => e.heuristicScore === 4);

console.log(`\n=== Precision report: ${path} ===\n`);
report("Tier 5 (leaf + owning-type-name match)", tier5);
report("Tier 4 (exact leaf-name match, non-generic)", tier4);
report("Overall", labeled);
