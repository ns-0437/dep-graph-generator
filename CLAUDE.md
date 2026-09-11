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
- Against `github_catalog.json`: 2025 required fields total, 1073 excluded as context, 227
  unresolved by heuristics and handed to the LLM. 893 nodes (provenance 1.0), ~2100 edges
  heuristically, plus whatever the LLM resolves on top when credentials are present.

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

- `npm run typecheck` — `tsc` in strict mode (+ `noUncheckedIndexedAccess`). There was no
  `tsconfig.json` at all until this was added; TypeScript had never actually been
  type-checked in this project before that (tsx only transpiles, it doesn't check types).
- `npm test` — 24 unit tests via Node's built-in test runner (`node --test`, no extra
  framework dependency), covering `tokenize`, `schema`, and `match` — including a
  regression test for the small-catalog context-field bug and a cycle-guard test for
  self-referential schemas.
- `.github/workflows/ci.yml` — runs typecheck, tests, and selfcheck on every push/PR. Adds
  its own pass/fail gate on selfcheck's JSON output (provenance_ratio >= 0.8, edges > 0)
  since selfcheck.ts itself always exits 0.

Before this pass, none of the above existed: zero automated tests, no type-checking
infrastructure, no CI. "Testing" meant reading `npm run selfcheck`'s console output by eye.

## Commands

```bash
npm install --legacy-peer-deps   # build step (per generator.json)
npm run typecheck                # strict TypeScript check
npm test                         # unit tests
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
