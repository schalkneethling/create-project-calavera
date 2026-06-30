import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { buildAiApplyResult, createCodexAgentToml } from "../src/ai/artifacts.js";
import { aiArtifactCatalog, DEFAULT_AI_TARGET } from "../src/ai/catalog.js";
import { integrationCatalog } from "../src/catalog.js";
import { createEmptyState } from "../src/state.js";
import {
  assertKnownValue,
  assertObjectArray,
  assertString,
  assertStringArray,
} from "../src/utils/assertions.js";
import {
  aiArtifactRecipeItems,
  buildRecipe,
  catalogResponse,
  composeRecipe,
  CONFIG_SCHEMA_URL,
  explainRecipeIntegrations,
  listIntegrationOptions,
  normalizeAiArtifactInputs,
  profileDefaults,
  validateRecipe,
  validateRecipeCompositionInput,
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

test("shared assertion helpers reject unexpected value shapes", () => {
  assert.doesNotThrow(() => assertString("name", "value"));
  assert.doesNotThrow(() => assertStringArray("items", ["one", "two"]));
  assert.doesNotThrow(() => assertStringArray("items", []));
  assert.doesNotThrow(() => assertObjectArray("objects", [{ id: "one" }]));
  assert.doesNotThrow(() => assertObjectArray("objects", []));
  assert.doesNotThrow(() => assertKnownValue("profile", "modern", profiles));

  assert.throws(() => assertString("name", 1), /name must be a string/);
  assert.throws(() => assertStringArray("items", "one"), /items must be an array of strings/);
  assert.throws(() => assertStringArray("items", ["one", 2]), /items must be an array of strings/);
  assert.throws(() => assertObjectArray("objects", "one"), /objects must be an array of objects/);
  assert.throws(() => assertObjectArray("objects", [null]), /objects must be an array of objects/);
  assert.throws(() => assertObjectArray("objects", [[]]), /objects must be an array of objects/);
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
