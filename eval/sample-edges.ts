/**
 * Draws a stratified, reproducible random sample of edges from dependency_graph.json for
 * manual precision labeling. This is a QA/research tool, not part of the deliverable --
 * the generator's output schema stays exactly {nodes, edges: [{from,to,label}]}; this script
 * separately re-derives *why* each sampled edge was produced (which specific output field on
 * the producer justified it, and at what heuristic score) purely for human review, using the
 * same lib functions generate.ts itself uses.
 *
 * Run: node --import tsx eval/sample-edges.ts
 * Output: eval/sample.json (each entry has verdict: null until hand-labeled).
 */
import { readFileSync, writeFileSync } from "fs";
import { loadCatalog, slugOf } from "../src/lib/catalog.js";
import { flattenOutputs } from "../src/lib/schema.js";
import { indexFields, buildLeafFrequency, matchScore, SCORE_THRESHOLD } from "../src/lib/match.js";
import type { IndexedField } from "../src/lib/match.js";
import { tokenize } from "../src/lib/tokenize.js";
import type { InputField } from "../src/types.js";

// Fixed, documented seed -- the sample is reproducible from this, not re-randomized on
// every run (which would make "did labeling stay consistent" impossible to check later).
const SEED = 424242;
const PER_TIER = 45;

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

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

const graph = JSON.parse(readFileSync("dependency_graph.json", "utf-8"));

/** Re-derive which specific field on the producer justified this edge, and at what score. */
function justify(edge: { from: string; to: string; label: string }) {
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
  return { ...e, score, justifyingField: field ? { name: field.field.name, parentType: field.field.parentType, path: field.field.path } : null };
});

const tier5 = withEvidence.filter((e) => e.score === 5);
const tier4 = withEvidence.filter((e) => e.score === 4);
const other = withEvidence.filter((e) => e.score !== 4 && e.score !== 5);
console.error(`edges by score: tier5=${tier5.length} tier4=${tier4.length} other/unexplained=${other.length} (of ${withEvidence.length} total)`);
if (other.length > 0) {
  console.error("WARNING: some edges could not be re-justified at score>=SCORE_THRESHOLD -- likely LLM-resolved edges, sampling only heuristic tiers.");
}

const rand = mulberry32(SEED);
const sampleTier5 = shuffle(tier5, rand).slice(0, PER_TIER);
const sampleTier4 = shuffle(tier4, rand).slice(0, PER_TIER);

function toolSummary(slug: string) {
  const t = toolBySlug.get(slug);
  return t ? { slug, description: t.description ?? null, requiredInputs: t.inputParameters?.required ?? [] } : null;
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
  generatedFrom: "dependency_graph.json",
  methodology:
    "Stratified random sample by heuristic match score (5 = leaf+type-name match, e.g. issue_number/Issue.number; 4 = exact leaf-name match, non-generic). Each entry needs 'verdict' filled in by hand: 'correct' (the producer really does supply this value), 'incorrect' (coincidental/wrong match), or 'ambiguous' (genuinely unclear without deeper GitHub API knowledge). See eval/README.md.",
  entries: [...sampleTier5.map(buildEntry), ...sampleTier4.map(buildEntry)],
};

writeFileSync("eval/sample.json", JSON.stringify(sample, null, 2), "utf-8");
console.error(`wrote eval/sample.json: ${sample.entries.length} entries (${sampleTier5.length} tier-5, ${sampleTier4.length} tier-4)`);
