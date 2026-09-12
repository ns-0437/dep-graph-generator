import { test } from "node:test";
import assert from "node:assert/strict";
import { mulberry32, shuffle } from "./sampling.js";

test("mulberry32 is deterministic for a given seed", () => {
  const a = mulberry32(424242);
  const b = mulberry32(424242);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
});

test("mulberry32 produces different sequences for different seeds", () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  assert.notEqual(a(), b());
});

test("mulberry32 stays within [0, 1)", () => {
  const rand = mulberry32(424242);
  for (let i = 0; i < 100; i++) {
    const v = rand();
    assert.ok(v >= 0 && v < 1, `${v} out of range`);
  }
});

test("shuffle does not mutate the input array", () => {
  const input = [1, 2, 3, 4, 5];
  const copy = input.slice();
  shuffle(input, mulberry32(1));
  assert.deepEqual(input, copy);
});

test("shuffle is a permutation -- same elements, same length", () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffle(input, mulberry32(7));
  assert.equal(out.length, input.length);
  assert.deepEqual([...out].sort(), [...input].sort());
});

test("shuffle is deterministic for the same seed", () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const out1 = shuffle(input, mulberry32(424242));
  const out2 = shuffle(input, mulberry32(424242));
  assert.deepEqual(out1, out2);
});
