import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./tokenize.js";
import { looseCandidates, llmDisambiguate } from "./llm.js";
import type { ChatClient } from "./llm.js";
import type { InputField, OutField } from "../types.js";

function input(name: string): InputField {
  return { name, tokens: tokenize(name) };
}
function outField(name: string, parentType: string): OutField {
  return { name, parentType, path: name };
}

test("looseCandidates ranks by token overlap and dedupes by (slug, leaf)", () => {
  const outputsByTool = new Map<string, OutField[]>([
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
  const outputsByTool = new Map<string, OutField[]>([
    ["CONSUMER", [outField("id", "X")]],
    ["A", [outField("id", "X")]],
    ["B", [outField("id", "X")]],
    ["C", [outField("id", "X")]],
  ]);
  const candidates = looseCandidates(input("id"), "CONSUMER", outputsByTool, 2);
  assert.equal(candidates.length, 2);
  assert.ok(!candidates.some((c) => c.slug === "CONSUMER"));
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
    const outputsByTool = new Map<string, OutField[]>([["PRODUCER", [outField("id", "Channel")]]]);
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
  const outputsByTool = new Map<string, OutField[]>([["PRODUCER", [outField("id", "Channel")]]]);
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
  const outputsByTool = new Map<string, OutField[]>([["PRODUCER", [outField("id", "Channel")]]]);
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
  const outputsByTool = new Map<string, OutField[]>([["PRODUCER", [outField("id", "Channel")]]]);
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

test("llmDisambiguate skips fields with zero loose candidates without calling the client", async () => {
  let called = false;
  const outputsByTool = new Map<string, OutField[]>([["PRODUCER", [outField("totally_unrelated", "X")]]]);
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
  const outputsByTool = new Map<string, OutField[]>([["PRODUCER", [outField("id", "Thing")]]]);
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
