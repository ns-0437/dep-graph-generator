# Precision/recall evaluation

Everything up to this point verified that the generator *runs* correctly (provenance ratio,
edge count, the two README example patterns, unit tests for each matching rule). None of it
measured whether the ~1800 edges it actually produces are *correct* — a graph can pass every
one of those checks and still be full of coincidental, non-useful matches. This directory is
that measurement.

## Precision: is a sampled edge actually a real dependency?

`sample-edges.ts` draws a **stratified, reproducible** random sample from
`dependency_graph.json`:

- Stratified by heuristic match score (tier 5 = leaf name + owning-type-name match, e.g.
  `issue_number` / `Issue.number`; tier 4 = exact leaf-name match on a non-generic field) —
  so precision can be reported per tier instead of one blended number that hides whether the
  weaker-evidence tier is actually weaker in practice.
- Reproducible from a fixed seed (`424242`) recorded in the output file itself, so re-running
  the script produces the identical sample as long as the underlying graph hasn't changed —
  a labeled sample is worthless if you can't tell whether a later re-run is the same data or
  silently different data.
- 45 entries per tier (90 total). Each entry carries everything needed to judge it without
  re-deriving anything by hand: both tools' descriptions and required inputs, the specific
  output field that justified the match (name + owning type + path), and the heuristic score.

Run it: `node --import tsx eval/sample-edges.ts` (regenerates `dependency_graph.json` first
via `npm run generate` if you want it against the current code — the script reads whatever
`dependency_graph.json` already has on disk).

**Labeling** (by hand, in `eval/sample.json`): for each entry, fill in `verdict`:
- `"correct"` — the producer's output really does supply a usable value for the consumer's
  required field. This does NOT require the two tools to form a sensible real-world workflow
  together (e.g. "block a user" then "add them as a collaborator" is a strange sequence of
  actions, but if `username` genuinely flows from one to the other, that's still correct —
  workflow plausibility isn't the question, whether the *data* is genuinely reusable is).
- `"incorrect"` — coincidental or circular. Concretely: the producer needs a DIFFERENT
  identifier space than the consumer even though the field names happen to match (e.g. a
  `run_id` that means "workflow run" on one side and "check run" on the other), or a
  dependency that survived matching but doesn't actually hold up on inspection.
- `"ambiguous"` — genuinely unclear without deeper GitHub API knowledge than the catalog's
  own description gives you. Use sparingly; only when a `correct`/`incorrect` call would be
  a guess, not a judgment.

`compute-precision.ts` reads the labeled file and reports precision per tier (and overall),
treating `ambiguous` as excluded from the denominator by default (reported separately, not
silently counted as wrong).

## Recall (partial): are the "unresolved" fields real misses, or genuinely nothing to find?

Precision alone can't tell you what the generator *missed* — a graph with zero false
positives and huge numbers of false negatives would still look great on precision alone. Full
recall would need an authoritative ground-truth list of every real dependency in the GitHub
API, which doesn't exist in structured form; building one by exhaustively cross-referencing
893 tools against GitHub's actual documented semantics is out of scope here. What's doable
and still honest: sample from the fields the heuristic left **unresolved**, and hand-judge
whether each one is a real miss (a dependency that exists but wasn't found) or a true negative
(the field is genuinely something only the caller can supply — free text, a boolean flag, a
value with no natural producer in this catalog). See `sample-unresolved.ts` /
`unresolved-sample.json` — same reproducible-seed approach, `verdict` is `"real_miss"` /
`"true_negative"` / `"ambiguous"` instead.

This gives a **miss rate among unresolved fields**, not a true recall figure (recall would
need the denominator to include fields the heuristic *did* resolve incorrectly-confidently
too, which precision already covers from the other direction) — the two together give a much
fuller picture than either alone, without overclaiming a number harder to defend.

## Results

See `RESULTS.md` once both samples are labeled — real numbers, not vibes, with the specific
edges that turned out wrong (and why) kept as evidence rather than only reporting a
percentage.
