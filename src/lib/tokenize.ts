/**
 * Words the length>3 guard below would otherwise leave alone, but that are genuinely
 * plural. Found via eval/sample-unresolved.ts: "environment_ids" tokenizes to
 * ["environment", "ids"] (not "id"), so it can never match an output field named "id" no
 * matter how good the rest of the scoring logic is -- an entire class of `*_ids` fields
 * (environment_ids, selected_repository_ids, ...) was silently unmatchable. Checked across
 * the whole catalog before adding this: the only other 3-letter tokens ending in "s" that
 * appear anywhere are "has", "lfs", "dns", "vcs" -- all non-plural (a verb and three
 * acronyms) -- so this is a targeted exception, not a general threshold change that would
 * mangle those into "ha"/"lf"/"dn"/"vc".
 */
const IRREGULAR_PLURALS: Readonly<Record<string, string>> = { ids: "id" };

export function singularize(t: string): string {
  if (IRREGULAR_PLURALS[t]) return IRREGULAR_PLURALS[t];
  if (t.length > 3 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("ses")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** camelCase / snake_case -> lowercase, singularized tokens, e.g. "issue_number" -> ["issue","number"]. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((t) => singularize(t.toLowerCase()));
}
