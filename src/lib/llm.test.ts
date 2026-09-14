import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./tokenize.js";
import { looseCandidates, llmDisambiguate } from "./llm.js";
import { canonicalFieldKey, indexFields } from "./match.js";
import type { ChatClient } from "./llm.js";
import type { IndexedField } from "./match.js";
import type { InputField, OutField } from "../types.js";

function input(name: string): InputField {
  return { name, tokens: tokenize(name) };
}
function outField(name: string, parentType: string): OutField {
  return { name, parentType, path: name };
}
/** Build an outputsByTool map the way generate.ts does, via indexFields(). */
function indexedOutputsByTool(entries: [string, OutField[]][]): Map<string, IndexedField[]> {
  return new Map(entries.map(([slug, fields]) => [slug, indexFields(fields)]));
}

test("looseCandidates ranks by token overlap and dedupes by (slug, leaf)", () => {
  const outputsByTool = indexedOutputsByTool([
    ["PRODUCER_A", [outField("channel_id", "Channel"), outField("channel_id", "Channel")]],
    ["PRODUCER_B", [outField("id", "Channel")]],
    ["PRODUCER_C", [outField("unrelated_thing", "Other")]],
  ]);
  const candidates = looseCandidates(input("channel_id"), "CONSUMER", outputsByTool, 5);
  assert.deepEqual(
    candidates.map((c) => c.slug),
    ["PRODUCER_A", "PRODUCER_B"],
  );
  assert.equal(candidates[0]!.overlap, 2);
});

test("looseCandidates excludes the consumer itself and respects the limit", () => {
  const outputsByTool = indexedOutputsByTool([
    ["CONSUMER", [outField("id", "X")]],
    ["A", [outField("id", "X")]],
    ["B", [outField("id", "X")]],
    ["C", [outField("id", "X")]],
  ]);
  const candidates = looseCandidates(input("id"), "CONSUMER", outputsByTool, 2);
  assert.equal(candidates.length, 2);
  assert.ok(!candidates.some((c) => c.slug === "CONSUMER"));
});

test("looseCandidates excludes a producer that itself requires the same field (circular), given requiredNamesByTool", () => {
  // Regression guard: the heuristic matching loop in generate.ts already excludes circular
  // producers via isCircularProducer (876/2101 real edges, per match.ts's own docs on the
  // pattern) -- but before this fix, looseCandidates/llmDisambiguate never received
  // requiredNamesByTool at all, so a field the heuristic couldn't resolve *because* every
  // real candidate was circular got handed to the LLM with those same circular producers
  // still in its candidate list, undefended. The LLM reasons purely on field/type-name
  // semantics and has no way to know CIRCULAR_PRODUCER is circular -- confirmed against the
  // real GitHub catalog that 32 of 230 LLM-bound fields had a circular producer as their
  // single top-ranked candidate before this fix.
  const outputsByTool = indexedOutputsByTool([
    ["CIRCULAR_PRODUCER", [outField("package_type", "Package")]],
    ["CLEAN_PRODUCER", [outField("package_type", "Package")]],
  ]);
  const requiredNamesByTool = new Map<string, ReadonlySet<string>>([
    ["CIRCULAR_PRODUCER", new Set([canonicalFieldKey("package_type")])],
    ["CLEAN_PRODUCER", new Set()],
  ]);
  const candidates = looseCandidates(input("package_type"), "CONSUMER", outputsByTool, 5, requiredNamesByTool);
  assert.deepEqual(
    candidates.map((c) => c.slug),
    ["CLEAN_PRODUCER"],
  );
});

test("looseCandidates keeps all candidates when requiredNamesByTool is omitted (existing callers unaffected)", () => {
  const outputsByTool = indexedOutputsByTool([["CIRCULAR_PRODUCER", [outField("package_type", "Package")]]]);
  const candidates = looseCandidates(input("package_type"), "CONSUMER", outputsByTool, 5);
  assert.deepEqual(
    candidates.map((c) => c.slug),
    ["CIRCULAR_PRODUCER"],
  );
});

test("llmDisambiguate never offers the LLM a circular producer as a candidate", async () => {
  const outputsByTool = indexedOutputsByTool([
    ["CIRCULAR_PRODUCER", [outField("package_type", "Package")]],
    ["CLEAN_PRODUCER", [outField("package_type", "Package")]],
  ]);
  const requiredNamesByTool = new Map<string, ReadonlySet<string>>([
    ["CIRCULAR_PRODUCER", new Set([canonicalFieldKey("package_type")])],
    ["CLEAN_PRODUCER", new Set()],
  ]);
  let sentCandidateSlugs: string[] = [];
  const fakeClient: ChatClient = {
    chat: {
      completions: {
        create: async (params) => {
          const items = JSON.parse(params.messages[0]!.content.split("Items:\n")[1]!);
          sentCandidateSlugs = items[0].candidate_producers.map((c: { producer_tool: string }) => c.producer_tool);
          return { choices: [{ message: { content: "[]" } }] };
        },
      },
    },
  };
  await llmDisambiguate(
    [{ consumer: "CONSUMER", field: input("package_type") }],
    outputsByTool,
    fakeClient,
    requiredNamesByTool,
  );
  assert.deepEqual(sentCandidateSlugs, ["CLEAN_PRODUCER"]);
});

test("llmDisambiguate returns [] immediately when there's nothing unresolved (no client call)", async () => {
  let called = false;
  const fakeClient: ChatClient = {
    chat: { completions: { create: async () => { called = true; return { choices: [] }; } } },
  };
  const result = await llmDisambiguate([], new Map(), fakeClient);
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("llmDisambiguate returns [] without a client and without OPENAI_API_KEY set", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const outputsByTool = indexedOutputsByTool([["PRODUCER", [outField("id", "Channel")]]]);
    const result = await llmDisambiguate(
      [{ consumer: "CONSUMER", field: input("channel_id") }],
      outputsByTool,
    );
    assert.deepEqual(result, []);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

test("llmDisambiguate parses a valid response into the chosen edge", async () => {
  const outputsByTool = indexedOutputsByTool([["PRODUCER", [outField("id", "Channel")]]]);
  const fakeClient: ChatClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: '[{"idx":0,"ci":0}]' } }],
        }),
      },
    },
  };
  const result = await llmDisambiguate(
    [{ consumer: "CONSUMER", field: input("channel_id") }],
    outputsByTool,
    fakeClient,
  );
  assert.deepEqual(result, [{ from: "PRODUCER", to: "CONSUMER", label: "channel_id" }]);
});

test("llmDisambiguate treats ci: null as 'no match' rather than an edge", async () => {
  const outputsByTool = indexedOutputsByTool([["PRODUCER", [outField("id", "Channel")]]]);
  const fakeClient: ChatClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: '[{"idx":0,"ci":null}]' } }] }),
      },
    },
  };
  const result = await llmDisambiguate(
    [{ consumer: "CONSUMER", field: input("channel_id") }],
    outputsByTool,
    fakeClient,
  );
  assert.deepEqual(result, []);
});

test("llmDisambiguate degrades gracefully on a malformed/unparseable response instead of throwing", async () => {
  const outputsByTool = indexedOutputsByTool([["PRODUCER", [outField("id", "Channel")]]]);
  const fakeClient: ChatClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: "not json at all" } }] }),
      },
    },
  };
  const result = await llmDisambiguate(
    [{ consumer: "CONSUMER", field: input("channel_id") }],
    outputsByTool,
    fakeClient,
  );
  assert.deepEqual(result, []);
});

test("llmDisambiguate degrades gracefully when the response is valid JSON but not an array", async () => {
  // A distinct failure mode from "malformed/unparseable" above: this is valid JSON --
  // JSON.parse succeeds -- but a bare object (a plausible LLM formatting slip: answering
  // with the single choice object directly instead of wrapping it in an array) isn't
  // iterable, so `for (const {idx, ci} of parsed)` throws. Must land in the same catch as a
  // parse failure, not crash the whole batch/process.
  const outputsByTool = indexedOutputsByTool([["PRODUCER", [outField("id", "Channel")]]]);
  const fakeClient: ChatClient = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: '{"idx":0,"ci":0}' } }] }),
      },
    },
  };
  const result = await llmDisambiguate(
    [{ consumer: "CONSUMER", field: input("channel_id") }],
    outputsByTool,
    fakeClient,
  );
  assert.deepEqual(result, []);
});

test("llmDisambiguate ignores idx/ci values that are out of range, without crashing", async () => {
  // The LLM can hallucinate indices outside what was actually offered -- batch[idx] and
  // candidates[ci] are plain array access (out-of-range returns undefined, doesn't throw),
  // guarded by `if (u && c)` before ever building an edge from them.
  const outputsByTool = indexedOutputsByTool([["PRODUCER", [outField("id", "Channel")]]]);
  const fakeClient: ChatClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: '[{"idx":99,"ci":0},{"idx":0,"ci":99},{"idx":-1,"ci":0}]' } }],
        }),
      },
    },
  };
  const result = await llmDisambiguate(
    [{ consumer: "CONSUMER", field: input("channel_id") }],
    outputsByTool,
    fakeClient,
  );
  assert.deepEqual(result, []);
});

test("llmDisambiguate degrades gracefully when the response has no choices/content at all", async () => {
  // Distinct from the "malformed JSON" case above: here the response shape itself is
  // missing (choices: [] or content: null), so `resp.choices[0]?.message?.content ?? "[]"`
  // is what has to save this, not the try/catch around JSON.parse.
  const outputsByTool = indexedOutputsByTool([["PRODUCER", [outField("id", "Channel")]]]);
  const fakeClient: ChatClient = {
    chat: { completions: { create: async () => ({ choices: [] }) } },
  };
  const result = await llmDisambiguate(
    [{ consumer: "CONSUMER", field: input("channel_id") }],
    outputsByTool,
    fakeClient,
  );
  assert.deepEqual(result, []);
});

test("llmDisambiguate skips fields with zero loose candidates without calling the client", async () => {
  let called = false;
  const outputsByTool = indexedOutputsByTool([["PRODUCER", [outField("totally_unrelated", "X")]]]);
  const fakeClient: ChatClient = {
    chat: { completions: { create: async () => { called = true; return { choices: [] }; } } },
  };
  const result = await llmDisambiguate(
    [{ consumer: "CONSUMER", field: input("channel_id") }],
    outputsByTool,
    fakeClient,
  );
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("llmDisambiguate batches in groups of 25", async () => {
  const outputsByTool = indexedOutputsByTool([["PRODUCER", [outField("id", "Thing")]]]);
  const unresolved = Array.from({ length: 30 }, (_, i) => ({
    consumer: `CONSUMER_${i}`,
    field: input("thing_id"),
  }));
  let batchSizes: number[] = [];
  const fakeClient: ChatClient = {
    chat: {
      completions: {
        create: async (params) => {
          const items = JSON.parse(params.messages[0]!.content.split("Items:\n")[1]!);
          batchSizes.push(items.length);
          return { choices: [{ message: { content: "[]" } }] };
        },
      },
    },
  };
  await llmDisambiguate(unresolved, outputsByTool, fakeClient);
  assert.deepEqual(batchSizes, [25, 5]);
});
