// ADR-0018 Decisions 2 and 5 (#1051): each tool the MCP server and the Composer's WebMCP tools
// share by name takes its input and output schemas from one definition in tool-schemas.js. The
// Composer's Playwright suite checks that the page registers `webMcpToolSchemas()`; this file
// checks that the MCP server registers the same definitions, and that both forms accept the same
// inputs apart from the parts marked Node.js-only.
import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  describeBaselineTarget,
  recommendBaselineTarget,
} from "@schalkneethling/calavera-baseline-core";
import Ajv from "ajv";
import * as z from "zod";

import { CODEQL_LANGUAGES } from "../src/github-repository-controls-options.js";
import { createMcpServer } from "../src/mcp.js";
import {
  composeRecipeResponse,
  describeIntegrationResponse,
  explainRecipeResponse,
  recipeCompositionToolNames,
  validateRecipeResponse,
} from "../src/recipe.js";
import {
  nodeOnly,
  sharedToolSchemas,
  toolJsonSchema,
  webMcpToolSchemas,
} from "../src/tool-schemas.js";

async function listMcpTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((tool) => [tool.name, tool]));
  } finally {
    await client.close();
    await server.close();
  }
}

const mcpTools = await listMcpTools();
const webMcpSchemas = webMcpToolSchemas();
const ajv = new Ajv({ allErrors: true, strict: false });

/** @param {string} tool @param {unknown} input */
function mcpAccepts(tool, input) {
  return sharedToolSchemas[tool].input.safeParse(input).success;
}

/** @param {string} tool @param {unknown} input */
function webMcpAccepts(tool, input) {
  return ajv.validate(webMcpSchemas[tool].inputSchema, input);
}

// The core call behind each tool, for checking that the core refuses an input too.
const coreCalls = {
  compose_recipe: (input) => composeRecipeResponse(input),
  describe_baseline_target: ({ target }) => describeBaselineTarget(target),
  recommend_baseline_target: ({ features }) => recommendBaselineTarget(features),
  describe_integration: ({ id }) => describeIntegrationResponse(id),
  explain_recipe: ({ recipe }) => explainRecipeResponse(recipe),
  validate_recipe: ({ recipe }) => {
    const validation = validateRecipeResponse(recipe);
    if (!validation.ok) throw new Error(validation.errors[0]);
  },
};

const githubControls = { repository: "octo/repo" };

// Inputs the core accepts. Each is checked against the core below, so an entry the core refuses
// fails that test instead of proving nothing here.
const coreAcceptedComposeInputs = [
  { profile: "default" },
  { profile: "default", packageManager: "pnpm", tools: ["CSS Baseline"] },
  // #1027: severity is optional, and normalizeBaselineTarget reads a year written as a string.
  { profile: "default", integrationOptions: { "stylelint-baseline": { available: "newly" } } },
  { profile: "default", integrationOptions: { "stylelint-baseline": { available: "2024" } } },
  {
    profile: "default",
    integrationOptions: { "stylelint-baseline": { available: 2024, severity: "error" } },
  },
  {
    profile: "default",
    tools: ["stylelint-baseline", "html-validate"],
    integrationOptions: { "html-validate": { quality: false } },
  },
  {
    profile: "default",
    tools: ["stryker"],
    integrationOptions: {
      stryker: { testRunner: "node:test", testFiles: ["tests/**/*.mjs", "test/*.mjs"] },
    },
  },
  // The core trims the repository and each list value, and removes duplicates.
  {
    profile: "default",
    tools: ["github-repository-controls"],
    integrationOptions: {
      "github-repository-controls": {
        repository: " octo/repo ",
        defaultBranch: "trunk",
        requiredChecks: [],
        mergeMethods: [" squash", "merge"],
        dependabotEcosystems: ["npm", "npm"],
        codeqlLanguages: ["go ", "actions"],
        codeqlQuerySuite: "default",
        releaseEnvironment: {
          reviewers: ["octocat", "hubot"],
          waitTimer: 43_200,
          branches: ["main", "release"],
        },
      },
    },
  },
  {
    profile: "default",
    tools: ["github-repository-controls"],
    integrationOptions: {
      "github-repository-controls": { ...githubControls, releaseEnvironment: false },
    },
  },
  {
    profile: "default",
    tools: ["github-repository-controls"],
    integrationOptions: {
      "github-repository-controls": { ...githubControls, releaseEnvironment: null },
    },
  },
  // The core reads these fields with ??, so null selects the default.
  {
    profile: "default",
    tools: ["stylelint-baseline", "html-validate"],
    integrationOptions: {
      "stylelint-baseline": { available: "widely", severity: null },
      "html-validate": { quality: null },
    },
  },
  {
    profile: "default",
    tools: ["github-repository-controls"],
    integrationOptions: {
      "github-repository-controls": {
        ...githubControls,
        codeqlQuerySuite: null,
        releaseEnvironment: { reviewers: ["octocat"], waitTimer: null },
      },
    },
  },
  // The core reads a falsy tools or aiArtifacts as absent.
  { profile: "default", tools: null },
  { profile: "default", aiArtifacts: null },
  // compose_recipe ignores a key it does not read, at the top level and on an artifact.
  { profile: "default", unknown: true },
  { profile: "default", aiArtifacts: [{ id: "skill-calavera", note: "kept out" }] },
];

test("the shared tool definitions name exactly the tools both surfaces share", () => {
  assert.deepEqual(Object.keys(sharedToolSchemas), [...recipeCompositionToolNames]);
});

test("the MCP server advertises each shared tool's core input and output schema", () => {
  for (const [name, { input, output }] of Object.entries(sharedToolSchemas)) {
    const tool = mcpTools.get(name);
    assert.deepEqual(tool?.inputSchema, toolJsonSchema(input, { io: "input" }), name);
    assert.deepEqual(
      tool?.outputSchema,
      output ? toolJsonSchema(output, { io: "output" }) : undefined,
      name,
    );
  }
});

test("MCP and WebMCP declare the same output schema for each shared tool", () => {
  for (const name of Object.keys(sharedToolSchemas)) {
    // The WebMCP form leaves out only the $schema key, because registerTool takes the schema itself.
    const expected = structuredClone(mcpTools.get(name)?.outputSchema);
    if (expected) delete expected.$schema;
    assert.deepEqual(webMcpSchemas[name].outputSchema, expected, name);
  }
  assert.ok(webMcpSchemas.list_integrations.outputSchema);
  // The Stryker entry's test runners are the fields integrationOptions.stryker refers to.
  const runner = webMcpSchemas.describe_integration.outputSchema.properties.testRunners.items;
  assert.deepEqual(runner.required, ["id", "label", "dependencies", "testFiles"]);
});

test("MCP and WebMCP declare the same input schema apart from the Node.js-only artifact inputs", () => {
  for (const name of Object.keys(sharedToolSchemas)) {
    const mcpInput = structuredClone(mcpTools.get(name)?.inputSchema);
    assert.equal(mcpInput.$schema, "http://json-schema.org/draft-07/schema#", name);
    delete mcpInput.$schema;
    if (name === "compose_recipe") {
      // ADR-0018 Decision 2: the WebMCP adapter leaves the Node.js-only part out, and refuses it.
      const item = mcpInput.properties.aiArtifacts.anyOf[0].items;
      assert.equal(item.properties.inputs.type, "object");
      delete item.properties.inputs;
      item.propertyNames = { not: { enum: ["inputs"] } };
    }
    assert.deepEqual(webMcpSchemas[name].inputSchema, mcpInput, name);
  }
});

test("every compose_recipe input the core accepts passes both declared schemas", () => {
  for (const input of coreAcceptedComposeInputs) {
    assert.doesNotThrow(() => composeRecipeResponse(structuredClone(input)), JSON.stringify(input));
    assert.equal(mcpAccepts("compose_recipe", input), true, `MCP: ${JSON.stringify(input)}`);
    assert.equal(webMcpAccepts("compose_recipe", input), true, `WebMCP: ${JSON.stringify(input)}`);
  }
});

test("both declared schemas accept the other shared tools' valid inputs", () => {
  const accepted = [
    ["list_profiles", {}],
    ["list_integrations", {}],
    ["list_integrations", { profile: "minimal" }],
    ["describe_integration", { id: "stylelint" }],
    ["list_ai_artifacts", {}],
    ["list_baseline_targets", {}],
    ["describe_baseline_target", { target: "widely" }],
    ["describe_baseline_target", { target: "newly" }],
    ["describe_baseline_target", { target: 2024 }],
    // normalizeBaselineTarget reads a four-digit year written as a string.
    ["describe_baseline_target", { target: "2024" }],
    ["search_baseline_features", { query: "grid" }],
    ["search_baseline_features", { query: "grid", limit: 5 }],
    ["search_baseline_features", { query: "grid", limit: 100 }],
    ["recommend_baseline_target", { features: ["grid"] }],
    ["validate_recipe", { recipe: { profile: "default" } }],
    ["explain_recipe", { recipe: { profile: "default" } }],
  ];

  for (const [tool, input] of accepted) {
    assert.equal(mcpAccepts(tool, input), true, `MCP ${tool}: ${JSON.stringify(input)}`);
    assert.equal(webMcpAccepts(tool, input), true, `WebMCP ${tool}: ${JSON.stringify(input)}`);
  }
});

test("compose_recipe defaults packageManager to npm, as the core does", () => {
  assert.equal(webMcpSchemas.compose_recipe.inputSchema.properties.packageManager.default, "npm");
  assert.equal(composeRecipeResponse({ profile: "default" }).recipe.packageManager, "npm");
});

/** @param {Record<string, unknown>} fields */
const compose = (fields) => ["compose_recipe", { profile: "default", ...fields }];
/** @param {string} id @param {unknown} options */
const option = (id, options) => compose({ tools: [id], integrationOptions: { [id]: options } });
/** @param {Record<string, unknown>} fields */
const github = (fields) => option("github-repository-controls", { ...githubControls, ...fields });
/** @param {Record<string, unknown>} fields */
const releaseEnvironment = (fields) =>
  github({ releaseEnvironment: { reviewers: ["octocat"], ...fields } });
/** @param {Record<string, unknown>} fields */
const nodeTest = (fields) => option("stryker", { testRunner: "node:test", ...fields });

// Inputs the core refuses, one fault each: unknown keys, wrong container types, and wrong values.
const refused = [
  ["compose_recipe", {}],
  compose({ profile: 5 }),
  compose({ profile: "not-a-profile" }),
  compose({ packageManager: "deno" }),
  compose({ tools: "stylelint" }),
  compose({ tools: [5] }),
  compose({ aiArtifacts: "skill-calavera" }),
  compose({ aiArtifacts: [5] }),
  compose({ aiArtifacts: [{}] }),
  compose({ aiArtifacts: [{ id: "skill-calavera" }, { id: 5 }] }),
  compose({ aiArtifacts: [{ id: "hook-block-dangerous-commands", target: 5 }] }),
  compose({ aiArtifacts: [{ id: "skill-protected-branch-guard", inputs: "main" }] }),
  compose({
    aiArtifacts: [
      { id: "skill-calavera" },
      { id: "skill-protected-branch-guard", inputs: { protectedBranch: 5 } },
    ],
  }),
  compose({ integrationOptions: [] }),
  compose({ integrationOptions: { eslint: {} } }),
  option("stylelint-baseline", "widely"),
  option("stylelint-baseline", { available: "widely", level: "error" }),
  // #1027: available is required.
  option("stylelint-baseline", {}),
  ...["someday", "x2024", "20245", 2024.5].map((available) =>
    option("stylelint-baseline", { available }),
  ),
  option("stylelint-baseline", { available: "newly", severity: "info" }),
  option("html-validate", "no"),
  option("html-validate", { quality: true, strict: true }),
  option("html-validate", { quality: "no" }),
  option("stryker", "vitest"),
  option("stryker", { runner: "vitest" }),
  option("stryker", { testRunner: "jest" }),
  nodeTest({ testFiles: "tests/**/*.mjs" }),
  nodeTest({ testFiles: [] }),
  nodeTest({ testFiles: [""] }),
  nodeTest({ testFiles: [5] }),
  option("github-repository-controls", "octo/repo"),
  option("github-repository-controls", {}),
  github({ colour: "blue" }),
  github({ repository: "no-slash" }),
  github({ repository: 5 }),
  github({ defaultBranch: " " }),
  github({ requiredChecks: "ci" }),
  github({ requiredChecks: [" "] }),
  ...[
    ["mergeMethods", "fast"],
    ["dependabotEcosystems", "pip"],
    ["codeqlLanguages", "cobol"],
  ].flatMap(([field, unknown]) => [
    github({ [field]: unknown }),
    github({ [field]: [] }),
    github({ [field]: [unknown] }),
    github({ [field]: [5] }),
  ]),
  github({ codeqlQuerySuite: "x" }),
  ...[
    "requireCodeqlResults",
    "wiki",
    "projects",
    "autoMerge",
    "deleteBranchOnMerge",
    "updateBranch",
  ].map((field) => github({ [field]: "yes" })),
  github({ releaseEnvironment: true }),
  github({ releaseEnvironment: "release" }),
  github({ releaseEnvironment: {} }),
  releaseEnvironment({ colour: "blue" }),
  releaseEnvironment({ reviewers: "octocat" }),
  releaseEnvironment({ reviewers: [] }),
  releaseEnvironment({ reviewers: [" "] }),
  releaseEnvironment({ name: " " }),
  ...[-1, 43_201, 1.5, "60"].map((waitTimer) => releaseEnvironment({ waitTimer })),
  releaseEnvironment({ preventSelfReview: "yes" }),
  releaseEnvironment({ branches: "main" }),
  releaseEnvironment({ branches: [] }),
  releaseEnvironment({ branches: [" "] }),
  ["describe_integration", {}],
  ["describe_integration", { id: 5 }],
  ["describe_baseline_target", {}],
  ["describe_baseline_target", { target: "someday" }],
  ["describe_baseline_target", { target: 5.5 }],
  ["recommend_baseline_target", { features: [] }],
  ["recommend_baseline_target", { features: "grid" }],
  ["recommend_baseline_target", { features: [5] }],
  ["validate_recipe", {}],
  ["validate_recipe", { recipe: [] }],
  ["explain_recipe", {}],
  ["explain_recipe", { recipe: "default" }],
];

test("both declared schemas refuse each input the core refuses, and MCP answers with the core's message", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const [tool, input] of refused) {
      const label = `${tool}: ${JSON.stringify(input)}`;
      let coreMessage;
      try {
        coreCalls[tool](structuredClone(input));
      } catch (error) {
        coreMessage = error.message;
      }
      assert.equal(typeof coreMessage, "string", `the core refuses ${label}`);
      assert.equal(mcpAccepts(tool, input), false, `MCP ${label}`);
      assert.equal(webMcpAccepts(tool, input), false, `WebMCP ${label}`);

      // ADR-0018 Decision 2 (#1051 owner decision of 2026-11-22): the SDK's invalid-arguments
      // envelope carries the core's own message for the refused field.
      const result = await client.callTool({ name: tool, arguments: input });
      assert.equal(result.isError, true, label);
      const [text] = result.content.map(({ text }) => text);
      const prefix = `MCP error -32602: Input validation error: Invalid arguments for tool ${tool}: `;
      assert.ok(text.startsWith(prefix), `${label}\n${text}`);
      // One fault, so one issue line, and it is the core's message followed by the path.
      const lines = text.slice(prefix.length).split("\n");
      assert.equal(lines.length, 1, `${label}\n${text}`);
      assert.ok(
        lines[0].startsWith(`${coreMessage} at `),
        `${label}\nexpected: ${coreMessage}\nactual: ${lines[0]}`,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("both declared schemas refuse a few inputs the core tolerates, as both surfaces did before", () => {
  // The core reads any query, falls back to its default limit, and lists no integrations for an
  // unknown profile, so these refusals have no core message to carry. The schemas the two surfaces
  // declared before #1051 already refused them.
  const tolerated = [
    ["search_baseline_features", { query: "grid", limit: 0 }],
    ["search_baseline_features", { query: "grid", limit: 101 }],
    ["search_baseline_features", {}],
    ["search_baseline_features", { query: 5 }],
    ["list_integrations", { profile: "not-a-profile" }],
  ];

  for (const [tool, input] of tolerated) {
    assert.equal(mcpAccepts(tool, input), false, `MCP ${tool}: ${JSON.stringify(input)}`);
    assert.equal(webMcpAccepts(tool, input), false, `WebMCP ${tool}: ${JSON.stringify(input)}`);
  }
});

test("no shared schema holds a check that its JSON Schema form cannot carry", () => {
  // The MCP server validates with the Zod schema and the Composer declares its JSON Schema form,
  // and toJSONSchema leaves out a refinement or a transform, so one would make MCP refuse an
  // input that WebMCP declares acceptable without failing the comparisons above.
  const seen = new Set();
  /** @param {unknown} value @param {string} path */
  function visit(value, path) {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof z.ZodType) {
      const { def } = value._zod;
      assert.ok(!["pipe", "transform", "custom"].includes(def.type), `${path} is a ${def.type}`);
      for (const check of def.checks ?? []) {
        assert.notEqual(check._zod.def.check, "custom", `${path} has a refinement`);
      }
      for (const [key, child] of Object.entries(def)) visit(child, `${path}.${key}`);
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  }
  for (const [name, schemas] of Object.entries(sharedToolSchemas)) visit(schemas, name);
  assert.ok(seen.size > 100, "the walk reached the nested schemas");
});

test("only the MCP schema accepts the Node.js-only artifact inputs", () => {
  const input = {
    profile: "default",
    aiArtifacts: [{ id: "skill-protected-branch-guard", inputs: { protectedBranch: "main" } }],
  };
  assert.equal(mcpAccepts("compose_recipe", input), true);
  assert.equal(webMcpAccepts("compose_recipe", input), false);
});

test("the browser form refuses to leave out a required Node.js-only property", () => {
  // The browser form refuses a Node.js-only property, so a required one could never be satisfied.
  const optional = z.object({ id: z.string(), inputs: nodeOnly(z.string().optional()) });
  assert.deepEqual(toolJsonSchema(optional, { io: "input", browser: true }).propertyNames, {
    not: { enum: ["inputs"] },
  });

  const noneRequired = z.object({ inputs: nodeOnly(z.string().optional()) });
  assert.deepEqual(toolJsonSchema(noneRequired, { io: "input", browser: true }).properties, {});

  const required = z.object({
    id: z.string(),
    inputs: nodeOnly(z.string()),
    secrets: nodeOnly(z.string()),
  });
  assert.throws(() => toolJsonSchema(required, { io: "input", browser: true }), {
    message: "A Node.js-only property must be optional: inputs, secrets.",
  });
  assert.deepEqual(toolJsonSchema(required, { io: "input" }).required, ["id", "inputs", "secrets"]);
});

test("the CodeQL language list reaches both surfaces from the repository-controls module", () => {
  const languagesIn = (schema) =>
    schema.properties.integrationOptions.properties["github-repository-controls"].properties
      .codeqlLanguages.items.anyOf[0].enum;

  assert.deepEqual(languagesIn(mcpTools.get("compose_recipe")?.inputSchema), [...CODEQL_LANGUAGES]);
  assert.deepEqual(languagesIn(webMcpSchemas.compose_recipe.inputSchema), [...CODEQL_LANGUAGES]);
});
