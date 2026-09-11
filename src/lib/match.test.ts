import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./tokenize.js";
import {
  matchScore,
  isGeneric,
  isContextField,
  buildLeafFrequency,
  buildInputFrequency,
  indexFields,
} from "./match.js";
import type { InputField, OutField } from "../types.js";

function input(name: string): InputField {
  return { name, tokens: tokenize(name) };
}
function outField(name: string, parentType: string): OutField {
  return { name, parentType, path: name };
}
/** Build a single IndexedField the way generate.ts does via indexFields(), for tests. */
function indexed(name: string, parentType: string) {
  return indexFields([outField(name, parentType)])[0]!;
}

test("matchScore: issue_number matches Issue.number (the core case this project exists for)", () => {
  const leafFreq = buildLeafFrequency(new Map([["X", indexFields([outField("number", "Issue")])]]));
  const score = matchScore(input("issue_number"), indexed("number", "Issue"), leafFreq);
  assert.equal(score, 5);
});

test("matchScore: pull_number matches PullRequest.number", () => {
  const leafFreq = buildLeafFrequency(new Map([["X", indexFields([outField("number", "PullRequest")])]]));
  const score = matchScore(input("pull_number"), indexed("number", "PullRequest"), leafFreq);
  assert.equal(score, 5);
});

test("matchScore: wrong owning type is rejected even with a matching leaf name", () => {
  // pull_number's leftover token "pull" doesn't match Milestone -- must not match.
  const leafFreq = buildLeafFrequency(new Map([["X", indexFields([outField("number", "Milestone")])]]));
  const score = matchScore(input("pull_number"), indexed("number", "Milestone"), leafFreq);
  assert.equal(score, 0);
});

test("matchScore: leaf name not contained in input name scores 0", () => {
  const leafFreq = buildLeafFrequency(new Map([["X", indexFields([outField("owner", "Repo")])]]));
  const score = matchScore(input("issue_number"), indexed("owner", "Repo"), leafFreq);
  assert.equal(score, 0);
});

test("matchScore: exact match with a rare (non-generic) field name scores 4", () => {
  const leafFreq = buildLeafFrequency(new Map([["X", indexFields([outField("sha", "Commit")])]]));
  const score = matchScore(input("sha"), indexed("sha", "Commit"), leafFreq);
  assert.equal(score, 4);
});

test("matchScore: exact match with a generic (very common) field name scores 1, below threshold", () => {
  // "id" produced by 30 different tools -- generic, needs type corroboration.
  const outputsByTool = new Map(
    Array.from({ length: 30 }, (_, i) => [`TOOL_${i}`, indexFields([outField("id", "Whatever")])]),
  );
  const leafFreq = buildLeafFrequency(outputsByTool);
  const score = matchScore(input("id"), indexed("id", "Whatever"), leafFreq);
  assert.equal(score, 1);
  assert.ok(score < 4, "score 1 must fall below the acceptance threshold used in generate.ts");
});

test("isGeneric: true once a leaf name is produced by more tools than the threshold", () => {
  const outputsByTool = new Map(
    Array.from({ length: 26 }, (_, i) => [`TOOL_${i}`, indexFields([outField("name", "Whatever")])]),
  );
  const leafFreq = buildLeafFrequency(outputsByTool);
  assert.equal(isGeneric("name", leafFreq, 25), true);
});

test("isGeneric: false for a rare field name", () => {
  const leafFreq = buildLeafFrequency(new Map([["TOOL_0", indexFields([outField("node_id", "Whatever")])]]));
  assert.equal(isGeneric("node_id", leafFreq, 25), false);
});

test("indexFields precomputes the same tokens tokenize() would produce", () => {
  const [f] = indexFields([outField("issue_number", "Issue")]);
  assert.deepEqual(f!.tokens, tokenize("issue_number"));
  assert.deepEqual(f!.typeTokens, tokenize("Issue"));
  assert.equal(f!.field.name, "issue_number");
});

test("isContextField: catches a field required by a large share of a large catalog (owner/repo pattern)", () => {
  const totalTools = 893;
  const requiredByTool: InputField[][] = Array.from({ length: 442 }, () => [input("owner")]);
  const freq = buildInputFrequency(requiredByTool);
  assert.equal(isContextField("owner", freq, totalTools), true);
});

test("isContextField: does NOT flag a field required by most tools in a small catalog (the bug this test guards against)", () => {
  // Regression test for a real bug: with only 2 tools, a field required by 1 of them (50%)
  // was wrongly treated as boilerplate context by a ratio-only filter, producing 0 edges
  // for the generalization check against test-fixtures/fake_slack_catalog.json.
  const totalTools = 2;
  const requiredByTool: InputField[][] = [[input("channel_id")]];
  const freq = buildInputFrequency(requiredByTool);
  assert.equal(isContextField("channel_id", freq, totalTools), false);
});

test("isContextField: false for a field required by only a handful of tools in a large catalog", () => {
  const totalTools = 893;
  const requiredByTool: InputField[][] = Array.from({ length: 25 }, () => [input("issue_number")]);
  const freq = buildInputFrequency(requiredByTool);
  assert.equal(isContextField("issue_number", freq, totalTools), false);
});
