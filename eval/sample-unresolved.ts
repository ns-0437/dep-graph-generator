/**
 * Draws a stratified, reproducible random sample of *unresolved* required fields -- fields
 * the heuristic could not find any producer for -- for manual miss-rate labeling. This is
 * the recall-side counterpart to sample-edges.ts (see eval/README.md's "Recall (partial)"
 * section for why this is a miss rate among unresolved fields, not a full recall figure).
 *
 * Re-derives the exact same `unresolved` list generate.ts itself computes (same context-field
 * skip, same circular-producer exclusion, same SCORE_THRESHOLD), rather than approximating it,
 * so the sample reflects what actually ships in dependency_graph.json's edge set.
 *
 * For each sampled field we also record the single highest-scoring candidate found among ALL
 * tools (even though it fell below SCORE_THRESHOLD) -- the near-miss, if any -- so a human
 * labeler can see whether the heuristic came close and was excluded by threshold/circularity,
 * or found nothing resembling a producer at all.
 *
 * Run: node --import tsx eval/sample-unresolved.ts [output-path] [--force]
 * Output: eval/unresolved-sample.json by default (each entry has verdict: null until
 * hand-labeled), or the given path -- an optional override that exists mainly so a smoke
 * test can exercise this script end-to-end without touching the real, hand-labeled file
 * (see sample-unresolved.test.ts).
 */
import { writeFileSync } from "fs";
import { loadCatalog, slugOf, requiredInputsOf } from "../src/lib/catalog.js";
import { flattenOutputs } from "../src/lib/schema.js";
import {
  indexFields,
  buildLeafFrequency,
  buildInputFrequency,
  buildRequiredNamesByTool,
  matchScore,
  isContextField,
  isCircularProducer,
  canonicalFieldKey,
  SCORE_THRESHOLD,
} from "../src/lib/match.js";
import type { IndexedField } from "../src/lib/match.js";
import type { InputField, Tool } from "../src/types.js";
import { mulberry32, shuffle } from "./lib/sampling.js";
import { assertSafeToOverwrite } from "./lib/safe-write.js";

const OUT_PATH = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "eval/unresolved-sample.json";
assertSafeToOverwrite(OUT_PATH);

const SEED = 424242;
const SAMPLE_SIZE = 60;

const tools: Tool[] = loadCatalog("github_catalog.json");
const toolBySlug = new Map<string, Tool>();
for (const t of tools) {
  const id = slugOf(t);
  if (id) toolBySlug.set(id, t);
}

const outputsByTool = new Map<string, ReturnType<typeof flattenOutputs>>();
for (const [slug, tool] of toolBySlug) outputsByTool.set(slug, flattenOutputs(tool));
const indexedOutputsByTool = new Map<string, IndexedField[]>();
for (const [slug, fields] of outputsByTool) indexedOutputsByTool.set(slug, indexFields(fields));
const leafFrequency = buildLeafFrequency(indexedOutputsByTool);

const requiredByTool = new Map<string, InputField[]>();
for (const [slug, tool] of toolBySlug) requiredByTool.set(slug, requiredInputsOf(tool));
const inputFrequency = buildInputFrequency([...requiredByTool.values()]);
const totalTools = toolBySlug.size;

// Shared with generate.ts specifically so the two can't drift out of sync with each other
// the way they once did (see buildRequiredNamesByTool's own docs, and CLAUDE.md's bug list,
// for the incident this replaced: this script silently regressed to exact-string circularity
// matching for one commit after generate.ts's own copy of this logic was fixed).
const requiredNamesByTool = buildRequiredNamesByTool(requiredByTool);

// Same loop as generate.ts, but we also track the best-scoring candidate below threshold
// (or excluded by circularity) for each unresolved field, purely for labeling context.
const unresolved: {
  consumer: string;
  field: InputField;
  nearMiss: { producer: string; score: number; excludedAsCircular: boolean } | null;
}[] = [];
let contextFieldsSkipped = 0;
let requiredFieldsTotal = 0;

for (const [consumerSlug, requiredInputs] of requiredByTool) {
  for (const input of requiredInputs) {
    requiredFieldsTotal++;
    if (isContextField(input.name, inputFrequency, totalTools)) {
      contextFieldsSkipped++;
      continue;
    }
    let resolved = false;
    let bestNearMiss: { producer: string; score: number; excludedAsCircular: boolean } | null = null;
    const canonicalInputName = canonicalFieldKey(input.name);
    for (const [producerSlug, fields] of indexedOutputsByTool) {
      if (producerSlug === consumerSlug) continue;
      const circular = isCircularProducer(canonicalInputName, requiredNamesByTool.get(producerSlug) ?? new Set());
      let best = 0;
      for (const f of fields) best = Math.max(best, matchScore(input, f, leafFrequency));
      if (best >= SCORE_THRESHOLD && !circular) {
        resolved = true;
        break;
      }
      if (best > 0 && (!bestNearMiss || best > bestNearMiss.score)) {
        bestNearMiss = { producer: producerSlug, score: best, excludedAsCircular: circular };
      }
    }
    if (!resolved) unresolved.push({ consumer: consumerSlug, field: input, nearMiss: bestNearMiss });
  }
}

console.error(
  `required fields: ${requiredFieldsTotal} total, ${contextFieldsSkipped} context (skipped), ${unresolved.length} unresolved`,
);

const rand = mulberry32(SEED);
const sampled = shuffle(unresolved, rand).slice(0, SAMPLE_SIZE);

function toolSummary(slug: string) {
  const t = toolBySlug.get(slug);
  return t ? { slug, description: t.description ?? null, requiredInputs: t.inputParameters?.required ?? [] } : null;
}

const entries = sampled.map((u) => ({
  consumer: toolSummary(u.consumer),
  field: u.field.name,
  nearMiss: u.nearMiss
    ? {
        producer: u.nearMiss.producer,
        producerDescription: toolBySlug.get(u.nearMiss.producer)?.description ?? null,
        score: u.nearMiss.score,
        excludedAsCircular: u.nearMiss.excludedAsCircular,
      }
    : null,
  verdict: null as null | "real_miss" | "true_negative" | "ambiguous",
  notes: "",
}));

const sample = {
  seed: SEED,
  sampleSize: SAMPLE_SIZE,
  totalUnresolved: unresolved.length,
  generatedFrom: "github_catalog.json (re-run through the same heuristic as generate.ts)",
  methodology:
    "Simple random sample (unlike sample-edges.ts, unresolved fields aren't naturally tiered by heuristic score, so there's no stratification axis here) of fields the heuristic left unresolved. Each entry needs 'verdict': 'real_miss' (a producer for this field genuinely exists somewhere in the catalog but the heuristic didn't find it -- e.g. a near-miss that was wrongly excluded, or a real match the token/type-name matching approach is structurally unable to express), 'true_negative' (the field is genuinely something only the caller can supply -- free text, a boolean/enum flag, a value with no natural producer anywhere in this catalog), or 'ambiguous'. See eval/README.md.",
  entries,
};

writeFileSync(OUT_PATH, JSON.stringify(sample, null, 2), "utf-8");
console.error(`wrote ${OUT_PATH}: ${entries.length} entries (of ${unresolved.length} unresolved total)`);
