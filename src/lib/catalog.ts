import { readFileSync } from "fs";
import { tokenize } from "./tokenize.js";
import type { Tool, InputField } from "../types.js";

export function loadCatalog(catalogPath: string | undefined): Tool[] {
  if (!catalogPath) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(catalogPath, "utf-8"));
  } catch (err) {
    throw new Error(`failed to read/parse catalog at "${catalogPath}": ${(err as Error).message}`);
  }
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.tools)) return obj.tools as Tool[];
    if (Array.isArray(obj.items)) return obj.items as Tool[];
  }
  // Previously this silently fell through to `[]`, which produces a graph with 0 nodes
  // and 0 edges and no indication of why -- indistinguishable from "catalog legitimately
  // has no tools". Fail loudly instead so a malformed/misshapen catalog is obvious.
  throw new Error(
    `catalog at "${catalogPath}" is not a recognized shape -- expected a JSON array of ` +
      `tools, or an object with a "tools" or "items" array property.`,
  );
}

export function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.name ?? tool.function?.name;
}

export function requiredInputsOf(tool: Tool): InputField[] {
  const schema = tool.inputParameters;
  const required: string[] = schema?.required ?? [];
  return required.map((name) => ({ name, tokens: tokenize(name) }));
}

export const SERVICE_KEYWORDS = [
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
export function guessService(slug: string): string | undefined {
  const rest = tokenize(slug).slice(1);
  for (const kw of SERVICE_KEYWORDS) {
    const kwTokens = tokenize(kw);
    if (kwTokens.every((k) => rest.includes(k))) {
      // Pluralize only the last word -- pluralizing every word independently turns
      // "pull_request" into "pulls_requests" instead of "pull_requests".
      return kwTokens
        .map((k, i) => (i === kwTokens.length - 1 && !k.endsWith("s") ? k + "s" : k))
        .join("_");
    }
  }
  return rest[0];
}
