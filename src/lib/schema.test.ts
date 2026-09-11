import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenOutputs } from "./schema.js";

function tool(outputParameters: any) {
  return { outputParameters };
}

test("flattenOutputs resolves a nested $ref into $defs", () => {
  const fields = flattenOutputs(
    tool({
      properties: {
        data: { $ref: "#/$defs/Issue" },
      },
      $defs: {
        Issue: {
          type: "object",
          properties: { number: { type: "integer" } },
        },
      },
    }),
  );
  assert.deepEqual(fields, [{ name: "number", parentType: "Issue", path: "data.number" }]);
});

test("flattenOutputs descends through an array of $ref items", () => {
  const fields = flattenOutputs(
    tool({
      properties: {
        data: { $ref: "#/$defs/ListResponse" },
      },
      $defs: {
        ListResponse: {
          type: "object",
          properties: {
            issues: { type: "array", items: { $ref: "#/$defs/Issue" } },
          },
        },
        Issue: {
          type: "object",
          properties: { number: { type: "integer" } },
        },
      },
    }),
  );
  assert.deepEqual(fields, [{ name: "number", parentType: "Issue", path: "data.issues.number" }]);
});

test("flattenOutputs merges allOf property sets under the same owning type", () => {
  const fields = flattenOutputs(
    tool({
      properties: {
        data: { $ref: "#/$defs/Combined" },
      },
      $defs: {
        Combined: {
          allOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "string" } } }],
        },
      },
    }),
  );
  const names = fields.map((f) => f.name).sort();
  assert.deepEqual(names, ["a", "b"]);
});

test("flattenOutputs stops on a self-referential \$ref instead of looping forever", () => {
  const fields = flattenOutputs(
    tool({
      properties: {
        data: { $ref: "#/$defs/Node" },
      },
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            parent: { $ref: "#/$defs/Node" },
          },
        },
      },
    }),
  );
  // "name" is collected once; the cyclic "parent" ref is not re-entered.
  assert.deepEqual(
    fields.filter((f) => f.name === "name").length,
    1,
  );
});

test("flattenOutputs returns nothing when outputParameters has no data property", () => {
  assert.deepEqual(flattenOutputs(tool({ properties: {} })), []);
  assert.deepEqual(flattenOutputs({ outputParameters: undefined }), []);
});
