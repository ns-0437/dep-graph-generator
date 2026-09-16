# Dep Graph — Composio tool dependency graph generator

Originally built for a Composio/Litmus take-home assessment; kept here as a personal
portfolio copy with its real development history reconstructed into reviewable commits.

## Task

Build a generator that reads a Composio toolkit's tool catalog and outputs a dependency
graph: which tools' outputs can supply which other tools' required inputs (e.g. listing
issues gives you an issue number, which the create-comment tool needs). Must generalize to
any toolkit's catalog, not just GitHub — no hardcoded relations.

Grading is via `npm run selfcheck` style checks:
- **provenance_ratio** = (nodes whose id is an actual catalog slug) / (total nodes) — must
  be `>= 0.8`. Never invent node ids; always take them from the catalog you're given.
- **has-edges gate** — 0 edges fails outright.
- Edge quality/labels also matter per the README.

## File structure

- `README.md` — the original assessment spec (read this over this file if they ever disagree).
- `generator.json` — how a grader builds/runs the generator: `build` = `npm install
  --legacy-peer-deps`, `run` = `node --import tsx src/generate.ts` (catalog path is appended
  as the final CLI arg).
- `github_catalog.json` — the example toolkit catalog to build/test against (893 tools).
  Shape: array of tools, each `{ slug, name, description, inputParameters, outputParameters }`
  where `inputParameters`/`outputParameters` are JSON Schema (with `$defs`/`$ref`).
- `test-fixtures/fake_slack_catalog.json` — a minimal synthetic non-GitHub catalog used to
  verify the generator actually generalizes, not just works on the one catalog it was tuned
  against.
- `src/generate.ts` — **the actual deliverable**, now just orchestration (116 lines): load
  the catalog, build indices, run the matching loop, call the LLM pass, write outputs. The
  actual logic lives in `src/lib/`:
  - `lib/tokenize.ts` — name normalization (tested: `tokenize.test.ts`).
  - `lib/schema.ts` — `$ref`/`$defs` output-schema flattening (tested: `schema.test.ts`).
  - `lib/catalog.ts` — catalog loading, slug/input extraction, service guessing.
  - `lib/match.ts` — the actual matching heuristic: `matchScore`, `isGeneric`,
    `isContextField`, as pure functions (tested: `match.test.ts` — the most important tests
    in the repo, since this is the logic the whole project exists to get right).
  - `lib/llm.ts` — batched LLM disambiguation for fields the heuristic can't resolve.
  - `lib/visualization.ts` — renders `graph.html`.
- `src/types.ts` — shared types (`GraphNode`, `Edge`, `Graph`, `OutField`, `InputField`).
- `src/selfcheck.ts` — provided, unmodified. Runs the generator against
  `github_catalog.json` and prints `{ nodes, edges, provenance_ratio, labeled_edges }`.
  Run via `npm run selfcheck`. **Note:** it only prints `WARNING` text on failure and always
  exits 0 — it was never meant to gate anything, just report numbers for local iteration.
  CI (see below) adds its own real pass/fail gate on top of selfcheck's JSON output instead
  of modifying this file.
- `graph.html` — visualization (nodes/edges you can see), embeds the graph data inline,
  rendered client-side with a hand-rolled canvas force layout. No build/server needed.
- `dependency_graph.json` — generator output. Gitignored (regenerated on demand).
- `index.html` — redirects the bare GitHub Pages URL to `graph.html` (the generator writes
  `graph.html`, not `index.html`, so Pages would 404 at the root without this).
- `.nojekyll` — tells GitHub Pages to serve files as-is, skipping Jekyll processing.
- `.gitattributes` — forces LF line endings regardless of the checkout platform.
- `LICENSE` — MIT.

## Deployment

`graph.html` is published live at https://ns-0437.github.io/dep-graph-generator/ via GitHub
Pages (source: `main` branch, root). Since `graph.html` is fully self-contained (the graph
data is embedded inline, not fetched), redeploying it just means regenerating the file and
pushing — `npm run generate -- github_catalog.json` followed by a commit and push. There's
no CI wiring this up automatically yet; it's a manual step after changing `generate.ts` or
the catalog.

## Output schema (must match exactly)

```json
{
  "nodes": [{ "id": "GITHUB_CREATE_AN_ISSUE", "service": "issues" }],
  "edges": [{ "from": "GITHUB_LIST_REPOSITORY_ISSUES", "to": "GITHUB_CREATE_AN_ISSUE_COMMENT", "label": "issue_number" }]
}
```
`from`/`to` are producer/consumer tool slugs. `label` is the consumer's input field name
that the producer supplies.

## The hard part: input/output field names rarely match literally

Catalog `outputParameters` schemas are deeply nested GitHub API response shapes accessed via
`$ref`/`$defs` (e.g. `data` → `$ref: ListRepositoryIssuesResponse` → `issues[]` → `$ref: Issue`
→ `Issue.number`). Meanwhile the consumer's required input is literally named `issue_number`,
not `number`. Matching `issue_number` to `Issue.number` requires walking the ref graph and
doing semantic/contextual matching (parent type name `Issue` + input name `issue_number`),
not plain string equality. This is why the original README explicitly green-lights
LLM-assisted inference — a pure string-match approach scores near-zero on edges.

Also: many required inputs (`owner`, `repo`, `path`, branch names) are normally supplied
directly by the user/caller rather than produced by another tool. Don't manufacture edges
for these just because some tool happens to output a same-named field — that inflates edge
count with noise and hurts quality.

## LLM access

For runtime LLM calls (used for disambiguating ambiguous field matches), read
`OPENAI_API_KEY` / `OPENAI_BASE_URL` from env — OpenAI-SDK compatible, point `baseURL` at
whatever base URL is provided, use a model like `openai/gpt-4o`. Batch multiple
field-matching questions per call rather than one call per candidate pair (893 tools means
O(n^2) naive pairing is way too expensive).

## Performance

`generate()` against the real catalog: ~20s -> ~1.9s (~10x). Measured, and the fix is
correct, not just fast -- verified identical output before/after (893 nodes, 2101 edges,
both times). The dominant cost was `matchScore` re-running `tokenize()` (a regex replace,
split, and per-token singularize, allocating new arrays) on the *same* field's name and
type on every single comparison, even though a field's tokens never change — the matching
loop calls it roughly (required fields) x (candidate fields) times, which is ~24.9 million
calls against the real catalog. `IndexedField` (`lib/match.ts`) precomputes each field's
tokens once via `indexFields()` instead. The same pattern existed in `looseCandidates`
(`lib/llm.ts`, the LLM-disambiguation candidate lookup) and got the same fix: ~4.5s -> ~0.25s
for that path specifically (only exercised when `OPENAI_API_KEY` is actually set).

Worth knowing if you're debugging apparent slowness on Windows specifically: an initial
`time` measurement showed `real` at ~20s but `user`+`sys` under 0.3s combined, which looks
exactly like I/O-wait — it isn't. Git-Bash's `time` builtin doesn't reliably report CPU
accounting for Windows child processes; isolating the cost with `process.hrtime`/`Date.now`
timestamps inside the actual code (not shell-level `time`) showed it was genuine, CPU-bound
JavaScript execution the whole time.

## Design decisions & known limitations

Current thresholds in `src/generate.ts` (tune here if quality needs adjusting):
- `SCORE_THRESHOLD = 4` — minimum match score to accept an edge. Score 5 = leaf name's
  tokens are a subset of the input's tokens AND the leftover input tokens match the
  producer field's owning type name (e.g. `issue_number` = `number` + `issue`, and `issue`
  matches type `Issue`). Score 4 = leaf name equals the input name exactly and isn't a
  generic/common field. Score 1 = exact match but the field name is too generic to trust
  alone (dropped, below threshold).
- `GENERIC_THRESHOLD = 25` — a leaf field name produced by more than 25 different tools
  (e.g. `id`, `name`, `url`) is "generic": an exact-name match alone isn't accepted for it,
  it needs type-name corroboration (score 5) instead.
- `CONTEXT_FIELD_RATIO = 0.15` plus `CONTEXT_FIELD_MIN_COUNT = 20` — a required input name
  needed by more than 15% of all tools *and* at least 20 tools is treated as caller-supplied
  context, never producer-supplied, and excluded from matching entirely. For the GitHub
  catalog this catches `owner` (49%), `repo` (49%), and `org` (21%) — before this filter the
  generator produced ~4000 edges, nearly half of them `owner`/`repo`/`org` noise from
  coincidental leaf-name matches; after it, ~2100 edges, with both dependency patterns the
  original README calls out (`issue_number`, `pull_number`) still correctly present. The
  absolute floor matters for generalization to small toolkits: `test-fixtures/
  fake_slack_catalog.json` is a 2-tool catalog where a ratio-only filter wrongly treated a
  field required by 1 of 2 tools (50%) as "boilerplate", producing 0 edges — a field needing
  a majority of a handful of tools isn't evidence of anything without a real sample size.
- `MAX_PRODUCERS_PER_FIELD = 3` — measured, not just assumed, how much work this cap
  actually does. The numbers below were measured before the `isCircularProducer` fix (see
  the "bugs found by actually measuring correctness" list): fields with at least one
  candidate had an **average of ~15 producers tied at the best score**, one field had
  **197** tied producers, and the specific worked example below was one of **18** tied
  candidates. Excluding circular producers shrank that pool a lot — the same `issue_number`
  ->`GITHUB_CREATE_AN_ISSUE_COMMENT` case now has only **8** non-circular candidates, because
  most of the original 18 were exactly the "single-entity action echoes its own id back"
  pattern that fix targets. Re-verified directly against the current graph rather than
  trusting the older number: ties are still broken by catalog iteration order (stable sort,
  whichever 3 happen to appear first), still arbitrary but not wrong, and removing the cap
  entirely is still not a real improvement for the same reason as before (a tie at the
  ceiling score means every tied candidate is equally well-evidenced already, so keeping
  all of them is noise amplification, not more signal). Concretely, right now:
  `GITHUB_LIST_REPOSITORY_ISSUES` — the exact tool the original README names as its
  `issue_number` example — is present in the (now smaller) candidate pool but still isn't
  one of the 3 the cap keeps (`GITHUB_CREATE_AN_ISSUE`, `GITHUB_GET_AN_ISSUE_EVENT`,
  `GITHUB_LIST_ISSUE_EVENTS_FOR_A_REPOSITORY` are, by catalog order). `issue_number` edges
  into `GITHUB_CREATE_AN_ISSUE_COMMENT` are still correctly present (the README's own text
  already hedges this: "there could be other ways to get an issue_number too") — just not
  from that specific producer. Recording this, and re-checking it after each fix that
  changes the candidate pool, because it's the kind of thing worth knowing before citing a
  specific edge as a worked example.
- Against `github_catalog.json`: 2025 required fields total, 1073 excluded as context, 230
  unresolved by heuristics and handed to the LLM. 893 nodes (provenance 1.0), 1889 edges
  heuristically, plus whatever the LLM resolves on top when credentials are present. (These
  numbers moved three times since first written -- 2101 -> 1825 -> 1894 -> 1889 -- as real
  correctness bugs were found and fixed; see the "bugs found by actually measuring
  correctness" list below and `eval/RESULTS.md` for what changed and why.)

`flattenOutputs` (in `lib/schema.ts`) handles `$ref`/`$defs`, arrays, and — since a later
pass — `allOf`/`oneOf`/`anyOf` composition, walking each branch as an alternative shape for
the same node rather than a new field. This mattered in practice: `anyOf` appears 174 times
in the real catalog (`allOf` appears 0 times), including cases where a tool's entire `data`
payload is typed as `anyOf: [RealShape, { type: object, additionalProperties: true }]` —
before this was handled, the whole field was treated as one opaque leaf and everything
inside `RealShape` was silently lost. Fixing it recovered real fields (e.g.
`GITHUB_ADD_ORG_RUNNER_LABELS` went from 0 to 4 correctly-typed leaf fields) without
regressing either README example pattern. Nullable-primitive unions (`anyOf: [string,
null]`) are still correctly treated as a leaf under their own property name rather than
wrongly recursed into — see the "recovers... real-world anyOf" and "nullable-primitive"
tests in `schema.test.ts` for both cases side by side.

Known limitations (heuristic can't catch these):
- Input names that don't literally contain the producer field's name at all — e.g. an input
  `base_branch` wanting a `Branch.name` field — score 0 immediately because `name` isn't a
  substring of `base_branch`'s tokens. The LLM disambiguation pass can catch some of these
  (it's given loose token-overlap candidates, not just heuristic-passing ones), but only for
  fields with zero heuristic candidates, and only if any candidate has token overlap at all.
- A handful of single-generic-English-word required fields (e.g. `value`) can still produce
  an occasional false-positive edge if a rare output field happens to share that exact name
  with type-name-independent score 4 — the frequency-based genericity check only catches
  fields common enough to have >25 occurrences across the catalog.

## Testing & CI

- `npm run typecheck` — `tsc` in strict mode, plus `noUncheckedIndexedAccess`,
  `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  and `exactOptionalPropertyTypes`. There was no `tsconfig.json` at all until this was added;
  TypeScript had never actually been type-checked in this project before that (tsx only
  transpiles, it doesn't check types). The last five flags were added in a later pass,
  verified one at a time against real hits rather than turned on as a group and assumed
  clean: `noUnusedLocals` caught a genuinely dead import in `eval/sample-edges.ts`
  (`SCORE_THRESHOLD`, referenced only inside a log string, never in code), and
  `exactOptionalPropertyTypes` caught `generate.ts` explicitly assigning `undefined` to
  `GraphNode.service` (an optional property) instead of omitting the key -- fixed without
  changing runtime behavior (regenerated `dependency_graph.json`/`graph.html` and diffed
  against the pre-fix output: byte-identical, since `JSON.stringify` already drops
  `undefined`-valued keys either way).
- `npm test` — 115 tests via Node's built-in test runner (`node --test`, no extra framework
  dependency): unit tests for every `lib/*` module and every `eval/*`/`eval/lib/*` script,
  end-to-end tests calling the real exported `generate()` (against the synthetic Slack
  catalog, the actual GitHub catalog, and — via an injected fake LLM client — cases that
  exercise LLM-resolved edges and duplicate-field dedup specifically), and CLI subprocess
  tests that spawn the real entrypoint and check the files it writes. `generate.ts` had to be
  made safely importable first — `main()` used to run unconditionally at module scope, so
  importing the file anywhere immediately tried to read argv and write output files as a
  side effect; it's now guarded behind an entrypoint check. Includes real end-to-end smoke
  tests for `sample-edges.ts`/`sample-unresolved.ts` themselves (running the actual scripts
  as subprocesses against a temp output path, never touching the real hand-labeled files) --
  added specifically because these two scripts had *no* automated coverage at all before, and
  silently drifted out of sync with `generate.ts`'s own logic for a full commit as a direct
  result (see the bug list below). One of these tests is a parity check that runs both
  `sample-unresolved.ts` and `generate.ts` and asserts their unresolved-field counts agree --
  the exact invariant that broke.
- `npm run coverage` — via `c8` (switched from Node's `--experimental-test-coverage`, see
  below), gated with `.c8rc.json` (`--check-coverage` at 100% across the board — lines,
  functions, statements, *and* branches): **100% coverage on every metric, every file, no
  exceptions** (the branch number climbed from an earlier 93.58% by deliberately reading c8's
  own uncovered-line report and writing a test for each real gap it named, rather than
  assuming high line coverage meant the logic was actually exercised). What were previously a
  handful of `c8 ignore`-marked defensive fallbacks (`generate.ts`'s and
  `eval/sample-unresolved.ts`'s `requiredNamesByTool.get(producerSlug) ?? new Set()`,
  `schema.ts`'s `path ? ... : key`) turned out, on closer inspection, to be *provably*
  unreachable rather than just unreachable in practice — each one guarded a case that the
  surrounding code's own construction makes structurally impossible, not merely unlikely — so
  they were removed outright (a `!` non-null assertion in the two `Map.get` cases, the dead
  branch deleted entirely in `schema.ts`) instead of continuing to carry ignore comments for
  code that could never run under any input. The genuinely-hard-to-reach cases in the eval
  sampling scripts (e.g. a mismatch between `dependency_graph.json` and `github_catalog.json`,
  or a catalog tool with no `description` — checked directly: 0 of 893 have one) are still
  `c8 ignore`-marked with an explanation, since constructing them would need independently
  injectable inputs those scripts don't have; the difference is those really do depend on
  external data being a certain way, not on this codebase's own internal invariants.
  - **A real blind spot in the 100% claim, found by checking rather than trusting it**: by
    default, c8 (like most coverage tools) only reports on files that were actually imported
    during the test run -- a source file nothing ever requires is invisible to the report
    entirely, not shown as 0%, just absent, so "100% coverage" could quietly mean "100% of
    the files something happened to touch." Verified this wasn't hiding anything by adding
    `all: true` with an explicit `include` (`src/**/*.ts`, `eval/**/*.ts`): it surfaced
    exactly one real gap, `src/selfcheck.ts` at a flat 0%, invisible in every previous
    coverage run this whole project. Not a bug to fix, though -- `selfcheck.ts` is provided
    and deliberately left unmodified (see the file-structure section above), so it isn't a
    fair target for this project's own coverage gate. Added it and `src/types.ts`
    (interfaces only, no executable code to cover) to `.c8rc.json`'s `exclude` alongside
    `all: true`, so the 100% figure now means what it claims — every file that's actually
    this project's own code and could meaningfully be covered, is — rather than being
    silently narrowed to whatever the test suite happened to import.
  - **Correcting an earlier claim in this file's history**: an earlier version of this
    section said generate.ts's edge-emission loop showing as uncovered was "a
    tsx-transform/sourcemap attribution quirk... not an actual gap." That specific claim was
    wrong on the details, caught by cross-checking Node's coverage flag against `c8` on the
    same run: they reported *completely different* uncovered lines for the same file. `c8`
    was right — it pointed at `main()`/the CLI entrypoint, which genuinely had never been
    exercised by anything (closed by adding CLI subprocess tests and a fake-client test for
    the LLM-merge path). Node's own `--experimental-test-coverage` really does have a real
    line-attribution problem in this codebase (confirmed, not assumed) — which is *why*
    `npm run coverage` now uses `c8` instead. The honest version: don't trust either coverage
    tool's specific line numbers without cross-checking when something looks surprising;
    trust that a *stable, mature* tool (c8) is right by default, but verify even that against
    what the code actually does before writing docs around it.
- `npm run verify` — chains typecheck + test + selfcheck; the one command to run before
  trusting a change.
- `.github/workflows/ci.yml` — runs typecheck, tests, and selfcheck on every push/PR. Adds
  its own pass/fail gate on selfcheck's JSON output (provenance_ratio >= 0.8, edges > 0)
  since selfcheck.ts itself always exits 0.

Before this pass, none of the above existed: zero automated tests, no type-checking
infrastructure, no CI. "Testing" meant reading `npm run selfcheck`'s console output by eye.

**Real bugs the tests caught, not hypothetical ones:**
- `guessService` pluralized every keyword token independently, turning `pull_request` into
  `pulls_requests` instead of `pull_requests` — present since the very first version, never
  caught by eyeballing sample output, affected 41 real nodes in the GitHub catalog. Caught by
  a test asserting the literal expected string.
- `loadCatalog` silently returned `[]` for a malformed catalog (an object with no
  `tools`/`items` array) — indistinguishable from a catalog that legitimately has zero
  tools, so a bad input would fail the has-edges gate with no indication why. Now throws a
  clear error naming the path and the expected shape.
- `renderVisualizationHtml` embedded `JSON.stringify(graph)` directly into a `<script>` tag.
  `JSON.stringify` does not escape `</script>` — a node id, service, or edge label
  containing that substring (case-insensitively, per how the HTML parser's script-data
  state actually matches close tags) would break out of the tag and inject arbitrary
  HTML/script. The current catalog doesn't trigger this (checked directly), but the
  generator explicitly promises to generalize to any toolkit's catalog. Fixed by escaping
  every `<` in the embedded JSON before writing it.
- A second, more serious vulnerability in the same file, found and fixed later: the node
  tooltip was built via string-concatenated `innerHTML` using `hit.id`/`hit.service`/each
  edge's `label`/`from` — all catalog-derived — with no escaping at all. Unlike the bug
  above, `escapeForInlineScript` doesn't cover this: it protects the JSON-embedding
  boundary, but by the time these values reach the tooltip code they're already parsed back
  to their original form. **Confirmed real and exploitable, not theoretical**, by actually
  running it: generated a graph from a catalog with a tool slug shaped like an `<img>` tag
  with an `onerror` handler, hovered the node in a real browser, and watched
  `document.title`/`document.body.style.background` actually change — arbitrary script
  execution from hovering a maliciously-named node. Fixed with an `escapeHtml()` helper
  added to the generated page's own script (this runs in the browser at tooltip-render
  time, not in Node at generation time), wrapping all four values before the `innerHTML`
  assignment; re-ran the identical exploit afterward and confirmed it now renders as inert,
  visibly-escaped text.
- `flattenOutputs` only merged `allOf`, not `oneOf`/`anyOf` — see the design-decisions
  section above for the measured impact (real fields silently lost for tools whose response
  shape used `anyOf`, which the actual catalog does 174 times).
- `graph.html` froze/appeared blank for 1+ second on every load with no loading indicator —
  measured directly (`domContentLoaded` at 1103ms despite the file loading in 41ms), not
  assumed from reading the code. Fixed with a visible "Laying out the graph..." message and
  deferred layout computation. Worth noting for anyone touching this file: the first attempt
  used a double `requestAnimationFrame`, the idiomatic choice — but while testing it, `rAF`
  callbacks never fired at all in this session's browser automation tool (confirmed via
  explicit instrumentation), even though `document.visibilityState` reported `"visible"`.
  Switched to `setTimeout(fn, 0)`, which is spec-guaranteed to defer regardless of embedding
  context, and verified it actually resolves (not just theoretically should). A CSS bug
  surfaced in the same pass too: the loading overlay was double-offset from being nested
  inside an already-offset container.
- `graph.html`'s canvas rendered blurry on any HiDPI/retina display (`devicePixelRatio > 1`)
  — the drawing-buffer resolution (`canvas.width`/`height`) was set to exactly the CSS
  display size, with no DPR scaling, so the browser had to upscale the bitmap. Confirmed
  directly in-browser (backing buffer matched CSS size 1:1 under a real `devicePixelRatio:
  1.5` session) before fixing, not assumed from reading the code. Fixed by scaling the
  buffer by `devicePixelRatio` and applying a matching `ctx.setTransform`, which required
  separating the buffer's pixel count from the logical size the mouse-coordinate mapping
  reasons in (`cssWidth`/`cssHeight`) — re-verified click/hover accuracy under a mocked
  `devicePixelRatio: 2` afterward, not just that the buffer resized.
- `graph.html`'s `#legend` overlay (the "Drag background to pan..." hint box) had no
  `pointer-events: none`, unlike `#tooltip` which already correctly had it. A
  `position:fixed` element paints above in-flow content regardless of z-index, so the
  legend silently swallowed drag/click events meant for the canvas underneath whenever a
  gesture started over it — confirmed interactively: a pan drag starting on the legend
  produced zero movement, the identical drag a few pixels outside it worked. Fixed with the
  same `pointer-events: none` treatment `#tooltip` already had.
- (Checked, not a bug, but verified rather than assumed: `npm audit` reports 0
  vulnerabilities in the current dependency tree.)
- (Checked, not a bug: a security audit for prototype pollution, prompted by finding the
  tooltip XSS above. `JSON.parse` treats `"__proto__"` as a normal own property, not the
  prototype setter — verified directly, not assumed — and every place a catalog-derived
  string is used as a plain-object key (only one: `schema.ts`'s `defs[refName]`) is a read,
  never a write; grepped the whole `src`/`eval` tree for dynamic bracket-notation
  *assignment* into a plain object, the actual pollution vector, and found none — only
  `Map.set`, which is immune by construction. Locked in with a real regression test: a
  catalog with a `$ref` pointing at a `$defs` entry literally named `__proto__` and fields
  named `constructor`, run through the full `generate()` pipeline, confirmed
  `Object.prototype` gains zero new properties. Built via `JSON.parse` on real JSON text,
  not a JS object literal — a literal `{ __proto__: ... }` in source is special-cased by
  the language to set the actual prototype, which would test something different from what
  `loadCatalog()` actually does.)
- Defense-in-depth added on top of the tooltip XSS fix above, not a separately-discovered
  bug: `graph.html` shipped with no Content-Security-Policy at all, so the `escapeHtml()`
  fix was the *only* thing standing between a future regression and arbitrary script
  execution. Added a `<meta http-equiv="Content-Security-Policy">` tag restricting
  `script-src` to a SHA-256 hash of the exact embedded script (no `'unsafe-inline'`), plus
  `object-src 'none'` and `base-uri 'none'`. The script's content differs per graph (it
  inlines that graph's JSON data), so the hash is computed at render time via
  `crypto.createHash` over the exact string being shipped — a hardcoded hash would go stale
  the moment the catalog changed and silently block the page's own script. **Verified this
  actually blocks something, not just that the header is present**: with the CSP live,
  injected `'<img src=x onerror="...">'` directly into the tooltip's `innerHTML` via the
  browser console (bypassing `escapeHtml()` entirely, simulating a hypothetical future
  regression) — the browser blocked it and logged an explicit CSP violation, where before
  adding the CSP the identical injection executed. Also re-ran the full interaction surface
  (hover/tooltip, pan, click-to-highlight, wheel-zoom, search filtering, the "show isolated"
  checkbox's async re-layout) under the CSP and confirmed zero violations, so the policy
  isn't accidentally breaking the page's own legitimate inline script.
- The heuristic matching loop excludes any producer that itself requires the same field it
  would supply (`isCircularProducer`, see that function's own docs for the 876/2101-edge
  measured impact) — but `looseCandidates`/`llmDisambiguate` never received
  `requiredNamesByTool` and only excluded the exact consumer slug, so a field the heuristic
  couldn't resolve *because every real candidate was circular* got forwarded to the LLM with
  those same circular producers still in its candidate list, undefended. The LLM reasons
  purely on field/type-name semantics with no way to know a candidate is circular, and has
  every reason to pick the semantically obvious (but circular) one right back. **Measured
  against the real GitHub catalog, not assumed**: of the 230 fields sent to the LLM, 87
  (37.8%) had at least one circular producer among their top-5 loose candidates, and for 32
  (13.9%) the single top-ranked candidate was circular — e.g. the top candidate for
  `GITHUB_DELETE_A_PACKAGE_VERSION_FOR_THE_AUTHENTICATED_USER`'s `package_type` input was
  `GITHUB_DELETE_PACKAGE`'s own `package_type` output, but `GITHUB_DELETE_PACKAGE` itself
  requires `package_type` as input — the exact pattern `isCircularProducer` exists to catch.
  Fixed by threading the already-computed `requiredNamesByTool` through both functions,
  filtering with the same check the heuristic loop uses. No effect on this repo's checked-in
  `graph.html` (no `OPENAI_API_KEY` is configured here, so the LLM path is a documented
  no-op), but closes the gap for anyone who runs generation with credentials set.
- `singularize()` treated any word ending in `"ses"` as a double-s plural (`"classes"` ->
  `"class"`) and dropped both trailing letters — correct for words whose singular already
  ends in `"ss"`, but it also caught words whose singular legitimately ends in a single
  `"se"` — `"releases"`, `"licenses"`, `"databases"` — dropping the `"e"` too (`"releases"`
  -> `"releas"` instead of `"release"`). **Confirmed live in the shipped output, not just
  constructed examples**: `GITHUB_LIST_RELEASES` tokenized to `"releas"`, which no longer
  matched the `"release"` keyword in `SERVICE_KEYWORDS`, so `guessService` mis-labeled its
  service as `"list"` (the first leftover token) instead of `"releases"` — this was live in
  `dependency_graph.json`/`graph.html` before the fix. Fixed by restricting the double-strip
  rule to a genuine double-s pattern (`"sses"`), leaving single-s-plus-se words to fall
  through to the generic "strip trailing s" branch. Documented trade-off: words whose
  singular already ends in a single `"s"` and pluralize by adding `"es"` (e.g. `"status"` ->
  `"statuses"`) surface identically to the `"se"+"s"` pattern and can't be told apart from
  the string alone — `"statuses"` now singularizes to `"statuse"` instead of the
  previously-correct `"status"`. Checked directly that this has zero visible effect on
  anything the current catalog generates: `"status"` isn't a `SERVICE_KEYWORDS` entry, and
  re-running the full heuristic matching pipeline with the fix applied produced the exact
  same 1889 edges as before.
- `guessService`'s pluralization rule was a bare "add an `s` unless it already ends in `s`",
  which is wrong for any `SERVICE_KEYWORDS` entry ending in a consonant+`"y"` — `"repository"`
  is the only one, but it's a very common one. **Confirmed against the real shipped
  `dependency_graph.json`**: 161 of 893 nodes (every `*_REPOSITORY*` tool) carried
  `service: "repositorys"` — 4x the blast radius of the earlier `pulls_requests` bug (41
  nodes), which had a different root cause (pluralizing every token independently instead of
  just the last one). Fixed with a small `pluralize()` helper applying the standard rule: a
  trailing consonant+`"y"` becomes `"ies"`, a trailing vowel+`"y"` just gets an `"s"`, a word
  already ending in `"s"` is left alone. Re-ran the generator afterward and confirmed the
  edge count is unaffected (1889, unchanged) — this only touches node display labels.
- `slugOf` falls back to `tool.function?.name` for the OpenAI function-calling tool shape
  (`{ type: "function", function: { name, parameters } }` — the shape Composio's own SDK can
  export a catalog in), but `requiredInputsOf` only ever read `tool.inputParameters`. A
  catalog fully in that shape got correctly-identified, correctly-labeled nodes and silently
  **zero** required fields, hence zero edges, with no error. **Confirmed directly**: built a
  two-tool catalog in this shape and ran it through `generate()` — logged
  `"required fields: 0 total"`. Fixed by falling back to `tool.function?.parameters` (both
  are plain JSON Schema objects with the same `properties`/`required` shape, so this is a
  direct extension, not a guess). `flattenOutputs` isn't touched: the OpenAI function-calling
  spec has no analogous output-schema field to fall back to.
- `toolBySlug` (and every map keyed by slug built from it) can only hold one definition per
  slug — a plain `Map.set` on a repeated key silently keeps the last one — but the node list
  was built by pushing once per raw tool entry with no uniqueness check. A catalog with a
  duplicate slug produced a graph with two same-id nodes, while every field of the
  earlier-seen definition for that slug was silently discarded from matching entirely, with
  no error. **Confirmed directly**: two `GITHUB_CREATE_AN_ISSUE` entries (first requiring
  real inputs, second only `"owner"`) produced a graph with a vanished first definition.
  Fixed with the same "fail loudly on ambiguous input" philosophy `loadCatalog` already uses
  for a malformed shape: `generate()` now throws naming the duplicated slug. The real GitHub
  catalog has zero duplicate slugs (checked directly), so this doesn't change anything it
  currently generates.
- (Dev-tooling only, not the generator itself:) `eval/lib/safe-write.ts`'s
  `assertSafeToOverwrite` only guarded `JSON.parse` against corrupt/unreadable JSON — a file
  that parses fine but whose `entries` field isn't an array (e.g. hand-edited into an object)
  threw an unhandled `TypeError` from calling `.filter` on it, crashing the exact safety net
  meant to protect hand-labeled eval data from an accidental overwrite. Confirmed directly
  before fixing. Fixed by validating `Array.isArray(existing.entries)` up front and treating
  a non-array the same as the already-handled corrupt-JSON case.
- `llmDisambiguate`'s JSON-extraction regex (`/\[[\s\S]*\]/`) was greedy — it matched from the
  FIRST `"["` to the LAST `"]"` anywhere in the model's response. A model appending any
  trailing remark containing a `"]"` (e.g. referencing `candidate_producers[0]`, a completely
  normal thing to do even when told to respond with ONLY the array) got that prose swallowed
  into the "JSON", `JSON.parse` threw, and the whole batch of up to 25 items was silently
  dropped even though the model's actual answer was fully correct. **Confirmed directly**: a
  response of `` [{"idx":0,"ci":0}]\n\nNote: candidate_producers[0] was the best match here. ``
  failed to parse and dropped a correct edge. Replaced with a bracket-balance scan
  (`extractJsonArray`) that finds the first `"["` and walks forward tracking nesting depth and
  string state until the matching `"]"`, so trailing prose (or a bracket/backslash inside a
  quoted string value) can't be mistaken for part of the array.
- `isEffectivelyContainer` in `schema.ts` was a separate, unmemoized recursion from `walk()`'s
  own cycle-guarded traversal — every property value got a fresh call with no memory of work
  already done for a sibling property (or a different `anyOf` branch) resolving to the same
  type. For polymorphic types that branch into several other types that branch again (a
  realistic API-response shape, not a pathological one), the same resolved type got
  re-explored from scratch at every branch and depth level — genuine exponential time in the
  branching factor. **Confirmed directly**: a synthetic schema of mutually-referencing types
  (branching factor 4, 6 chain types) took ~9.8s to flatten a single tool's output schema;
  branching factor 6 on the same shape didn't finish in 60 seconds. `flattenOutputs` is
  `generate()`'s hot path, called once per tool. Fixed by caching each resolved node's
  containment result in a `Map` keyed by the resolved node object itself, so every `$ref`
  pointing at the same `$defs` entry shares one cache entry. Both previously-slow cases now
  complete in under a millisecond; re-ran the full generator against the real GitHub catalog
  afterward and confirmed identical output (1889 edges, unchanged) — this is a pure
  performance fix.
- `nodeAt` in the generated visualization compared world-space distance against a fixed
  `"10"` threshold meant to be a screen-pixel hit tolerance (matching the largest rendered
  node radius, which is always a fixed 3–10 screen pixels regardless of zoom), but never
  scaled that comparison by `view.scale`. **Confirmed directly**: at the min zoom bound
  (0.05) the effective screen-space hit radius was 0.5px (a click square on a visibly
  rendered node missed); at the max zoom bound (6) it was 60px (a click 50px away from a node
  still registered as a hit). Fixed by multiplying the world-space distance by `view.scale`
  before comparing, converting the comparison back into screen-space. Verified by extracting
  the real `nodeAt` function from the rendered script and running it with a mocked
  `view`/`toWorld` across scale 0.05, 1, and 6; also loaded the regenerated `graph.html` in a
  real browser afterward with no console errors.
- Toggling "show isolated" calls `buildDataset`/`layout`/`draw`, which replaces the `nodes`
  array entirely (revealing or hiding isolated nodes) and correctly re-highlights matches on
  the canvas — but only the search box's own `"input"` handler recomputed the printed
  `"N match(es)"` count, so it stayed stale relative to the new node set. **Confirmed live in
  a browser**: searching a term matching only a currently-hidden isolated node
  (`GITHUB_ABORT_REPOSITORY_MIGRATION`) correctly showed `"0 match(es)"`; checking "show
  isolated" revealed and highlighted that node on the canvas, but the count stayed at
  `"0 match(es)"` before this fix, updating to `"1 match(es)"` after. Fixed by factoring the
  match-count computation into a shared `updateMatchCount()` function called from both
  handlers.
- `matchScore`'s `leafTokens.every(...)` is vacuously `true` when `leafTokens` is `[]` —
  `tokenize()` produces `[]` for any property name made only of separator characters (e.g.
  `"___"`). Without a guard, that vacuous truth skipped the subset check entirely, degrading
  the match to "does the leaf's TYPE name alone satisfy every input token," ignoring the
  field's own name. **Confirmed directly**: a field named `"___"` on type `IssueNumberInfo`
  scored the maximum (5) against an `"issue_number"` input, while a normally-named `"value"`
  field on the identical type correctly scored 0. Not present in the real catalog today
  (checked: 0 of 26161 real output leaf field names tokenize to `[]`), but the project
  explicitly promises to generalize to any toolkit's catalog. Fixed with an explicit early
  return for an empty `leafTokens`.
- `requiredInputsOf`'s `required` field is typed as `string[]`, but the source is untrusted
  JSON — a hand-edited or malformed catalog can put a non-array value there with no runtime
  check catching it, and calling `.map` on it threw an opaque `"required.map is not a
  function"` TypeError with no indication which tool caused it. **Confirmed directly** for
  both a string and an object value. Fixed with the same "fail loudly with a clear,
  actionable message" philosophy `loadCatalog` already uses for a malformed catalog shape:
  throws naming the offending tool's slug and what was actually found.
- `eval/sample-edges.ts` and `eval/sample-unresolved.ts` each had their own `toolSummary()`
  helper computing `requiredInputs` as `t.inputParameters?.required ?? []` — a copy of
  `requiredInputsOf`'s logic from *before* it gained the `tool.function?.parameters` fallback
  above. For a tool in that shape, this display-only summary — shown to a human labeler
  reviewing why an edge was or wasn't produced — would show `requiredInputs: []` even though
  the tool genuinely requires fields, potentially misleading the labeling verdict. **Confirmed
  directly**: `requiredInputsOf` on a function-calling-shaped tool correctly found `["repo",
  "title"]`, while the old expression evaluated to `[]` for the identical tool. Fixed by
  having both `toolSummary()` functions call `requiredInputsOf(t)` directly instead of
  duplicating its logic, so this display-only summary can't drift out of sync with the actual
  matching logic again. No effect on the real GitHub catalog (it's in the documented shape,
  not the function-calling one).
- (Checked, deliberately not acted on: `npm outdated` shows both `openai` and `typescript`
  have a major version available beyond what the `^` ranges in package.json allow — current
  major versions are patched and current within themselves. Bumping either is a real,
  separate task (major versions can carry breaking API changes — the OpenAI SDK's call
  shape, or new strict-mode TS errors) that deserves its own dedicated testing pass, not an
  incidental version bump folded into unrelated work.)
- (Checked, deliberately not acted on: `--legacy-peer-deps` in `generator.json`'s `build`
  step and CI's install step may no longer be load-bearing — a plain `npm install` in a
  clean checkout (fresh `node_modules`, no lockfile) succeeded with 0 conflicts and 0
  vulnerabilities, verified directly rather than assumed. Not removing it: `generator.json`
  is the original assessment's fixed build/run contract, kept verbatim on purpose (see the
  file-structure section above), so it isn't touched even for a plausible simplification;
  keeping CI's install step matching it avoids the two silently diverging over time.)

**Bugs found by actually measuring correctness, not just that the generator runs** (see
[`eval/RESULTS.md`](eval/RESULTS.md) for the full precision/recall evaluation this came from):
- 42% of all edges (876/2101) were circular: a candidate producer that itself required the
  exact field it claimed to supply (e.g. `GITHUB_CLOSE_ISSUE` requires `issue_number` and
  its response naturally echoes the issue it just closed) — you'd need the value already to
  call the "producer". Fixed via `isCircularProducer` in `src/lib/match.ts`; edges dropped
  2101 -> 1800.
- `singularize()` never pluralized `"ids"` (the trailing-`s`-strip rule's `length > 3` guard,
  meant to protect short singular words like `id`/`os`, also protected this 3-letter plural),
  making every `*_ids` field silently unmatchable regardless of how good the rest of the
  scoring was. Fixed with a narrow, catalog-verified exception; edges 1800 -> 1825.
- Hand-labeling 90 sampled edges found precision is 60.7%, not the ~100% "it runs and
  produces plausible-looking edges" impression the earlier checks gave — dominated by scoped
  identifiers (`comment_id`, `secret_name`, `run_id`, ...) that mean different things in
  different sub-resource namespaces but share a literal field name.
- Hand-labeling 60 sampled unresolved fields found 2 of 10 real misses were the same domain
  abbreviation not sharing a token with its own type name (`hook_id` vs `Webhook.id`, `pat_id`
  vs `Token.id`). Fixed with a small `TOKEN_SYNONYMS` map in `src/lib/match.ts`; edges
  1825 -> 1894. See `eval/RESULTS.md`'s "Follow-up fix" section.
- Making the TOKEN_SYNONYMS fix apply consistently to `isCircularProducer` (not just
  `matchScore`) surfaced a second, unrelated, bigger gap: `isCircularProducer`'s exact-string
  comparison missed producers and consumers naming the identical field in different
  conventions -- this catalog mixes camelCase (`migrationId`, `pullRequestId`) and snake_case
  (`migration_id`, `pull_request_id`) for the same concepts across its GraphQL- vs
  REST-flavored tools. 8 genuinely circular edges had been silently let through; fixing it
  freed 3 previously-blocked genuine producers into the newly-open
  `MAX_PRODUCERS_PER_FIELD` slots. Net edges 1894 -> 1889. Caught (and fixed) a real
  performance regression while building this fix, too: canonicalizing inside
  `isCircularProducer` on every call — it runs ~24.9 million times — regressed `generate()`
  from ~1.9s to ~5.7s; precomputing each producer's canonicalized keys once (same discipline
  as `IndexedField`) brought it back to ~2.2-2.8s.
- (Checked after finding the naming-convention circularity bug above, in case the same
  problem existed elsewhere: `isContextField`/`buildInputFrequency` count required-field
  *names* by exact raw string too, not tokens. Verified directly against the real catalog
  rather than assumed clean — every context field this filter actually relies on (`owner`,
  `repo`, `org`, `issue_number`, `pull_number`) is spelled one way, consistently, everywhere
  it appears. The one real split found catalog-wide (`project_id`: 10 tools, `projectId`: 2)
  sums to 12, still under `CONTEXT_FIELD_MIN_COUNT` (20) either combined or apart, so it
  can't currently flip a context-detection decision. `matchScore` itself was never at risk
  here regardless — it already tokenizes both sides of every comparison via
  `IndexedField`/`InputField`, so `project_id` vs `projectId` as a *matching* target already
  resolves identically either way. Not fixed, because there's currently nothing to fix.)
- Two more real incidents from actually building and using the eval tooling itself (not the
  generator), both in `eval/`:
  - Re-running `sample-edges.ts`/`sample-unresolved.ts` directly (to sanity-check an
    unrelated refactor's output) silently overwrote the hand-labeled
    `eval/sample.json`/`eval/unresolved-sample.json` with fresh, unlabeled samples — caught
    only because it happened to be noticed before the overwrite got committed. Fixed with
    `eval/lib/safe-write.ts`'s `assertSafeToOverwrite`, now called at the top of both
    scripts: refuses (exit 1) if the target already has any hand-labeled entries, unless
    `--force` is passed.
  - Separately, `sample-unresolved.ts` was never updated when `isCircularProducer`'s
    contract changed to expect pre-canonicalized keys — it kept passing raw field names,
    silently regressing its own circularity detection back to exact-string matching (losing
    both the hook/webhook synonym and the camelCase/snake_case fix) while `generate.ts`
    itself stayed correct. Caught by the exact kind of drift the script's own docstring
    warns about: it reported 229 unresolved fields against a catalog where `generate.ts`
    reports 230. Fixed to canonicalize the same way `generate.ts` does.
  - A real concurrency bug, found twice because the first fix didn't generalize the lesson:
    `generate.ts` always writes to `dependency_graph.json`/`graph.html` with no output-path
    override, and `generate.test.ts`'s CLI subprocess test reads-before/writes/restores-after
    that exact shared path around its own test. Node's test runner runs different test
    *files* concurrently by default, so any *other* test file that spawns `node
    src/generate.ts` as a subprocess (rather than calling the exported `generate()` function
    in-process) races that read-modify-restore cycle — a plausible explanation for an
    earlier, never-explained, non-reproducible single test flake from a previous round. Found
    and fixed in `sample-edges.test.ts` first (a fixture-generation `before()` hook); the
    identical mistake was then found separately in `sample-unresolved.test.ts`'s own parity
    check, missed by the first fix because it was in a different file. Both now call
    `generate()` in-process instead. `generate.ts`'s own `OUT_PATH` constant now carries a
    comment warning against this specific mistake, so a third instance doesn't need
    rediscovering the same way.

## Commands

```bash
npm install --legacy-peer-deps   # build step (per generator.json)
npm run typecheck                # strict TypeScript check
npm test                         # unit + integration tests
npm run coverage                 # tests with coverage report
npm run verify                   # typecheck + test + selfcheck, chained
npm run selfcheck                # run generator on github_catalog.json + report metrics
npm run generate -- <catalog>    # run generator directly on an arbitrary catalog path
```

## Working rules

- Commit frequently, one logical change per commit.
- Keep `src/generate.ts` and `src/lib/*` catalog-agnostic: no GitHub-specific hardcoding of
  slugs or fields, even though `github_catalog.json` is the primary catalog on hand to test
  with — verify against `test-fixtures/fake_slack_catalog.json` too.
- Run `npm run typecheck && npm test && npm run selfcheck` after changes to `src/` to catch
  regressions before they reach CI.
- **One-time setup**: run `git config core.hooksPath .githooks` to enable the pre-commit
  hook, which type-checks *and runs the full coverage-gated test suite* (`npm run coverage`,
  not just `npm test`) against the staged snapshot (not the working tree) before allowing a
  commit. This exists because of a real incident: a refactor's `git add` listed two of three
  changed files, which typechecked fine locally (the third file's changes were sitting right
  there on disk) but broke CI once pushed, since the committed snapshot was incomplete. The
  hook uses `git stash --keep-index` specifically so it checks what would actually be
  committed, not whatever else happens to be in the working tree — verified directly by
  reconstructing that exact scenario and confirming the hook fails it. The test step was
  added later, verified the same way (staged a deliberately failing test, confirmed the hook
  rejects it, then removed the scratch test before committing the change for real) — and
  once coverage was gated at 100% project-wide, upgraded from `npm test` to `npm run
  coverage` so a coverage-dropping change fails locally before the commit even happens, not
  only on the CI round-trip; verified the same way again (a deliberately uncovered function,
  confirmed the hook catches the drop, then removed it).
