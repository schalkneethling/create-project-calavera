import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Ajv2020 from "ajv/dist/2020.js";
import packageJson from "../package.json" with { type: "json" };
import * as prettier from "prettier";

import { buildAiApplyResult, createCodexAgentToml } from "../src/ai/artifacts.js";
import { aiArtifactCatalog, DEFAULT_AI_TARGET } from "../src/ai/catalog.js";
import { integrationCatalog } from "../src/catalog.js";
import {
  agentBootstrap,
  applyRecipeObject,
  initRecipe,
  inspectProject,
  parseArgs,
} from "../src/index.js";
import { callMcpTool, createMcpServer } from "../src/mcp.js";
import { createEmptyState, normalizeState } from "../src/state.js";
import {
  assertKnownValue,
  assertObjectArray,
  assertPlainObject,
  assertString,
  assertStringArray,
} from "../src/utils/assertions.js";
import { textHash } from "../src/utils/hash.js";
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
  projectLocalCommandCatalog,
  projectLocalCommandSteps,
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

const execFileAsync = promisify(execFile);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const schemaUrl = CONFIG_SCHEMA_URL;
const rootProperties = [
  "$schema",
  "version",
  "profile",
  "packageManager",
  "integrations",
  "integrationOptions",
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

const schema = await readProjectJson("../../apps/composer/public/calavera.config.schema.json");
const config = await readProjectJson("../../calavera.config.json");
const skillsShConfig = await readProjectJson("../../skills.sh.json");
const integrationIds = integrationCatalog.map(({ id }) => id);
const schemaProperties = schema.properties ?? {};
const scriptProperties = schemaProperties.scripts?.properties ?? {};
const schemaIntegrationIds = schema.$defs?.integrationId?.enum;
const ajv = new Ajv2020({ allErrors: true, validateFormats: false });

function assertValid(validate, value) {
  assert.equal(validate(value), true, ajv.errorsText(validate.errors));
}

async function assertPathMissing(path, message = `${path} should not exist`) {
  await assert.rejects(() => stat(path), /ENOENT/, message);
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
    buildRecipe("modern", ["stylelint-baseline"], "pnpm", [], {
      "stylelint-baseline": { available: 2025, severity: "warning" },
    }),
  );
  assertValid(
    validate,
    buildRecipe("modern", ["editorconfig"], "pnpm", [
      { type: "skill", src: "skills/frontend-engineering" },
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

test("config schema rejects invalid or detached Stylelint Baseline options", () => {
  const validate = ajv.compile(schema);
  const valid = buildRecipe("modern", ["stylelint-baseline"], "npm", [], {
    "stylelint-baseline": { available: "newly", severity: "error" },
  });

  assertValid(validate, valid);
  assert.equal(
    validate({ ...valid, integrations: ["stylelint"] }),
    false,
    "options must reference a selected integration",
  );
  assert.equal(
    validate({
      ...valid,
      integrationOptions: {
        "stylelint-baseline": { available: 2025, severity: "warning", extra: true },
      },
    }),
    false,
    "unknown option fields must be rejected",
  );
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

test("bundled skills expose complete OpenAI interface metadata", async () => {
  const skillRoot = new URL("../src/ai/skills/", import.meta.url);
  const skillDirectories = (await readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const displayNames = new Set();

  for (const skillName of skillDirectories) {
    const skill = await readFile(new URL(`${skillName}/SKILL.md`, skillRoot), "utf8");
    const metadata = await readFile(new URL(`${skillName}/agents/openai.yaml`, skillRoot), "utf8");
    const declaredSkillName = skill.match(/^name: ([a-z0-9-]+)$/m)?.[1];
    const displayName = metadata.match(/^  display_name: "([^"\n]+)"$/m)?.[1];
    const shortDescription = metadata.match(/^  short_description: "([^"\n]+)"$/m)?.[1];
    const defaultPrompt = metadata.match(/^  default_prompt: "([^"\n]+)"$/m)?.[1];

    await prettier.format(metadata, { parser: "yaml" });
    assert.ok(declaredSkillName, `${skillName} must declare a skill name`);
    assert.match(metadata, /^interface:$/m);
    assert.ok(displayName, `${skillName} must define interface.display_name`);
    assert.ok(shortDescription, `${skillName} must define interface.short_description`);
    assert.ok(defaultPrompt, `${skillName} must define interface.default_prompt`);
    assert.ok(
      shortDescription.length >= 25 && shortDescription.length <= 64,
      `${skillName} short_description must be 25-64 characters`,
    );
    assert.match(defaultPrompt, new RegExp(`\\$${escapeRegExp(declaredSkillName)}\\b`));
    assert.equal(displayNames.has(displayName), false, `Duplicate display name: ${displayName}`);
    displayNames.add(displayName);

    if (skillName === "code-review") {
      assert.match(metadata, /^policy:\n  allow_implicit_invocation: false$/m);
    } else {
      assert.doesNotMatch(metadata, /^policy:/m);
    }
  }
});

test("skills.sh grouping includes every bundled skill exactly once", () => {
  const bundledSkillSlugs = aiArtifactCatalog
    .filter((artifact) => artifact.type === "skill")
    .map((artifact) => artifact.src.replace(/^skills\//, ""))
    .sort();
  const groupedSkillSlugs = skillsShConfig.groupings
    .flatMap((grouping) => grouping.skills)
    .toSorted();

  assert.equal(skillsShConfig.$schema, "https://skills.sh/schemas/skills.sh.schema.json");
  assert.equal(skillsShConfig.notGrouped, "bottom");
  assert.deepEqual(groupedSkillSlugs, bundledSkillSlugs);
  assert.equal(new Set(groupedSkillSlugs).size, groupedSkillSlugs.length);

  for (const grouping of skillsShConfig.groupings) {
    assert.equal(typeof grouping.title, "string");
    assert.ok(grouping.title.length > 0);
    assert.ok(Array.isArray(grouping.skills));
    assert.ok(grouping.skills.length > 0);
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
    integrationOptions: undefined,
  });
});

test("shared composition normalizes Stylelint Baseline options", () => {
  const recipe = composeRecipe({
    profile: "modern",
    tools: ["stylelint-baseline"],
    integrationOptions: {
      "stylelint-baseline": { available: "2025", severity: "error" },
    },
  });

  assert.deepEqual(recipe.integrationOptions, {
    "stylelint-baseline": { available: 2025, severity: "error" },
  });
  assert.throws(
    () =>
      composeRecipe({
        profile: "modern",
        tools: ["stylelint"],
        integrationOptions: {
          "stylelint-baseline": { available: 2025, severity: "warning" },
        },
      }),
    /requires the stylelint-baseline integration/,
  );
  assert.throws(
    () =>
      buildRecipe("modern", ["stylelint-baseline"], "npm", [], {
        "stylelint-baseline": { available: 2025, severity: "notice" },
      }),
    /warning or error/,
  );
});

test("shared composition resolves duplicate tool labels within the active profile", () => {
  assert.deepEqual(normalizeIntegrationInputs(["JSX-A11y"], "modern"), ["oxlint-jsx-a11y"]);
  assert.deepEqual(normalizeIntegrationInputs(["JSX-A11y"], "classic"), ["eslint-jsx-a11y"]);
});

test("JSX accessibility integrations are grouped with React options", () => {
  const modernJsxA11y = listIntegrationOptions("modern").find(({ id }) => id === "oxlint-jsx-a11y");
  const classicJsxA11y = listIntegrationOptions("classic").find(
    ({ id }) => id === "eslint-jsx-a11y",
  );

  assert.equal(modernJsxA11y?.label, "JSX-A11y");
  assert.equal(modernJsxA11y?.group, "React best practices");
  assert.equal(classicJsxA11y?.label, "JSX-A11y");
  assert.equal(classicJsxA11y?.group, "React best practices");
});

test("project-local command guidance covers every package manager", () => {
  assert.deepEqual(Object.keys(projectLocalCommandCatalog), packageManagers);
  assert.equal(
    projectLocalCommandCatalog.npm.agentBootstrap,
    "npm create project-calavera -- --init",
  );
  assert.equal(
    projectLocalCommandCatalog.npm.applyDryRun,
    "npm create project-calavera apply -- --dry-run",
  );

  for (const packageManager of packageManagers) {
    const steps = projectLocalCommandSteps(packageManager);

    assert.deepEqual(
      steps.map(({ id }) => id),
      ["agentBootstrap", "applyDryRun", "applyRecipe"],
    );
    assert.equal(
      steps.every(({ command }) => command.includes("project-calavera")),
      true,
    );
  }
});

test("shared composition copies profile defaults before returning recipes", () => {
  const recipe = composeRecipe({ profile: "minimal" });
  recipe.integrations.push("mutated");

  assert.deepEqual(profileDefaults.minimal, ["editorconfig"]);
  assert.notEqual(composeRecipe({ profile: "modern" }).integrations, profileDefaults.modern);
});

test("shared composition normalizes AI artifact inputs into recipe items", () => {
  const input = normalizeAiArtifactInputs([
    { id: "Frontend engineering" },
    { id: "hooks/block-dangerous-commands", target: "codex" },
    { id: "Technical devil's advocate" },
  ]);

  assert.deepEqual(input, [
    { id: "skill-frontend-engineering", target: undefined },
    { id: "hook-block-dangerous-commands", target: "codex" },
    { id: "agent-technical-devils-advocate", target: DEFAULT_AI_TARGET },
  ]);
  assert.deepEqual(aiArtifactRecipeItems(input), [
    { type: "skill", src: "skills/frontend-engineering" },
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
    aiArtifacts: [{ id: "skill-frontend-engineering" }],
  });

  assertValid(validate, recipe);
  assert.equal(validateRecipe(recipe), recipe);
});

test("shared recipe validation rejects mixed formatter integrations", () => {
  const mixedFormatterRecipe = buildRecipe("modern", ["oxfmt", "prettier"], "npm");

  assert.throws(
    () => validateRecipe(mixedFormatterRecipe),
    /Choose either Oxfmt or Prettier, not both/,
  );
  assert.equal(validateRecipeResponse(mixedFormatterRecipe).ok, false);
  assert.match(
    validateRecipeResponse(mixedFormatterRecipe).errors?.[0] ?? "",
    /Choose either Oxfmt or Prettier, not both/,
  );
});

test("shared recipe validation rejects malformed AI items and unknown properties", () => {
  const recipe = buildRecipe("minimal", [], "npm");
  assert.throws(() => validateRecipe({ ...recipe, ai: [{}] }), /non-empty type and src/);
  assert.throws(() => validateRecipe({ ...recipe, unexpected: true }), /Unknown recipe properties/);
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
    aiArtifacts: [{ id: "Frontend engineering" }],
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
    listAiArtifactsResponse().artifacts.some(({ id }) => id === "skill-frontend-engineering"),
    true,
  );
  assert.deepEqual(recipeResponse.recipe.integrations, ["oxlint", "stylelint"]);
  assert.equal(validateRecipeResponse(recipeResponse.recipe).ok, true);
  assert.equal(
    explainRecipeResponse(recipeResponse.recipe).aiArtifacts[0].id,
    "skill-frontend-engineering",
  );
});

test("CLI parser accepts scripted rich composer options", () => {
  const options = parseArgs([
    "init",
    "--profile",
    "modern",
    "--package-manager",
    "pnpm",
    "--integration",
    "Oxlint,Stylelint",
    "--tool",
    "Oxc React best practices",
    "--ai-artifact",
    "skill-frontend-engineering",
    "--ai-artifact",
    "hook-block-dangerous-commands@codex",
    "--apply",
    "--yes",
  ]);

  assert.equal(options.command, "init");
  assert.equal(options.profile, "modern");
  assert.equal(options.packageManager, "pnpm");
  assert.deepEqual(options.integrations, ["Oxlint", "Stylelint", "Oxc React best practices"]);
  assert.deepEqual(options.aiArtifacts, [
    { id: "skill-frontend-engineering" },
    { id: "hook-block-dangerous-commands", target: "codex" },
  ]);
  assert.equal(options.apply, true);
  assert.equal(options.assumeYes, true);
  assert.deepEqual(
    parseArgs([
      "apply",
      "--reown-managed-file",
      "oxlint.json",
      "--reown-managed-files",
      ".prettierrc.json,tsconfig.json",
    ]).reownManagedFiles,
    ["oxlint.json", ".prettierrc.json", "tsconfig.json"],
  );

  assert.deepEqual(
    parseArgs(["init", "--ai-artifact", "hook-block-dangerous-commands@team@codex"]).aiArtifacts,
    [{ id: "hook-block-dangerous-commands", target: "team@codex" }],
  );
});

test("CLI parser ignores package-manager forwarding separators", () => {
  assert.equal(parseArgs(["--", "--init"]).command, "agent-init");
  assert.equal(parseArgs([" -- ", "--init"]).command, "agent-init");
  assert.equal(parseArgs(["apply", "--", "--dry-run"]).command, "apply");
  assert.equal(parseArgs(["apply", "--", "--dry-run"]).dryRun, true);
});

test("CLI entry point runs through package-manager-style symlinks", async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-cli-symlink-"));
  const binPath = join(projectDirectory, "create-project-calavera");

  await symlink(fileURLToPath(new URL("../src/index.js", import.meta.url)), binPath);

  const { stdout } = await execFileAsync(
    process.execPath,
    [binPath, "--", "--init", "--dry-run", "--json"],
    { cwd: projectDirectory },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.command, "agent-init");
  assert.equal(result.dryRun, true);
  assert.equal(
    result.changes.some(({ path }) => path === ".agents/skills/calavera"),
    true,
  );
});

test("CLI rich composer writes a schema-valid config without applying by default", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-rich-cli-"));

  try {
    process.chdir(projectDirectory);

    const result = await initRecipe({
      command: "init",
      config: "calavera.config.json",
      dryRun: false,
      json: true,
      noInstall: true,
      assumeYes: true,
      apply: false,
      profile: "modern",
      packageManager: "pnpm",
      integrations: ["Oxlint", "Stylelint"],
      aiArtifacts: [{ id: "Frontend engineering" }],
    });
    const writtenConfig = JSON.parse(await readFile("calavera.config.json", "utf8"));

    assert.equal(result.validation.ok, true);
    assert.deepEqual(writtenConfig, result.recipe);
    assert.deepEqual(writtenConfig.integrations, ["oxlint", "stylelint"]);
    assert.deepEqual(writtenConfig.ai, [{ type: "skill", src: "skills/frontend-engineering" }]);
    assertValid(ajv.compile(schema), writtenConfig);
    await assertPathMissing("package.json", "config-only compose must not create package.json");
  } finally {
    process.chdir(originalDirectory);
  }
});

test("CLI rich composer dry-run apply keeps the review boundary non-destructive", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-rich-cli-apply-dry-run-"));

  try {
    process.chdir(projectDirectory);

    const result = await initRecipe({
      command: "init",
      config: "calavera.config.json",
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
      apply: true,
      profile: "minimal",
      packageManager: "npm",
      integrations: ["editorconfig"],
      aiArtifacts: [],
    });

    assert.equal(result.applyDryRun?.dryRun, true);
    assert.deepEqual(
      result.applyDryRun?.changes.map(({ path }) => path),
      ["package.json", ".editorconfig"],
    );
    assert.deepEqual(result.applyDryRun?.integrations, ["editorconfig"]);
    assert.equal(result.applyResult, undefined);
    await assertPathMissing("calavera.config.json", "dry-run compose must not write config");
    await assertPathMissing("package.json", "dry-run apply must not create package.json");
    await assertPathMissing(".editorconfig", "dry-run apply must not write managed files");
  } finally {
    process.chdir(originalDirectory);
  }
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
  const script = await readProjectFile("../../apps/composer/script.js");
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
      tools.find(({ name }) => name === "inspect_project")?.description,
      recipeToolDescriptions.inspect_project,
    );
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
        aiArtifacts: [{ id: "Frontend engineering" }],
      },
    });
    const recipe = result.structuredContent.recipe;

    assert.deepEqual(recipe.integrations, ["oxlint", "stylelint"]);
    assert.deepEqual(recipe.ai, [{ type: "skill", src: "skills/frontend-engineering" }]);
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
    aiArtifacts: [{ id: "skill-frontend-engineering" }],
  });
  const validation = await callMcpTool("validate_recipe", { recipe });
  const dryRun = await callMcpTool("dry_run_apply", { recipe });

  assert.equal(validation.ok, true);
  assert.match(dryRun.approvalBoundary, /before calling apply_recipe/);
  assert.equal(dryRun.result.dryRun, true);
  assert.equal(
    dryRun.result.changes.some(({ path }) => path === "calavera.config.json"),
    true,
  );
  assert.equal(
    dryRun.result.changes.some(({ path }) => path === ".agents/skills/frontend-engineering"),
    true,
  );
});

test("Baseline MCP tools expose the same recommendation contract as Baseline core", async () => {
  const targets = await callMcpTool("list_baseline_targets");
  const description = await callMcpTool("describe_baseline_target", { target: 2025 });
  const search = await callMcpTool("search_baseline_features", { query: "nesting", limit: 5 });
  const recommendation = await callMcpTool("recommend_baseline_target", {
    features: ["nesting", "has"],
  });

  assert.ok(targets.targets.some(({ target }) => target === 2025));
  assert.equal(description.target, 2025);
  assert.ok(search.features.some(({ id }) => id === "nesting"));
  assert.equal(recommendation.recommendedTarget, 2023);
  assert.deepEqual(recommendation.integrationOptions, {
    "stylelint-baseline": { available: 2023, severity: "warning" },
  });
});

test("project inspection reports package manager, files, and conflict hints", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-project-inspection-"));

  try {
    process.chdir(projectDirectory);
    await writeFile(
      "package.json",
      `${JSON.stringify(
        {
          packageManager: "pnpm@11.3.0",
          scripts: {
            lint: "eslint .",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile("pnpm-lock.yaml", "");
    await writeFile("eslint.config.js", "export default [];\n");
    await writeFile(".editorconfig", "local edits\n");

    const recipe = buildRecipe("modern", ["editorconfig", "oxlint"], "npm");
    const inspection = await inspectProject(recipe);

    assert.equal(inspection.packageManager, "pnpm");
    assert.equal(inspection.files.includes("package.json"), true);
    assert.equal(inspection.files.includes("eslint.config.js"), true);
    assert.equal(
      inspection.findings.some(
        ({ kind, message }) => kind === "package-manager" && message.includes("pnpm"),
      ),
      true,
    );
    assert.equal(
      inspection.findings.some(({ kind }) => kind === "package-manager-mismatch"),
      true,
    );
    assert.equal(
      inspection.findings.some(
        ({ kind, path, severity }) =>
          kind === "managed-file-conflict" && path === ".editorconfig" && severity === "error",
      ),
      true,
    );
    assert.equal(
      inspection.findings.some(
        ({ kind, path }) => kind === "equivalent-tooling" && path === "eslint.config.js",
      ),
      true,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("MCP inspect_project exposes current project conflict hints", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-mcp-inspect-project-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", JSON.stringify({ packageManager: "bun@1.3.14" }));
    await writeFile("bun.lock", "");

    const response = await callMcpTool("inspect_project", {
      recipe: composeRecipe({ profile: "minimal", packageManager: "npm" }),
    });

    assert.equal(response.packageManager, "bun");
    assert.equal(response.files.includes("bun.lock"), true);
    assert.equal(
      response.findings.some(({ kind }) => kind === "package-manager-mismatch"),
      true,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap dry-run previews guidance without writing files", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-dry-run-"));

  try {
    process.chdir(projectDirectory);

    const result = await agentBootstrap({ dryRun: true, json: true });

    assert.equal(result.command, "agent-init");
    assert.equal(result.dryRun, true);
    assert.equal(
      result.changes.some(({ path }) => path === ".agents/skills/calavera"),
      true,
    );
    assert.equal(
      result.changes.some(({ path }) => path === "AGENTS.md"),
      true,
    );
    assert.equal(
      result.changes.some(({ path }) => path === ".agents/calavera/mcp.md"),
      true,
    );
    assert.deepEqual(result.mcp, {
      harness: "skip",
      action: "manual",
      reason: "Skipped project MCP auto-config. Follow .agents/calavera/mcp.md for manual setup.",
    });
    assert.match(result.nextPrompt, /Use Calavera for this project/);
    await assert.rejects(() => stat("AGENTS.md"), /ENOENT/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap assume-yes skips MCP auto-config without explicit harness", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-assume-yes-"));

  try {
    process.chdir(projectDirectory);

    const result = await agentBootstrap({ assumeYes: true, json: true });

    assert.equal(result.mcp.harness, "skip");
    assert.equal(result.mcp.action, "manual");
    assert.equal(
      result.changes.some(({ path }) => path === ".agents/calavera/mcp.md"),
      true,
    );
    await assert.rejects(() => stat(".mcp.json"), /ENOENT/);
    await assert.rejects(() => stat(".codex/config.toml"), /ENOENT/);
    await assert.rejects(() => stat(".cursor/mcp.json"), /ENOENT/);
    await assert.rejects(() => stat("opencode.json"), /ENOENT/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap preserves existing AGENTS.md and writes fallback guidance", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("AGENTS.md", "Existing project guidance.\n");
    await writeFile("package.json", JSON.stringify({ packageManager: "pnpm@11.3.0" }));

    const result = await agentBootstrap({ json: true, mcpHarness: "skip" });
    const existingGuidance = await readFile("AGENTS.md", "utf8");
    const fallbackGuidance = await readFile("AGENTS.calavera.md", "utf8");
    const mcpGuidance = await readFile(".agents/calavera/mcp.md", "utf8");
    const skill = await readFile(".agents/skills/calavera/SKILL.md", "utf8");
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));

    assert.equal(existingGuidance, "Existing project guidance.\n");
    assert.match(fallbackGuidance, /Calavera Agent Guidance/);
    assert.match(fallbackGuidance, /Treat files listed by `dry_run_apply`/);
    assert.doesNotMatch(fallbackGuidance, /\.calavera\/run-if-files\.mjs/);
    assert.match(fallbackGuidance, /Do not hand-write or edit them/);
    assert.match(fallbackGuidance, /reports `-32000`/);
    assert.match(fallbackGuidance, /treat the outcome as unknown instead of failed/);
    assert.match(fallbackGuidance, /\.calavera\/state\.json/);
    assert.match(fallbackGuidance, /Choose either Oxfmt or Prettier/);
    assert.match(mcpGuidance, /create-project-calavera-mcp/);
    assert.match(mcpGuidance, /"command": "pnpm"/);
    assert.match(
      mcpGuidance,
      new RegExp(
        `"args": \\[\\s+"dlx",\\s+"--package",\\s+"create-project-calavera@${packageJson.version}",\\s+"create-project-calavera-mcp"\\s+\\]`,
      ),
    );
    assert.doesNotMatch(mcpGuidance, /"command": "npx"/);
    assert.match(mcpGuidance, /detected package manager is pnpm/);
    assert.match(mcpGuidance, /devEngines\.packageManager/);
    assert.match(mcpGuidance, /When configuring an MCP server manually/);
    assert.match(
      mcpGuidance,
      new RegExp(
        `- npm: \`npx --package create-project-calavera@${packageJson.version} create-project-calavera-mcp\``,
      ),
    );
    assert.match(
      mcpGuidance,
      new RegExp(
        `- pnpm: \`pnpm dlx --package create-project-calavera@${packageJson.version} create-project-calavera-mcp\``,
      ),
    );
    assert.match(
      mcpGuidance,
      new RegExp(
        `- Yarn: \`yarn dlx --package create-project-calavera@${packageJson.version} create-project-calavera-mcp\``,
      ),
    );
    assert.match(
      mcpGuidance,
      new RegExp(
        `- Bun: \`bunx --package create-project-calavera@${packageJson.version} create-project-calavera-mcp\``,
      ),
    );
    assert.match(mcpGuidance, /Claude Code/);
    assert.match(mcpGuidance, /\.mcp\.json/);
    assert.match(mcpGuidance, /Cursor/);
    assert.match(mcpGuidance, /\.cursor\/mcp\.json/);
    assert.match(mcpGuidance, /Codex/);
    assert.match(mcpGuidance, /\.codex\/config\.toml/);
    assert.match(mcpGuidance, /OpenCode/);
    assert.match(mcpGuidance, /opencode\.json/);
    assert.match(mcpGuidance, /never writes global\/user MCP config/);
    assert.match(mcpGuidance, /inspect_project/);
    assert.match(mcpGuidance, /omitted\s+script explanations/);
    assert.match(mcpGuidance, /ownership notes/);
    assert.match(mcpGuidance, /Do not combine Oxfmt and Prettier/);
    assert.match(mcpGuidance, /bun is unable to write files to tempdir: PermissionDenied/);
    assert.match(mcpGuidance, /TMPDIR/);
    assert.match(mcpGuidance, /BUN_INSTALL_CACHE_DIR/);
    assert.match(mcpGuidance, /restricted hosts/);
    assert.doesNotMatch(mcpGuidance, /Calavera-managed helper for generated package scripts/);
    assert.match(mcpGuidance, /reports `-32000`/);
    assert.match(mcpGuidance, /before retrying the apply/);
    assert.match(mcpGuidance, /existing tooling files/);
    assert.match(mcpGuidance, /calavera\.schalkneethling\.com/);
    assert.match(mcpGuidance, /pnpm dlx create-project-calavera apply --dry-run/);
    assert.match(skill, /name: calavera/);
    assert.match(skill, /MCP Setup/);
    assert.match(skill, /devEngines\.packageManager/);
    assert.match(skill, /inspect_project/);
    assert.match(skill, /omitted script explanations/);
    assert.match(skill, /Choose either Oxfmt or Prettier/);
    assert.match(
      skill,
      /npx --package create-project-calavera@<version> create-project-calavera-mcp/,
    );
    assert.match(
      skill,
      /bunx --package create-project-calavera@<version> create-project-calavera-mcp/,
    );
    assert.match(skill, /first word in `command` and the remaining words in `args`/);
    assert.match(skill, /bun is unable to write files to tempdir: PermissionDenied/);
    assert.match(skill, /TMPDIR/);
    assert.match(skill, /BUN_INSTALL_CACHE_DIR/);
    assert.match(skill, /Treat files listed by `dry_run_apply`/);
    assert.doesNotMatch(skill, /\.calavera\/run-if-files\.mjs/);
    assert.match(skill, /reports `-32000`/);
    assert.match(skill, /outcome as unknown instead of failed/);
    assert.match(skill, /Fallbacks/);
    assert.match(skill, /npm create project-calavera@<version> apply -- --dry-run/);
    assert.match(skill, /pnpm dlx create-project-calavera@<version> apply --dry-run/);
    assert.match(skill, /yarn dlx create-project-calavera@<version> apply --dry-run/);
    assert.match(skill, /bunx create-project-calavera@<version> apply --dry-run/);
    assert.doesNotMatch(skill, /npm create project-calavera apply -- --dry-run/);
    assert.equal(
      result.changes.some(
        ({ type, path, reason }) =>
          type === "skip" && path === "AGENTS.md" && reason.includes("left unchanged"),
      ),
      true,
    );
    assert.equal(result.mcp.harness, "skip");
    assert.equal(result.mcp.action, "manual");
    assert.equal(
      state.aiArtifacts.some(
        ({ type, name, path }) =>
          type === "skill" && name === "calavera" && path === ".agents/skills/calavera",
      ),
      true,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap writes Claude Code project MCP config", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-claude-mcp-"));

  try {
    process.chdir(projectDirectory);

    const result = await agentBootstrap({
      json: true,
      mcpHarness: "claude-code",
      packageManager: "pnpm",
    });
    const config = JSON.parse(await readFile(".mcp.json", "utf8"));

    assert.equal(result.mcp.harness, "claude-code");
    assert.equal(result.mcp.action, "write");
    assert.equal(result.mcp.path, ".mcp.json");
    assert.deepEqual(config.mcpServers.calavera, {
      command: "pnpm",
      args: [
        "dlx",
        "--package",
        `create-project-calavera@${packageJson.version}`,
        "create-project-calavera-mcp",
      ],
    });
    await assert.rejects(() => stat(".agents/calavera/mcp.md"), /ENOENT/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap writes Cursor project MCP config", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-cursor-mcp-"));

  try {
    process.chdir(projectDirectory);

    const result = await agentBootstrap({
      json: true,
      mcpHarness: "cursor",
      packageManager: "npm",
    });
    const config = JSON.parse(await readFile(".cursor/mcp.json", "utf8"));

    assert.equal(result.mcp.harness, "cursor");
    assert.equal(result.mcp.action, "write");
    assert.equal(result.mcp.path, ".cursor/mcp.json");
    assert.deepEqual(config.mcpServers.calavera, {
      command: "npx",
      args: [
        "--package",
        `create-project-calavera@${packageJson.version}`,
        "create-project-calavera-mcp",
      ],
    });
    await assert.rejects(() => stat(".agents/calavera/mcp.md"), /ENOENT/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap writes Codex project MCP config", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-codex-mcp-"));

  try {
    process.chdir(projectDirectory);
    await mkdir(".codex", { recursive: true });
    await writeFile(
      ".codex/config.toml",
      '[approval]\nmode = "manual"\n\n[mcp_servers.other]\ncommand = "node"\n',
    );

    const result = await agentBootstrap({
      json: true,
      mcpHarness: "codex",
      packageManager: "yarn",
    });
    const config = await readFile(".codex/config.toml", "utf8");

    assert.equal(result.mcp.harness, "codex");
    assert.equal(result.mcp.action, "update");
    assert.equal(result.mcp.path, ".codex/config.toml");
    assert.match(config, /\[approval\]\nmode = "manual"/);
    assert.match(config, /\[mcp_servers\.other\]\ncommand = "node"/);
    assert.match(config, /\[mcp_servers\.calavera\]/);
    assert.match(config, /command = "yarn"/);
    assert.match(
      config,
      new RegExp(
        `args = \\["dlx", "--package", "create-project-calavera@${escapeRegExp(packageJson.version)}", "create-project-calavera-mcp"\\]`,
      ),
    );
    await assert.rejects(() => stat(".agents/calavera/mcp.md"), /ENOENT/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap updates existing Codex MCP config idempotently", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-codex-idempotent-"));

  try {
    process.chdir(projectDirectory);
    await mkdir(".codex", { recursive: true });
    await writeFile(
      ".codex/config.toml",
      [
        "[approval]",
        'mode = "manual"',
        "",
        "[mcp_servers.calavera]",
        'command = "old-command"',
        'args = ["old-arg"]',
        "",
        "[mcp_servers.other]",
        'command = "node"',
        "",
      ].join("\n"),
    );

    const result = await agentBootstrap({
      json: true,
      mcpHarness: "codex",
      packageManager: "npm",
    });
    const config = await readFile(".codex/config.toml", "utf8");

    assert.equal(result.mcp.harness, "codex");
    assert.equal(result.mcp.action, "update");
    assert.equal(config.match(/\[mcp_servers\.calavera\]/g)?.length, 1);
    assert.match(config, /\[approval\]\nmode = "manual"/);
    assert.match(config, /\[mcp_servers\.other\]\ncommand = "node"/);
    assert.match(config, /\[mcp_servers\.calavera\]\ncommand = "npx"/);
    assert.doesNotMatch(config, /old-command|old-arg/);
    assert.match(
      config,
      new RegExp(
        `args = \\["--package", "create-project-calavera@${escapeRegExp(packageJson.version)}", "create-project-calavera-mcp"\\]`,
      ),
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap writes and merges OpenCode project MCP config", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-opencode-mcp-"));

  try {
    process.chdir(projectDirectory);
    await writeFile(
      "opencode.json",
      `${JSON.stringify(
        {
          $schema: 42,
          theme: "system",
          mcp: {
            existing: {
              type: "local",
              command: ["node", "server.js"],
              enabled: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await agentBootstrap({
      json: true,
      mcpHarness: "opencode",
      packageManager: "bun",
    });
    const config = JSON.parse(await readFile("opencode.json", "utf8"));

    assert.equal(result.mcp.harness, "opencode");
    assert.equal(result.mcp.action, "update");
    assert.equal(result.mcp.path, "opencode.json");
    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.equal(config.theme, "system");
    assert.deepEqual(config.mcp.existing, {
      type: "local",
      command: ["node", "server.js"],
      enabled: true,
    });
    assert.deepEqual(config.mcp.calavera, {
      type: "local",
      command: [
        "bunx",
        "--package",
        `create-project-calavera@${packageJson.version}`,
        "create-project-calavera-mcp",
      ],
      enabled: true,
    });
    await assert.rejects(() => stat(".agents/calavera/mcp.md"), /ENOENT/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap dry-run reports MCP config without writing it", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-mcp-dry-run-"));

  try {
    process.chdir(projectDirectory);

    const result = await agentBootstrap({
      dryRun: true,
      json: true,
      mcpHarness: "cursor",
      packageManager: "npm",
    });

    assert.deepEqual(result.mcp, {
      harness: "cursor",
      action: "write",
      path: ".cursor/mcp.json",
    });
    assert.equal(
      result.changes.some(({ type, path }) => type === "write" && path === ".cursor/mcp.json"),
      true,
    );
    assert.equal(
      result.changes.some(({ path }) => path === ".agents/calavera/mcp.md"),
      false,
    );
    await assert.rejects(() => stat(".cursor/mcp.json"), /ENOENT/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap falls back to manual MCP guidance when config write fails", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-mcp-fallback-"));

  try {
    process.chdir(projectDirectory);
    await mkdir(".cursor", { recursive: true });
    await writeFile(".cursor/mcp.json", "[]\n");

    const result = await agentBootstrap({
      json: true,
      mcpHarness: "cursor",
      packageManager: "npm",
    });
    const mcpGuidance = await readFile(".agents/calavera/mcp.md", "utf8");

    assert.equal(result.mcp.harness, "cursor");
    assert.equal(result.mcp.action, "manual");
    assert.match(result.mcp.reason, /Could not write project MCP config at \.cursor\/mcp\.json/);
    assert.match(result.mcp.reason, /mcp\.json must contain a JSON object/);
    assert.match(mcpGuidance, /Calavera MCP Setup/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap uses devEngines package manager for MCP config", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-bun-mcp-"));

  try {
    process.chdir(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({
        devEngines: {
          packageManager: {
            name: "bun",
            version: "1.3.14",
            onFail: "download",
          },
        },
      }),
    );

    await agentBootstrap({ json: true, mcpHarness: "claude-code" });
    const config = JSON.parse(await readFile(".mcp.json", "utf8"));

    assert.deepEqual(config.mcpServers.calavera, {
      command: "bunx",
      args: [
        "--package",
        `create-project-calavera@${packageJson.version}`,
        "create-project-calavera-mcp",
      ],
    });
    await assert.rejects(() => stat(".agents/calavera/mcp.md"), /ENOENT/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap uses devEngines package manager for manual MCP guidance", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-bun-mcp-guidance-"));

  try {
    process.chdir(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({
        devEngines: {
          packageManager: {
            name: "bun",
            version: "1.3.14",
            onFail: "download",
          },
        },
      }),
    );

    await agentBootstrap({ json: true, mcpHarness: "skip" });
    const mcpGuidance = await readFile(".agents/calavera/mcp.md", "utf8");

    assert.match(mcpGuidance, /"command": "bunx"/);
    assert.match(
      mcpGuidance,
      new RegExp(
        `"args": \\[\\s+"--package",\\s+"create-project-calavera@${packageJson.version}",\\s+"create-project-calavera-mcp"\\s+\\]`,
      ),
    );
    assert.match(mcpGuidance, /detected package manager is Bun/);
    assert.match(
      mcpGuidance,
      /npm rejecting a Bun-managed project\s+through `devEngines\.packageManager`/,
    );
    assert.match(mcpGuidance, /bun is unable to write files to tempdir: PermissionDenied/);
    assert.match(mcpGuidance, /TMPDIR/);
    assert.match(mcpGuidance, /BUN_INSTALL_CACHE_DIR/);
    assert.doesNotMatch(mcpGuidance, /"command": "npx"/);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("agent bootstrap rejects conflicting Calavera state path", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-init-conflict-"));

  try {
    process.chdir(projectDirectory);
    await writeFile(".calavera", "not a directory\n");

    await assert.rejects(
      () => agentBootstrap({ json: true }),
      /Cannot write Calavera bootstrap state/,
    );
    await assert.rejects(() => stat(".agents"), /ENOENT/);
  } finally {
    process.chdir(originalDirectory);
  }
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

test("apply dry runs allow formatting-only drift in managed JSON files", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-dry-run-json-format-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const recipe = buildRecipe("modern", ["oxlint"], "npm");
    await applyRecipeObject(recipe, {
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    const formattedOxlintConfig = `${JSON.stringify(
      JSON.parse(await readFile("oxlint.json", "utf8")),
      null,
      4,
    )}\n`;
    await writeFile("oxlint.json", formattedOxlintConfig);

    const inspection = await inspectProject(recipe);
    assert.equal(
      inspection.findings.some(
        (finding) => finding.kind === "managed-file-conflict" && finding.path === "oxlint.json",
      ),
      false,
    );

    const result = await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(
      result.changes.some((change) => change.type === "write" && change.path === "oxlint.json"),
      true,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply can re-own approved managed file drift before writing recipe updates", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-reown-managed-file-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const initialRecipe = buildRecipe("modern", ["oxlint"], "npm");
    await applyRecipeObject(initialRecipe, {
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    const formattedOxlintConfig = `${JSON.stringify(
      JSON.parse(await readFile("oxlint.json", "utf8")),
      null,
      4,
    )}\n`;
    await writeFile("oxlint.json", formattedOxlintConfig);

    const nextRecipe = buildRecipe(
      "modern",
      [
        "oxlint",
        "oxlint-eslint",
        "oxlint-typescript",
        "oxlint-unicorn",
        "oxlint-oxc",
        "oxlint-react",
        "oxlint-jsx-a11y",
      ],
      "npm",
    );

    await assert.rejects(
      () =>
        applyRecipeObject(nextRecipe, {
          dryRun: true,
          json: true,
          noInstall: true,
          assumeYes: true,
        }),
      /Refusing to overwrite existing managed file: oxlint\.json/,
    );

    const inspection = await inspectProject(nextRecipe, {
      reownManagedFiles: [".\\oxlint.json"],
    });
    assert.equal(
      inspection.findings.some(
        (finding) => finding.kind === "managed-file-conflict" && finding.path === "oxlint.json",
      ),
      false,
    );
    assert.equal(
      inspection.findings.some(
        (finding) => finding.kind === "managed-file-reown" && finding.path === "oxlint.json",
      ),
      true,
    );

    const dryRun = await applyRecipeObject(nextRecipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
      reownManagedFiles: ["./oxlint.json"],
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(
      dryRun.projectInspection.findings.some(
        (finding) => finding.kind === "managed-file-reown" && finding.path === "oxlint.json",
      ),
      true,
    );

    await applyRecipeObject(nextRecipe, {
      json: true,
      noInstall: true,
      assumeYes: true,
      reownManagedFiles: [join(projectDirectory, "oxlint.json")],
    });

    const oxlintConfig = JSON.parse(await readFile("oxlint.json", "utf8"));
    assert.deepEqual(oxlintConfig.plugins, [
      "eslint",
      "typescript",
      "unicorn",
      "oxc",
      "react",
      "jsx-a11y",
    ]);

    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.managedFiles, [
      { path: "oxlint.json", hash: textHash(await readFile("oxlint.json", "utf8")) },
    ]);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply dry runs explain omitted scripts and managed ownership", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-dry-run-omitted-scripts-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const result = await applyRecipeObject(
      {
        ...buildRecipe("minimal", ["editorconfig"], "npm"),
        scripts: {
          lint: true,
          format: true,
          typecheck: true,
          quality: true,
        },
      },
      {
        dryRun: true,
        json: true,
        noInstall: true,
        assumeYes: true,
      },
    );
    const packageChange = result.changes.find(
      ({ type, path }) => type === "update" && path === "package.json",
    );
    const editorConfigChange = result.changes.find(
      ({ type, path }) => type === "write" && path === ".editorconfig",
    );

    assert.deepEqual(packageChange?.scripts, []);
    assert.equal(
      packageChange?.omittedScripts?.some(
        ({ script, reason }) =>
          script === "format" &&
          reason === "format was requested but no formatter integration is selected.",
      ),
      true,
    );
    assert.equal(
      packageChange?.omittedScripts?.some(({ script }) => script === "typecheck"),
      true,
    );
    assert.equal(editorConfigChange?.ownership, "calavera");
    assert.equal(editorConfigChange?.action, "write");
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply dry runs reject mixed formatter integrations", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-dry-run-formatter-conflict-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    await assert.rejects(
      () =>
        applyRecipeObject(buildRecipe("modern", ["oxfmt", "prettier"], "npm"), {
          dryRun: true,
          json: true,
          noInstall: true,
          assumeYes: true,
        }),
      /Choose either Oxfmt or Prettier, not both/,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply uses direct tool scripts without the run-if-files helper", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-direct-scripts-"));
  const recipe = buildRecipe("modern", ["typescript", "oxlint", "oxfmt", "stylelint"], "npm");

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const dryRun = await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    assert.equal(
      dryRun.changes.some(({ path }) => path === ".calavera/run-if-files.mjs"),
      false,
    );

    await applyRecipeObject(recipe, {
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    const packageFile = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(packageFile.scripts.lint, 'oxlint . && stylelint "**/*.{css,scss}"');
    assert.equal(
      packageFile.scripts["lint:fix"],
      'oxlint --fix . && stylelint "**/*.{css,scss}" --fix',
    );
    assert.equal(packageFile.scripts.format, "oxfmt --write .");
    assert.equal(packageFile.scripts["format:check"], "oxfmt --check .");
    assert.equal(packageFile.scripts.typecheck, "tsc --noEmit");
    assert.doesNotMatch(JSON.stringify(packageFile.scripts), /run-if-files/);
    const stylelintConfig = JSON.parse(await readFile(".stylelintrc.json", "utf8"));
    assert.equal(stylelintConfig.ignoreFiles.includes("**/dist/**"), true);
    assert.equal(stylelintConfig.ignoreFiles.includes("**/dist-types/**"), true);
    assert.equal(stylelintConfig.ignoreFiles.includes("node_modules/**"), true);
    await assertPathMissing(".calavera/run-if-files.mjs");
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply composes logical CSS Stylelint plugin metadata", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-stylelint-logical-css-"));
  const recipe = buildRecipe("modern", ["stylelint-logical-css"], "npm");

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

    const result = await applyRecipeObject(recipe, {
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    assert.deepEqual(result.dependencies, ["stylelint", "stylelint-plugin-logical-css"]);

    const stylelintConfig = JSON.parse(await readFile(".stylelintrc.json", "utf8"));

    assert.equal(
      stylelintConfig.extends.includes("stylelint-plugin-logical-css/configs/recommended"),
      true,
    );
    assert.equal(stylelintConfig.plugins.includes("stylelint-plugin-logical-css"), true);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply carries recipe Baseline options into the generated Stylelint rule", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-stylelint-baseline-options-"));
  const recipe = buildRecipe("modern", ["stylelint-baseline"], "npm", [], {
    "stylelint-baseline": { available: 2025, severity: "error" },
  });

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await applyRecipeObject(recipe, {
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    const stylelintConfig = JSON.parse(await readFile(".stylelintrc.json", "utf8"));
    assert.deepEqual(stylelintConfig.rules["plugin/use-baseline"], [
      true,
      { available: 2025, severity: "error" },
    ]);
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply writes selected Prettier plugins into configuration", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-prettier-plugins-"));
  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", JSON.stringify({ scripts: {} }));
    await applyRecipeObject(
      buildRecipe("classic", ["prettier-tailwind", "prettier-astro"], "npm"),
      { json: true, noInstall: true, assumeYes: true },
    );
    assert.deepEqual(JSON.parse(await readFile(".prettierrc.json", "utf8")), {
      plugins: ["prettier-plugin-tailwindcss", "prettier-plugin-astro"],
    });
  } finally {
    process.chdir(originalDirectory);
    await rm(projectDirectory, { force: true, recursive: true });
  }
});

test("doctor does not expect the removed run-if-files helper", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-doctor-no-helper-"));

  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await writeFile(
      "calavera.config.json",
      `${JSON.stringify(buildRecipe("modern", ["typescript", "oxlint"], "npm"), null, 2)}\n`,
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("../src/index.js", import.meta.url)), "doctor", "--json"],
      { env: { ...process.env, NO_COLOR: "1" } },
    );
    const result = JSON.parse(stdout);

    assert.equal(
      result.issues.some(({ message }) => message.includes(".calavera/run-if-files.mjs")),
      false,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("clean treats a matching managed run-if-files helper as stale", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-clean-helper-"));
  const helperPath = ".calavera/run-if-files.mjs";
  const helperContents = "managed helper from an older Calavera release\n";

  try {
    process.chdir(projectDirectory);
    await mkdir(".calavera");
    await writeFile(
      "calavera.config.json",
      `${JSON.stringify(buildRecipe("modern", ["oxlint"], "npm"), null, 2)}\n`,
    );
    await writeFile(helperPath, helperContents);
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify(
        {
          version: 1,
          profile: "modern",
          integrations: ["oxlint"],
          files: [helperPath],
          managedFiles: [{ path: helperPath, hash: textHash(helperContents) }],
          aiArtifacts: [],
        },
        null,
        2,
      )}\n`,
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("../src/index.js", import.meta.url)), "clean", "--dry-run", "--json"],
      { env: { ...process.env, NO_COLOR: "1" } },
    );
    const result = JSON.parse(stdout);

    assert.equal(
      result.changes.some(({ type, path }) => type === "delete" && path === helperPath),
      true,
    );
    assert.equal(result.message, "Dry run complete. No files were removed.");
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply dry-run human output distinguishes owned writes and omitted scripts", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-cli-dry-run-output-"));
  const binPath = join(projectDirectory, "create-project-calavera");

  try {
    process.chdir(projectDirectory);
    await symlink(fileURLToPath(new URL("../src/index.js", import.meta.url)), binPath);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await writeFile(
      "calavera.config.json",
      `${JSON.stringify(
        {
          ...buildRecipe("minimal", ["editorconfig"], "npm"),
          scripts: {
            lint: true,
            format: true,
            typecheck: true,
            quality: true,
          },
        },
        null,
        2,
      )}\n`,
    );

    const { stdout } = await execFileAsync(process.execPath, [binPath, "apply", "--dry-run"], {
      env: { ...process.env, NO_COLOR: "1" },
    });

    assert.match(stdout, /Would update package\.json/);
    assert.match(stdout, /Would write and own \.editorconfig/);
    assert.match(
      stdout,
      /Would omit script format: format was requested but no formatter integration is selected\./,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply uses project devEngines package manager over an implicit npm recipe default", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-apply-bun-devengines-"));

  try {
    process.chdir(projectDirectory);
    await writeFile(
      "package.json",
      `${JSON.stringify(
        {
          scripts: {},
          devEngines: {
            packageManager: {
              name: "bun",
              version: "1.3.14",
              onFail: "download",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await applyRecipeObject(buildRecipe("modern", ["oxlint"], "npm"), {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });

    assert.equal(result.packageManager, "bun");
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply recognizes a declared npm package manager", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-apply-npm-package-manager-"));
  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", JSON.stringify({ scripts: {}, packageManager: "npm@11.6.0" }));
    const result = await applyRecipeObject(buildRecipe("minimal", [], "pnpm"), {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });
    assert.equal(result.packageManager, "npm");
  } finally {
    process.chdir(originalDirectory);
  }
});

test("apply package manager override wins over project devEngines detection", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-apply-pm-override-"));

  try {
    process.chdir(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({
        devEngines: {
          packageManager: {
            name: "bun",
            version: "1.3.14",
          },
        },
      }),
    );

    const result = await applyRecipeObject(buildRecipe("minimal", ["editorconfig"], "npm"), {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
      packageManager: "pnpm",
    });

    assert.equal(result.packageManager, "pnpm");
  } finally {
    process.chdir(originalDirectory);
  }
});

test("MCP dry_run_apply uses project devEngines package manager", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-mcp-dry-run-bun-"));

  try {
    process.chdir(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({
        devEngines: {
          packageManager: {
            name: "bun",
            version: "1.3.14",
          },
        },
      }),
    );

    const response = await callMcpTool("dry_run_apply", {
      recipe: composeRecipe({ profile: "minimal" }),
    });

    assert.equal(response.result.packageManager, "bun");
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

test("MCP apply_recipe rejects config paths escaping through a symlink", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-mcp-symlink-"));
  const outsideDirectory = await mkdtemp(join(tmpdir(), "calavera-mcp-outside-"));
  try {
    process.chdir(projectDirectory);
    await symlink(outsideDirectory, "linked");
    await assert.rejects(
      () =>
        callMcpTool("apply_recipe", {
          recipe: composeRecipe({ profile: "minimal", packageManager: "npm" }),
          config: "linked/calavera.config.json",
          noInstall: true,
        }),
      /config path must stay inside the current project workspace/,
    );
  } finally {
    process.chdir(originalDirectory);
    await rm(projectDirectory, { force: true, recursive: true });
    await rm(outsideDirectory, { force: true, recursive: true });
  }
});

test("hook apply plans both outputs and protects an unowned settings sidecar", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-hook-sidecar-"));
  const recipe = buildRecipe("minimal", [], "npm", [
    {
      type: "hook",
      src: "hooks/auto-approve-safe-commands",
      target: "claude-code",
    },
  ]);
  try {
    process.chdir(projectDirectory);
    await writeFile("package.json", JSON.stringify({ scripts: {} }));
    const dryRun = await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
    });
    assert.deepEqual(
      dryRun.changes.filter(({ category }) => category === "ai").map(({ path }) => path),
      [
        ".agents/hooks/claude-code/auto-approve-safe-commands.mjs",
        ".agents/hooks/claude-code/auto-approve-safe-commands.settings-fragment.json",
      ],
    );
    await mkdir(".agents/hooks/claude-code", { recursive: true });
    await writeFile(
      ".agents/hooks/claude-code/auto-approve-safe-commands.settings-fragment.json",
      "unowned\n",
    );
    await assert.rejects(
      () =>
        applyRecipeObject(recipe, {
          dryRun: true,
          json: true,
          noInstall: true,
          assumeYes: true,
        }),
      /settings-fragment\.json.*not recorded as Calavera-managed/,
    );

    await rm(".agents/hooks/claude-code/auto-approve-safe-commands.settings-fragment.json");
    await applyRecipeObject(recipe, {
      json: true,
      noInstall: true,
      assumeYes: true,
    });
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(
      state.aiArtifacts.map(({ path }) => path),
      [
        ".agents/hooks/claude-code/auto-approve-safe-commands.mjs",
        ".agents/hooks/claude-code/auto-approve-safe-commands.settings-fragment.json",
      ],
    );

    await writeFile(
      "calavera.config.json",
      `${JSON.stringify(buildRecipe("minimal", [], "npm"), null, 2)}\n`,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("../src/index.js", import.meta.url)), "clean", "--yes", "--json"],
      { env: { ...process.env, NO_COLOR: "1" } },
    );
    const cleanResult = JSON.parse(stdout);
    assert.deepEqual(
      cleanResult.changes.filter(({ category }) => category === "ai").map(({ path }) => path),
      [
        ".agents/hooks/claude-code/auto-approve-safe-commands.mjs",
        ".agents/hooks/claude-code/auto-approve-safe-commands.settings-fragment.json",
      ],
    );
    await assert.rejects(() => stat(".agents/hooks/claude-code/auto-approve-safe-commands.mjs"));
    await assert.rejects(() =>
      stat(".agents/hooks/claude-code/auto-approve-safe-commands.settings-fragment.json"),
    );
  } finally {
    process.chdir(originalDirectory);
    await rm(projectDirectory, { force: true, recursive: true });
  }
});

test("MCP AI-only apply preserves existing managed tooling state", async () => {
  const originalDirectory = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-mcp-ai-only-apply-"));
  const oxlintConfig = `${JSON.stringify({ plugins: ["typescript"] }, null, 2)}\n`;

  try {
    process.chdir(projectDirectory);
    await mkdir(".calavera");
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await writeFile("oxlint.json", oxlintConfig);
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify(
        {
          version: 1,
          profile: "modern",
          integrations: ["oxlint"],
          files: ["oxlint.json"],
          managedFiles: [{ path: "oxlint.json", hash: textHash(oxlintConfig) }],
          aiArtifacts: [],
        },
        null,
        2,
      )}\n`,
    );

    await callMcpTool("apply_recipe", {
      recipe: buildRecipe("minimal", [], "npm", [
        { type: "skill", src: "skills/frontend-engineering" },
      ]),
      writeConfig: false,
      noInstall: true,
    });

    await assert.rejects(readFile("calavera.config.json", "utf8"), { code: "ENOENT" });

    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.equal(state.profile, "modern");
    assert.deepEqual(state.integrations, ["oxlint"]);
    assert.deepEqual(state.files, ["oxlint.json"]);
    assert.deepEqual(state.managedFiles, [{ path: "oxlint.json", hash: textHash(oxlintConfig) }]);
    assert.equal(
      state.aiArtifacts.some((artifact) => artifact.path === ".agents/skills/frontend-engineering"),
      true,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("JSON apply installs dependencies without writing spinner UI to stdout", async () => {
  const originalDirectory = process.cwd();
  const originalPath = process.env.PATH;
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-json-apply-install-"));
  const binDirectory = join(projectDirectory, "bin");
  const npmPath = join(binDirectory, "npm");
  const stdoutWrites = [];
  const originalStdoutWrite = process.stdout.write;

  try {
    process.chdir(projectDirectory);
    await mkdir(binDirectory);
    await writeFile(
      npmPath,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('install-called.txt', process.argv.slice(2).join(' '));\n",
    );
    await chmod(npmPath, 0o755);
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    process.env.PATH = [binDirectory, originalPath].filter(Boolean).join(delimiter);
    process.stdout.write = function captureStdoutWrite(chunk, ...args) {
      stdoutWrites.push(String(chunk));
      return originalStdoutWrite.call(this, chunk, ...args);
    };

    const result = await applyRecipeObject(buildRecipe("modern", ["oxlint"], "npm"), {
      json: true,
      assumeYes: true,
    });

    assert.equal(result.dryRun, false);
    assert.deepEqual(result.dependencies, ["oxlint"]);
    assert.match(await readFile("install-called.txt", "utf8"), /install --save-dev oxlint/);
    assert.doesNotMatch(stdoutWrites.join(""), /Installing development dependencies/);
    assert.doesNotMatch(stdoutWrites.join(""), /Dependencies installed/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.env.PATH = originalPath;
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

test("persisted state rejects absolute and parent-relative managed paths", () => {
  assert.throws(
    () =>
      normalizeState({
        managedFiles: [{ path: "../outside", hash: "hash" }],
        aiArtifacts: [],
      }),
    /must stay inside the current project workspace/,
  );
  assert.throws(
    () =>
      normalizeState({
        managedFiles: [],
        aiArtifacts: [
          {
            type: "skill",
            name: "unsafe",
            source: "skills/unsafe",
            path: "/tmp/outside",
            hash: "hash",
          },
        ],
      }),
    /must stay inside the current project workspace/,
  );
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
