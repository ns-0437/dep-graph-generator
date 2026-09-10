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
- `src/generate.ts` — **the actual deliverable**. Entry point; reads catalog path from
  `process.argv` (last arg), writes `dependency_graph.json` to cwd.
- `src/selfcheck.ts` — provided, unmodified. Runs the generator against
  `github_catalog.json` and prints `{ nodes, edges, provenance_ratio, labeled_edges }`.
  Run via `npm run selfcheck`.
- `graph.html` — visualization (nodes/edges you can see), embeds the graph data inline,
  rendered client-side with a hand-rolled canvas force layout. No build/server needed.
- `dependency_graph.json` — generator output. Gitignored (regenerated on demand).

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

## Commands

```bash
npm install --legacy-peer-deps   # build step (per generator.json)
npm run selfcheck                # run generator on github_catalog.json + report metrics
npm run generate -- <catalog>    # run generator directly on an arbitrary catalog path
```

## Working rules

- Commit frequently, one logical change per commit.
- Keep `src/generate.ts` catalog-agnostic: no GitHub-specific hardcoding of slugs or fields,
  even though `github_catalog.json` is the primary catalog on hand to test with — verify
  against `test-fixtures/fake_slack_catalog.json` too.
- Re-run `npm run selfcheck` after each change to `generate.ts` to catch regressions in
  provenance_ratio / edge count early.
