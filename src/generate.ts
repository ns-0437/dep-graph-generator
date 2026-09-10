/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it: the catalog path is passed as a CLI argument, e.g.
 *   `node --import tsx src/generate.ts path/to/catalog.json`
 * We write `dependency_graph.json` to the working directory.
 */
import { readFileSync, writeFileSync } from "fs";

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

  const SCORE_THRESHOLD = 4;
  const MAX_PRODUCERS_PER_FIELD = 3;
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const [consumerSlug, tool] of toolBySlug) {
    for (const input of requiredInputsOf(tool)) {
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

async function main() {
  const graph = await generate(loadCatalog());
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error(`wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
