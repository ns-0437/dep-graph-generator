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

/**
 * TODO: this is a placeholder. Every tool becomes a node, no edges yet — passes the
 * "node ids are real slugs" check but scores ~0 on correctness until dependency
 * inference is added.
 */
async function generate(tools: Tool[]): Promise<Graph> {
  const nodes: Node[] = tools
    .map(slugOf)
    .filter((s): s is string => !!s)
    .map((id) => ({ id }));
  const edges: Edge[] = [];
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
