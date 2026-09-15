import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "fs";
import { loadCatalog, slugOf, requiredInputsOf, guessService, pluralize } from "./catalog.js";

test("slugOf prefers slug, falls back to name, then function.name", () => {
  assert.equal(slugOf({ slug: "A", name: "B" }), "A");
  assert.equal(slugOf({ name: "B" }), "B");
  assert.equal(slugOf({ function: { name: "C" } }), "C");
  assert.equal(slugOf({}), undefined);
});

test("requiredInputsOf tokenizes each required field name", () => {
  const fields = requiredInputsOf({
    inputParameters: { required: ["issue_number", "owner"] },
  });
  assert.deepEqual(
    fields.map((f) => f.name),
    ["issue_number", "owner"],
  );
  assert.deepEqual(fields[0]!.tokens, ["issue", "number"]);
});

test("requiredInputsOf returns [] when there's no inputParameters.required", () => {
  assert.deepEqual(requiredInputsOf({}), []);
});

test("guessService matches a known keyword present in the slug", () => {
  assert.equal(guessService("GITHUB_CREATE_AN_ISSUE"), "issues");
  assert.equal(guessService("GITHUB_MERGE_A_PULL_REQUEST"), "pull_requests");
});

test("guessService falls back to the first token after the toolkit prefix when no keyword matches", () => {
  assert.equal(guessService("GITHUB_XYZZY_FOO"), "xyzzy");
});

test("pluralize leaves a word that already ends in 's' unchanged", () => {
  // No current SERVICE_KEYWORDS entry ends in "s" (they're all singular nouns), so this
  // guard can't be exercised through guessService with a real keyword -- tested directly.
  assert.equal(pluralize("status"), "status");
});

test("pluralize adds just 's' to a word ending in a vowel+'y'", () => {
  // The consonant+'y' -> 'ies' rule must not over-fire on a vowel+'y' ending, e.g. "day" ->
  // "days", not "daies".
  assert.equal(pluralize("day"), "days");
});

test("pluralize turns a trailing consonant+'y' into 'ies'", () => {
  assert.equal(pluralize("repository"), "repositories");
});

test("pluralize adds a plain 's' to an ordinary word", () => {
  assert.equal(pluralize("issue"), "issues");
});

test("guessService pluralizes a keyword ending in consonant+'y' as '...ies', not '...ys'", () => {
  // Regression guard: the old pluralization rule was a bare "add an s unless it already
  // ends in s", which is wrong for any keyword ending in a consonant+"y" -- "repository" +
  // "s" reads as "repositorys". "repository" is the only SERVICE_KEYWORDS entry with this
  // shape, but it's a very common one: confirmed against the real shipped
  // dependency_graph.json that 161 of 893 nodes (every *_REPOSITORY* tool) carried
  // service: "repositorys" before this fix.
  assert.equal(guessService("GITHUB_LIST_LABELS_FOR_A_REPOSITORY"), "repositories");
  assert.equal(guessService("GITHUB_ADD_A_REPOSITORY_COLLABORATOR"), "repositories");
});

test("guessService matches a keyword whose plural form ends in a single 'se'", () => {
  // Regression guard for a real bug in singularize (see tokenize.test.ts): a "...ses"
  // ending word that legitimately singularizes to something ending in "se" -- like
  // "releases" -> "release" -- used to tokenize to "releas" instead, which no longer
  // matched the "release" SERVICE_KEYWORDS entry. Confirmed against the real shipped
  // catalog: GITHUB_LIST_RELEASES was mis-labeled with service "list" before this fix.
  assert.equal(guessService("GITHUB_LIST_RELEASES"), "releases");
});

test("loadCatalog accepts a bare array", () => {
  const path = "test-fixtures/tmp_array_catalog.json";
  writeFileSync(path, JSON.stringify([{ slug: "A" }]));
  try {
    assert.deepEqual(loadCatalog(path), [{ slug: "A" }]);
  } finally {
    unlinkSync(path);
  }
});

test("loadCatalog accepts { tools: [...] } and { items: [...] }", () => {
  // Was previously only exercising the "tools" shape despite its name -- c8's branch
  // coverage report caught that the "items" branch (catalog.ts) had never actually run.
  const toolsPath = "test-fixtures/tmp_wrapped_tools_catalog.json";
  const itemsPath = "test-fixtures/tmp_wrapped_items_catalog.json";
  writeFileSync(toolsPath, JSON.stringify({ tools: [{ slug: "A" }] }));
  writeFileSync(itemsPath, JSON.stringify({ items: [{ slug: "B" }] }));
  try {
    assert.deepEqual(loadCatalog(toolsPath), [{ slug: "A" }]);
    assert.deepEqual(loadCatalog(itemsPath), [{ slug: "B" }]);
  } finally {
    unlinkSync(toolsPath);
    unlinkSync(itemsPath);
  }
});

test("loadCatalog throws on a malformed catalog instead of silently returning []", () => {
  const path = "test-fixtures/tmp_bad_catalog.json";
  writeFileSync(path, JSON.stringify({ foo: "bar" }));
  try {
    assert.throws(() => loadCatalog(path), /not a recognized shape/);
  } finally {
    unlinkSync(path);
  }
});

test("loadCatalog throws a clear error when no path is given", () => {
  assert.throws(() => loadCatalog(undefined), /pass the toolkit catalog path/);
});

test("loadCatalog throws a clear error on invalid JSON", () => {
  const path = "test-fixtures/tmp_invalid_catalog.json";
  writeFileSync(path, "{ not valid json");
  try {
    assert.throws(() => loadCatalog(path), /failed to read\/parse catalog/);
  } finally {
    unlinkSync(path);
  }
});

test("loadCatalog throws a clear error when the catalog file doesn't exist at all", () => {
  // Distinct failure mode from invalid JSON above -- a missing file throws a raw ENOENT
  // from readFileSync, not a JSON.parse SyntaxError, and both need to land in the same
  // catch block. Verified the actual error message first (not just assumed the catch
  // works for both): it correctly reports "failed to read/parse catalog at ...: ENOENT...".
  assert.throws(
    () => loadCatalog("this-file-truly-does-not-exist.json"),
    /failed to read\/parse catalog/,
  );
});
