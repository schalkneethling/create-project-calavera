import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import { buildAiApplyResult, createCodexAgentToml } from "../src/ai/artifacts.js";
import { aiArtifactCatalog, DEFAULT_AI_TARGET } from "../src/ai/catalog.js";
import { integrationCatalog } from "../src/catalog.js";
import { createEmptyState } from "../src/state.js";
import { buildRecipe, CONFIG_SCHEMA_URL } from "../src/recipe.js";

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
const defaultScriptFlags = ["lint", "lint:fix", "format", "format:check", "typecheck", "quality"];
const scriptFlags = [
  ...defaultScriptFlags,
  "lint:changed",
  "lint:fix:changed",
  "format:changed",
  "format:check:changed",
  "quality:changed",
];
const execFileAsync = promisify(execFile);

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
  for (const flag of defaultScriptFlags) {
    assert.equal(typeof config.scripts?.[flag], "boolean", `scripts.${flag} must be boolean.`);
  }
});

test("generated recipes reference the published schema URL", () => {
  const recipe = buildRecipe("modern", ["editorconfig"], "pnpm");

  assert.equal(recipe.$schema, schemaUrl);
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

test("changed-file script flags generate opt-in delta scripts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "calavera-delta-scripts-"));
  const cliPath = new URL("../src/index.js", import.meta.url);
  const deltaConfig = {
    $schema: schemaUrl,
    version: 1,
    profile: "modern",
    packageManager: "pnpm",
    integrations: ["oxlint", "oxfmt", "stylelint", "stylelint-standard"],
    scripts: {
      "lint:changed": true,
      "lint:fix:changed": true,
      "format:changed": true,
      "format:check:changed": true,
      "quality:changed": true,
    },
  };

  await writeFile(join(cwd, "package.json"), `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
  await writeFile(join(cwd, "calavera.config.json"), `${JSON.stringify(deltaConfig, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [fileURLToPath(cliPath), "apply", "--yes", "--no-install"],
    {
      cwd,
    },
  );

  const packageJSON = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  const helper = await readFile(join(cwd, ".calavera/run-changed-files.mjs"), "utf8");

  assert.match(packageJSON.scripts["lint:changed"], /run-changed-files\.mjs/);
  assert.match(packageJSON.scripts["lint:changed"], /oxlint/);
  assert.match(packageJSON.scripts["lint:changed"], /stylelint/);
  assert.match(packageJSON.scripts["lint:fix:changed"], /oxlint --fix/);
  assert.match(packageJSON.scripts["format:changed"], /oxfmt --write/);
  assert.match(packageJSON.scripts["format:check:changed"], /oxfmt --check/);
  assert.match(packageJSON.scripts["quality:changed"], /pnpm lint:changed/);
  assert.match(packageJSON.scripts["quality:changed"], /pnpm format:check:changed/);
  assert.match(helper, /CALAVERA_CHANGED_BASE/);
});
