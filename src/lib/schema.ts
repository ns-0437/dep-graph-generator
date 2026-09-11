import type { Tool, OutField } from "../types.js";

/**
 * Walk outputParameters' `data` payload through $ref/$defs, collecting every leaf field
 * along with the name of the object type that owns it. Catalog output schemas are deeply
 * nested (data -> $ref -> ListRepositoryIssuesResponse -> issues[] -> $ref -> Issue ->
 * number), so a flat list of "field name equals input name" won't find anything useful —
 * the owning type name (e.g. "Issue") is what later lets us match `issue_number` to
 * `Issue.number` even though the two names don't share a literal substring beyond "number".
 */
export function flattenOutputs(tool: Tool): OutField[] {
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
