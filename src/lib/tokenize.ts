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
  // Only a genuine double-s plural ("classes" -> "class") should drop both trailing
  // letters. The old `endsWith("ses")` check also matched any word that legitimately ends
  // in a single "se" -- "releases"/"licenses"/"databases" -- and wrongly dropped the "e" too
  // ("releases" -> "releas" instead of "release"). Confirmed against the real GitHub
  // catalog: GITHUB_LIST_RELEASES tokenized to "releas", which no longer matched the
  // "release" keyword in SERVICE_KEYWORDS, so guessService mis-labeled its service as "list"
  // (the first leftover token) instead of "releases". Restricting to "sses" leaves
  // single-s-plus-se words to fall through to the generic branch below, which correctly
  // strips just the trailing "s".
  //
  // Trade-off, not a fix: words whose SINGULAR already ends in a single "s" and pluralize by
  // adding "es" (e.g. "status" -> "statuses") surface identically to the "se"+"s" pattern
  // above ("...ses") and can't be told apart from the string alone without a dictionary --
  // this restriction now under-strips those ("statuses" -> "statuse" instead of "status"),
  // where the old code happened to get them right. Checked directly: "status" isn't a
  // SERVICE_KEYWORDS entry, and re-running the full heuristic matching pipeline against the
  // real catalog with this change produced the exact same 1889 edges, so this trade-off has
  // no effect on anything the current catalog actually generates -- unlike the "releases"
  // case above, which is independently verified to fix a real, currently-shipped bug.
  if (t.length > 4 && t.endsWith("sses")) return t.slice(0, -2);
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
