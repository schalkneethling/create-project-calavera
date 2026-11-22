// #1176: the Composer's WebMCP handlers check their input with tool-input.js. Ajv is the reference
// JSON Schema validator: the checker must accept and refuse exactly what Ajv does for every schema
// the core generates for the Composer.
import assert from "node:assert/strict";
import { test } from "node:test";

import Ajv from "ajv";

import { nodeOnlyInputMessage, validateRecipe } from "../../../packages/cli/src/recipe.js";
import { webMcpToolSchemas } from "../../../packages/cli/src/tool-schemas.js";
import { ToolInputError, checkToolInput, schemaRefusal } from "../tool-input.js";

const schemas = webMcpToolSchemas();
const ajv = new Ajv({ strict: false, allErrors: false });

const PROBES = [
  undefined,
  null,
  true,
  false,
  0,
  1,
  2024,
  1.5,
  101,
  "",
  "x",
  "widely",
  " widely ",
  "2024",
  "default",
  "npm",
  [],
  ["x"],
  [1],
  {},
  { x: 1 },
];

// A valid input for each tool, which the probes then change one field at a time.
const VALID = {
  list_profiles: {},
  list_integrations: { profile: "default" },
  describe_integration: { id: "stylelint" },
  list_ai_artifacts: {},
  list_baseline_targets: {},
  describe_baseline_target: { target: "widely" },
  search_baseline_features: { query: "grid", limit: 5 },
  recommend_baseline_target: { features: ["grid"] },
  compose_recipe: {
    profile: "default",
    packageManager: "pnpm",
    tools: ["stylelint"],
    aiArtifacts: [{ id: "calavera", target: "claude" }],
    integrationOptions: {
      "stylelint-baseline": { available: "widely", severity: "error" },
      "html-validate": { quality: false },
      stryker: { testRunner: "node:test", testFiles: ["test/*.test.mjs"] },
      "github-repository-controls": {
        repository: "owner/name",
        defaultBranch: "main",
        requiredChecks: ["quality"],
        mergeMethods: ["squash"],
        codeqlLanguages: [" javascript-typescript "],
        codeqlQuerySuite: null,
        releaseEnvironment: { reviewers: ["octocat"], waitTimer: 5, branches: ["main"] },
      },
    },
  },
  validate_recipe: { recipe: { profile: "default" } },
  explain_recipe: { recipe: { profile: "default" } },
};

/** Every path into `value` that leads to a property or an array item, including the root. */
function paths(value, prefix = []) {
  const children =
    value && typeof value === "object"
      ? Object.entries(value).flatMap(([key, child]) =>
          paths(child, [...prefix, Array.isArray(value) ? Number(key) : key]),
        )
      : [];
  return [prefix, ...children];
}

function valueAt(input, path) {
  return path.reduce((parent, key) => parent[key], input);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withValue(input, path, value) {
  if (path.length === 0) return value;
  const copy = structuredClone(input);
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key];
  if (value === undefined) delete parent[path.at(-1)];
  else parent[path.at(-1)] = value;
  return copy;
}

test("the checker accepts and refuses what Ajv does for every generated Composer schema", () => {
  assert.deepEqual(Object.keys(VALID).sort(), Object.keys(schemas).sort());
  let refused = 0;
  for (const [name, { inputSchema }] of Object.entries(schemas)) {
    const validate = ajv.compile(inputSchema);
    const valid = VALID[name];
    const variants = [
      valid,
      // A field the schema does not name, and the Node.js-only artifact inputs.
      { ...valid, extra: 1 },
      ...paths(valid).flatMap((path) => [
        ...PROBES.map((probe) => withValue(valid, path, probe)),
        ...(isPlainObject(valueAt(valid, path))
          ? [
              withValue(valid, [...path, "extra"], 1),
              withValue(valid, [...path, "inputs"], { protectedBranch: "main" }),
            ]
          : []),
      ]),
    ];
    for (const input of variants) {
      const refusal = schemaRefusal(inputSchema, input);
      if (refusal) refused += 1;
      assert.equal(
        refusal === undefined,
        validate(input),
        `${name} ${JSON.stringify(input)}: the checker says ${JSON.stringify(refusal)}, Ajv says ${JSON.stringify(validate.errors)}`,
      );
    }
  }
  // The corpus exercises refusals, not only valid inputs.
  assert.ok(refused > 500, `only ${refused} refusals`);
});

test("the checker supports every keyword and type the generated Composer schemas use", () => {
  const nodes = (schema) =>
    schema && typeof schema === "object"
      ? [
          schema,
          ...Object.entries(schema).flatMap(([keyword, rule]) =>
            keyword === "properties"
              ? Object.values(rule).flatMap(nodes)
              : Array.isArray(rule)
                ? rule.flatMap(nodes)
                : nodes(rule),
          ),
        ]
      : [];
  for (const { inputSchema } of Object.values(schemas)) {
    for (const node of nodes(inputSchema)) {
      for (const [keyword, rule] of Object.entries(node)) {
        // A single-keyword schema reaches that keyword's check whatever the value is.
        assert.doesNotThrow(() => schemaRefusal({ [keyword]: rule }, Symbol("probe")), keyword);
      }
    }
  }
});

test("the checker refuses a schema it cannot fully check", () => {
  assert.throws(
    () => schemaRefusal({ oneOf: [{ type: "string" }] }, "x"),
    /does not support the JSON Schema keyword oneOf/,
  );
  assert.throws(
    () => schemaRefusal({ type: ["string", "date"] }, 1),
    /does not support the JSON Schema type date/,
  );
});

test("the checker names the refused part as the core does", () => {
  const schema = schemas.compose_recipe.inputSchema;
  const input = { profile: "default", aiArtifacts: [{ id: "calavera", inputs: {} }] };
  assert.deepEqual(schemaRefusal(schema, input), {
    path: ["aiArtifacts", 0, "inputs"],
    keyword: "propertyNames",
    reason: "is not accepted here",
  });
  assert.deepEqual(schemaRefusal(schemas.search_baseline_features.inputSchema, {}), {
    path: ["query"],
    keyword: "required",
    reason: "is required",
  });
});

test("a refusal carries the core's message, with the core's error as its cause", () => {
  const schema = schemas.validate_recipe.inputSchema;
  const error = captureError(() =>
    checkToolInput(schema, { recipe: [] }, ({ recipe }) => validateRecipe(recipe)),
  );
  assert.ok(error instanceof ToolInputError);
  assert.equal(error.message, "Recipe must be an object.");
  assert.equal(error.path, "recipe");
  assert.equal(error.keyword, "type");
  assert.equal(error.cause?.message, "Recipe must be an object.");
});

test("a Node.js-only part is refused with the core's message even when the core accepts it", () => {
  const error = captureError(() =>
    checkToolInput(
      schemas.compose_recipe.inputSchema,
      { profile: "default", aiArtifacts: [{ id: "calavera", inputs: {} }] },
      () => {},
    ),
  );
  assert.ok(error instanceof ToolInputError);
  assert.equal(error.message, nodeOnlyInputMessage("aiArtifacts[0].inputs"));
  assert.equal(
    error.message,
    "Invalid aiArtifacts[0].inputs: only the Calavera MCP server accepts this field, because checking it needs Node.js. Leave it out of the Composer's tool call, or call the MCP server's tool of the same name.",
  );
  assert.equal(error.cause, undefined);
});

test("a refusal the core has no message for is described from the schema", () => {
  const schema = schemas.search_baseline_features.inputSchema;
  const error = captureError(() => checkToolInput(schema, { query: "grid", limit: 0 }, () => {}));
  assert.ok(error instanceof ToolInputError);
  assert.equal(error.message, "Invalid limit: expected a number of at least 1.");
  assert.equal(
    captureError(() => checkToolInput(schema, "grid")).message,
    "Invalid input: expected an object.",
  );
});

test("an accepted input passes through without running the core's check", () => {
  const input = { query: "grid" };
  assert.equal(
    checkToolInput(schemas.search_baseline_features.inputSchema, input, () => {
      throw new Error("The core check ran.");
    }),
    input,
  );
});

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the call to throw.");
}

test("each keyword accepts and refuses what Ajv does on its own, whatever the value's type", () => {
  const schemasByKeyword = [
    { type: "number" },
    { type: "integer" },
    { type: ["boolean", "null"] },
    { enum: ["a", 1] },
    { const: false },
    { pattern: "^\\d{4}$" },
    { pattern: "^.$" },
    { minLength: 2 },
    { minimum: 1 },
    { maximum: 100 },
    { minItems: 1 },
    { minItems: 2 },
    { items: { type: "string" } },
    { required: ["x"] },
    { properties: { x: { type: "string" } } },
    { additionalProperties: false },
    { properties: { y: {} }, additionalProperties: { type: "string" } },
    { propertyNames: { not: { enum: ["x"] } } },
    { not: { type: "string" } },
    { anyOf: [{ type: "string" }, { type: "null" }] },
  ];
  const values = [
    ...PROBES,
    100,
    100.5,
    -1,
    "😀",
    "😀😀",
    ["x", 1],
    ["x", "y"],
    { x: "y" },
    { y: 1 },
  ];
  for (const schema of schemasByKeyword) {
    const validate = ajv.compile(schema);
    for (const value of values) {
      if (value === undefined) continue;
      assert.equal(
        schemaRefusal(schema, value) === undefined,
        validate(value),
        `${JSON.stringify(schema)} ${JSON.stringify(value)}`,
      );
    }
  }
});

test("each refusal names the refused part and the rule it broke", () => {
  const cases = [
    [{ type: "string" }, 1, [], "type", "expected a string"],
    [{ type: "integer" }, 1.5, [], "type", "expected an integer"],
    [{ type: "number" }, Number.NaN, [], "type", "expected a number"],
    [{ type: ["boolean", "null"] }, 1, [], "type", "expected a boolean or a null"],
    [{ enum: ["warning", "error"] }, "info", [], "enum", "expected one of warning, error"],
    [{ const: false }, true, [], "const", "expected false"],
    [{ pattern: "^\\d{4}$" }, "20", [], "pattern", "has a value in the wrong format"],
    [{ minLength: 2 }, "😀", [], "minLength", "expected at least 2 characters"],
    [{ minimum: 1 }, 0, [], "minimum", "expected a number of at least 1"],
    [{ maximum: 100 }, 101, [], "maximum", "expected a number of at most 100"],
    [{ minItems: 1 }, [], [], "minItems", "expected at least 1 item"],
    [{ minItems: 2 }, ["x"], [], "minItems", "expected at least 2 items"],
    [{ items: { type: "string" } }, ["x", 1], [1], "type", "expected a string"],
    [{ required: ["a", "b"] }, { a: 1 }, ["b"], "required", "is required"],
    [{ properties: { a: { type: "string" } } }, { a: 1 }, ["a"], "type", "expected a string"],
    [
      { properties: { a: {} }, additionalProperties: false },
      { a: 1, b: 2 },
      ["b"],
      "additionalProperties",
      "is not a known field",
    ],
    [
      { properties: { a: {} }, additionalProperties: { type: "string" } },
      { a: 1, b: "x", c: 2 },
      ["c"],
      "type",
      "expected a string",
    ],
    [
      { propertyNames: { not: { enum: ["inputs"] } } },
      { id: "x", inputs: {} },
      ["inputs"],
      "propertyNames",
      "is not accepted here",
    ],
    [{ not: { type: "string" } }, "x", [], "not", "is not accepted here"],
    // Each branch refused the type, so the reason names both.
    [
      { anyOf: [{ type: "array" }, { type: "null" }] },
      false,
      [],
      "type",
      "expected an array or a null",
    ],
    // Not every branch refused only the type, so the first refusal at that depth stands.
    [
      { anyOf: [{ type: "string", enum: ["a"] }, { type: "integer" }] },
      "z",
      [],
      "enum",
      "expected one of a",
    ],
    // The deepest refusal is the branch the value was meant for, even when it is not the first.
    [
      { anyOf: [{ type: "null" }, { type: "array", items: { type: "string" } }] },
      ["x", 1],
      [1],
      "type",
      "expected a string",
    ],
  ];
  for (const [schema, value, path, keyword, reason] of cases) {
    assert.deepEqual(
      schemaRefusal(schema, value),
      { path, keyword, reason },
      JSON.stringify(schema),
    );
  }
  // A pattern is read as Unicode, as Ajv reads it, so "." matches one emoji.
  assert.equal(schemaRefusal({ pattern: "^.$" }, "😀"), undefined);
  assert.equal(schemaRefusal({ maximum: 100 }, 100), undefined);
});

test("a refusal falls back to the schema's description when the core gives no Error", () => {
  const schema = schemas.search_baseline_features.inputSchema;
  for (const coreCheck of [
    undefined,
    () => {},
    () => {
      throw "not an Error";
    },
  ]) {
    const error = captureError(() =>
      checkToolInput(schema, { query: "grid", limit: 101 }, coreCheck),
    );
    assert.equal(error.name, "ToolInputError");
    assert.equal(error.message, "Invalid limit: expected a number of at most 100.");
    assert.equal(error.path, "limit");
    assert.equal(error.keyword, "maximum");
    assert.equal("cause" in error, false);
  }
});

test("the core's check does not run on an input that is not an object", () => {
  const error = captureError(() =>
    checkToolInput(schemas.search_baseline_features.inputSchema, "grid", () => {
      throw new Error("The core check ran.");
    }),
  );
  assert.equal(error.message, "Invalid input: expected an object.");
  assert.equal(error.path, "");
});
