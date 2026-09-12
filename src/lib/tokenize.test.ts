import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, singularize } from "./tokenize.js";

test("tokenize splits snake_case", () => {
  assert.deepEqual(tokenize("issue_number"), ["issue", "number"]);
});

test("tokenize splits camelCase", () => {
  assert.deepEqual(tokenize("issueNumber"), ["issue", "number"]);
});

test("tokenize splits PascalCase type names", () => {
  assert.deepEqual(tokenize("PullRequest"), ["pull", "request"]);
});

test("tokenize singularizes plural tokens", () => {
  assert.deepEqual(tokenize("labels"), ["label"]);
  assert.deepEqual(tokenize("repositories"), ["repository"]);
});

test("tokenize lowercases", () => {
  assert.deepEqual(tokenize("OWNER"), ["owner"]);
});

test("tokenize drops empty segments from repeated separators", () => {
  assert.deepEqual(tokenize("a__b"), ["a", "b"]);
});

test("singularize does not mangle short words", () => {
  // guards against the naive "strip trailing s" approach breaking 3-letter words
  assert.equal(singularize("id"), "id");
  assert.equal(singularize("os"), "os");
});

test("singularize does not double-strip words already ending in double s", () => {
  assert.equal(singularize("access"), "access");
});

test("singularize treats 'ids' as the irregular plural of 'id'", () => {
  // "ids" is only 3 letters, so the general length>3 guard leaves it alone -- without an
  // explicit exception, tokenize("environment_ids") never matches an output field named
  // "id", silently making every *_ids field unmatchable. Found via eval/sample-unresolved.ts.
  assert.equal(singularize("ids"), "id");
  assert.deepEqual(tokenize("environment_ids"), ["environment", "id"]);
  assert.deepEqual(tokenize("selected_repository_ids"), ["selected", "repository", "id"]);
});

test("singularize's 'ids' exception doesn't over-fire on other short words ending in s", () => {
  // Verified against the real catalog: these are the only other 3-letter s-ending tokens
  // that appear anywhere in it, and none of them are plurals.
  assert.equal(singularize("has"), "has");
  assert.equal(singularize("lfs"), "lfs");
  assert.equal(singularize("dns"), "dns");
  assert.equal(singularize("vcs"), "vcs");
});
