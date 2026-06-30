import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Ajv2020 from "ajv/dist/2020.js";

import { buildAiApplyResult, createCodexAgentToml } from "../src/ai/artifacts.js";
import { aiArtifactCatalog, DEFAULT_AI_TARGET } from "../src/ai/catalog.js";
import { integrationCatalog } from "../src/catalog.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool, createMcpServer } from "../src/mcp.js";
import { createEmptyState } from "../src/state.js";
import {
  assertKnownValue,
  assertObjectArray,
  assertPlainObject,
  assertString,
  assertStringArray,
} from "../src/utils/assertions.js";
import {
  aiArtifactRecipeItems,
  buildRecipe,
  catalogResponse,
  composeRecipe,
  composeRecipeResponse,
  CONFIG_SCHEMA_URL,
  describeIntegrationResponse,
  explainRecipeIntegrations,
  explainRecipeResponse,
  listIntegrationOptions,
  listIntegrationsResponse,
  listAiArtifactsResponse,
  listProfilesResponse,
  normalizeAiArtifactInputs,
  normalizeIntegrationInputs,
  profileDefaults,
  recipeWorkflow,
  recipeToolDescriptions,
  resolveRecipeIntegrations,
  standardMcpToolNames,
  validateRecipe,
  validateRecipeCompositionInput,
  validateRecipeResponse,
  webMcpToolNames,
} from "../src/recipe.js";

const schemaUrl = CONFIG_SCHEMA_URL;
const rootProperties = [
  "$schema",
  "version",
  "profile",
  "packageManager",
  "integrations",
  "scripts",
  "ai",
];
const requiredProperties = ["version", "profile", "packageManager", "integrations", "scripts"];
const profiles = ["modern", "classic", "minimal"];
const packageManagers = ["npm", "pnpm", "yarn", "bun"];
const scriptFlags = ["lint", "lint:fix", "format", "format:check", "typecheck", "quality"];

async function readProjectFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function readProjectJson(path) {
  return JSON.parse(await readProjectFile(path));
}

const schema = await readProjectJson("web/public/calavera.config.schema.json");
const config = await readProjectJson("calavera.config.json");
const integrationIds = integrationCatalog.map(({ id }) => id);
const schemaProperties = schema.properties ?? {};
const scriptProperties = schemaProperties.scripts?.properties ?? {};
const schemaIntegrationIds = schema.$defs?.integrationId?.enum;
const ajv = new Ajv2020({ allErrors: true, validateFormats: false });

function assertValid(validate, value) {
  assert.equal(validate(value), true, ajv.errorsText(validate.errors));
}

test("config schema is the published draft 2020-12 schema", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, schemaUrl);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schemaProperties.$schema?.const, schemaUrl);
  assert.equal(schemaProperties.version?.const, 1);
});

test("published config schema is valid JSON Schema and validates the example config", () => {
  assert.equal(ajv.validateSchema(schema), true, ajv.errorsText(ajv.errors));

  const validate = ajv.compile(schema);

  assertValid(validate, config);
  assertValid(validate, buildRecipe("modern", ["editorconfig"], "pnpm"));
  assertValid(
    validate,
    buildRecipe("modern", ["editorconfig"], "pnpm", [
      { type: "skill", src: "skills/semantic-html" },
      { type: "hook", src: "hooks/block-dangerous-commands", target: DEFAULT_AI_TARGET },
      { type: "agent", src: "agents/technical-devils-advocate.md", target: "codex" },
    ]),
  );
});

test("config schema root shape matches the maintained recipe contract", () => {
  assert.deepEqual(Object.keys(schemaProperties), rootProperties);
  assert.deepEqual(schema.required, requiredProperties);
  assert.deepEqual(schemaProperties.profile?.enum, profiles);
  assert.deepEqual(schemaProperties.packageManager?.enum, packageManagers);
});

test("config schema integration enum stays in catalog order", () => {
  assert.deepEqual(schemaIntegrationIds, integrationIds);
});

test("AI artifact catalog exposes unique complete recipe items", async () => {
  const ids = new Set();

  for (const artifact of aiArtifactCatalog) {
    const sourceStats = await stat(new URL(`../src/ai/${artifact.src}`, import.meta.url));

    assert.equal(typeof artifact.id, "string");
    assert.equal(typeof artifact.label, "string");
    assert.equal(typeof artifact.group, "string");
    assert.equal(artifact.status, "bundled");
    assert.ok(["skill", "hook", "agent"].includes(artifact.type));
    assert.equal(ids.has(artifact.id), false, `Duplicate AI artifact id: ${artifact.id}`);

    if (artifact.type === "skill") {
      assert.match(artifact.src, /^skills\/[^/]+$/);
      assert.equal(artifact.defaultTarget, undefined);
      assert.equal(sourceStats.isDirectory(), true);
    } else if (artifact.type === "hook") {
      assert.match(artifact.src, /^hooks\/[^/]+$/);
      assert.equal(artifact.defaultTarget, DEFAULT_AI_TARGET);
      assert.equal(sourceStats.isDirectory(), true);
    } else {
      assert.match(artifact.src, /^agents\/[^/]+\.md$/);
      assert.equal(artifact.defaultTarget, DEFAULT_AI_TARGET);
      assert.equal(sourceStats.isFile(), true);
    }

    ids.add(artifact.id);
  }
});

test("config schema defines known boolean script flags", () => {
  for (const flag of scriptFlags) {
    assert.equal(scriptProperties[flag]?.type, "boolean");
  }
});

test("checked-in example config matches the maintained schema constants and enums", () => {
  assert.equal(config.$schema, schemaUrl);
  assert.equal(config.version, 1);
  assert.ok(profiles.includes(config.profile), `Unsupported profile: ${config.profile}.`);
  assert.ok(
    packageManagers.includes(config.packageManager),
    `Unsupported package manager: ${config.packageManager}.`,
  );
});

test("checked-in example config uses known unique integrations", () => {
  assert.ok(Array.isArray(config.integrations), "config integrations must be an array.");

  const uniqueIntegrationIds = new Set(config.integrations);
  const unknownIntegrationIds = config.integrations.filter(
    (id) => !schemaIntegrationIds.includes(id),
  );

  assert.equal(uniqueIntegrationIds.size, config.integrations.length);
  assert.deepEqual(unknownIntegrationIds, []);
});

test("checked-in example config uses known boolean script flags", () => {
  for (const flag of scriptFlags) {
    assert.equal(typeof config.scripts?.[flag], "boolean", `scripts.${flag} must be boolean.`);
  }
});

test("generated recipes reference the published schema URL", () => {
  const recipe = buildRecipe("modern", ["editorconfig"], "pnpm");

  assert.equal(recipe.$schema, schemaUrl);
});

test("shared composition uses profile defaults when tools are omitted", () => {
  assert.deepEqual(composeRecipe({ profile: "minimal" }), buildRecipe("minimal", ["editorconfig"]));
  assert.deepEqual(composeRecipe({ profile: "modern" }).integrations, profileDefaults.modern);
});

test("shared composition normalizes explicit tool labels and package managers", () => {
  const input = validateRecipeCompositionInput({
    profile: "classic",
    packageManager: "pnpm",
    tools: ["TypeScript type checking", "ESLint flat config", "Prettier"],
  });

  assert.deepEqual(input, {
    profile: "classic",
    packageManager: "pnpm",
    tools: ["typescript", "eslint", "prettier"],
    aiArtifacts: undefined,
  });
});

test("shared composition resolves duplicate tool labels within the active profile", () => {
  assert.deepEqual(normalizeIntegrationInputs(["Accessibility"], "modern"), ["oxlint-jsx-a11y"]);
  assert.deepEqual(normalizeIntegrationInputs(["Accessibility"], "classic"), ["eslint-jsx-a11y"]);
});

test("shared composition copies profile defaults before returning recipes", () => {
  const recipe = composeRecipe({ profile: "minimal" });
  recipe.integrations.push("mutated");

  assert.deepEqual(profileDefaults.minimal, ["editorconfig"]);
  assert.notEqual(composeRecipe({ profile: "modern" }).integrations, profileDefaults.modern);
});

test("shared composition normalizes AI artifact inputs into recipe items", () => {
  const input = normalizeAiArtifactInputs([
    { id: "Semantic HTML" },
    { id: "hooks/block-dangerous-commands", target: "codex" },
    { id: "Technical devil's advocate" },
  ]);

  assert.deepEqual(input, [
    { id: "skill-semantic-html", target: undefined },
    { id: "hook-block-dangerous-commands", target: "codex" },
    { id: "agent-technical-devils-advocate", target: DEFAULT_AI_TARGET },
  ]);
  assert.deepEqual(aiArtifactRecipeItems(input), [
    { type: "skill", src: "skills/semantic-html" },
    { type: "hook", src: "hooks/block-dangerous-commands", target: "codex" },
    {
      type: "agent",
      src: "agents/technical-devils-advocate.md",
      target: DEFAULT_AI_TARGET,
    },
  ]);
});

test("shared composition rejects whitespace-padded unsafe AI artifact targets", () => {
  for (const target of [" .. ", " . ", " nested/path ", " nested\\path "]) {
    assert.throws(
      () => normalizeAiArtifactInputs([{ id: "hooks/block-dangerous-commands", target }]),
      /Targets must be a single directory name/,
    );
  }
});

test("shared composition output validates against the published schema", () => {
  const validate = ajv.compile(schema);
  const recipe = composeRecipe({
    profile: "modern",
    packageManager: "bun",
    tools: ["Oxlint", "Oxc React best practices", "Stylelint"],
    aiArtifacts: [{ id: "skill-semantic-html" }],
  });

  assertValid(validate, recipe);
  assert.equal(validateRecipe(recipe), recipe);
});

test("shared catalog helpers expose WebMCP-ready profile scoped options", () => {
  const modernToolIds = listIntegrationOptions("modern").map(({ id }) => id);
  const classicToolIds = listIntegrationOptions("classic").map(({ id }) => id);
  const response = catalogResponse(composeRecipe({ profile: "minimal" }));

  assert.ok(modernToolIds.includes("oxlint-react"));
  assert.equal(modernToolIds.includes("eslint-react"), false);
  assert.ok(classicToolIds.includes("eslint-react"));
  assert.equal(classicToolIds.includes("oxlint-react"), false);
  assert.deepEqual(
    response.profiles.map(({ id }) => id),
    profiles,
  );
  assert.deepEqual(response.defaults, profileDefaults);
});

test("shared explanation helpers include selected and included integration reasons", () => {
  const explanation = explainRecipeIntegrations(
    buildRecipe("modern", ["oxlint-react", "stylelint-standard"]),
  );

  assert.deepEqual(
    explanation.map(({ id }) => id),
    ["oxlint", "oxlint-react", "stylelint", "stylelint-standard"],
  );
  assert.match(explanation.find(({ id }) => id === "oxlint").reason, /requires it/);
  assert.match(explanation.find(({ id }) => id === "oxlint-react").reason, /Explicitly selected/);
});

test("shared composition operation responses expose catalog, recipe, and explanation data", () => {
  const profilesResponse = listProfilesResponse();
  const recipeResponse = composeRecipeResponse({
    profile: "modern",
    packageManager: "pnpm",
    tools: ["Oxlint", "Stylelint"],
    aiArtifacts: [{ id: "Semantic HTML" }],
  });

  assert.deepEqual(
    profilesResponse.profiles.map(({ id }) => id),
    profiles,
  );
  assert.notEqual(
    profilesResponse.profiles.find(({ id }) => id === "modern").defaultIntegrations,
    profileDefaults.modern,
  );
  assert.deepEqual(
    listIntegrationsResponse({ profile: "classic" }).integrations.map(({ id }) => id),
    listIntegrationOptions("classic").map(({ id }) => id),
  );
  assert.equal(describeIntegrationResponse("Oxlint").id, "oxlint");
  assert.equal(
    listAiArtifactsResponse().artifacts.some(({ id }) => id === "skill-semantic-html"),
    true,
  );
  assert.deepEqual(recipeResponse.recipe.integrations, ["oxlint", "stylelint"]);
  assert.equal(validateRecipeResponse(recipeResponse.recipe).ok, true);
  assert.equal(
    explainRecipeResponse(recipeResponse.recipe).aiArtifacts[0].id,
    "skill-semantic-html",
  );
});

test("standard MCP workflow exposes dry-run and apply tools", () => {
  assert.deepEqual(recipeWorkflow(), standardMcpToolNames);
  assert.deepEqual(
    composeRecipeResponse({
      profile: "minimal",
    }).workflow,
    standardMcpToolNames,
  );
});

test("WebMCP workflow exposes browser download instead of filesystem apply tools", () => {
  assert.deepEqual(recipeWorkflow({ browser: true }), webMcpToolNames);
  assert.deepEqual(
    composeRecipeResponse(
      {
        profile: "minimal",
      },
      { browser: true },
    ).workflow,
    webMcpToolNames,
  );
  assert.equal(webMcpToolNames.includes("download_recipe"), true);
  assert.equal(webMcpToolNames.includes("dry_run_apply"), false);
  assert.equal(webMcpToolNames.includes("apply_recipe"), false);
});

test("WebMCP registers browser parity tools from the shared contract", async () => {
  const script = await readProjectFile("web/script.js");
  const registeredToolNames = [...script.matchAll(/registerTool\(\{\s*name: "([^"]+)"/g)].map(
    (match) => match[1],
  );
  const legacyToolNames = [
    "get_project_tooling_options",
    "get_ai_artifact_options",
    "configure_project_tooling",
    "configure_ai_artifacts",
    "download_configuration_json",
  ];

  assert.deepEqual(registeredToolNames.sort(), [...webMcpToolNames].sort());
  for (const legacyName of legacyToolNames) {
    assert.equal(
      registeredToolNames.includes(legacyName),
      false,
      `Legacy WebMCP tool remains: ${legacyName}`,
    );
  }
});

test("standard MCP server exposes Calavera recipe composition tools", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { tools } = await client.listTools();
    const toolNames = tools.map(({ name }) => name).sort();

    assert.deepEqual(toolNames, [...standardMcpToolNames].sort());
    assert.equal(
      tools.find(({ name }) => name === "compose_recipe")?.description,
      recipeToolDescriptions.compose_recipe,
    );
    assert.equal(
      tools.find(({ name }) => name === "apply_recipe")?.annotations?.destructiveHint,
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("standard MCP compose_recipe returns structured schema-valid content", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "calavera-test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "compose_recipe",
      arguments: {
        profile: "modern",
        packageManager: "pnpm",
        tools: ["Oxlint", "Stylelint"],
        aiArtifacts: [{ id: "Semantic HTML" }],
      },
    });
    const recipe = result.structuredContent.recipe;

    assert.deepEqual(recipe.integrations, ["oxlint", "stylelint"]);
    assert.deepEqual(recipe.ai, [{ type: "skill", src: "skills/semantic-html" }]);
    assertValid(ajv.compile(schema), recipe);
  } finally {
    await client.close();
    await server.close();
  }
});

test("standard MCP validation and dry-run tools return agent-readable JSON", async () => {
  const recipe = composeRecipe({
    profile: "minimal",
    packageManager: "npm",
    aiArtifacts: [{ id: "skill-semantic-html" }],
  });
  const validation = await callMcpTool("validate_recipe", { recipe });
  const dryRun = await callMcpTool("dry_run_apply", { recipe });

  assert.equal(validation.ok, true);
  assert.match(dryRun.approvalBoundary, /before calling apply_recipe/);
  assert.equal(dryRun.result.dryRun, true);
  assert.equal(
    dryRun.result.changes.some(({ path }) => path === ".agents/skills/semantic-html"),
    true,
  );
});

test("apply dry runs surface managed file overwrite conflicts", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-dry-run-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await writeFile(".editorconfig", "local edits\n");

    await assert.rejects(
      () =>
        applyRecipeObject(buildRecipe("minimal", ["editorconfig"], "npm"), {
          dryRun: true,
          json: true,
          noInstall: true,
          assumeYes: true,
        }),
      /Refusing to overwrite existing managed file: \.editorconfig/,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("MCP apply_recipe rejects config paths outside the current workspace", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-mcp-apply-"));

  try {
    process.chdir(projectDirectory);

    await assert.rejects(
      () =>
        callMcpTool("apply_recipe", {
          recipe: composeRecipe({ profile: "minimal", packageManager: "npm" }),
          config: "../calavera.config.json",
          noInstall: true,
        }),
      /config path must stay inside the current project workspace/,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("shared integration resolution expands nested includes without catalog-order coupling", () => {
  const fixtures = [
    {
      id: "test-grandchild",
      label: "Test grandchild",
      group: "Test",
      platform: "test",
      status: "optional",
      dependencies: [],
    },
    {
      id: "test-child",
      label: "Test child",
      group: "Test",
      platform: "test",
      status: "optional",
      dependencies: [],
      includes: ["test-grandchild"],
    },
    {
      id: "test-parent",
      label: "Test parent",
      group: "Test",
      platform: "test",
      status: "optional",
      dependencies: [],
      includes: ["test-child"],
    },
  ];

  integrationCatalog.unshift(...fixtures);

  try {
    assert.deepEqual(
      resolveRecipeIntegrations({ integrations: ["test-parent"] }).map(({ id }) => id),
      ["test-grandchild", "test-child", "test-parent"],
    );
  } finally {
    integrationCatalog.splice(0, fixtures.length);
  }
});

test("shared assertion helpers reject unexpected value shapes", () => {
  assert.doesNotThrow(() => assertString("name", "value"));
  assert.doesNotThrow(() => assertStringArray("items", ["one", "two"]));
  assert.doesNotThrow(() => assertStringArray("items", []));
  assert.doesNotThrow(() => assertObjectArray("objects", [{ id: "one" }]));
  assert.doesNotThrow(() => assertObjectArray("objects", []));
  assert.doesNotThrow(() => assertPlainObject("object", { id: "one" }));
  assert.doesNotThrow(() => assertKnownValue("profile", "modern", profiles));

  assert.throws(() => assertString("name", 1), /name must be a string/);
  assert.throws(() => assertStringArray("items", "one"), /items must be an array of strings/);
  assert.throws(() => assertStringArray("items", ["one", 2]), /items must be an array of strings/);
  assert.throws(() => assertObjectArray("objects", "one"), /objects must be an array of objects/);
  assert.throws(() => assertObjectArray("objects", [null]), /objects must be an array of objects/);
  assert.throws(() => assertObjectArray("objects", [[]]), /objects must be an array of objects/);
  assert.throws(() => assertPlainObject("object", null), /object must be an object/);
  assert.throws(() => assertPlainObject("object", []), /object must be an object/);
  assert.throws(() => assertKnownValue("profile", 1, profiles), /profile must be a string/);
  assert.throws(() => assertKnownValue("profile", "future", profiles), /Invalid profile: future/);
});

test("Codex agent adapter emits required TOML fields without Claude model metadata", async () => {
  const source = await readProjectFile("src/ai/agents/technical-devils-advocate.md");
  const toml = createCodexAgentToml(source);

  assert.match(toml, /^name = "technical-devils-advocate"$/m);
  assert.match(toml, /^description = "Technical devil's advocate/m);
  assert.match(toml, /^developer_instructions = "You are a technical devil's advocate/m);
  assert.doesNotMatch(toml, /^model = /m);
  assert.doesNotMatch(toml, /claude-4\.6-opus-high-thinking/);
});

test("Codex-targeted agent recipes resolve to .codex custom-agent TOML", async () => {
  const result = await buildAiApplyResult(
    {
      ai: [{ type: "agent", src: "agents/technical-devils-advocate.md", target: "codex" }],
    },
    { dryRun: true },
    createEmptyState(),
  );

  assert.deepEqual(result.changes, [
    {
      type: "write",
      path: ".codex/agents/technical-devils-advocate.toml",
      category: "ai",
      aiType: "agent",
      name: "technical-devils-advocate",
    },
  ]);
  assert.equal(result.artifacts[0].path, ".codex/agents/technical-devils-advocate.toml");
  assert.equal(result.artifacts[0].target, "codex");
  assert.equal(typeof result.artifacts[0].hash, "string");
  assert.ok(
    result.pointers.includes("Codex custom agent files are installed under .codex/agents/."),
  );
});
