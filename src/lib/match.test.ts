import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./tokenize.js";
import {
  matchScore,
  isGeneric,
  isContextField,
  isCircularProducer,
  canonicalFieldKey,
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

test("matchScore: hook_id matches Webhook.id via the hook/webhook synonym", () => {
  // Real, verified miss from eval/unresolved-sample.json labeling: GITHUB_LIST_REPOSITORY_WEBHOOKS's
  // Webhook.id is exactly what hook_id-requiring consumers need, but "hook" shares no token
  // with "webhook" under plain tokenization. See eval/RESULTS.md.
  const leafFreq = buildLeafFrequency(new Map([["X", indexFields([outField("id", "Webhook")])]]));
  const score = matchScore(input("hook_id"), indexed("id", "Webhook"), leafFreq);
  assert.equal(score, 5);
});

test("matchScore: pat_id matches Token.id via the pat/token synonym", () => {
  // Same class of verified miss as hook_id: GITHUB_LIST_ORG_RESOURCE_ACCESS_TOKENS's Token.id
  // is what pat_id/pat_ids-requiring consumers need. The catalog's own field description for
  // GITHUB_UPDATE_RESOURCE_ACCESS_WITH_TOKENS names that exact producer tool.
  const leafFreq = buildLeafFrequency(new Map([["X", indexFields([outField("id", "Token")])]]));
  const score = matchScore(input("pat_id"), indexed("id", "Token"), leafFreq);
  assert.equal(score, 5);
});

test("matchScore: the hook/pat synonyms don't fire for unrelated types", () => {
  // Guards against the synonym map being too loose -- "hook_id" must still be rejected
  // against a type that has nothing to do with webhooks, and "pat_id" against a type that
  // has nothing to do with tokens.
  const hookFreq = buildLeafFrequency(new Map([["X", indexFields([outField("id", "Milestone")])]]));
  assert.equal(matchScore(input("hook_id"), indexed("id", "Milestone"), hookFreq), 0);
  const patFreq = buildLeafFrequency(new Map([["X", indexFields([outField("id", "Repository")])]]));
  assert.equal(matchScore(input("pat_id"), indexed("id", "Repository"), patFreq), 0);
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

test("isGeneric: false for a field name that appears in no tool's output at all", () => {
  // leafFrequency.get(key) returns undefined here (not an empty Set) -- the ?? 0 fallback,
  // distinct from "appears but rarely" above.
  const leafFreq = buildLeafFrequency(new Map([["TOOL_0", indexFields([outField("node_id", "Whatever")])]]));
  assert.equal(isGeneric("completely_unseen_field", leafFreq, 25), false);
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

test("isContextField: false for a name that never appears in inputFrequency at all", () => {
  // inputFrequency.get(name) returns undefined here -- the ?? 0 fallback, distinct from a
  // name that appears but rarely.
  const freq = buildInputFrequency([[input("owner")]]);
  assert.equal(isContextField("completely_unseen_field", freq, 893), false);
});

test("isContextField: short-circuits on minCount before even computing the ratio", () => {
  // A field required by only 3 tools out of a small total (3/10 = 30%, well past
  // CONTEXT_FIELD_RATIO) must still be false, because it never reaches minCount -- the
  // `count >= minCount` check must reject it on its own, not rely on the ratio side.
  const requiredByTool: InputField[][] = Array.from({ length: 3 }, () => [input("some_field")]);
  const freq = buildInputFrequency(requiredByTool);
  assert.equal(isContextField("some_field", freq, 10), false);
});

// isCircularProducer takes already-canonicalized keys (see canonicalFieldKey's own docs for
// why: it runs ~24.9 million times against the real catalog, so canonicalizing inside the
// function itself on every call would reintroduce the exact re-tokenization cost
// IndexedField exists to avoid for matchScore). Tests canonicalize inline, the way
// generate.ts actually does it.
function circular(fieldName: string, producerRequiredNames: string[]): boolean {
  return isCircularProducer(canonicalFieldKey(fieldName), new Set(producerRequiredNames.map(canonicalFieldKey)));
}

test("isCircularProducer: true when the producer itself requires the same field", () => {
  // GITHUB_CLOSE_ISSUE requires issue_number to be called at all, so its response
  // describing "the issue I just closed" can't be a real discovery path for issue_number --
  // you needed the value already just to make the call.
  assert.equal(circular("issue_number", ["owner", "repo", "issue_number"]), true);
});

test("isCircularProducer: false when the producer doesn't require that field itself", () => {
  // GITHUB_CREATE_AN_ISSUE doesn't need issue_number to be called (the number is assigned
  // by the creation itself) -- a genuine discovery, not an echo.
  assert.equal(circular("issue_number", ["owner", "repo", "title"]), false);
});

test("isCircularProducer: true across the hook/webhook synonym, not just exact names", () => {
  // A hypothetical producer requiring "webhook_id" (not "hook_id") is exactly as circular
  // for a "hook_id"-requiring consumer as one requiring "hook_id" literally would be --
  // matchScore's TOKEN_SYNONYMS already treats these as the same field for scoring, so
  // circularity has to agree, or a future catalog update could silently produce a false
  // positive (a "circular" producer wrongly treated as genuine).
  assert.equal(circular("hook_id", ["owner", "repo", "webhook_id"]), true);
});

test("isCircularProducer: true across the pat/token synonym", () => {
  assert.equal(circular("pat_id", ["org", "token_id"]), true);
});

test("isCircularProducer: canonicalization doesn't cause unrelated fields to collide", () => {
  // Guards against the synonym/sort-based canonicalization being too loose.
  assert.equal(circular("hook_id", ["owner", "repo", "milestone_id"]), false);
});
