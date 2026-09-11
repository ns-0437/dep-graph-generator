import { tokenize } from "./tokenize.js";
import type { InputField, OutField } from "../types.js";

/** A leaf field name produced by more tools than this is too weak a signal on its own. */
export const GENERIC_THRESHOLD = 25;

/** Both a ratio and an absolute floor -- see isContextField for why both are needed. */
export const CONTEXT_FIELD_RATIO = 0.15;
export const CONTEXT_FIELD_MIN_COUNT = 20;

export const SCORE_THRESHOLD = 4;
export const MAX_PRODUCERS_PER_FIELD = 3;

export function buildLeafFrequency(outputsByTool: Map<string, OutField[]>): Map<string, Set<string>> {
  const leafFrequency = new Map<string, Set<string>>();
  for (const [slug, fields] of outputsByTool) {
    for (const f of fields) {
      const key = tokenize(f.name).join("_");
      if (!leafFrequency.has(key)) leafFrequency.set(key, new Set());
      leafFrequency.get(key)!.add(slug);
    }
  }
  return leafFrequency;
}

export function isGeneric(
  leafName: string,
  leafFrequency: Map<string, Set<string>>,
  threshold = GENERIC_THRESHOLD,
): boolean {
  const key = tokenize(leafName).join("_");
  return (leafFrequency.get(key)?.size ?? 0) > threshold;
}

/**
 * Score a required input field against one candidate output leaf field. The core idea:
 * `issue_number` tokenizes to {issue, number}. If the leaf field's tokens ({number}) are
 * a subset of the input's tokens, and the *leftover* tokens ({issue}) match the leaf's
 * owning type name (Issue), that's strong evidence of a real dependency — without ever
 * hardcoding "issue_number" or "Issue" anywhere.
 */
export function matchScore(
  input: InputField,
  field: OutField,
  leafFrequency: Map<string, Set<string>>,
  genericThreshold = GENERIC_THRESHOLD,
): number {
  const leafTokens = tokenize(field.name);
  if (!leafTokens.every((t) => input.tokens.includes(t))) return 0;
  const remaining = input.tokens.filter((t) => !leafTokens.includes(t));
  if (remaining.length === 0) return isGeneric(field.name, leafFrequency, genericThreshold) ? 1 : 4;
  const typeTokens = tokenize(field.parentType);
  return remaining.every((t) => typeTokens.includes(t)) ? 5 : 0;
}

export function buildInputFrequency(requiredByTool: InputField[][]): Map<string, number> {
  const inputFrequency = new Map<string, number>();
  for (const inputs of requiredByTool) {
    for (const input of inputs) {
      inputFrequency.set(input.name, (inputFrequency.get(input.name) ?? 0) + 1);
    }
  }
  return inputFrequency;
}

/**
 * Fields required by a large fraction of all tools (owner, repo, org, ...) are boilerplate
 * context the caller always supplies directly, never something looked up from another
 * tool's output — even a rare accidental leaf-name match for these is noise, not a real
 * dependency, so we exclude them from matching entirely rather than by threshold tuning.
 *
 * Both an absolute floor and a ratio: small catalogs can have a field required by most (or
 * all) of their handful of tools without it being boilerplate context — e.g. 1/2 tools
 * needing `channel_id` in a 2-tool catalog is not evidence of anything. The pattern only
 * becomes meaningful once there's a reasonable sample size behind it.
 */
export function isContextField(
  name: string,
  inputFrequency: Map<string, number>,
  totalTools: number,
  ratio = CONTEXT_FIELD_RATIO,
  minCount = CONTEXT_FIELD_MIN_COUNT,
): boolean {
  const count = inputFrequency.get(name) ?? 0;
  return count >= minCount && count / totalTools > ratio;
}
