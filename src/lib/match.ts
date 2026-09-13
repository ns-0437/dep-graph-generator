import { tokenize } from "./tokenize.js";
import type { InputField, OutField } from "../types.js";

/** A leaf field name produced by more tools than this is too weak a signal on its own. */
export const GENERIC_THRESHOLD = 25;

/** Both a ratio and an absolute floor -- see isContextField for why both are needed. */
export const CONTEXT_FIELD_RATIO = 0.15;
export const CONTEXT_FIELD_MIN_COUNT = 20;

export const SCORE_THRESHOLD = 4;
export const MAX_PRODUCERS_PER_FIELD = 3;

/**
 * An OutField with its name/type tokens precomputed once. matchScore is called once per
 * (required input) x (candidate field) pair -- against the real GitHub catalog that's
 * ~24.9 million calls. Re-running tokenize() (a regex replace + split + per-token
 * singularize) inside matchScore on every one of those calls measured at ~19.3s; computing
 * each field's tokens once up front instead drops that to well under a second, with
 * identical results (verified against the same edge count on the same catalog).
 */
export interface IndexedField {
  field: OutField;
  tokens: string[];
  typeTokens: string[];
}

export function indexFields(fields: OutField[]): IndexedField[] {
  return fields.map((field) => ({
    field,
    tokens: tokenize(field.name),
    typeTokens: tokenize(field.parentType),
  }));
}

export function buildLeafFrequency(outputsByTool: Map<string, IndexedField[]>): Map<string, Set<string>> {
  const leafFrequency = new Map<string, Set<string>>();
  for (const [slug, fields] of outputsByTool) {
    for (const f of fields) {
      const key = f.tokens.join("_");
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
 * Domain abbreviations that name the same concept as a catalog type name but share no
 * token with it under plain string tokenization -- found via eval/unresolved-sample.ts
 * hand-labeling (see eval/RESULTS.md): `hook_id` genuinely means the same thing as
 * `Webhook.id`, and `pat_id`/`pat_ids` genuinely mean the same thing as `Token.id`
 * (confirmed directly against the catalog; the catalog's own field description for
 * GITHUB_UPDATE_RESOURCE_ACCESS_WITH_TOKENS even names GITHUB_LIST_ORG_RESOURCE_ACCESS_TOKENS
 * as the source of pat ids). Both were real, verified misses, not guesses -- kept as a small,
 * explicit map rather than fuzzy/edit-distance matching, which would risk conflating
 * unrelated short tokens that happen to look similar.
 */
const TOKEN_SYNONYMS: Readonly<Record<string, string>> = {
  hook: "webhook",
  pat: "token",
};

function canonicalToken(t: string): string {
  return TOKEN_SYNONYMS[t] ?? t;
}

/** True if every token in `remaining` matches some token in `typeTokens`, allowing the
 * known abbreviation synonyms above in either direction (so "hook" matches "webhook" and
 * vice versa) without changing behavior for any token that isn't in that map. */
function remainingMatchesType(remaining: string[], typeTokens: string[]): boolean {
  return remaining.every((t) => typeTokens.some((tt) => canonicalToken(t) === canonicalToken(tt)));
}

/**
 * Score a required input field against one candidate output leaf field (pre-indexed, see
 * IndexedField). The core idea: `issue_number` tokenizes to {issue, number}. If the leaf
 * field's tokens ({number}) are a subset of the input's tokens, and the *leftover* tokens
 * ({issue}) match the leaf's owning type name (Issue), that's strong evidence of a real
 * dependency — without ever hardcoding "issue_number" or "Issue" anywhere.
 */
export function matchScore(
  input: InputField,
  indexed: IndexedField,
  leafFrequency: Map<string, Set<string>>,
  genericThreshold = GENERIC_THRESHOLD,
): number {
  const leafTokens = indexed.tokens;
  if (!leafTokens.every((t) => input.tokens.includes(t))) return 0;
  const remaining = input.tokens.filter((t) => !leafTokens.includes(t));
  if (remaining.length === 0) return isGeneric(indexed.field.name, leafFrequency, genericThreshold) ? 1 : 4;
  return remainingMatchesType(remaining, indexed.typeTokens) ? 5 : 0;
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

/**
 * Canonical form of a (possibly multi-token) field name, for synonym-aware equality --
 * "hook_id" and "webhook_id" both canonicalize to the same key via TOKEN_SYNONYMS. Exported
 * so callers (generate.ts) can precompute each producer's canonicalized required-name set
 * ONCE, the same way IndexedField precomputes leaf tokens once -- isCircularProducer runs
 * once per (required field) x (candidate producer) pair, ~24.9 million times against the
 * real catalog (see the performance notes in CLAUDE.md for matchScore's identical
 * re-tokenization pitfall), so recomputing this inside the function itself on every call
 * would reintroduce that exact cost.
 */
export function canonicalFieldKey(name: string): string {
  return tokenize(name).map(canonicalToken).sort().join("_");
}

/**
 * Precomputes each tool's canonicalized required-field-name set, ready to pass straight into
 * isCircularProducer. Exists as a single shared helper specifically because generate.ts and
 * eval/sample-unresolved.ts each used to build this map inline and independently -- and did,
 * for one commit, silently drift out of sync with each other when isCircularProducer's
 * contract changed (the eval script kept passing raw names after generate.ts switched to
 * canonical ones, quietly regressing its own circularity detection back to exact-string
 * matching). One implementation both callers share can't drift from itself.
 */
export function buildRequiredNamesByTool(requiredByTool: ReadonlyMap<string, InputField[]>): Map<string, Set<string>> {
  const requiredNamesByTool = new Map<string, Set<string>>();
  for (const [slug, inputs] of requiredByTool) {
    requiredNamesByTool.set(slug, new Set(inputs.map((i) => canonicalFieldKey(i.name))));
  }
  return requiredNamesByTool;
}

/**
 * True if the candidate producer itself requires this same field (exactly, or under the
 * TOKEN_SYNONYMS abbreviations above -- "hook_id" and "webhook_id" are the same field for
 * this purpose) as one of its own inputs -- meaning it can't actually be a useful precursor
 * for discovering that value, since you'd need the value already just to call the producer.
 * E.g. GITHUB_CLOSE_ISSUE requires issue_number as input, and its response naturally
 * describes the issue it just closed (so its output has a matching Issue.number field) --
 * but suggesting "call GITHUB_CLOSE_ISSUE to get issue_number" is circular, not a real
 * dependency chain. This pattern turned out to affect 876 of 2101 edges (42%) before being
 * excluded -- almost every "single-entity action" tool (get/update/close/add-to a specific
 * thing) echoes its own identifying inputs back in its response.
 *
 * The synonym-awareness matters for consistency with matchScore's own TOKEN_SYNONYMS use:
 * without it, a hypothetical producer requiring "webhook_id" that also exposes a matching
 * Webhook.id field could be wrongly treated as a genuine (non-circular) producer for some
 * other consumer's "hook_id" -- the same circularity matchScore's hook/webhook synonym
 * would otherwise miss. No tool in the current catalog requires "webhook_id" or "pat_id"
 * literally (checked directly), so this doesn't change today's edge count, but it closes a
 * real latent inconsistency between the two functions rather than leaving it for a future
 * catalog update to surface as a silent false positive.
 *
 * Both arguments must already be canonicalFieldKey()'d by the caller -- this function does
 * no tokenizing itself, so it stays a plain O(1) Set lookup.
 */
export function isCircularProducer(canonicalFieldName: string, producerCanonicalRequiredNames: ReadonlySet<string>): boolean {
  return producerCanonicalRequiredNames.has(canonicalFieldName);
}
