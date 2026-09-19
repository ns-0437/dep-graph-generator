# Contributing

## Setup

```bash
npm install --legacy-peer-deps
npm run verify
```

`npm run verify` runs the typecheck, the test suite and the selfcheck. CI runs the same three
on Node 20 and 22, so a green local run should be a green CI run.

## Before you commit

A pre-commit hook type-checks and runs the tests with a coverage gate against the staged
snapshot. If it fails, fix the cause rather than bypassing it.

## Pull requests

- Keep each PR to one change and link the issue it closes with `Closes #N`.
- Add or update a test beside the code in `src/lib/` when behaviour changes.
- Read [CLAUDE.md](CLAUDE.md) first if you are touching the matching heuristic; it records
  the design decisions and the bugs already found.
