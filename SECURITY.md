# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/ns-0437/dep-graph-generator/security/advisories/new)
rather than a public issue.

## Scope

The generator reads a catalog file and, optionally, an OpenAI-compatible API key from the
environment (`.env` is git-ignored). Never commit keys; if one leaks, rotate it and tell me.
