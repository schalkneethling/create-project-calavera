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
import { sharedToolSchemas, toolJsonSchema, webMcpToolSchemas } from "../src/tool-schemas.js";

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
    if (!validateRecipeResponse(recipe).ok) throw new Error("validate_recipe refused the recipe");
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
    assert.deepEqual(webMcpSchemas[name].outputSchema, mcpTools.get(name)?.outputSchema, name);
  }
  assert.ok(webMcpSchemas.list_integrations.outputSchema);
  // The Stryker entry's test runners are the fields integrationOptions.stryker refers to.
  const runner = webMcpSchemas.describe_integration.outputSchema.properties.testRunners.items;
  assert.deepEqual(runner.required, ["id", "label", "dependencies", "testFiles"]);
});

test("MCP and WebMCP declare the same input schema apart from the Node.js-only artifact inputs", () => {
  for (const name of Object.keys(sharedToolSchemas)) {
    const mcpInput = structuredClone(mcpTools.get(name)?.inputSchema);
    if (name === "compose_recipe") {
      assert.equal(mcpInput.properties.aiArtifacts.items.properties.inputs.type, "object");
      mcpInput.properties.aiArtifacts.items.properties.inputs = false;
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

test("both declared schemas refuse the same inputs the core refuses", () => {
  const refused = [
    ["compose_recipe", {}],
    ["compose_recipe", { profile: "default", packageManager: "deno" }],
    ["compose_recipe", { profile: "default", integrationOptions: { eslint: {} } }],
    // #1027: available is required.
    ["compose_recipe", { profile: "default", integrationOptions: { "stylelint-baseline": {} } }],
    [
      "compose_recipe",
      {
        profile: "default",
        integrationOptions: { "stylelint-baseline": { available: "newly", severity: "info" } },
      },
    ],
    [
      "compose_recipe",
      {
        profile: "default",
        tools: ["html-validate"],
        integrationOptions: { "html-validate": { quality: "no" } },
      },
    ],
    [
      "compose_recipe",
      {
        profile: "default",
        tools: ["stryker"],
        integrationOptions: { stryker: { testRunner: "jest" } },
      },
    ],
    [
      "compose_recipe",
      {
        profile: "default",
        tools: ["github-repository-controls"],
        integrationOptions: {
          "github-repository-controls": { ...githubControls, codeqlLanguages: ["cobol"] },
        },
      },
    ],
    [
      "compose_recipe",
      {
        profile: "default",
        tools: ["github-repository-controls"],
        integrationOptions: { "github-repository-controls": { repository: "no-slash" } },
      },
    ],
    [
      "compose_recipe",
      {
        profile: "default",
        tools: ["github-repository-controls"],
        integrationOptions: {
          "github-repository-controls": { ...githubControls, releaseEnvironment: {} },
        },
      },
    ],
    [
      "compose_recipe",
      {
        profile: "default",
        tools: ["github-repository-controls"],
        integrationOptions: { "github-repository-controls": { ...githubControls, wiki: "yes" } },
      },
    ],
    ["describe_baseline_target", { target: "someday" }],
    ...["x2024", "20245"].map((available) => [
      "compose_recipe",
      { profile: "default", integrationOptions: { "stylelint-baseline": { available } } },
    ]),
    ...[-1, 43_201].map((waitTimer) => [
      "compose_recipe",
      {
        profile: "default",
        tools: ["github-repository-controls"],
        integrationOptions: {
          "github-repository-controls": {
            ...githubControls,
            releaseEnvironment: { reviewers: ["octocat"], waitTimer },
          },
        },
      },
    ]),
    ["explain_recipe", {}],
    [
      "compose_recipe",
      {
        profile: "default",
        tools: ["github-repository-controls"],
        integrationOptions: {
          "github-repository-controls": {
            ...githubControls,
            releaseEnvironment: { reviewers: [] },
          },
        },
      },
    ],
    ["recommend_baseline_target", { features: [] }],
    ["describe_integration", {}],
    ["validate_recipe", { recipe: [] }],
  ];

  for (const [tool, input] of refused) {
    assert.throws(
      () => coreCalls[tool](structuredClone(input)),
      `core ${tool}: ${JSON.stringify(input)}`,
    );
    assert.equal(mcpAccepts(tool, input), false, `MCP ${tool}: ${JSON.stringify(input)}`);
    assert.equal(webMcpAccepts(tool, input), false, `WebMCP ${tool}: ${JSON.stringify(input)}`);
  }
});

test("both declared schemas refuse a few inputs the core tolerates, as both surfaces did before", () => {
  // The core falls back to its default limit and lists no integrations for an unknown profile,
  // but the schemas the two surfaces declared before #1051 already refused these.
  const tolerated = [
    ["search_baseline_features", { query: "grid", limit: 0 }],
    ["search_baseline_features", { query: "grid", limit: 101 }],
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

test("the MCP server answers a refused option with the core's message", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "compose_recipe",
      arguments: {
        profile: "default",
        tools: ["github-repository-controls"],
        integrationOptions: {
          "github-repository-controls": { ...githubControls, codeqlLanguages: ["cobol"] },
        },
      },
    });
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /Invalid github-repository-controls\.codeqlLanguages: cobol\. at integrationOptions\.github-repository-controls\.codeqlLanguages\[0\]/,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("each refused option field reports the core's message for that field", () => {
  const cases = [
    [{ "stylelint-baseline": { available: "someday" } }, /^Baseline target must be widely/],
    [{ "stylelint-baseline": { available: 2024.5 } }, /^Baseline target must be widely/],
    [
      { "github-repository-controls": { ...githubControls, codeqlLanguages: ["cobol"] } },
      /Invalid github-repository-controls\.codeqlLanguages: cobol\./,
    ],
    [
      { "stylelint-baseline": { available: "widely", severity: "info" } },
      /severity must be warning or error/,
    ],
    [{ stryker: { testRunner: "jest" } }, /stryker\.testRunner is "jest"/],
    [{ stryker: { testFiles: [] } }, /testFiles must list at least one glob/],
    [{ stryker: { testFiles: [""] } }, /testFiles must list at least one glob/],
    [
      { "github-repository-controls": { repository: "nope" } },
      /repository must use owner\/name format/,
    ],
    [
      { "github-repository-controls": { ...githubControls, defaultBranch: " " } },
      /defaultBranch must be a non-empty string/,
    ],
    [
      { "github-repository-controls": { ...githubControls, requiredChecks: [" "] } },
      /requiredChecks must be an array of non-empty strings/,
    ],
    [
      { "github-repository-controls": { ...githubControls, mergeMethods: ["fast"] } },
      /Invalid github-repository-controls\.mergeMethods: fast\./,
    ],
    [
      { "github-repository-controls": { ...githubControls, mergeMethods: [] } },
      /mergeMethods must contain at least one method/,
    ],
    [
      { "github-repository-controls": { ...githubControls, codeqlQuerySuite: "x" } },
      /codeqlQuerySuite must be default or extended/,
    ],
    [
      { "github-repository-controls": { ...githubControls, releaseEnvironment: {} } },
      /reviewers must contain at least one GitHub login/,
    ],
    [
      {
        "github-repository-controls": { ...githubControls, releaseEnvironment: { reviewers: [] } },
      },
      /reviewers must contain at least one GitHub login/,
    ],
    [
      {
        "github-repository-controls": {
          ...githubControls,
          releaseEnvironment: { reviewers: [" "] },
        },
      },
      /reviewers must be an array of non-empty strings/,
    ],
    [
      {
        "github-repository-controls": {
          ...githubControls,
          releaseEnvironment: { name: " ", reviewers: ["octocat"] },
        },
      },
      /releaseEnvironment\.name must be a non-empty string/,
    ],
    [
      {
        "github-repository-controls": {
          ...githubControls,
          releaseEnvironment: { reviewers: ["octocat"], branches: [] },
        },
      },
      /branches must contain at least one branch/,
    ],
    [
      {
        "github-repository-controls": {
          ...githubControls,
          releaseEnvironment: { reviewers: ["octocat"], branches: [" "] },
        },
      },
      /branches must be an array of non-empty strings/,
    ],
    [
      {
        "github-repository-controls": {
          ...githubControls,
          releaseEnvironment: { reviewers: ["octocat"], waitTimer: -1 },
        },
      },
      /waitTimer must be an integer from 0 to 43200/,
    ],
  ];

  for (const [integrationOptions, message] of cases) {
    const result = sharedToolSchemas.compose_recipe.input.safeParse({
      profile: "default",
      integrationOptions,
    });
    assert.equal(result.success, false, JSON.stringify(integrationOptions));
    assert.match(
      result.error.issues.map((issue) => issue.message).join("\n"),
      message,
      JSON.stringify(integrationOptions),
    );
  }
});

test("a profile that is not a string gets the schema's message, not the removed-profile one", () => {
  const result = sharedToolSchemas.compose_recipe.input.safeParse({ profile: 5 });
  assert.equal(result.success, false);
  assert.doesNotMatch(result.error.issues[0].message, /profile must be a string/);
});

test("only the MCP schema accepts the Node.js-only artifact inputs", () => {
  const input = {
    profile: "default",
    aiArtifacts: [{ id: "skill-protected-branch-guard", inputs: { protectedBranch: "main" } }],
  };
  assert.equal(mcpAccepts("compose_recipe", input), true);
  assert.equal(webMcpAccepts("compose_recipe", input), false);
});

test("the CodeQL language list reaches both surfaces from the repository-controls module", () => {
  const languagesIn = (schema) =>
    schema.properties.integrationOptions.properties["github-repository-controls"].properties
      .codeqlLanguages.items.anyOf[0].enum;

  assert.deepEqual(languagesIn(mcpTools.get("compose_recipe")?.inputSchema), [...CODEQL_LANGUAGES]);
  assert.deepEqual(languagesIn(webMcpSchemas.compose_recipe.inputSchema), [...CODEQL_LANGUAGES]);
});
