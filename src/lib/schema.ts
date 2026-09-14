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

  function compositionBranches(resolved: any): any[] {
    return [...(resolved.allOf ?? []), ...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])];
  }

  /**
   * Does this node (after following $ref/array/allOf/oneOf/anyOf) eventually reach a
   * schema with named properties worth descending into? Needed because real catalog data
   * has fields like `{ anyOf: [{ $ref: "#/$defs/RealShape" }, { type: "object",
   * additionalProperties: true }] }` (a real GitHub example) -- treating that field as an
   * opaque leaf would silently lose every field inside RealShape, but treating every
   * anyOf/oneOf field as a container would also wrongly swallow simple nullable-primitive
   * patterns like `{ anyOf: [{ type: "string" }, { type: "null" }] }`, which should still
   * be recorded as a leaf under their own property name.
   */
  function isEffectivelyContainer(node: any, depth = 0): boolean {
    if (!node || depth > MAX_DEPTH) return false;
    const { node: resolved } = resolve(node);
    if (resolved.properties) return true;
    if (resolved.type === "array" && resolved.items) return isEffectivelyContainer(resolved.items, depth + 1);
    return compositionBranches(resolved).some((branch) => isEffectivelyContainer(branch, depth + 1));
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
    // allOf/oneOf/anyOf: each branch is an alternative or additional shape for THIS same
    // node (not a new named field) -- e.g. "give me RealShape if possible, else any
    // object" -- so each branch is walked at the same path, letting $ref resolution give
    // it its own precise owning type name if it has one.
    for (const branch of compositionBranches(resolved)) {
      walk(branch, path, currentType, visited, depth + 1);
    }
    const props = resolved.properties;
    if (!props) return;
    for (const [key, val] of Object.entries<any>(props)) {
      // `path` is never empty here -- walk()'s only entry point (below) starts it at "data",
      // and every recursive call either passes it through unchanged or as this same
      // already-non-empty childPath, so there's no path-less case to handle. (A
      // `path ? ... : key` fallback used to sit here for that case; removed as genuinely
      // dead code rather than left with a coverage-ignore comment, since it's private to
      // this function and provably unreachable, not just unreachable in practice.)
      const childPath = `${path}.${key}`;
      if (isEffectivelyContainer(val)) {
        walk(val, childPath, currentType, visited, depth + 1);
      } else {
        results.push({ name: key, parentType: currentType, path: childPath });
      }
    }
  }

  walk(schema.properties.data, "data", "root", new Set(), 0);
  return results;
}
