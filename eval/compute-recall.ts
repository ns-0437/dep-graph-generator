/**
 * Reads a labeled eval/unresolved-sample.json and reports the miss rate among fields the
 * heuristic left unresolved -- not a true recall figure (see eval/README.md for why that
 * would need a denominator this project can't build). Ambiguous is excluded from the rate
 * and reported separately, same convention as compute-precision.ts.
 *
 * Run: node --import tsx eval/compute-recall.ts [path-to-unresolved-sample.json]
 */
import { readFileSync } from "fs";

interface Entry {
  verdict: "real_miss" | "true_negative" | "ambiguous" | null;
}

interface Sample {
  totalUnresolved: number;
  entries: Entry[];
}

const path = process.argv[2] ?? "eval/unresolved-sample.json";
const sample: Sample = JSON.parse(readFileSync(path, "utf-8"));

const unlabeled = sample.entries.filter((e) => e.verdict === null);
if (unlabeled.length > 0) {
  console.error(`WARNING: ${unlabeled.length} of ${sample.entries.length} entries have no verdict yet -- excluded below.`);
}

const labeled = sample.entries.filter((e) => e.verdict !== null);
const realMiss = labeled.filter((e) => e.verdict === "real_miss").length;
const trueNegative = labeled.filter((e) => e.verdict === "true_negative").length;
const ambiguous = labeled.filter((e) => e.verdict === "ambiguous").length;
const decided = realMiss + trueNegative;
const missRate = decided > 0 ? realMiss / decided : null;

console.log(`\n=== Miss-rate report: ${path} ===\n`);
console.log(
  `${labeled.length} of ${sample.totalUnresolved} unresolved fields sampled: ` +
    `${realMiss} real_miss, ${trueNegative} true_negative, ${ambiguous} ambiguous` +
    (missRate !== null ? ` -> miss rate ${(missRate * 100).toFixed(1)}% (of ${decided} decided, ambiguous excluded)` : ""),
);
