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
