# Evaluation results

Real numbers from hand-labeling `eval/sample.json` (precision) and
`eval/unresolved-sample.json` (miss rate), both against the graph as of commit
`1c847b2` (post the `isCircularProducer` and `singularize("ids")` fixes described
below). Methodology for both is in [`eval/README.md`](README.md); this file is
just the results and what they mean.

## Precision: 60.7% overall

Run: `node --import tsx eval/compute-precision.ts`

```
Tier 5 (leaf + owning-type-name match): 45 sampled, 27 correct, 18 incorrect, 0 ambiguous -> precision 60.0%
Tier 4 (exact leaf-name match, non-generic): 45 sampled, 27 correct, 17 incorrect, 1 ambiguous -> precision 61.4%
Overall: 90 sampled, 54 correct, 35 incorrect, 1 ambiguous -> precision 60.7%
```

Tier 5 (the stronger-evidence tier, requiring both a leaf-name match *and* the
leftover tokens to match the producing field's owning type name) turned out
essentially identical to tier 4 in practice -- the extra type-name check isn't
buying much discriminative power on this catalog. That's a useful finding on
its own: the tiering was designed on the assumption that type-name agreement
would meaningfully raise confidence, and the data doesn't support that
assumption as strongly as expected.

**What actually caused the ~40% of incorrect edges**, by frequency in the
labeled sample:

1. **Scoped identifiers spanning incompatible namespaces** (the single biggest
   cause). The same field name -- `comment_id`, `secret_name`, `reaction_id`,
   `project_number`, `run_id` -- means something different depending on the
   surrounding scope, and the heuristic has no way to see that scope: a commit
   comment's `id` and a gist comment's `id` are different resources entirely; an
   Actions secret and a Codespaces secret occupy separate namespaces even at
   the same org; a workflow run's `run_id` and a check run's `run_id` are
   unrelated ids that happen to share a name.
2. **Generic-sounding fields carrying arbitrary, unrelated content**: `value`,
   `summary`, `url_template` -- these match on name alone with no semantic
   connection (a project-field's custom `value` is not a variable's `value`).
3. **Nullable/coincidental fields**: `performed_via_github_app.client_id` is
   usually null and, even when present, is "whichever app happened to touch
   this unrelated resource," not the specific app you're asking about.
4. **Wrong-level nesting**: two fields named identically (`name`, `id`) but
   several JSON levels apart under structurally unrelated parent types.

**What the heuristic gets right, systematically**: any field whose value is a
*globally valid, context-independent identifier* -- usernames, branch names
within one repo, a repository's own id -- transfers correctly essentially
every time it was sampled. The failure mode is concentrated in identifiers
that are only valid *within a specific sub-resource's namespace*, not in
identifiers generally.

## Miss rate: 19.2% among unresolved fields (not full recall)

Run: `node --import tsx eval/compute-recall.ts`

```
60 of 253 unresolved fields sampled: 10 real_miss, 42 true_negative, 8 ambiguous -> miss rate 19.2%
```

This says: of the required fields the heuristic *already flagged* as having no
producer, about 1 in 5 sampled ones actually do have a real producer somewhere
in the catalog. It does **not** say anything about fields the heuristic
resolved *incorrectly confidently* -- that's what the precision number above
covers, from the other direction. See `eval/README.md` for why a single
combined recall figure isn't defensible here (no ground-truth dependency list
exists to build one against).

The 10 real misses split into two distinct causes:

- **Literal-name mismatches for the same concept** (6 of 10): the producer's
  field and the consumer's required-input name refer to the identical value
  but don't share enough tokens for the subset-match rule to see it --
  `run_attempt` vs `attempt_number`, `hook_id` vs `Webhook.id` (the abbreviation
  "hook" isn't a token of "webhook"), `pat_id`/`pat_ids` vs `Token.id`/`token_id`
  (verified directly against the catalog; the catalog's own field description
  for a sibling action even names the correct producer tool by hand -- GitHub's
  API is more consistent about this than this project's tokenizer is).
- **Generic-threshold collateral damage** (2 of 10, `key` and `login`): both
  are suppressed by the same `GENERIC_THRESHOLD` guard that correctly protects
  against real ambiguity elsewhere (license keys vs GPG keys vs webhook keys
  all called "key"), but for `CodeOfConduct.key` and `SimpleUser.login`
  specifically, the field really is single-concept everywhere it appears, so
  the guard is pure loss in these two cases.

None of the 10 were fixed via a general threshold change. Three were fixed
directly, each narrowly scoped and verified safe across the whole catalog
first rather than guessed: `singularize` treating "ids" as an irregular
plural (below), and a small `TOKEN_SYNONYMS` map added in a follow-up pass
covering `hook` -> `webhook` and `pat` -> `token` (see "Follow-up fix" below).
The remaining generic-threshold cases (`key`/`login`) would need type-aware
scope tracking, not just a synonym table, to fix without reintroducing the
false positives the genericity guard was added to prevent -- still out of
scope, documented here as a known, specific limitation rather than silently
left unexplained.

## A real bug found and fixed during this evaluation

While labeling the miss-rate sample, `GITHUB_REVIEW_PENDING_DEPLOYMENTS_FOR_A_WORKFLOW_RUN`'s
`environment_ids` field stood out: `GITHUB_LIST_ENVIRONMENTS`'s response clearly
has an `Environment.id` field that should have matched it at score 5 (leaf
`id` ⊆ input tokens `{environment, id}`, remainder `{environment}` matches the
owning type name) -- but it didn't match at all.

Root cause: `tokenize("environment_ids")` produced `["environment", "ids"]`,
not `["environment", "id"]`. `singularize()`'s trailing-`s`-strip rule is
guarded by `length > 3` specifically to avoid mangling short words like `id`
or `os` into `i`/`o` -- but `ids` is itself only 3 letters, so the guard
protecting short *singular* words also accidentally protected this *plural*
from ever being singularized. Every `*_ids` field in the catalog
(`environment_ids`, `selected_repository_ids`, ...) was silently unmatchable,
no matter how good the rest of the scoring logic was.

Fixed with a narrow, verified exception (`"ids" -> "id"`) rather than a general
threshold change: checked every 3-letter token ending in "s" that actually
appears anywhere in the catalog first, and confirmed the only others are
`has`, `lfs`, `dns`, `vcs` -- a verb and three acronyms, none of them plural --
so the fix doesn't risk mangling anything else.

**Measured impact**: `dependency_graph.json` edges 1800 -> 1825 (+25),
unresolved required fields 262 -> 253 (-9). `environment_ids` now resolves to
three genuine producers (`GITHUB_CREATE_DEPLOYMENT_PROTECTION_RULE`,
`GITHUB_CREATE_OR_UPDATE_AN_ENVIRONMENT`, `GITHUB_GET_AN_ENVIRONMENT`).

## Follow-up fix: hook/webhook and pat/token synonyms

Two of the ten `real_miss` entries above (`hook_id` vs `Webhook.id`, `pat_id`/
`pat_ids` vs `Token.id`) were the same structural problem as `run_attempt`/
`attempt_number` and `subscribableId`/`node_id`: a genuine, verified producer
existed, but the consumer's field name used a domain abbreviation that shares
no token with the producer's type name. Unlike those two, `hook`/`webhook` and
`pat`/`token` are narrow enough, well-defined enough abbreviations to fix
directly rather than just document: added `TOKEN_SYNONYMS` in
`src/lib/match.ts` (`hook -> webhook`, `pat -> token`), consulted only when
checking the leftover input tokens against a candidate's owning-type-name
tokens for a score-5 match.

**Measured impact**: `dependency_graph.json` edges 1825 -> 1894 (+69),
unresolved required fields 253 -> 229 (-24). Confirmed directly: 57 `hook_id`
edges now present (e.g. `GITHUB_LIST_ORGANIZATION_WEBHOOKS` ->
`GITHUB_DELETE_A_REPOSITORY_WEBHOOK`), and the exact `pat_id`/`pat_ids` edges
this evaluation predicted (`GITHUB_LIST_ORG_RESOURCE_ACCESS_TOKENS` ->
`GITHUB_LIST_TOKEN_ACCESS_REPOSITORIES` / `GITHUB_UPDATE_TOKEN_ORG_ACCESS` /
`GITHUB_UPDATE_RESOURCE_ACCESS_WITH_TOKENS`) are now present too.

This means the 60.7% precision / 19.2% miss-rate numbers above describe the
graph as it stood before this fix (commit `1c847b2`), not the current one.
Both samples were labeled by hand against real edges at that commit and are
kept as-is rather than silently regenerated out from under their own labels
-- re-sampling and fully re-labeling both sides after every fix isn't
sustainable, and the specific, verified findings above (the failure patterns,
not just the percentages) are still the load-bearing part of this evaluation.
The two entries this fix targeted are a confirmed, small net improvement on
top of that baseline, not a reason to distrust it.

## What this evaluation established, overall

Before this round, every check in this project (provenance ratio, the two
README example patterns, unit tests per matching rule, drift-checked
visualization) verified that the generator *runs* correctly. None of it
measured whether the graph it produces is *right*. This evaluation is that
measurement, and the honest summary is:

- **~61% of sampled edges are genuinely correct dependencies** -- a majority,
  but a graph a downstream consumer should treat as a starting point for
  investigation, not a ground-truth dependency list to blindly automate on.
- **The failure mode is concentrated and nameable**: scoped identifiers
  crossing incompatible namespaces, not random noise -- which means it's the
  right thing to warn users about specifically, rather than a vague
  "heuristics aren't perfect" caveat.
- **The heuristic also measurably misses real edges** (~19% of what it flags
  as unresolved), for reasons ranging from a fixable tokenizer bug (found and
  fixed here) to genuine synonym gaps that would need real investment to close
  without regressing precision elsewhere.
