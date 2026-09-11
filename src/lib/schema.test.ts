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

test("flattenOutputs recovers fields hidden behind a real-world anyOf shape (regression test)", () => {
  // Modeled directly on GITHUB_ADD_ORG_RUNNER_LABELS's actual schema: the wrapper's
  // 'data' property is typed as anyOf [the real shape, or any generic object] rather than
  // a plain $ref. Before this was handled, the whole 'data' field was treated as an opaque
  // leaf and every field inside the real shape (RunnerLabel.id/name/type, total_count) was
  // silently lost.
  const fields = flattenOutputs(
    tool({
      properties: {
        data: { $ref: "#/$defs/Wrapper" },
      },
      $defs: {
        Wrapper: {
          type: "object",
          properties: {
            data: {
              anyOf: [{ $ref: "#/$defs/RealShape" }, { type: "object", additionalProperties: true }],
            },
          },
        },
        RealShape: {
          type: "object",
          properties: {
            labels: { type: "array", items: { $ref: "#/$defs/RunnerLabel" } },
            total_count: { type: "integer" },
          },
        },
        RunnerLabel: {
          type: "object",
          properties: { id: { type: "integer" }, name: { type: "string" } },
        },
      },
    }),
  );
  const byName = Object.fromEntries(fields.map((f) => [f.name, f.parentType]));
  assert.equal(byName["id"], "RunnerLabel");
  assert.equal(byName["name"], "RunnerLabel");
  assert.equal(byName["total_count"], "RealShape");
});

test("flattenOutputs treats a nullable-primitive anyOf (string | null) as a leaf, not a container", () => {
  const fields = flattenOutputs(
    tool({
      properties: {
        data: { $ref: "#/$defs/FieldOption" },
      },
      $defs: {
        FieldOption: {
          type: "object",
          properties: {
            description: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      },
    }),
  );
  // Must still be recorded as a leaf named "description" -- not silently dropped, and not
  // wrongly recursed into (there's nothing inside a bare {type: "string"} to find).
  assert.deepEqual(fields, [{ name: "description", parentType: "FieldOption", path: "data.description" }]);
});

test("flattenOutputs handles oneOf the same way as anyOf", () => {
  const fields = flattenOutputs(
    tool({
      properties: {
        data: { $ref: "#/$defs/Wrapper" },
      },
      $defs: {
        Wrapper: {
          oneOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "string" } } }],
        },
      },
    }),
  );
  assert.deepEqual(
    fields.map((f) => f.name).sort(),
    ["a", "b"],
  );
});
