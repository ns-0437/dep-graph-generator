import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "fs";
import { loadCatalog, slugOf, requiredInputsOf, guessService } from "./catalog.js";

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
  const path = "test-fixtures/tmp_wrapped_catalog.json";
  writeFileSync(path, JSON.stringify({ tools: [{ slug: "A" }] }));
  try {
    assert.deepEqual(loadCatalog(path), [{ slug: "A" }]);
  } finally {
    unlinkSync(path);
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
