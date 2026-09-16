/**
 * Draws a stratified, reproducible random sample of edges from dependency_graph.json for
 * manual precision labeling. This is a QA/research tool, not part of the deliverable --
 * the generator's output schema stays exactly {nodes, edges: [{from,to,label}]}; this script
 * separately re-derives *why* each sampled edge was produced (which specific output field on
 * the producer justified it, and at what heuristic score) purely for human review, using the
 * same lib functions generate.ts itself uses.
 *
 * Run: node --import tsx eval/sample-edges.ts [output-path] [graph-input-path] [--force]
 * Output: eval/sample.json by default (each entry has verdict: null until hand-labeled), or
 * the given path -- an optional override that exists mainly so a smoke test can exercise
 * this script end-to-end without touching the real, hand-labeled file (see
 * sample-edges.test.ts). The graph input likewise defaults to dependency_graph.json but can
 * be overridden -- needed because that file is also written (temporarily, backed up and
 * restored) by generate.test.ts's CLI subprocess test, and Node's test runner runs different
 * test files concurrently by default: without an independent input path, a smoke test
 * reading/generating the real dependency_graph.json can race that other file's read-before/
 * write/restore-after around the exact same path.
 */
import { readFileSync, writeFileSync } from "fs";
import { loadCatalog, slugOf, requiredInputsOf } from "../src/lib/catalog.js";
import { flattenOutputs } from "../src/lib/schema.js";
import { indexFields, buildLeafFrequency, matchScore } from "../src/lib/match.js";
import type { IndexedField } from "../src/lib/match.js";
import { tokenize } from "../src/lib/tokenize.js";
import type { InputField } from "../src/types.js";
import { mulberry32, shuffle } from "./lib/sampling.js";
import { assertSafeToOverwrite } from "./lib/safe-write.js";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const OUT_PATH = positional[0] ?? "eval/sample.json";
const GRAPH_PATH = positional[1] ?? "dependency_graph.json";
assertSafeToOverwrite(OUT_PATH);

// Fixed, documented seed -- the sample is reproducible from this, not re-randomized on
// every run (which would make "did labeling stay consistent" impossible to check later).
const SEED = 424242;
const PER_TIER = 45;

const tools = loadCatalog("github_catalog.json");
const toolBySlug = new Map<string, any>();
for (const t of tools) {
  const id = slugOf(t);
  if (id) toolBySlug.set(id, t);
}

const outputsByTool = new Map<string, ReturnType<typeof flattenOutputs>>();
for (const [slug, tool] of toolBySlug) outputsByTool.set(slug, flattenOutputs(tool));
const indexedOutputsByTool = new Map<string, IndexedField[]>();
for (const [slug, fields] of outputsByTool) indexedOutputsByTool.set(slug, indexFields(fields));
const leafFrequency = buildLeafFrequency(indexedOutputsByTool);

const graph = JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));

/**
 * Re-derive which specific field on the producer justified this edge, and at what score.
 * The `?? []` and `field ? ... : null` fallbacks below are defensive: dependency_graph.json
 * and github_catalog.json are always read from the same generate() run, so every edge's
 * producer/consumer slug is guaranteed present in the catalog and to score >=SCORE_THRESHOLD
 * against at least one of its own fields -- only reachable if the two files were manually
 * mismatched. Marked c8-ignored rather than chasing coverage on data corruption this script
 * has no way to construct without a second, independently-injectable catalog/graph input.
 */
function justify(edge: { from: string; to: string; label: string }) {
  /* c8 ignore next */
  const fields = indexedOutputsByTool.get(edge.from) ?? [];
  const input: InputField = { name: edge.label, tokens: tokenize(edge.label) };
  let best: IndexedField | null = null;
  let bestScore = 0;
  for (const f of fields) {
    const s = matchScore(input, f, leafFrequency);
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }
  return { score: bestScore, field: best };
}

const withEvidence = (graph.edges as { from: string; to: string; label: string }[]).map((e) => {
  const { score, field } = justify(e);
  /* c8 ignore next */
  return { ...e, score, justifyingField: field ? { name: field.field.name, parentType: field.field.parentType, path: field.field.path } : null };
});

const tier5 = withEvidence.filter((e) => e.score === 5);
const tier4 = withEvidence.filter((e) => e.score === 4);
const other = withEvidence.filter((e) => e.score !== 4 && e.score !== 5);
console.error(`edges by score: tier5=${tier5.length} tier4=${tier4.length} other/unexplained=${other.length} (of ${withEvidence.length} total)`);
/* c8 ignore start -- only fires when dependency_graph.json actually has LLM-resolved edges,
   which requires a real OPENAI_API_KEY-backed generate() run; not exercised by the smoke
   test (which runs against whatever is currently committed, always LLM-edge-free) without
   either live network access or making the catalog/graph inputs independently injectable,
   neither of which is worth it for a single defensive warning line. */
if (other.length > 0) {
  console.error("WARNING: some edges could not be re-justified at score>=SCORE_THRESHOLD -- likely LLM-resolved edges, sampling only heuristic tiers.");
}
/* c8 ignore stop */

const rand = mulberry32(SEED);
const sampleTier5 = shuffle(tier5, rand).slice(0, PER_TIER);
const sampleTier4 = shuffle(tier4, rand).slice(0, PER_TIER);

// Every from/to slug in dependency_graph.json comes from a tool that was actually in
// github_catalog.json when it was generated; the `t ? ... : null` fallback below is only
// reachable on a mismatch between those two files (see justify()'s docs above for the
// identical reasoning).
// requiredInputs below was `t.inputParameters?.required ?? []` -- a stale duplicate of
// requiredInputsOf's logic that predates its OpenAI function-calling shape fallback (see
// catalog.ts). For a tool in that shape, this display-only summary would show
// requiredInputs: [] even though the tool genuinely requires fields (visible via
// tool.function.parameters.required), potentially misleading a human labeler reviewing why
// an edge was (or wasn't) produced. Now reuses the same function the actual matching logic
// calls, so the two can't drift apart again.
function toolSummary(slug: string) {
  const t = toolBySlug.get(slug);
  /* c8 ignore next */
  return t ? { slug, description: t.description ?? null, requiredInputs: requiredInputsOf(t).map((f) => f.name) } : null;
}

function buildEntry(e: (typeof withEvidence)[number]) {
  return {
    from: e.from,
    to: e.to,
    label: e.label,
    heuristicScore: e.score,
    justifyingField: e.justifyingField,
    producer: toolSummary(e.from),
    consumer: toolSummary(e.to),
    verdict: null as null | "correct" | "incorrect" | "ambiguous",
    notes: "",
  };
}

const sample = {
  seed: SEED,
  perTier: PER_TIER,
  generatedFrom: GRAPH_PATH,
  methodology:
    "Stratified random sample by heuristic match score (5 = leaf+type-name match, e.g. issue_number/Issue.number; 4 = exact leaf-name match, non-generic). Each entry needs 'verdict' filled in by hand: 'correct' (the producer really does supply this value), 'incorrect' (coincidental/wrong match), or 'ambiguous' (genuinely unclear without deeper GitHub API knowledge). See eval/README.md.",
  entries: [...sampleTier5.map(buildEntry), ...sampleTier4.map(buildEntry)],
};

writeFileSync(OUT_PATH, JSON.stringify(sample, null, 2), "utf-8");
console.error(`wrote ${OUT_PATH}: ${sample.entries.length} entries (${sampleTier5.length} tier-5, ${sampleTier4.length} tier-4)`);
