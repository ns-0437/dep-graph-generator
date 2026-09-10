/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it: the catalog path is passed as a CLI argument, e.g.
 *   `node --import tsx src/generate.ts path/to/catalog.json`
 * We write `dependency_graph.json` to the working directory.
 */
import { readFileSync, writeFileSync } from "fs";
import OpenAI from "openai";

type Tool = Record<string, any>;
interface Node {
  id: string;
  service?: string;
}
interface Edge {
  from: string;
  to: string;
  label?: string;
}
interface Graph {
  nodes: Node[];
  edges: Edge[];
}

const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";

function loadCatalog(): Tool[] {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const data = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.name ?? tool.function?.name;
}

function singularize(t: string): string {
  if (t.length > 3 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("ses")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** camelCase / snake_case -> lowercase, singularized tokens, e.g. "issue_number" -> ["issue","number"]. */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((t) => singularize(t.toLowerCase()));
}

interface OutField {
  name: string;
  parentType: string;
  path: string;
}

/**
 * Walk outputParameters' `data` payload through $ref/$defs, collecting every leaf field
 * along with the name of the object type that owns it. Catalog output schemas are deeply
 * nested (data -> $ref -> ListRepositoryIssuesResponse -> issues[] -> $ref -> Issue ->
 * number), so a flat list of "field name equals input name" won't find anything useful —
 * the owning type name (e.g. "Issue") is what later lets us match `issue_number` to
 * `Issue.number` even though the two names don't share a literal substring beyond "number".
 */
function flattenOutputs(tool: Tool): OutField[] {
  const schema = tool.outputParameters;
  if (!schema || !schema.properties?.data) return [];
  const defs: Record<string, any> = schema.$defs ?? {};
  const results: OutField[] = [];
  const MAX_DEPTH = 12;

  function resolve(node: any): { node: any; typeName?: string } {
    if (node && typeof node === "object" && typeof node.$ref === "string") {
      const refName = node.$ref.split("/").pop()!;
      return { node: defs[refName] ?? {}, typeName: refName };
    }
    return { node };
  }

  function walk(node: any, path: string, parentType: string, visited: Set<string>, depth: number) {
    if (!node || depth > MAX_DEPTH) return;
    const { node: resolved, typeName } = resolve(node);
    const currentType = typeName ?? parentType;
    if (typeName) {
      if (visited.has(typeName)) return;
      visited = new Set(visited);
      visited.add(typeName);
    }
    if (resolved.type === "array" && resolved.items) {
      walk(resolved.items, path, currentType, visited, depth + 1);
      return;
    }
    const subSchemas: any[] = [resolved, ...(resolved.allOf ?? [])];
    for (const sub of subSchemas) {
      const props = sub.properties;
      if (!props) continue;
      for (const [key, val] of Object.entries<any>(props)) {
        const childPath = path ? `${path}.${key}` : key;
        const { node: childResolved } = resolve(val);
        const isContainer = !!childResolved.properties || childResolved.type === "array" || !!childResolved.allOf;
        if (isContainer) {
          walk(val, childPath, currentType, visited, depth + 1);
        } else {
          results.push({ name: key, parentType: currentType, path: childPath });
        }
      }
    }
  }

  walk(schema.properties.data, "data", "root", new Set(), 0);
  return results;
}

interface InputField {
  name: string;
  tokens: string[];
}

function requiredInputsOf(tool: Tool): InputField[] {
  const schema = tool.inputParameters;
  const required: string[] = schema?.required ?? [];
  return required.map((name) => ({ name, tokens: tokenize(name) }));
}

const SERVICE_KEYWORDS = [
  "pull_request",
  "issue",
  "repository",
  "comment",
  "label",
  "milestone",
  "branch",
  "commit",
  "release",
  "workflow",
  "gist",
  "organization",
  "team",
  "user",
  "webhook",
  "review",
  "tag",
  "content",
  "file",
  "discussion",
  "project",
  "check",
  "action",
  "collaborator",
  "fork",
  "star",
  "notification",
  "deployment",
  "artifact",
  "secret",
  "environment",
  "migration",
  "invitation",
  "membership",
];

/** Best-effort category derived from the slug itself, e.g. GITHUB_CREATE_AN_ISSUE -> "issues". */
function guessService(slug: string): string | undefined {
  const rest = tokenize(slug).slice(1);
  for (const kw of SERVICE_KEYWORDS) {
    const kwTokens = tokenize(kw);
    if (kwTokens.every((k) => rest.includes(k))) {
      return kwTokens.map((k) => (k.endsWith("s") ? k : k + "s")).join("_");
    }
  }
  return rest[0];
}

async function generate(tools: Tool[]): Promise<Graph> {
  const toolBySlug = new Map<string, Tool>();
  const nodes: Node[] = [];
  for (const t of tools) {
    const id = slugOf(t);
    if (!id) continue;
    toolBySlug.set(id, t);
    nodes.push({ id, service: guessService(id) });
  }

  const outputsByTool = new Map<string, OutField[]>();
  const leafFrequency = new Map<string, Set<string>>();
  for (const [slug, tool] of toolBySlug) {
    const fields = flattenOutputs(tool);
    outputsByTool.set(slug, fields);
    for (const f of fields) {
      const key = tokenize(f.name).join("_");
      if (!leafFrequency.has(key)) leafFrequency.set(key, new Set());
      leafFrequency.get(key)!.add(slug);
    }
  }
  // A leaf name produced by many tools (id, name, url, ...) is too weak a signal on its
  // own; only accept it without type-name corroboration when it's actually rare.
  const GENERIC_THRESHOLD = 25;
  function isGeneric(leafName: string): boolean {
    const key = tokenize(leafName).join("_");
    return (leafFrequency.get(key)?.size ?? 0) > GENERIC_THRESHOLD;
  }

  /**
   * Score a required input field against one candidate output leaf field. The core idea:
   * `issue_number` tokenizes to {issue, number}. If the leaf field's tokens ({number}) are
   * a subset of the input's tokens, and the *leftover* tokens ({issue}) match the leaf's
   * owning type name (Issue), that's strong evidence of a real dependency — without ever
   * hardcoding "issue_number" or "Issue" anywhere.
   */
  function matchScore(input: InputField, field: OutField): number {
    const leafTokens = tokenize(field.name);
    if (!leafTokens.every((t) => input.tokens.includes(t))) return 0;
    const remaining = input.tokens.filter((t) => !leafTokens.includes(t));
    if (remaining.length === 0) return isGeneric(field.name) ? 1 : 4;
    const typeTokens = tokenize(field.parentType);
    return remaining.every((t) => typeTokens.includes(t)) ? 5 : 0;
  }

  // Fields required by a large fraction of all tools (owner, repo, org, ...) are boilerplate
  // context the caller always supplies directly, never something looked up from another
  // tool's output — even a rare accidental leaf-name match for these is noise, not a real
  // dependency, so we exclude them from matching entirely rather than by threshold tuning.
  const inputFrequency = new Map<string, number>();
  for (const tool of toolBySlug.values()) {
    for (const input of requiredInputsOf(tool)) {
      inputFrequency.set(input.name, (inputFrequency.get(input.name) ?? 0) + 1);
    }
  }
  const CONTEXT_FIELD_RATIO = 0.15;
  const totalTools = toolBySlug.size;
  function isContextField(name: string): boolean {
    return (inputFrequency.get(name) ?? 0) / totalTools > CONTEXT_FIELD_RATIO;
  }

  const SCORE_THRESHOLD = 4;
  const MAX_PRODUCERS_PER_FIELD = 3;
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const [consumerSlug, tool] of toolBySlug) {
    for (const input of requiredInputsOf(tool)) {
      if (isContextField(input.name)) continue;
      const candidates: { slug: string; score: number }[] = [];
      for (const [producerSlug, fields] of outputsByTool) {
        if (producerSlug === consumerSlug) continue;
        let best = 0;
        for (const f of fields) best = Math.max(best, matchScore(input, f));
        if (best >= SCORE_THRESHOLD) candidates.push({ slug: producerSlug, score: best });
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

  return { nodes, edges };
}

/**
 * Loosely-matching candidates for a required field the heuristic couldn't resolve: any
 * output leaf sharing at least one token with the input name, ranked by overlap. Used to
 * hand an LLM a short, pre-filtered multiple-choice list instead of the entire catalog.
 */
function looseCandidates(
  input: InputField,
  consumerSlug: string,
  outputsByTool: Map<string, OutField[]>,
  limit: number,
) {
  const scored: { slug: string; leaf: string; type: string; overlap: number }[] = [];
  for (const [slug, fields] of outputsByTool) {
    if (slug === consumerSlug) continue;
    for (const f of fields) {
      const overlap = tokenize(f.name).filter((t) => input.tokens.includes(t)).length;
      if (overlap > 0) scored.push({ slug, leaf: f.name, type: f.parentType, overlap });
    }
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  const seenKey = new Set<string>();
  const out: typeof scored = [];
  for (const s of scored) {
    const key = `${s.slug}:${s.leaf}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Batched LLM pass over fields the heuristic couldn't resolve. Multiple-choice, not free
 * text, to keep it cheap and reliable: for each unresolved field we hand the model a short
 * list of loosely-matching candidates and ask it to pick one or none. Not called from
 * generate() yet.
 */
async function llmDisambiguate(
  unresolved: { consumer: string; field: InputField }[],
  outputsByTool: Map<string, OutField[]>,
): Promise<Edge[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || unresolved.length === 0) return [];
  const baseURL = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL ?? "openai/gpt-4o";
  const client = new OpenAI({ apiKey, baseURL });

  const items = unresolved
    .map((u) => ({ ...u, candidates: looseCandidates(u.field, u.consumer, outputsByTool, 5) }))
    .filter((u) => u.candidates.length > 0);

  const BATCH = 25;
  const results: Edge[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const payload = batch.map((u, idx) => ({
      idx,
      consumer_tool: u.consumer,
      required_field: u.field.name,
      candidate_producers: u.candidates.map((c, ci) => ({
        ci,
        producer_tool: c.slug,
        output_field: c.leaf,
        output_object_type: c.type,
      })),
    }));
    const prompt =
      "For each item, decide which candidate_producer (if any) plausibly supplies the " +
      "value for required_field of consumer_tool, based on API semantics (e.g. an " +
      '"issue_number" field is supplied by a "number" field on an "Issue" object). ' +
      'Respond with ONLY a JSON array like [{"idx":0,"ci":2},{"idx":1,"ci":null}] — ' +
      "ci is the chosen candidate's ci, or null if none plausibly apply.\n\n" +
      `Items:\n${JSON.stringify(payload)}`;
    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      });
      const text = resp.choices[0]?.message?.content ?? "[]";
      const match = text.match(/\[[\s\S]*\]/);
      const parsed: { idx: number; ci: number | null }[] = JSON.parse(match ? match[0] : text);
      for (const { idx, ci } of parsed) {
        if (ci === null || ci === undefined) continue;
        const u = batch[idx];
        const c = u?.candidates[ci];
        if (u && c) results.push({ from: c.slug, to: u.consumer, label: u.field.name });
      }
    } catch (err) {
      console.error("LLM disambiguation batch failed, skipping batch:", (err as Error).message);
    }
  }
  return results;
}

async function main() {
  const graph = await generate(loadCatalog());
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error(`wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
