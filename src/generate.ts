/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it: the catalog path is passed as a CLI argument, e.g.
 *   `node --import tsx src/generate.ts path/to/catalog.json`
 * We write `dependency_graph.json` to the working directory.
 */
import { writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { flattenOutputs } from "./lib/schema.js";
import { loadCatalog, slugOf, requiredInputsOf, guessService } from "./lib/catalog.js";
import {
  buildLeafFrequency,
  buildInputFrequency,
  indexFields,
  matchScore,
  isContextField,
  SCORE_THRESHOLD,
  MAX_PRODUCERS_PER_FIELD,
} from "./lib/match.js";
import type { IndexedField } from "./lib/match.js";
import { llmDisambiguate } from "./lib/llm.js";
import type { ChatClient } from "./lib/llm.js";
import { renderVisualizationHtml } from "./lib/visualization.js";
import type { Tool, GraphNode, Edge, Graph, OutField, InputField } from "./types.js";

const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";

/**
 * `client` is only ever passed in tests -- production always lets llmDisambiguate build a
 * real OpenAI client from env vars. Threaded through here (not just llmDisambiguate itself)
 * so a test can exercise generate()'s own handling of LLM-contributed edges end to end --
 * merging them into the heuristic result and deduping against edges the heuristic already
 * found -- not just llmDisambiguate in isolation.
 */
export async function generate(tools: Tool[], client?: ChatClient): Promise<Graph> {
  const toolBySlug = new Map<string, Tool>();
  const nodes: GraphNode[] = [];
  for (const t of tools) {
    const id = slugOf(t);
    if (!id) continue;
    toolBySlug.set(id, t);
    nodes.push({ id, service: guessService(id) });
  }

  const outputsByTool = new Map<string, OutField[]>();
  for (const [slug, tool] of toolBySlug) {
    outputsByTool.set(slug, flattenOutputs(tool));
  }
  // matchScore runs once per (required input) x (candidate field) pair -- millions of times
  // against a large catalog -- so each field's tokens are computed once here rather than
  // re-tokenized inside every comparison. See IndexedField in lib/match.ts.
  const indexedOutputsByTool = new Map<string, IndexedField[]>();
  for (const [slug, fields] of outputsByTool) {
    indexedOutputsByTool.set(slug, indexFields(fields));
  }
  const leafFrequency = buildLeafFrequency(indexedOutputsByTool);

  const requiredByTool = new Map<string, InputField[]>();
  for (const [slug, tool] of toolBySlug) {
    requiredByTool.set(slug, requiredInputsOf(tool));
  }
  const inputFrequency = buildInputFrequency([...requiredByTool.values()]);
  const totalTools = toolBySlug.size;

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const unresolved: { consumer: string; field: InputField }[] = [];
  let contextFieldsSkipped = 0;
  let requiredFieldsTotal = 0;

  for (const [consumerSlug, requiredInputs] of requiredByTool) {
    for (const input of requiredInputs) {
      requiredFieldsTotal++;
      if (isContextField(input.name, inputFrequency, totalTools)) {
        contextFieldsSkipped++;
        continue;
      }
      const candidates: { slug: string; score: number }[] = [];
      for (const [producerSlug, fields] of indexedOutputsByTool) {
        if (producerSlug === consumerSlug) continue;
        let best = 0;
        for (const f of fields) best = Math.max(best, matchScore(input, f, leafFrequency));
        if (best >= SCORE_THRESHOLD) candidates.push({ slug: producerSlug, score: best });
      }
      if (candidates.length === 0) {
        unresolved.push({ consumer: consumerSlug, field: input });
        continue;
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const c of candidates.slice(0, MAX_PRODUCERS_PER_FIELD)) {
        const key = `${c.slug}->${consumerSlug}->${input.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: c.slug, to: consumerSlug, label: input.name });
      }
    }
  }

  const heuristicEdgeCount = edges.length;

  const llmEdges = await llmDisambiguate(unresolved, indexedOutputsByTool, client);
  for (const e of llmEdges) {
    const key = `${e.from}->${e.to}->${e.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
  }

  console.error(
    `[generate] required fields: ${requiredFieldsTotal} total, ${contextFieldsSkipped} treated as caller-supplied context (skipped), ` +
      `${unresolved.length} unresolved by heuristics (sent to LLM if credentials present). ` +
      `edges: ${heuristicEdgeCount} from heuristics, ${edges.length - heuristicEdgeCount} from LLM disambiguation.`,
  );

  return { nodes, edges };
}

const VIZ_PATH = "graph.html";

async function main() {
  const graph = await generate(loadCatalog(CATALOG_PATH));
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  writeFileSync(VIZ_PATH, renderVisualizationHtml(graph), "utf-8");
  console.error(
    `wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}, visualization to ${VIZ_PATH}`,
  );
}

// Only run main() when this file is executed directly (node generate.ts / node --import tsx
// generate.ts <catalog>), not when it's imported as a module -- e.g. from a test importing
// `generate` for an end-to-end check. Without this guard, importing this file anywhere
// would try to read argv, load a catalog, and write output files as a side effect.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
