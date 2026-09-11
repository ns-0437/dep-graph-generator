import { readFileSync } from "fs";
import { tokenize } from "./tokenize.js";
import type { Tool, InputField } from "../types.js";

export function loadCatalog(catalogPath: string | undefined): Tool[] {
  if (!catalogPath) {
    throw new Error("pass the toolkit catalog path as the first argument");
  }
  const data = JSON.parse(readFileSync(catalogPath, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
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
      return kwTokens.map((k) => (k.endsWith("s") ? k : k + "s")).join("_");
    }
  }
  return rest[0];
}
