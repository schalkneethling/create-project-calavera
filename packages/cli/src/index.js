#!/usr/bin/env node
// @ts-check
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";

import {
  cancel,
  confirm,
  groupMultiselect,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { execa } from "execa";
import packageJson from "../package.json" with { type: "json" };
import { lockedArtifactSources, runArtifactCommand } from "./artifact-lifecycle.js";

import {
  aiArtifactOutputPaths,
  assertAiSourceExists,
  buildAiApplyResult,
  hashAiInstall,
  resolveAiArtifacts,
} from "./ai/artifacts.js";
import {
  createEmptyState,
  managedFileStateForPath,
  managedFilesFromState,
  normalizeState,
  optionalStringArray,
} from "./state.js";
import {
  integrationConfigFiles,
  packageManagerLockfiles,
  projectInspectionFiles,
} from "./project-inspection.js";
import {
  composeRecipe,
  explainRecipeResponse,
  listAiArtifactOptions,
  listIntegrationOptions,
  packageManagerIdsForRecipe,
  projectLocalCommandCatalog,
  profileIdsForRecipe,
  profileDefaults,
  resolveRecipeIntegrations,
  validateRecipe,
  validateRecipeResponse,
} from "./recipe.js";
import { assertKnownValue } from "./utils/assertions.js";
import { FileWriteError } from "./utils/file-write-error.js";
import { assertWorkspacePath, fileExists, readJSON, writeJSON } from "./utils/fs.js";
import { isNotEmptyString, isPlainObject } from "./utils/guards.js";
import { textHash } from "./utils/hash.js";
import { logger } from "./utils/logger.js";
import {
  createCodexMcpTomlBlock,
  createMcpServersJsonConfig,
  createOpenCodeMcpJsonConfig,
  projectMcpConfigPath,
  writeCodexMcpConfig,
  writeMcpServersJsonConfig,
  writeOpenCodeMcpConfig,
} from "./utils/mcp-config.js";
import { groupedPromptOptions } from "./utils/prompt-options.js";
import { pluralizeCount, style, titleCase } from "./utils/text.js";

/**
 * @typedef {"npm" | "pnpm" | "yarn" | "bun"} PackageManager
 * @typedef {"claude-code" | "codex" | "cursor" | "opencode" | "skip"} McpHarness
 * @typedef {import("./ai/artifacts.js").AiArtifactState} AiArtifactState
 * @typedef {import("./state.js").CalaveraState} CalaveraState
 * @typedef {import("./state.js").ManagedFileState} ManagedFileState
 *
 * @typedef {object} CliOptions
 * @property {string} command
 * @property {string} config
 * @property {boolean} dryRun
 * @property {boolean} json
 * @property {boolean} noInstall
 * @property {boolean} assumeYes
 * @property {boolean} apply
 * @property {boolean} [writeConfig]
 * @property {PackageManager} [packageManager]
 * @property {"append" | "fallback"} [agentsMd]
 * @property {McpHarness} [mcpHarness]
 * @property {string} [profile]
 * @property {string[]} integrations
 * @property {{ id: string, target?: string }[]} aiArtifacts
 * @property {string[]} reownManagedFiles
 * @property {string} [artifactAction]
 * @property {string} [artifactId]
 * @property {"latest" | "next"} [artifactTag]
 * @property {boolean} [artifactAll]
 * @property {boolean} [checkUpdates]
 *
 * @typedef {object} PackageManagerCommands
 * @property {[string, string[]]} init
 * @property {(dependencies: string[]) => [string, string[]]} installDev
 * @property {(script: string) => string} run
 *
 * @typedef {object} PackageJSON
 * @property {Record<string, string | boolean>} [scripts]
 * @property {string} [packageManager]
 * @property {{ packageManager?: { name?: string } | Array<{ name?: string }> }} [devEngines]
 *
 * @typedef {object} Integration
 * @property {string} id
 * @property {string} [label]
 * @property {string} [group]
 * @property {string} [platform]
 * @property {string} [plugin]
 * @property {string} [status]
 * @property {string[]} [dependencies]
 * @property {string[]} [includes]
 * @property {{ extends?: string[], plugins?: string[], rules?: Record<string, unknown> }} [stylelint]
 * @property {{ plugins?: string[] }} [prettier]
 *
 * @typedef {object} Recipe
 * @property {string} [$schema]
 * @property {number} [version]
 * @property {string} [profile]
 * @property {PackageManager} [packageManager]
 * @property {string[]} [integrations]
 * @property {Record<string, unknown>} [integrationOptions]
 * @property {Record<string, boolean>} [scripts]
 * @property {unknown} [ai]
 *
 * @typedef {{ script: string, reason: string }} ScriptOmission
 * @typedef {{ severity: "info" | "warning" | "error", kind: string, message: string, path?: string }} ProjectInspectionFinding
 * @typedef {{ packageManager?: PackageManager, files: string[], findings: ProjectInspectionFinding[] }} ProjectInspection
 * @typedef {{ reownManagedFiles?: string[] }} ProjectInspectionOptions
 * @typedef {{ scripts: Record<string, string>, omittedScripts: ScriptOmission[] }} ScriptPlan
 * @typedef {{ type: string, path: string, action?: "write" | "update" | "scaffold" | "merge", ownership?: "calavera" | "project", category?: "ai", aiType?: string, name?: string, reason?: string, scripts?: string[], omittedScripts?: ScriptOmission[], removedDefaultTestScript?: boolean }} Change
 *
 * @typedef {object} ApplyResult
 * @property {"apply"} command
 * @property {boolean} dryRun
 * @property {PackageManager} packageManager
 * @property {string[]} dependencies
 * @property {string[]} integrations
 * @property {ProjectInspection} projectInspection
 * @property {Change[]} changes
 * @property {string[]} pointers
 *
 * @typedef {object} CleanResult
 * @property {"clean"} command
 * @property {boolean} [dryRun]
 * @property {Change[]} changes
 * @property {string} message
 *
 * @typedef {object} DoctorResult
 * @property {"doctor"} command
 * @property {boolean} ok
 * @property {{ level: "error" | "warning", message: string }[]} issues
 *
 * @typedef {object} InitResult
 * @property {"init"} command
 * @property {string} config
 * @property {boolean} dryRun
 * @property {Recipe} recipe
 * @property {{ ok: boolean, recipe?: Recipe, errors?: string[] }} validation
 * @property {{ integrations: unknown[], dependencies: string[], aiArtifacts: unknown[] }} explanation
 * @property {ApplyResult} [applyDryRun]
 * @property {ApplyResult} [applyResult]
 *
 * @typedef {object} AgentInitResult
 * @property {"agent-init"} command
 * @property {boolean} dryRun
 * @property {Change[]} changes
 * @property {string[]} pointers
 * @property {string} nextPrompt
 * @property {{ harness: McpHarness, action: "manual" | "write" | "update" | "skip", path?: string, reason?: string }} mcp
 *
 * @typedef {{ command: `artifacts ${string}`, [key: string]: unknown }} ArtifactCommandResult
 * @typedef {ApplyResult | CleanResult | DoctorResult | InitResult | AgentInitResult | ArtifactCommandResult} CommandResult
 */

const CONFIG_FILE = "calavera.config.json";
const STATE_FILE = ".calavera/state.json";
const AGENT_BOOTSTRAP_GUIDANCE_FILE = "AGENTS.md";
const AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE = "AGENTS.calavera.md";
const AGENT_BOOTSTRAP_MCP_FILE = ".agents/calavera/mcp.md";
const AGENT_BOOTSTRAP_MARKER = "<!-- calavera-agent-bootstrap -->";
const AGENT_BOOTSTRAP_SECTION_START = "<!-- calavera-agent-bootstrap:start -->";
const AGENT_BOOTSTRAP_SECTION_END = "<!-- calavera-agent-bootstrap:end -->";
const AGENT_BOOTSTRAP_SKILL_RECIPE = {
  ai: [{ type: "skill", src: "skills/calavera" }],
};
const AGENT_BOOTSTRAP_NEXT_PROMPT =
  "Use Calavera for this project. First verify that the Calavera MCP tools are available. If they are not available, stop and help me configure the MCP server before composing or applying anything. Once the tools are available, inspect the current project for existing tooling and possible config conflicts, list the available profiles, integrations, and AI artifacts, compose a recipe, show me the dry-run result, and apply it only after I approve.";
const SCRIPT_SOURCE_EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs"];
const TSC_INCLUDE_PATTERNS = SCRIPT_SOURCE_EXTENSIONS.map((extension) => `src/**/*.${extension}`);

/** @type {Record<PackageManager, PackageManagerCommands>} */
const packageManagerCommands = {
  npm: {
    init: ["npm", ["init", "-y"]],
    installDev: (dependencies) => ["npm", ["install", "--save-dev", ...dependencies]],
    run: (script) => `npm run ${script}`,
  },
  pnpm: {
    init: ["pnpm", ["init"]],
    installDev: (dependencies) => ["pnpm", ["add", "--save-dev", ...dependencies]],
    run: (script) => `pnpm ${script}`,
  },
  yarn: {
    init: ["yarn", ["init", "-y"]],
    installDev: (dependencies) => ["yarn", ["add", "--dev", ...dependencies]],
    run: (script) => `yarn ${script}`,
  },
  bun: {
    init: ["bun", ["init", "-y"]],
    installDev: (dependencies) => ["bun", ["add", "--dev", ...dependencies]],
    run: (script) => `bun run ${script}`,
  },
};

/** @type {PackageManager[]} */
const supportedPackageManagers = /** @type {PackageManager[]} */ (
  Object.keys(packageManagerCommands)
);
/** @type {McpHarness[]} */
const supportedMcpHarnesses = ["claude-code", "codex", "cursor", "opencode", "skip"];
const supportedProfiles = profileIdsForRecipe();
const recipePackageManagers = packageManagerIdsForRecipe();
const args = process.argv.slice(2);
/** @type {import("node:util").ParseArgsOptionsConfig} */
const cliParseOptions = {
  config: { type: "string", default: CONFIG_FILE },
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  init: { type: "boolean" },
  json: { type: "boolean" },
  "agents-md": { type: "string" },
  "mcp-harness": { type: "string" },
  "no-install": { type: "boolean" },
  yes: { type: "boolean" },
  "package-manager": { type: "string" },
  profile: { type: "string" },
  integration: { type: "string", multiple: true, default: [] },
  integrations: { type: "string", multiple: true, default: [] },
  tool: { type: "string", multiple: true, default: [] },
  tools: { type: "string", multiple: true, default: [] },
  "ai-artifact": { type: "string", multiple: true, default: [] },
  "ai-artifacts": { type: "string", multiple: true, default: [] },
  "reown-managed-file": { type: "string", multiple: true, default: [] },
  "reown-managed-files": { type: "string", multiple: true, default: [] },
  tag: { type: "string", default: "latest" },
  all: { type: "boolean" },
  "check-updates": { type: "boolean" },
};

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
function listFlagValues(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {unknown[]} values
 * @returns {string[]}
 */
function collectListValues(...values) {
  return values.flatMap((value) =>
    Array.isArray(value)
      ? value.flatMap((item) => (typeof item === "string" ? listFlagValues(item) : []))
      : typeof value === "string"
        ? listFlagValues(value)
        : [],
  );
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalStringValue(value) {
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {string} value
 * @returns {{ id: string, target?: string }}
 */
function parseAiArtifactFlag(value) {
  const separatorIndex = value.indexOf("@");

  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return { id: value };
  }

  return {
    id: value.slice(0, separatorIndex),
    target: value.slice(separatorIndex + 1),
  };
}

/**
 * @param {string | undefined} packageManager
 * @returns {PackageManager}
 */
function assertSupportedPackageManager(packageManager) {
  if (
    !packageManager ||
    !supportedPackageManagers.includes(/** @type {PackageManager} */ (packageManager))
  ) {
    throw new Error(
      `Invalid package manager: ${packageManager ?? "<missing>"}. Allowed values: ${supportedPackageManagers.join(", ")}.`,
    );
  }

  return /** @type {PackageManager} */ (packageManager);
}

/**
 * @param {string | undefined} harness
 * @returns {McpHarness}
 */
function assertSupportedMcpHarness(harness) {
  if (!harness || !supportedMcpHarnesses.includes(/** @type {McpHarness} */ (harness))) {
    throw new Error(
      `Invalid MCP harness: ${harness ?? "<missing>"}. Allowed values: ${supportedMcpHarnesses.join(", ")}.`,
    );
  }

  return /** @type {McpHarness} */ (harness);
}

/**
 * @param {string[]} rawArgs
 * @returns {CliOptions}
 */
export function parseArgs(rawArgs) {
  const args = rawArgs.filter((arg) => arg.trim() !== "--");
  const { values, positionals } = parseNodeArgs({
    args,
    options: cliParseOptions,
    allowPositionals: true,
  });
  const profile = optionalStringValue(values.profile);
  const packageManager = optionalStringValue(values["package-manager"]);
  const agentsMd = optionalStringValue(values["agents-md"]);
  const mcpHarness = optionalStringValue(values["mcp-harness"]);
  const artifactTag = optionalStringValue(values.tag) ?? "latest";
  assertKnownValue("tag", artifactTag, ["latest", "next"]);
  /** @type {CliOptions} */
  const parsed = {
    command: values.help ? "help" : values.init ? "agent-init" : (positionals[0] ?? "init"),
    config: optionalStringValue(values.config) ?? CONFIG_FILE,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    noInstall: values["no-install"] === true,
    assumeYes: values.yes === true,
    apply: values.apply === true,
    integrations: collectListValues(
      values.integration,
      values.integrations,
      values.tool,
      values.tools,
    ),
    aiArtifacts: collectListValues(values["ai-artifact"], values["ai-artifacts"]).map(
      parseAiArtifactFlag,
    ),
    reownManagedFiles: collectListValues(
      values["reown-managed-file"],
      values["reown-managed-files"],
    ),
    artifactAction: positionals[1],
    artifactId: positionals[2],
    artifactTag: /** @type {"latest" | "next"} */ (artifactTag),
    artifactAll: values.all === true,
    checkUpdates: values["check-updates"] === true,
  };

  if (profile !== undefined) {
    assertKnownValue("profile", profile, supportedProfiles);
    parsed.profile = profile;
  }

  if (packageManager !== undefined) {
    parsed.packageManager = assertSupportedPackageManager(packageManager);
  }

  if (agentsMd !== undefined) {
    assertKnownValue("agents-md", agentsMd, ["append", "fallback"]);
    parsed.agentsMd = /** @type {"append" | "fallback"} */ (agentsMd);
  }

  if (mcpHarness !== undefined) {
    parsed.mcpHarness = assertSupportedMcpHarness(mcpHarness);
  }

  return parsed;
}

/**
 * @returns {Promise<PackageJSON>}
 */
async function readPackageJSONIfPresent() {
  const packageJSONPath = resolve("package.json");

  if (await fileExists(packageJSONPath)) {
    return /** @type {Promise<PackageJSON>} */ (readJSON(packageJSONPath));
  }

  return {};
}

/**
 * @param {string} path
 * @returns {Promise<Recipe>}
 */
async function readRecipe(path) {
  const recipe = await readJSON(path);

  if (!isPlainObject(recipe)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  optionalStringArray(recipe.integrations, `${path} integrations`);

  if (Object.hasOwn(recipe, "packageManager") && !isNotEmptyString(recipe.packageManager)) {
    throw new Error(`${path} packageManager must be a non-empty string.`);
  }

  if (Object.hasOwn(recipe, "scripts") && !isPlainObject(recipe.scripts)) {
    throw new Error(`${path} scripts must be an object.`);
  }

  return /** @type {Recipe} */ (recipe);
}

/**
 * @param {Array<string | null | undefined | false>} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values.filter(isNotEmptyString))];
}

/**
 * @returns {Promise<CalaveraState>}
 */
async function readStateIfPresent() {
  if (!(await fileExists(STATE_FILE))) {
    return createEmptyState();
  }

  return normalizeState(await readJSON(STATE_FILE));
}

/**
 * @param {PackageJSON} [packageJSON]
 * @returns {PackageManager | undefined}
 */
function detectPackageManager(packageJSON = {}) {
  if (packageJSON.packageManager?.startsWith("npm")) {
    return "npm";
  }

  if (packageJSON.packageManager?.startsWith("pnpm")) {
    return "pnpm";
  }

  if (packageJSON.packageManager?.startsWith("yarn")) {
    return "yarn";
  }

  if (packageJSON.packageManager?.startsWith("bun")) {
    return "bun";
  }

  const devPackageManagers = [packageJSON.devEngines?.packageManager]
    .flat()
    .flatMap((packageManager) =>
      packageManager && typeof packageManager.name === "string" ? [packageManager.name] : [],
    );
  const devPackageManager = devPackageManagers.find((packageManager) =>
    supportedPackageManagers.includes(/** @type {PackageManager} */ (packageManager)),
  );

  if (devPackageManager) {
    return /** @type {PackageManager} */ (devPackageManager);
  }

  if (packageManagerLockfiles.pnpm.some((path) => existsSync(path))) {
    return "pnpm";
  }

  if (packageManagerLockfiles.yarn.some((path) => existsSync(path))) {
    return "yarn";
  }

  if (packageManagerLockfiles.bun.some((path) => existsSync(path))) {
    return "bun";
  }

  if (packageManagerLockfiles.npm.some((path) => existsSync(path))) {
    return "npm";
  }

  return undefined;
}

/**
 * @param {Recipe} recipe
 * @param {Partial<CliOptions>} applyOptions
 * @param {PackageJSON} packageJSON
 * @returns {PackageManager}
 */
function resolveApplyPackageManager(recipe, applyOptions, packageJSON) {
  const packageManager =
    applyOptions.packageManager ?? detectPackageManager(packageJSON) ?? recipe.packageManager;

  if (packageManager) {
    return assertSupportedPackageManager(packageManager);
  }

  return "npm";
}

/**
 * @param {PackageJSON} packageJSON
 * @returns {boolean}
 */
function removeDefaultTestScript(packageJSON) {
  const defaultNpmTestScript = 'echo "Error: no test specified" && exit 1';

  if (packageJSON.scripts?.test === defaultNpmTestScript) {
    delete packageJSON.scripts.test;
    return true;
  }

  return false;
}

/**
 * @param {PackageManager} packageManager
 * @param {boolean} dryRun
 * @param {boolean} assumeYes
 * @param {boolean} json
 * @returns {Promise<PackageJSON>}
 */
async function ensurePackageJSON(packageManager, dryRun, assumeYes, json) {
  const supportedPackageManager = assertSupportedPackageManager(packageManager);
  const packageJSONPath = resolve("package.json");

  if (await fileExists(packageJSONPath)) {
    return /** @type {Promise<PackageJSON>} */ (readJSON(packageJSONPath));
  }

  if (!assumeYes) {
    const createPackageJSON = await confirm({
      message:
        "No package.json found. Calavera needs one to manage tooling. Create a default package.json?",
    });

    if (!createPackageJSON || isCancel(createPackageJSON)) {
      cancel("Setup cancelled");
      process.exit(0);
    }
  }

  if (!dryRun) {
    const [command, commandArgs] = packageManagerCommands[supportedPackageManager].init;
    const spin = json ? null : spinner();
    spin?.start("Creating package.json...");
    await execa(command, commandArgs, { stderr: "inherit" });
    spin?.stop("Created package.json");
  }

  return dryRun ? { scripts: {} } : /** @type {Promise<PackageJSON>} */ (readJSON(packageJSONPath));
}

/**
 * @param {Recipe} recipe
 * @param {Integration[]} integrations
 * @param {PackageManager} packageManager
 * @returns {ScriptPlan}
 */
function buildScripts(recipe, integrations, packageManager) {
  const supportedPackageManager = assertSupportedPackageManager(packageManager);
  /** @param {string} id */
  const has = (id) => integrations.some((integration) => integration.id === id);
  const usesOxlint = has("oxlint");
  const usesESLint = has("eslint");
  const usesStylelint = has("stylelint");
  const usesOxfmt = has("oxfmt");
  const usesPrettier = has("prettier");
  const usesReactDoctor = has("react-doctor");
  const usesTypeScript = has("typescript");

  const lintParts = [
    usesOxlint ? "oxlint ." : null,
    usesESLint ? "eslint ." : null,
    usesStylelint ? 'stylelint "**/*.{css,scss}"' : null,
  ].filter(Boolean);

  const lintFixParts = [
    usesOxlint ? "oxlint --fix ." : null,
    usesESLint ? "eslint --fix ." : null,
    usesStylelint ? 'stylelint "**/*.{css,scss}" --fix' : null,
  ].filter(Boolean);

  /** @type {Record<string, string>} */
  const scripts = {};
  /** @type {ScriptOmission[]} */
  const omittedScripts = [];

  if (recipe.scripts?.lint && lintParts.length > 0) {
    scripts.lint = lintParts.join(" && ");
  } else if (recipe.scripts?.lint) {
    omittedScripts.push({
      script: "lint",
      reason: "lint was requested but no linting integration is selected.",
    });
  }

  if (recipe.scripts?.["lint:fix"] && lintFixParts.length > 0) {
    scripts["lint:fix"] = lintFixParts.join(" && ");
  } else if (recipe.scripts?.["lint:fix"]) {
    omittedScripts.push({
      script: "lint:fix",
      reason: "lint:fix was requested but no fix-capable linting integration is selected.",
    });
  }

  if (recipe.scripts?.format) {
    if (usesOxfmt) {
      scripts.format = "oxfmt --write .";
    } else if (usesPrettier) {
      scripts.format = "prettier --write .";
    } else {
      omittedScripts.push({
        script: "format",
        reason: "format was requested but no formatter integration is selected.",
      });
    }
  }

  if (recipe.scripts?.["format:check"]) {
    if (usesOxfmt) {
      scripts["format:check"] = "oxfmt --check .";
    } else if (usesPrettier) {
      scripts["format:check"] = "prettier --check .";
    } else {
      omittedScripts.push({
        script: "format:check",
        reason: "format:check was requested but no formatter integration is selected.",
      });
    }
  }

  if (recipe.scripts?.typecheck && usesTypeScript) {
    scripts.typecheck = "tsc --noEmit";
  } else if (recipe.scripts?.typecheck) {
    omittedScripts.push({
      script: "typecheck",
      reason: "typecheck was requested but the TypeScript integration is not selected.",
    });
  }

  if (usesReactDoctor) {
    scripts["react:doctor"] = "react-doctor --offline";
    scripts["react:doctor:diff"] = "react-doctor --offline --diff";
  }

  if (recipe.scripts?.quality) {
    const qualityScripts = [
      "lint",
      "format:check",
      usesTypeScript && recipe.scripts?.typecheck ? "typecheck" : null,
      usesReactDoctor ? "react:doctor" : null,
    ]
      .filter(isNotEmptyString)
      .filter((script) => Boolean(scripts[script]));

    if (qualityScripts.length > 0) {
      scripts.quality = qualityScripts
        .map((script) => packageManagerCommands[supportedPackageManager].run(script))
        .join(" && ");
    } else {
      omittedScripts.push({
        script: "quality",
        reason: "quality was requested but no generated scripts are available to aggregate.",
      });
    }
  }

  return { scripts, omittedScripts };
}

function createEditorConfig() {
  return `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
`;
}

function createAgentBootstrapGuidanceBody() {
  return `# Calavera Agent Guidance

- Use Calavera when the user wants to inspect, compose, preview, apply, or update project tooling.
- Verify the Calavera MCP tools are available before composing a recipe.
- Prefer the Calavera MCP server over hand-authoring \`calavera.config.json\`.
- If the Calavera MCP tools are not available, stop and help the user register the MCP server from \`${AGENT_BOOTSTRAP_MCP_FILE}\`, then reload the agent session if the MCP host requires it.
- Do not inspect npm cache internals or import Calavera source files from a package cache as a substitute for MCP setup.
- Inspect existing project tooling before composing a recipe and raise likely config conflicts early.
- If likely conflicts exist, pause before applying changes. List each conflict as a hard stop or a migration decision the user can approve, and use \`dry_run_apply\` to show concrete impact when adoption still looks possible.
- Start with \`inspect_project\`, \`list_profiles\`, \`list_integrations\`, and \`list_ai_artifacts\`; use \`describe_integration\` when the user asks for more information or an option needs explanation.
- Choose either Oxfmt or Prettier for formatting; do not select both in the same recipe.
- Compose recipes with \`compose_recipe\`, validate them with \`validate_recipe\`, and explain the selected integrations with \`explain_recipe\`.
- Always present \`dry_run_apply\` output to the user before changing files.
- Call \`apply_recipe\` only after the user explicitly approves the dry-run result.
- If the MCP transport closes or reports \`-32000\` during or immediately after \`apply_recipe\`, treat the outcome as unknown instead of failed. Inspect \`calavera.config.json\`, \`.calavera/state.json\`, generated files, and package metadata before retrying the apply.
- Treat files listed by \`dry_run_apply\` as Calavera-managed outputs. Do not hand-write or edit them; let \`apply_recipe\` or \`create-project-calavera apply\` create them after approval.
- Use AskUserTool or the agent client's equivalent when available for profile choices, conflict decisions, and apply approval.

MCP setup notes live in \`${AGENT_BOOTSTRAP_MCP_FILE}\`.
`;
}

function createAgentBootstrapGuidance() {
  return `${AGENT_BOOTSTRAP_MARKER}
${createAgentBootstrapGuidanceBody()}`;
}

function createAgentBootstrapGuidanceSection() {
  return `${AGENT_BOOTSTRAP_SECTION_START}
${createAgentBootstrapGuidanceBody().trimEnd()}
${AGENT_BOOTSTRAP_SECTION_END}
`;
}

/**
 * @param {PackageManager} packageManager
 * @returns {{ command: string, args: string[] }}
 */
function createMcpLaunchCommand(packageManager) {
  const packageSpecifier = `create-project-calavera@${packageJson.version}`;

  switch (packageManager) {
    case "pnpm":
      return {
        command: "pnpm",
        args: ["dlx", "--package", packageSpecifier, "create-project-calavera-mcp"],
      };
    case "yarn":
      return {
        command: "yarn",
        args: ["dlx", "--package", packageSpecifier, "create-project-calavera-mcp"],
      };
    case "bun":
      return {
        command: "bunx",
        args: ["--package", packageSpecifier, "create-project-calavera-mcp"],
      };
    default:
      return {
        command: "npx",
        args: ["--package", packageSpecifier, "create-project-calavera-mcp"],
      };
  }
}

/**
 * @param {{ command: string, args: string[] }} launchCommand
 * @returns {string}
 */
function formatShellCommand(launchCommand) {
  return [launchCommand.command, ...launchCommand.args].join(" ");
}

function createMcpManualCommandReference() {
  return supportedPackageManagers
    .map((packageManager) => {
      const commands = projectLocalCommandCatalog[packageManager];
      return `- ${commands.label}: \`${formatShellCommand(createMcpLaunchCommand(packageManager))}\``;
    })
    .join("\n");
}

/**
 * @param {{ command: string, args: string[] }} launchCommand
 * @returns {string}
 */
function createMcpServerConfigSnippet(launchCommand) {
  return JSON.stringify(createMcpServersJsonConfig(launchCommand), null, 2);
}

/**
 * @param {PackageManager} packageManager
 * @returns {string}
 */
function createAgentBootstrapMcpInstructions(packageManager) {
  const commands = projectLocalCommandCatalog[packageManager];
  const launchCommand = createMcpLaunchCommand(packageManager);
  const mcpConfig = createMcpServerConfigSnippet(launchCommand);
  const codexConfig = createCodexMcpTomlBlock(launchCommand).trimEnd();
  const opencodeConfig = JSON.stringify(createOpenCodeMcpJsonConfig(launchCommand), null, 2);
  const shellCommand = formatShellCommand(launchCommand);
  const manualCommandReference = createMcpManualCommandReference();

  return `# Calavera MCP Setup

Calavera can configure MCP automatically during \`--init\` for one project-local
agent harness. It never writes global/user MCP config. If you skipped
auto-config or need to repair a setup manually, use the project-local target for
your harness.

This project's detected package manager is ${commands.label}; the launch command
is:

\`\`\`bash
${shellCommand}
\`\`\`

## Project-local targets

### Claude Code: \`.mcp.json\`

\`\`\`json
${mcpConfig}
\`\`\`

### Cursor: \`.cursor/mcp.json\`

\`\`\`json
${mcpConfig}
\`\`\`

### Codex: \`.codex/config.toml\`

\`\`\`toml
${codexConfig}
\`\`\`

### OpenCode: \`opencode.json\`

\`\`\`json
${opencodeConfig}
\`\`\`

Project-local MCP servers should be registered from the project root. Using the
package manager declared by the project avoids package-manager preflight
failures before Calavera can start, such as npm rejecting a Bun-managed project
through \`devEngines.packageManager\`.

When configuring an MCP server manually, choose the command that matches the
project's package manager:

${manualCommandReference}

After registration, reload or restart the agent session if your MCP host does not
discover new tools dynamically. Confirm the Calavera tools are visible before
composing a recipe.

Do not work around missing MCP tools by reading npm cache internals or importing
Calavera source files from package cache paths. That bypasses the supported MCP
setup and can use the wrong cached package version.

## Command syntax for agents

\`npm create\` uses \`--\` to forward flags to Calavera:

\`\`\`bash
npm create project-calavera -- --init
npm create project-calavera apply -- --dry-run
\`\`\`

Do not use \`npm create project-calavera --init\`; npm treats \`--init\` as its own
option and Calavera falls back to the recipe CLI.

Direct binary launchers such as \`npx --package\` and MCP server registrations
do not need an extra \`--\` before Calavera flags:

\`\`\`bash
npx --package create-project-calavera@${packageJson.version} create-project-calavera --help
${shellCommand}
\`\`\`

## Bun temp and cache directories

If a Bun-based MCP launch fails before Calavera starts with
\`error: bun is unable to write files to tempdir: PermissionDenied\`, configure
the MCP host to give that server a writable temp directory. Set \`TMPDIR\` to an
absolute path that exists and is writable by the MCP host process, such as an
absolute path to a project-local \`.calavera/tmp\` directory.

If Bun can write temp files but cannot populate its package cache, also set
\`BUN_INSTALL_CACHE_DIR\` to an absolute writable directory, such as an absolute
path to \`.calavera/bun-install-cache\`. Keep these environment overrides on Bun
MCP registrations only; they are recovery settings for restricted hosts, not
part of the default Calavera MCP config.

## Calavera MCP workflow

Use the tools in this order when they are available:

1. \`inspect_project\`
2. \`list_profiles\`
3. \`list_integrations\`
4. \`describe_integration\`
5. \`list_ai_artifacts\`
6. \`compose_recipe\`
7. \`validate_recipe\`
8. \`explain_recipe\`
9. \`dry_run_apply\`
10. \`apply_recipe\`

\`dry_run_apply\` is the review boundary. Show its inspection findings, omitted
script explanations, ownership notes, and planned file changes to the user, then
wait for explicit approval before calling \`apply_recipe\`.

\`apply_recipe.writeConfig: false\` only skips writing \`calavera.config.json\`.
Do not use it to bypass managed-file conflicts, stale state hashes, or an
unapproved dry-run result.

If the MCP transport closes or reports \`-32000\` during or immediately after
\`apply_recipe\`, treat the apply outcome as unknown instead of failed. Inspect
\`calavera.config.json\`, \`.calavera/state.json\`, generated files, and package
metadata before retrying the apply.

## Formatter choice

Choose one formatter per project. Do not combine Oxfmt and Prettier in one
recipe; they would compete for the same formatting scripts and config ownership.

Before composing a recipe, call \`inspect_project\` or inspect the project for existing tooling files such as \`package.json\`, \`calavera.config.json\`, \`.editorconfig\`, \`eslint.config.js\`, \`oxlint.json\`, \`.prettierrc.json\`, \`.stylelintrc.json\`, and \`tsconfig.json\`. Mention likely conflicts or local conventions before proposing changes. If conflicts exist, say whether they are hard stops or migration decisions, then use \`dry_run_apply\` to show the impact when adoption is still possible.

If the MCP server cannot be registered, use the hosted Web UI to compose and download a recipe:

https://calavera.schalkneethling.com

Then run \`${commands.applyDryRun}\` and ask for approval before running \`${commands.applyRecipe}\`.

Suggested first prompt:

> ${AGENT_BOOTSTRAP_NEXT_PROMPT}
`;
}

/**
 * @param {Integration[]} integrations
 * @returns {{ plugins: string[], rules: Record<string, unknown> }}
 */
function createOxlintConfig(integrations) {
  const pluginNames = integrations
    .filter((integration) => integration.platform === "oxlint-plugin")
    .map((integration) => integration.plugin);

  return {
    plugins: unique(pluginNames),
    rules: {},
  };
}

/**
 * @param {Integration[]} integrations
 * @returns {string}
 */
function createESLintConfig(integrations) {
  const useTypeScript = integrations.some((integration) => integration.id === "typescript-eslint");
  const usePrettier = integrations.some(
    (integration) => integration.id === "eslint-config-prettier",
  );

  const imports = [
    'import js from "@eslint/js";',
    'import globals from "globals";',
    useTypeScript ? 'import tseslint from "typescript-eslint";' : null,
    usePrettier ? 'import eslintConfigPrettier from "eslint-config-prettier";' : null,
  ].filter(Boolean);

  const configs = [
    "js.configs.recommended",
    useTypeScript ? "...tseslint.configs.strictTypeChecked" : null,
    useTypeScript ? "...tseslint.configs.stylisticTypeChecked" : null,
    usePrettier ? "eslintConfigPrettier" : null,
  ].filter(Boolean);

  const baseConfig = `{
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.nodeBuiltin,
      },${
        useTypeScript
          ? `
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },`
          : ""
      }
    },
    rules: {
      "no-console": ["error", { allow: ["clear", "info"] }],
    },
  }`;

  if (useTypeScript) {
    return `${imports.join("\n")}

export default tseslint.config(
  ${configs.join(",\n  ")},
  ${baseConfig},
);
`;
  }

  return `${imports.join("\n")}

export default [
  ${configs.join(",\n  ")},
  ${baseConfig},
];
`;
}

/**
 * @param {Integration[]} integrations
 * @param {Record<string, unknown>} [integrationOptions]
 * @returns {{ extends: string[], ignoreFiles: string[], plugins: string[], rules: Record<string, unknown> }}
 */
function createStylelintConfig(integrations, integrationOptions = {}) {
  /** @type {{ extends: string[], ignoreFiles: string[], plugins: string[], rules: Record<string, unknown> }} */
  const config = {
    extends: [],
    ignoreFiles: [
      "coverage/**",
      "dist/**",
      "**/dist/**",
      "**/dist-types/**",
      "dist-web/**",
      "node_modules/**",
    ],
    plugins: [],
    rules: {},
  };

  for (const integration of integrations) {
    if (!integration.stylelint) {
      continue;
    }

    config.extends.push(...(integration.stylelint.extends ?? []));
    config.plugins.push(...(integration.stylelint.plugins ?? []));
    config.rules = {
      ...config.rules,
      ...integration.stylelint.rules,
    };
  }

  config.extends = unique(config.extends);
  config.plugins = unique(config.plugins);

  const baselineOptions = integrationOptions["stylelint-baseline"];
  if (baselineOptions) {
    config.rules["plugin/use-baseline"] = [true, baselineOptions];
  }

  return config;
}

/**
 * @param {Integration[]} integrations
 * @returns {{ plugins?: string[] }}
 */
function createPrettierConfig(integrations) {
  const plugins = unique(
    integrations.flatMap((integration) => integration.prettier?.plugins ?? []),
  );

  return plugins.length > 0 ? { plugins } : {};
}

function createTSConfig() {
  return {
    compilerOptions: {
      allowJs: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      isolatedModules: true,
      module: "ESNext",
      moduleResolution: "bundler",
      noEmit: true,
      noUncheckedIndexedAccess: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
      target: "ESNext",
      types: ["node"],
      verbatimModuleSyntax: true,
    },
    include: TSC_INCLUDE_PATTERNS,
    exclude: ["node_modules"],
  };
}

function createReactDoctorConfig() {
  return {
    offline: true,
  };
}

/**
 * @param {string} path
 * @returns {string}
 */
function realpathIfPresent(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function normalizeManagedFilePath(path) {
  const pathWithPlatformSeparators = path.replace(/\\/g, "/");
  const projectRoot = realpathIfPresent(resolve("."));
  const absolutePath = realpathIfPresent(resolve(pathWithPlatformSeparators));
  return relative(projectRoot, absolutePath).replace(/\\/g, "/");
}

/**
 * @param {string[]} paths
 * @returns {Set<string>}
 */
function normalizeManagedFilePathSet(paths) {
  return new Set(paths.map(normalizeManagedFilePath));
}

/**
 * @param {string} path
 * @param {string} contents
 * @param {CalaveraState} previousState
 * @param {Set<string>} reownManagedFiles
 */
async function assertSafeManagedFileWrite(path, contents, previousState, reownManagedFiles) {
  if (!(await fileExists(path))) {
    return;
  }

  const installedContents = await readFile(path, "utf8");
  const targetHash = textHash(contents);
  const installedHash = textHash(installedContents);

  if (installedHash === targetHash) {
    return;
  }

  const stateFile = managedFileStateForPath(previousState, path);

  if (stateFile?.hash === installedHash) {
    return;
  }

  if (jsonContentsMatch(path, installedContents, contents)) {
    return;
  }

  if (stateFile && reownManagedFiles.has(normalizeManagedFilePath(path))) {
    return;
  }

  const reason = stateFile
    ? `It appears to have local edits (installed=${installedHash}, state=${stateFile.hash}).`
    : "It is not recorded as Calavera-managed.";

  throw new Error(`Refusing to overwrite existing managed file: ${path}. ${reason}`);
}

/**
 * @param {{ path: string, contents: string }[]} filePlans
 * @param {CalaveraState} previousState
 * @param {Set<string>} reownManagedFiles
 */
async function assertSafeManagedFileWrites(filePlans, previousState, reownManagedFiles) {
  for (const filePlan of filePlans) {
    await assertSafeManagedFileWrite(
      filePlan.path,
      filePlan.contents,
      previousState,
      reownManagedFiles,
    );
  }
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }

  return value;
}

/**
 * @param {string} path
 * @param {string} installedContents
 * @param {string} targetContents
 * @returns {boolean}
 */
function jsonContentsMatch(path, installedContents, targetContents) {
  if (!path.endsWith(".json")) {
    return false;
  }

  try {
    return (
      JSON.stringify(sortJsonValue(JSON.parse(installedContents))) ===
      JSON.stringify(sortJsonValue(JSON.parse(targetContents)))
    );
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @param {string} contents
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @param {CalaveraState} previousState
 * @param {Set<string>} reownManagedFiles
 * @returns {Promise<ManagedFileState>}
 */
async function writeManagedFile(path, contents, dryRun, changes, previousState, reownManagedFiles) {
  changes.push({ type: "write", path, action: "write", ownership: "calavera" });

  const managedFile = {
    path,
    hash: textHash(contents),
  };

  if (dryRun) {
    return managedFile;
  }

  await assertSafeManagedFileWrite(path, contents, previousState, reownManagedFiles);

  const directory = dirname(path);
  if (directory !== ".") {
    await mkdir(directory, { recursive: true });
  }

  await writeFile(path, contents);

  return managedFile;
}

/**
 * @param {string} path
 * @param {unknown} value
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @param {CalaveraState} previousState
 * @param {Set<string>} reownManagedFiles
 * @returns {Promise<ManagedFileState>}
 */
async function writeManagedJSONFile(
  path,
  value,
  dryRun,
  changes,
  previousState,
  reownManagedFiles,
) {
  return writeManagedFile(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    dryRun,
    changes,
    previousState,
    reownManagedFiles,
  );
}

/**
 * @param {Integration[]} integrations
 * @param {Record<string, unknown>} [integrationOptions]
 * @returns {{ path: string, contents: string }[]}
 */
function plannedManagedFiles(integrations, integrationOptions = {}) {
  const plans = [];

  if (integrations.some((integration) => integration.id === "editorconfig")) {
    plans.push({ path: ".editorconfig", contents: createEditorConfig() });
  }

  if (integrations.some((integration) => integration.id === "oxlint")) {
    plans.push({
      path: "oxlint.json",
      contents: `${JSON.stringify(createOxlintConfig(integrations), null, 2)}\n`,
    });
  }

  if (integrations.some((integration) => integration.id === "eslint")) {
    plans.push({ path: "eslint.config.js", contents: createESLintConfig(integrations) });
  }

  if (integrations.some((integration) => integration.id === "prettier")) {
    plans.push({
      path: ".prettierrc.json",
      contents: `${JSON.stringify(createPrettierConfig(integrations), null, 2)}\n`,
    });
    plans.push({
      path: ".prettierignore",
      contents: "node_modules\npackage-lock.json\npnpm-lock.yaml\nyarn.lock\nbun.lockb\n",
    });
  }

  if (integrations.some((integration) => integration.id === "stylelint")) {
    plans.push({
      path: ".stylelintrc.json",
      contents: `${JSON.stringify(createStylelintConfig(integrations, integrationOptions), null, 2)}\n`,
    });
  }

  if (integrations.some((integration) => integration.id === "react-doctor")) {
    plans.push({
      path: "react-doctor.config.json",
      contents: `${JSON.stringify(createReactDoctorConfig(), null, 2)}\n`,
    });
  }

  if (integrations.some((integration) => integration.id === "typescript")) {
    plans.push({
      path: "tsconfig.json",
      contents: `${JSON.stringify(createTSConfig(), null, 2)}\n`,
    });
  }

  return plans;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function projectFileExists(path) {
  return fileExists(resolve(path));
}

/**
 * @param {{ path: string, contents: string }} filePlan
 * @param {CalaveraState} previousState
 * @param {Set<string>} reownManagedFiles
 * @returns {Promise<ProjectInspectionFinding | undefined>}
 */
async function inspectManagedFilePlan(filePlan, previousState, reownManagedFiles) {
  if (!(await projectFileExists(filePlan.path))) {
    return undefined;
  }

  const targetHash = textHash(filePlan.contents);
  const installedContents = await readFile(filePlan.path, "utf8");
  const installedHash = textHash(installedContents);

  if (installedHash === targetHash) {
    return undefined;
  }

  const stateFile = managedFileStateForPath(previousState, filePlan.path);

  if (stateFile?.hash === installedHash) {
    return undefined;
  }

  if (jsonContentsMatch(filePlan.path, installedContents, filePlan.contents)) {
    return undefined;
  }

  if (stateFile && reownManagedFiles.has(normalizeManagedFilePath(filePlan.path))) {
    return {
      severity: "warning",
      kind: "managed-file-reown",
      path: filePlan.path,
      message: `${filePlan.path} has local edits relative to Calavera state; this run will treat the current contents as an approved managed-file baseline before applying the recipe.`,
    };
  }

  return {
    severity: "error",
    kind: "managed-file-conflict",
    path: filePlan.path,
    message: `${filePlan.path} already exists and is not a matching Calavera-managed file; review, remove, or migrate it before applying this recipe.`,
  };
}

/**
 * @param {Recipe} [recipe]
 * @param {ProjectInspectionOptions} [options]
 * @returns {Promise<ProjectInspection>}
 */
export async function inspectProject(recipe, options = {}) {
  const packageJSON = await readPackageJSONIfPresent();
  const previousState = await readStateIfPresent();
  const reownManagedFiles = normalizeManagedFilePathSet(options.reownManagedFiles ?? []);
  const packageManager = detectPackageManager(packageJSON);
  const integrations = recipe ? resolveRecipeIntegrations(recipe) : [];
  const integrationIds = new Set(integrations.map((integration) => integration.id));
  /** @type {string[]} */
  const files = [];
  /** @type {ProjectInspectionFinding[]} */
  const findings = [];

  for (const path of projectInspectionFiles) {
    if (await projectFileExists(path)) {
      files.push(path);
    }
  }

  if (packageManager) {
    findings.push({
      severity: "info",
      kind: "package-manager",
      message: `Detected ${packageManager} as the project package manager.`,
    });
  }

  const presentLockfiles = Object.values(packageManagerLockfiles)
    .flat()
    .filter((path) => files.includes(path));

  if (presentLockfiles.length > 1) {
    findings.push({
      severity: "warning",
      kind: "multiple-lockfiles",
      message: `Multiple package-manager lockfiles are present: ${presentLockfiles.join(", ")}. Confirm which package manager owns installs before applying.`,
    });
  }

  if (recipe?.packageManager && packageManager && recipe.packageManager !== packageManager) {
    findings.push({
      severity: "warning",
      kind: "package-manager-mismatch",
      path: "package.json",
      message: `The recipe uses ${recipe.packageManager}, but project inspection detected ${packageManager}; this is a migration decision that should be approved before applying.`,
    });
  }

  const packageScripts = packageJSON.scripts ?? {};
  for (const scriptName of ["lint", "lint:fix", "format", "format:check", "typecheck"]) {
    if (recipe?.scripts?.[scriptName] && typeof packageScripts[scriptName] === "string") {
      findings.push({
        severity: "warning",
        kind: "existing-package-script",
        path: "package.json",
        message: `package.json already defines "${scriptName}"; Calavera will replace that script if this recipe is applied.`,
      });
    }
  }

  for (const filePlan of plannedManagedFiles(integrations, recipe?.integrationOptions)) {
    const finding = await inspectManagedFilePlan(filePlan, previousState, reownManagedFiles);

    if (finding) {
      findings.push(finding);
    }
  }

  for (const [integrationId, paths] of Object.entries(integrationConfigFiles)) {
    if (!integrationIds.has(integrationId)) {
      continue;
    }

    for (const path of paths) {
      if (files.includes(path)) {
        findings.push({
          severity: "warning",
          kind: "existing-config",
          path,
          message: `${path} already exists; adopting the ${integrationId} integration may be a migration decision rather than a clean scaffold.`,
        });
      }
    }
  }

  if (
    integrationIds.has("oxlint") &&
    files.includes("eslint.config.js") &&
    !integrationIds.has("eslint")
  ) {
    findings.push({
      severity: "warning",
      kind: "equivalent-tooling",
      path: "eslint.config.js",
      message:
        "eslint.config.js exists while Oxlint is selected; decide whether this project should migrate linting or keep the existing ESLint setup.",
    });
  }

  if (
    integrationIds.has("eslint") &&
    files.includes("oxlint.json") &&
    !integrationIds.has("oxlint")
  ) {
    findings.push({
      severity: "warning",
      kind: "equivalent-tooling",
      path: "oxlint.json",
      message:
        "oxlint.json exists while ESLint is selected; decide whether this project should migrate linting or keep the existing Oxlint setup.",
    });
  }

  return {
    packageManager,
    files,
    findings,
  };
}

/**
 * @param {CliOptions} options
 * @returns {Promise<ApplyResult>}
 */
export async function applyRecipe(options) {
  const configPath = resolve(options.config);
  const recipe = await readRecipe(configPath);
  return applyRecipeObject(recipe, options);
}

/**
 * @param {Recipe} recipe
 * @param {Partial<CliOptions>} options
 * @returns {Promise<ApplyResult>}
 */
export async function applyRecipeObject(recipe, options = {}) {
  validateRecipe(recipe);

  const applyOptions = {
    dryRun: false,
    json: false,
    noInstall: false,
    assumeYes: false,
    reownManagedFiles: [],
    ...options,
  };
  const previousState = await readStateIfPresent();
  const reownManagedFiles = normalizeManagedFilePathSet(applyOptions.reownManagedFiles ?? []);
  const integrations = resolveRecipeIntegrations(recipe);
  const dependencyList = unique(
    integrations.flatMap((integration) => integration.dependencies ?? []),
  );
  const detectedPackageJSON = await readPackageJSONIfPresent();
  const packageManager = resolveApplyPackageManager(recipe, applyOptions, detectedPackageJSON);
  const packageJSON = await ensurePackageJSON(
    packageManager,
    applyOptions.dryRun,
    applyOptions.assumeYes,
    applyOptions.json,
  );
  const projectInspection = await inspectProject(recipe, {
    reownManagedFiles: applyOptions.reownManagedFiles,
  });
  const scriptPlan = buildScripts(recipe, integrations, packageManager);
  const { scripts, omittedScripts } = scriptPlan;
  /** @type {Change[]} */
  const changes = [];
  /** @type {ManagedFileState[]} */
  const managedFiles = [];
  const removedDefaultTestScript = removeDefaultTestScript(packageJSON);
  const managedFilePlans = plannedManagedFiles(integrations, recipe.integrationOptions);

  await assertSafeManagedFileWrites(managedFilePlans, previousState, reownManagedFiles);

  const artifactSources = await lockedArtifactSources(recipe, applyOptions.dryRun);
  const aiResult = await buildAiApplyResult(recipe, applyOptions, previousState, artifactSources);

  if (applyOptions.writeConfig) {
    const configPath = resolve(applyOptions.config ?? "calavera.config.json");
    changes.push({
      type: "write",
      path: relative(process.cwd(), configPath),
      action: "write",
      ownership: "project",
    });
    await writeJSON(configPath, recipe, applyOptions.dryRun);
  }

  packageJSON.scripts = {
    ...packageJSON.scripts,
    ...scripts,
  };
  changes.push({
    type: "update",
    path: "package.json",
    action: "update",
    ownership: "project",
    scripts: Object.keys(scripts),
    omittedScripts,
    removedDefaultTestScript,
  });

  if (integrations.some((integration) => integration.id === "editorconfig")) {
    managedFiles.push(
      await writeManagedFile(
        ".editorconfig",
        createEditorConfig(),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "oxlint")) {
    managedFiles.push(
      await writeManagedJSONFile(
        "oxlint.json",
        createOxlintConfig(integrations),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "eslint")) {
    managedFiles.push(
      await writeManagedFile(
        "eslint.config.js",
        createESLintConfig(integrations),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "prettier")) {
    managedFiles.push(
      await writeManagedJSONFile(
        ".prettierrc.json",
        createPrettierConfig(integrations),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
    managedFiles.push(
      await writeManagedFile(
        ".prettierignore",
        "node_modules\npackage-lock.json\npnpm-lock.yaml\nyarn.lock\nbun.lockb\n",
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "stylelint")) {
    managedFiles.push(
      await writeManagedJSONFile(
        ".stylelintrc.json",
        createStylelintConfig(integrations, recipe.integrationOptions),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "react-doctor")) {
    managedFiles.push(
      await writeManagedJSONFile(
        "react-doctor.config.json",
        createReactDoctorConfig(),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "typescript")) {
    managedFiles.push(
      await writeManagedJSONFile(
        "tsconfig.json",
        createTSConfig(),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (!applyOptions.dryRun) {
    await writeJSON("package.json", packageJSON, false);
  }

  if (!applyOptions.dryRun) {
    await mkdir(".calavera", { recursive: true });
    await writeJSON(
      STATE_FILE,
      mergeRecipeIntoState(
        previousState,
        recipe.profile,
        integrations.map((integration) => integration.id),
        managedFiles,
        aiResult.artifacts,
      ),
      false,
    );
  }

  if (dependencyList.length > 0 && !applyOptions.noInstall && !applyOptions.dryRun) {
    const [command, commandArgs] =
      packageManagerCommands[packageManager].installDev(dependencyList);
    const spin = applyOptions.json ? null : spinner();
    spin?.start("Installing development dependencies...");
    await execa(command, commandArgs, { stderr: "inherit" });
    spin?.stop("Dependencies installed");
  }

  return {
    command: "apply",
    dryRun: applyOptions.dryRun,
    packageManager,
    dependencies: dependencyList,
    integrations: integrations.map((integration) => integration.id),
    projectInspection,
    changes: [...changes, ...aiResult.changes],
    pointers: aiResult.pointers,
  };
}

/**
 * @param {CalaveraState} previousState
 * @param {string | undefined} profile
 * @param {string[]} integrations
 * @param {ManagedFileState[]} managedFiles
 * @param {AiArtifactState[]} aiArtifacts
 * @returns {CalaveraState}
 */
function mergeRecipeIntoState(previousState, profile, integrations, managedFiles, aiArtifacts) {
  const managedFilesByPath = new Map(
    managedFilesFromState(previousState).map((file) => [file.path, file]),
  );

  for (const managedFile of managedFiles) {
    managedFilesByPath.set(managedFile.path, managedFile);
  }

  const nextManagedFiles = [...managedFilesByPath.values()];
  const preservesToolingRecipe = managedFiles.length === 0 && aiArtifacts.length > 0;

  return {
    ...previousState,
    version: 1,
    profile: preservesToolingRecipe ? previousState.profile : profile,
    integrations: preservesToolingRecipe ? previousState.integrations : integrations,
    files: nextManagedFiles.map((file) => file.path),
    managedFiles: nextManagedFiles,
    aiArtifacts,
  };
}

/**
 * @param {CalaveraState} previousState
 * @param {AiArtifactState[]} aiArtifacts
 * @returns {CalaveraState}
 */
function mergeAiArtifactsIntoState(previousState, aiArtifacts) {
  const artifactsByPath = new Map(
    previousState.aiArtifacts.map((artifact) => [artifact.path, artifact]),
  );

  for (const artifact of aiArtifacts) {
    artifactsByPath.set(artifact.path, artifact);
  }

  return {
    ...previousState,
    version: 1,
    aiArtifacts: [...artifactsByPath.values()],
  };
}

/**
 * @param {string} path
 * @param {string} contents
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @param {string} conflictReason
 * @returns {Promise<boolean>}
 */
async function writeBootstrapTextFile(path, contents, dryRun, changes, conflictReason) {
  const targetPath = path.trim();

  if (!targetPath) {
    throw new Error("Bootstrap file path must be a non-empty string.");
  }

  if (await fileExists(targetPath)) {
    const currentContents = await readFile(targetPath, "utf8");

    changes.push({
      type: "skip",
      path: targetPath,
      reason: currentContents === contents ? "Already up to date." : conflictReason,
    });

    return currentContents === contents;
  }

  changes.push({ type: "write", path: targetPath });

  if (!dryRun) {
    const directory = dirname(targetPath);
    if (directory !== ".") {
      await mkdir(directory, { recursive: true });
    }

    await writeFile(targetPath, contents);
  }

  return true;
}

/**
 * @param {string} path
 */
async function assertBootstrapDirectoryAvailable(path) {
  if (!(await fileExists(path))) {
    return;
  }

  const pathStats = await stat(path);

  if (!pathStats.isDirectory()) {
    throw new Error(
      `Cannot write Calavera bootstrap state because ${path} exists and is not a directory.`,
    );
  }
}

/**
 * @param {CliOptions} options
 * @returns {Promise<"append" | "fallback">}
 */
async function resolveAgentBootstrapGuidanceMode(options) {
  if (options.agentsMd) {
    return options.agentsMd;
  }

  if (options.json || options.assumeYes || !process.stdin.isTTY) {
    return "fallback";
  }

  const selected = await select({
    message: `${AGENT_BOOTSTRAP_GUIDANCE_FILE} already exists. How should Calavera add guidance?`,
    options: [
      {
        value: "append",
        label: "Append guidance",
        hint: "Add marked Calavera guidance directly to AGENTS.md",
      },
      {
        value: "fallback",
        label: "Fallback only",
        hint: `Leave AGENTS.md unchanged and write ${AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE}`,
      },
    ],
  });

  exitIfCancel(selected);

  return selected === "append" ? "append" : "fallback";
}

/**
 * @param {CliOptions} options
 * @returns {Promise<McpHarness>}
 */
async function resolveAgentBootstrapMcpHarness(options) {
  if (options.mcpHarness) {
    return options.mcpHarness;
  }

  if (options.json || options.assumeYes || !process.stdin.isTTY) {
    return "skip";
  }

  const selected = await select({
    message: "Configure the Calavera MCP server for which agent harness?",
    options: [
      {
        value: "claude-code",
        label: "Claude Code",
        hint: "Write project .mcp.json",
      },
      {
        value: "codex",
        label: "Codex",
        hint: "Write project .codex/config.toml",
      },
      {
        value: "cursor",
        label: "Cursor",
        hint: "Write project .cursor/mcp.json",
      },
      {
        value: "opencode",
        label: "OpenCode",
        hint: "Write project opencode.json",
      },
      {
        value: "skip",
        label: "Skip auto-config",
        hint: `Use ${AGENT_BOOTSTRAP_MCP_FILE} for manual setup`,
      },
    ],
  });

  exitIfCancel(selected);

  return assertSupportedMcpHarness(typeof selected === "string" ? selected : "skip");
}

/**
 * @param {McpHarness} harness
 * @param {{ command: string, args: string[] }} launchCommand
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @returns {Promise<{ harness: McpHarness, action: "manual" | "write" | "update" | "skip", path?: string, reason?: string }>}
 */
async function writeAgentBootstrapMcpConfig(harness, launchCommand, dryRun, changes) {
  const path = projectMcpConfigPath(harness);

  if (!path) {
    return {
      harness,
      action: "manual",
      reason: `Skipped project MCP auto-config. Follow ${AGENT_BOOTSTRAP_MCP_FILE} for manual setup.`,
    };
  }

  /** @type {"write" | "update" | "skip"} */
  let action;
  const initialChangeCount = changes.length;

  try {
    switch (harness) {
      case "claude-code":
      case "cursor":
        action = await writeMcpServersJsonConfig(path, launchCommand, dryRun, changes);
        break;
      case "codex":
        action = await writeCodexMcpConfig(path, launchCommand, dryRun, changes);
        break;
      case "opencode":
        action = await writeOpenCodeMcpConfig(path, launchCommand, dryRun, changes);
        break;
      default:
        action = "skip";
    }
  } catch (error) {
    changes.splice(initialChangeCount);
    return {
      harness,
      action: "manual",
      reason: `Could not write project MCP config at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }. Follow ${AGENT_BOOTSTRAP_MCP_FILE} for manual setup.`,
    };
  }

  return { harness, action, path };
}

/**
 * @param {string} contents
 * @param {string} section
 * @returns {{ contents: string, changed: boolean }}
 */
function upsertAgentBootstrapGuidanceSection(contents, section) {
  const startIndex = contents.indexOf(AGENT_BOOTSTRAP_SECTION_START);
  const endIndex = contents.indexOf(AGENT_BOOTSTRAP_SECTION_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return {
      contents: `${contents.trimEnd()}\n\n${section}`,
      changed: true,
    };
  }

  const replaceEndIndex = endIndex + AGENT_BOOTSTRAP_SECTION_END.length;
  const nextContents = `${contents.slice(0, startIndex)}${section.trimEnd()}${contents.slice(
    replaceEndIndex,
  )}`;

  return {
    contents: nextContents,
    changed: nextContents !== contents,
  };
}

/**
 * @param {string} currentGuidance
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @param {CliOptions} options
 */
async function handleExistingAgentBootstrapGuidance(currentGuidance, dryRun, changes, options) {
  const guidance = createAgentBootstrapGuidance();
  const guidanceSection = createAgentBootstrapGuidanceSection();

  if (currentGuidance.includes(AGENT_BOOTSTRAP_SECTION_START)) {
    const nextGuidance = upsertAgentBootstrapGuidanceSection(currentGuidance, guidanceSection);

    changes.push({
      type: nextGuidance.changed ? "update" : "skip",
      path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
      reason: nextGuidance.changed
        ? "Calavera guidance section will be updated."
        : "Calavera guidance section already up to date.",
    });

    if (!dryRun && nextGuidance.changed) {
      await writeFile(AGENT_BOOTSTRAP_GUIDANCE_FILE, nextGuidance.contents);
    }
    return;
  }

  if (currentGuidance.includes(AGENT_BOOTSTRAP_MARKER)) {
    changes.push({
      type: "skip",
      path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
      reason: "Calavera guidance already present.",
    });
    return;
  }

  const mode = await resolveAgentBootstrapGuidanceMode(options);

  if (mode === "append") {
    const nextGuidance = upsertAgentBootstrapGuidanceSection(currentGuidance, guidanceSection);

    changes.push({
      type: "update",
      path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
      reason: "Append marked Calavera guidance section.",
    });

    if (!dryRun) {
      await writeFile(AGENT_BOOTSTRAP_GUIDANCE_FILE, nextGuidance.contents);
    }
    return;
  }

  changes.push({
    type: "skip",
    path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
    reason: `Existing AGENTS.md left unchanged; Calavera guidance ${dryRun ? "would be" : "was"} written separately.`,
  });

  await writeBootstrapTextFile(
    AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE,
    guidance,
    dryRun,
    changes,
    "Existing fallback Calavera guidance differs and was left unchanged.",
  );
}

/**
 * @param {CliOptions} options
 * @param {Change[]} changes
 */
async function writeAgentBootstrapGuidance(options, changes) {
  const guidance = createAgentBootstrapGuidance();

  if (!(await fileExists(AGENT_BOOTSTRAP_GUIDANCE_FILE))) {
    await writeBootstrapTextFile(
      AGENT_BOOTSTRAP_GUIDANCE_FILE,
      guidance,
      options.dryRun,
      changes,
      "Existing agent guidance differs and was left unchanged.",
    );
    return;
  }

  const currentGuidance = await readFile(AGENT_BOOTSTRAP_GUIDANCE_FILE, "utf8");

  if (currentGuidance === guidance) {
    changes.push({
      type: "skip",
      path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
      reason: "Already up to date.",
    });
    return;
  }

  await handleExistingAgentBootstrapGuidance(currentGuidance, options.dryRun, changes, options);
}

/**
 * @param {Partial<CliOptions>} [options]
 * @returns {Promise<AgentInitResult>}
 */
export async function agentBootstrap(options = {}) {
  /** @type {CliOptions} */
  const bootstrapOptions = {
    command: "agent-init",
    config: CONFIG_FILE,
    dryRun: false,
    json: false,
    noInstall: false,
    assumeYes: false,
    apply: false,
    integrations: [],
    aiArtifacts: [],
    ...options,
    reownManagedFiles: options.reownManagedFiles ?? [],
  };
  const detectedPackageJSON = await readPackageJSONIfPresent();
  const packageManager = assertSupportedPackageManager(
    bootstrapOptions.packageManager ?? detectPackageManager(detectedPackageJSON) ?? "npm",
  );
  const launchCommand = createMcpLaunchCommand(packageManager);

  await assertBootstrapDirectoryAvailable(".calavera");

  const previousState = await readStateIfPresent();
  const aiResult = await buildAiApplyResult(
    AGENT_BOOTSTRAP_SKILL_RECIPE,
    { dryRun: bootstrapOptions.dryRun },
    previousState,
  );
  /** @type {Change[]} */
  const changes = [...aiResult.changes];

  await writeAgentBootstrapGuidance(bootstrapOptions, changes);
  const mcpHarness = await resolveAgentBootstrapMcpHarness(bootstrapOptions);
  const mcp = await writeAgentBootstrapMcpConfig(
    mcpHarness,
    launchCommand,
    bootstrapOptions.dryRun,
    changes,
  );

  if (mcp.action === "manual") {
    await writeBootstrapTextFile(
      AGENT_BOOTSTRAP_MCP_FILE,
      createAgentBootstrapMcpInstructions(packageManager),
      bootstrapOptions.dryRun,
      changes,
      "Existing Calavera MCP setup notes differ and were left unchanged.",
    );
  }

  const wroteFallbackGuidance = changes.some(
    (change) => change.path === AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE,
  );
  const agentGuidancePointer = wroteFallbackGuidance
    ? `Agent guidance: ${AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE} for manual merge with ${AGENT_BOOTSTRAP_GUIDANCE_FILE}`
    : `Agent guidance: ${AGENT_BOOTSTRAP_GUIDANCE_FILE}`;
  const mcpPointer =
    mcp.action === "manual"
      ? `MCP setup: manual (${AGENT_BOOTSTRAP_MCP_FILE})`
      : `MCP setup: ${mcp.path}`;

  if (!bootstrapOptions.dryRun) {
    await mkdir(".calavera", { recursive: true });
    await writeJSON(
      STATE_FILE,
      mergeAiArtifactsIntoState(previousState, aiResult.artifacts),
      false,
    );
  }

  return {
    command: "agent-init",
    dryRun: bootstrapOptions.dryRun,
    changes,
    pointers: [
      ...aiResult.pointers,
      agentGuidancePointer,
      mcpPointer,
      ...(mcp.action === "manual" ? [`MCP setup notes: ${AGENT_BOOTSTRAP_MCP_FILE}`] : []),
    ],
    nextPrompt: AGENT_BOOTSTRAP_NEXT_PROMPT,
    mcp,
  };
}

/**
 * @param {unknown} value
 * @returns {never | void}
 */
function exitIfCancel(value) {
  if (isCancel(value)) {
    cancel("Setup cancelled");
    process.exit(0);
  }
}

/**
 * @param {Recipe} recipe
 * @param {{ integrations: unknown[], dependencies: string[], aiArtifacts: unknown[] }} explanation
 * @returns {string}
 */
function formatRecipeSummary(recipe, explanation) {
  return [
    `${style("bold", "Profile")}: ${recipe.profile}`,
    `${style("bold", "Package manager")}: ${recipe.packageManager}`,
    `${style("bold", "Integrations")}: ${pluralizeCount((recipe.integrations ?? []).length, "item")}`,
    `${style("bold", "Dependencies")}: ${
      explanation.dependencies.length > 0 ? explanation.dependencies.join(", ") : "none"
    }`,
    `${style("bold", "AI artifacts")}: ${explanation.aiArtifacts.length}`,
  ].join("\n");
}

/**
 * @param {ApplyResult} result
 * @returns {string}
 */
function formatApplySummary(result) {
  const changedPaths = result.changes.map((change) => change.path);

  return [
    `${style("bold", "Package manager")}: ${result.packageManager}`,
    `${style("bold", "Integrations")}: ${result.integrations.join(", ") || "none"}`,
    `${style("bold", "Dev dependencies")}: ${result.dependencies.join(", ") || "none"}`,
    `${style("bold", "Planned changes")}: ${changedPaths.join(", ") || "none"}`,
  ].join("\n");
}

/**
 * @param {CliOptions} options
 * @returns {Promise<string>}
 */
async function promptForProfile(options) {
  const selected =
    options.profile ??
    (await select({
      message: "Choose a tooling profile",
      options: supportedProfiles.map((id) => ({
        value: id,
        label: titleCase(id),
        hint: `${profileDefaults[id]?.length ?? 0} default integrations`,
      })),
    }));

  exitIfCancel(selected);
  return typeof selected === "string" ? selected : "modern";
}

/**
 * @param {CliOptions} options
 * @param {PackageManager} detectedPackageManager
 * @returns {Promise<PackageManager>}
 */
async function promptForPackageManager(options, detectedPackageManager) {
  const selected =
    options.packageManager ??
    (options.assumeYes
      ? detectedPackageManager
      : await select({
          message: "Choose a package manager",
          initialValue: detectedPackageManager,
          options: recipePackageManagers.map((id) => ({
            value: id,
            label: id,
            hint: id === detectedPackageManager ? "detected" : undefined,
          })),
        }));

  exitIfCancel(selected);

  return assertSupportedPackageManager(
    typeof selected === "string" ? selected : detectedPackageManager,
  );
}

/**
 * @param {CliOptions} options
 * @param {string} profile
 * @returns {Promise<string[]>}
 */
async function promptForIntegrations(options, profile) {
  const defaults = profileDefaults[profile] ?? profileDefaults.modern ?? [];

  if (options.integrations.length > 0) {
    return options.integrations;
  }

  if (options.assumeYes || options.profile) {
    return defaults;
  }

  const selected = await groupMultiselect({
    message: "Choose integration packs",
    options: groupedPromptOptions(listIntegrationOptions(profile)),
    initialValues: defaults,
    required: true,
  });

  exitIfCancel(selected);

  if (
    !Array.isArray(selected) ||
    !selected.every((integration) => typeof integration === "string")
  ) {
    throw new Error("Selected integration values must be strings.");
  }

  return selected;
}

/**
 * @param {CliOptions} options
 * @returns {Promise<{ id: string, target?: string }[]>}
 */
async function promptForAiArtifacts(options) {
  if (options.aiArtifacts.length > 0 || options.assumeYes) {
    return options.aiArtifacts;
  }

  const artifactOptions = listAiArtifactOptions();
  const selected = await groupMultiselect({
    message: "Choose AI artifacts",
    options: groupedPromptOptions(artifactOptions),
    initialValues: [],
    required: false,
  });

  exitIfCancel(selected);

  if (!Array.isArray(selected) || !selected.every((artifact) => typeof artifact === "string")) {
    throw new Error("Selected AI artifact values must be strings.");
  }

  /** @type {{ id: string, target?: string }[]} */
  const aiArtifacts = [];

  for (const id of selected) {
    const artifact = artifactOptions.find((option) => option.id === id);

    if (!artifact?.defaultTarget) {
      aiArtifacts.push({ id });
      continue;
    }

    const target = await text({
      message: `Target directory for ${artifact.label}`,
      defaultValue: artifact.defaultTarget,
      placeholder: artifact.defaultTarget,
    });

    exitIfCancel(target);
    aiArtifacts.push({ id, target: typeof target === "string" ? target : artifact.defaultTarget });
  }

  return aiArtifacts;
}

/**
 * @param {CliOptions} options
 * @returns {Promise<InitResult>}
 */
export async function initRecipe(options) {
  if (!options.json) {
    console.clear();
    intro("Compose your Calavera tooling recipe");
  }

  const detectedPackageJSON = await readPackageJSONIfPresent();
  const detectedPackageManager = assertSupportedPackageManager(
    detectPackageManager(detectedPackageJSON) ?? "npm",
  );
  const profile = await promptForProfile(options);
  const packageManager = await promptForPackageManager(options, detectedPackageManager);
  const integrations = await promptForIntegrations(options, profile);
  const aiArtifacts = await promptForAiArtifacts(options);
  const recipe = composeRecipe({
    profile,
    packageManager,
    tools: integrations,
    aiArtifacts,
  });
  const validation = validateRecipeResponse(recipe);
  const explanation = explainRecipeResponse(recipe);

  await writeJSON(options.config, recipe, options.dryRun);

  if (!options.json) {
    note(formatRecipeSummary(recipe, explanation), "Recipe summary");
  }

  /** @type {ApplyResult | undefined} */
  let applyDryRun;
  /** @type {ApplyResult | undefined} */
  let applyResult;

  if (options.apply) {
    applyDryRun = await applyRecipeObject(recipe, {
      ...options,
      dryRun: true,
      assumeYes: true,
      packageManager,
    });

    if (!options.json) {
      note(formatApplySummary(applyDryRun), "Apply dry run");
    }

    const shouldApply =
      options.assumeYes ||
      (await confirm({
        message: "Apply these Calavera-managed changes now?",
        initialValue: false,
      }));

    exitIfCancel(shouldApply);

    if (shouldApply && !options.dryRun) {
      applyResult = await applyRecipeObject(recipe, {
        ...options,
        dryRun: false,
        assumeYes: true,
        packageManager,
      });
    }
  }

  if (!options.json) {
    outro(
      applyResult
        ? "Calavera recipe composed and applied."
        : `Calavera recipe ${options.dryRun ? "previewed" : "written"}.`,
    );
  }

  return {
    command: "init",
    config: options.config,
    dryRun: options.dryRun,
    recipe,
    validation,
    explanation,
    applyDryRun,
    applyResult,
  };
}

/**
 * @param {CliOptions} options
 * @returns {Promise<DoctorResult>}
 */
async function doctor(options) {
  const hasConfig = await fileExists(options.config);
  const hasPackageJSON = await fileExists("package.json");
  /** @type {{ level: "error" | "warning", message: string }[]} */
  const issues = [];

  if (!hasConfig) {
    issues.push({
      level: "error",
      message: `Missing ${options.config}. Run create-project-calavera init first.`,
    });
  }

  if (!hasPackageJSON) {
    issues.push({
      level: "warning",
      message: "Missing package.json. Calavera can create one during apply.",
    });
  }

  if (hasConfig) {
    const recipe = await readRecipe(options.config);
    const integrations = resolveRecipeIntegrations(recipe);
    const aiArtifacts = resolveAiArtifacts(recipe);
    const expectedFiles = [
      integrations.some((integration) => integration.id === "editorconfig")
        ? ".editorconfig"
        : null,
      integrations.some((integration) => integration.id === "oxlint") ? "oxlint.json" : null,
      integrations.some((integration) => integration.id === "eslint") ? "eslint.config.js" : null,
      integrations.some((integration) => integration.id === "prettier") ? ".prettierrc.json" : null,
      integrations.some((integration) => integration.id === "prettier") ? ".prettierignore" : null,
      integrations.some((integration) => integration.id === "stylelint")
        ? ".stylelintrc.json"
        : null,
      integrations.some((integration) => integration.id === "react-doctor")
        ? "react-doctor.config.json"
        : null,
      integrations.some((integration) => integration.id === "typescript") ? "tsconfig.json" : null,
    ].filter(isNotEmptyString);

    for (const file of expectedFiles) {
      if (!(await fileExists(file))) {
        issues.push({
          level: "warning",
          message: `Missing managed file: ${file}. Run create-project-calavera apply to regenerate managed files.`,
        });
      }
    }

    for (const artifact of aiArtifacts) {
      await assertAiSourceExists(artifact.type, artifact.sourcePath, artifact.index);

      for (const path of aiArtifactOutputPaths(artifact)) {
        if (!(await fileExists(path))) {
          issues.push({
            level: "warning",
            message: `Missing managed AI ${artifact.type}: ${path}. Run create-project-calavera apply to regenerate managed AI artifacts.`,
          });
        }
      }
    }
  }

  return {
    command: "doctor",
    ok: issues.every((issue) => issue.level !== "error"),
    issues,
  };
}

/**
 * @param {Integration[]} integrations
 * @returns {string[]}
 */
function expectedManagedFiles(integrations) {
  return [
    integrations.some((integration) => integration.id === "editorconfig") ? ".editorconfig" : null,
    integrations.some((integration) => integration.id === "oxlint") ? "oxlint.json" : null,
    integrations.some((integration) => integration.id === "eslint") ? "eslint.config.js" : null,
    integrations.some((integration) => integration.id === "prettier") ? ".prettierrc.json" : null,
    integrations.some((integration) => integration.id === "prettier") ? ".prettierignore" : null,
    integrations.some((integration) => integration.id === "stylelint") ? ".stylelintrc.json" : null,
    integrations.some((integration) => integration.id === "react-doctor")
      ? "react-doctor.config.json"
      : null,
    integrations.some((integration) => integration.id === "typescript") ? "tsconfig.json" : null,
  ].filter(isNotEmptyString);
}

/**
 * @param {CliOptions} options
 * @returns {Promise<CleanResult>}
 */
async function clean(options) {
  const hasState = await fileExists(STATE_FILE);

  if (!hasState) {
    return {
      command: "clean",
      changes: [],
      message: "No Calavera state found. Nothing to clean.",
    };
  }

  const state = await readStateIfPresent();
  const recipe = (await fileExists(options.config))
    ? await readRecipe(options.config)
    : { integrations: [] };
  const integrations = resolveRecipeIntegrations(recipe);
  const expectedAiPaths = new Set(resolveAiArtifacts(recipe).flatMap(aiArtifactOutputPaths));
  const expectedFiles = new Set(expectedManagedFiles(integrations));
  const staleFiles = managedFilesFromState(state).filter((file) => !expectedFiles.has(file.path));
  const staleAiArtifacts = state.aiArtifacts.filter(
    (artifact) => !expectedAiPaths.has(artifact.path),
  );
  /** @type {ManagedFileState[]} */
  const staleFilesSafeToRemove = [];
  /** @type {Array<ManagedFileState & { reason?: string, installedHash?: string }>} */
  const staleFilesWithLocalEdits = [];
  /** @type {AiArtifactState[]} */
  const staleAiArtifactsSafeToRemove = [];
  /** @type {Array<AiArtifactState & { installedHash: string }>} */
  const staleAiArtifactsWithLocalEdits = [];

  for (const file of staleFiles) {
    if (!(await fileExists(file.path))) {
      staleFilesSafeToRemove.push(file);
      continue;
    }

    if (!file.hash) {
      staleFilesWithLocalEdits.push({
        ...file,
        reason:
          "Managed file has legacy state without a hash; run apply before clean can remove it safely.",
      });
      continue;
    }

    const installedHash = textHash(await readFile(file.path, "utf8"));

    if (installedHash === file.hash) {
      staleFilesSafeToRemove.push(file);
    } else {
      staleFilesWithLocalEdits.push({
        ...file,
        installedHash,
      });
    }
  }

  for (const artifact of staleAiArtifacts) {
    if (!(await fileExists(artifact.path))) {
      staleAiArtifactsSafeToRemove.push(artifact);
      continue;
    }

    const installedHash = await hashAiInstall(artifact.type, artifact.path, artifact.target);

    if (installedHash === artifact.hash) {
      staleAiArtifactsSafeToRemove.push(artifact);
    } else {
      staleAiArtifactsWithLocalEdits.push({
        ...artifact,
        installedHash,
      });
    }
  }

  if (staleFilesSafeToRemove.length === 0 && staleAiArtifactsSafeToRemove.length === 0) {
    return {
      command: "clean",
      changes: [
        ...staleFilesWithLocalEdits.map((file) => ({
          type: "skip",
          path: file.path,
          reason:
            file.reason ??
            `Managed file has local edits (installed=${file.installedHash}, state=${file.hash}).`,
        })),
        ...staleAiArtifactsWithLocalEdits.map((artifact) => ({
          type: "skip",
          path: artifact.path,
          reason: `AI artifact has local edits (installed=${artifact.installedHash}, state=${artifact.hash}).`,
        })),
      ],
      message:
        staleFilesWithLocalEdits.length > 0 || staleAiArtifactsWithLocalEdits.length > 0
          ? "No stale managed items were safe to remove. Some stale items have local edits."
          : "No stale managed files found.",
    };
  }

  if (!options.assumeYes && !options.dryRun) {
    const staleCount = staleFilesSafeToRemove.length + staleAiArtifactsSafeToRemove.length;
    const shouldClean = await confirm({
      message: `Remove ${staleCount} stale Calavera-managed item(s)?`,
    });

    if (!shouldClean || isCancel(shouldClean)) {
      return {
        command: "clean",
        changes: [],
        message: "Clean cancelled.",
      };
    }
  }

  const changes = [
    ...staleFilesSafeToRemove.map((file) => ({ type: "delete", path: file.path })),
    ...staleFilesWithLocalEdits.map((file) => ({
      type: "skip",
      path: file.path,
      reason:
        file.reason ??
        `Managed file has local edits (installed=${file.installedHash}, state=${file.hash}).`,
    })),
    ...staleAiArtifactsSafeToRemove.map((artifact) => ({
      type: "delete",
      path: artifact.path,
      category: "ai",
      aiType: artifact.type,
      name: artifact.name,
    })),
    ...staleAiArtifactsWithLocalEdits.map((artifact) => ({
      type: "skip",
      path: artifact.path,
      category: "ai",
      aiType: artifact.type,
      name: artifact.name,
      reason: `AI artifact has local edits (installed=${artifact.installedHash}, state=${artifact.hash}).`,
    })),
  ];

  if (!options.dryRun) {
    for (const file of staleFilesSafeToRemove) {
      if (await fileExists(file.path)) {
        await unlink(await assertWorkspacePath(file.path, process.cwd(), "Managed file path"));
      }
    }

    for (const artifact of staleAiArtifactsSafeToRemove) {
      await rm(await assertWorkspacePath(artifact.path, process.cwd(), "AI artifact path"), {
        force: true,
        recursive: true,
      });
    }

    await writeJSON(
      STATE_FILE,
      {
        ...state,
        files: managedFilesFromState(state)
          .filter((file) => expectedFiles.has(file.path))
          .map((file) => file.path),
        managedFiles: managedFilesFromState(state).filter((file) => expectedFiles.has(file.path)),
        aiArtifacts: state.aiArtifacts.filter((artifact) => expectedAiPaths.has(artifact.path)),
      },
      false,
    );
  }

  return {
    command: "clean",
    dryRun: options.dryRun,
    changes,
    message: options.dryRun
      ? "Dry run complete. No files were removed."
      : "Removed stale managed files.",
  };
}

function formatHelp() {
  return `create-project-calavera ${packageJson.version}

Usage:
  create-project-calavera [command] [options]

Commands:
  init                 Compose calavera.config.json interactively or from flags
  agent-init           Bootstrap agent guidance, MCP notes, and the Calavera skill
  bootstrap            Alias for agent-init
  apply                Apply the recipe in calavera.config.json
  doctor               Check whether Calavera-managed files are present
  update               Re-apply the recipe in calavera.config.json
  clean                Remove stale Calavera-managed files when safe
  artifacts install    Install exact package-backed artifact selections
  artifacts status     Inspect locked artifacts offline by default
  artifacts doctor     Check installed artifacts and local edits
  artifacts migrate    Convert legacy recipe paths to stable artifact IDs
  artifacts update     Update one artifact ID, or every artifact with --all
  help                 Show this help

Options:
  --init               Bootstrap agent guidance, MCP notes, and the Calavera skill
  --dry-run            Preview writes without changing files
  --apply              Preview and optionally apply after composing a recipe
  --config <path>      Recipe path, defaults to calavera.config.json
  --package-manager    npm, pnpm, yarn, or bun
  --profile            modern, classic, or minimal
  --tool <id>          Add an integration by id or label; repeatable
  --ai-artifact <id>   Add a bundled AI artifact; repeatable
  --tag <channel>      Artifact release channel: latest (default) or next
  --all                Update every selected artifact
  --check-updates      Allow artifacts status to query the registry
  --agents-md <mode>   append or fallback when AGENTS.md already exists
  --mcp-harness <host> claude-code, codex, cursor, opencode, or skip
  --json               Print JSON output
  --yes                Use defaults and skip prompts
  --no-install         Write files without installing dependencies during apply
  --reown-managed-file <path>
                      Treat a tracked managed file's current contents as approved
  -h, --help           Show this help

Agent-first setup:
  npm create project-calavera -- --init
  pnpm dlx create-project-calavera --init
  yarn dlx create-project-calavera --init
  bunx create-project-calavera --init

MCP-first workflow:
  1. Run the agent bootstrap command above from the project root.
  2. Choose exactly one project-local MCP host when prompted, or skip for manual setup.
  3. Reload or restart the agent session if required by your MCP host.
  4. Confirm these tools are visible before composing a recipe:
     inspect_project, list_profiles, list_integrations, list_ai_artifacts,
     compose_recipe, validate_recipe, explain_recipe, dry_run_apply, apply_recipe.

Package-runner syntax:
  npm create needs -- before Calavera flags, for example:
    npm create project-calavera -- --init
    npm create project-calavera apply -- --dry-run

  Direct binary launchers do not need an extra -- before Calavera flags:
    npx --package create-project-calavera@${packageJson.version} create-project-calavera --help
    npx --package create-project-calavera@${packageJson.version} create-project-calavera --init

  MCP launch commands run create-project-calavera-mcp directly; do not add --help
  or inspect npm cache internals as a substitute for MCP setup.

  Calavera only writes project-local MCP config. Global host config is manual.`;
}

function printHelp() {
  console.info(formatHelp());
}

/**
 * @param {CommandResult} result
 * @param {boolean} [asJSON]
 */
function printResult(result, asJSON = false) {
  if (asJSON) {
    console.info(JSON.stringify(result, null, 2));
    return;
  }

  if (result.command === "doctor") {
    if (result.issues.length === 0) {
      logger.success("Calavera doctor found no issues.");
      return;
    }

    for (const issue of result.issues) {
      logger[issue.level === "error" ? "error" : "warn"](issue.message);
    }
    return;
  }

  if (result.command === "clean") {
    logger.info(result.message);
    return;
  }

  if (result.command === "agent-init") {
    if (result.dryRun) {
      logger.info("Calavera agent bootstrap dry run complete. No files were changed.");
    } else {
      logger.success("Calavera agent bootstrap complete.");
    }

    for (const change of result.changes) {
      if (change.type === "write") {
        logger.info(result.dryRun ? `Would write ${change.path}` : `Wrote ${change.path}`);
      }

      if (change.type === "skip") {
        logger.info(
          result.dryRun
            ? `Would skip ${change.path}: ${change.reason}`
            : `Skipped ${change.path}: ${change.reason}`,
        );
      }

      if (change.type === "update") {
        logger.info(
          result.dryRun
            ? `Would update ${change.path}: ${change.reason}`
            : `Updated ${change.path}: ${change.reason}`,
        );
      }
    }

    for (const pointer of result.pointers) {
      logger.info(pointer);
    }

    logger.info(
      result.mcp.action === "manual"
        ? `MCP auto-config skipped: ${result.mcp.reason}`
        : `MCP auto-config ${result.mcp.action}: ${result.mcp.path}`,
    );
    logger.info("Review the files above to confirm what Calavera changed or skipped.");
    logger.info(`Next prompt: ${result.nextPrompt}`);
    return;
  }

  if (result.command === "init") {
    if (result.dryRun) {
      logger.info(`Calavera recipe dry run complete. Would write ${result.config}.`);
    } else {
      logger.success(`Wrote ${result.config}.`);
    }

    logger.info(`Profile: ${result.recipe.profile}`);
    logger.info(`Package manager: ${result.recipe.packageManager}`);
    logger.info(`Integrations: ${(result.recipe.integrations ?? []).join(", ")}`);

    if (Array.isArray(result.recipe.ai) && result.recipe.ai.length > 0) {
      logger.info(`AI artifacts: ${result.recipe.ai.length}`);
    }

    if (result.applyDryRun && !result.applyResult) {
      logger.info("Apply was previewed but not run.");
    }

    if (result.applyResult) {
      logger.success("Calavera apply complete.");
      for (const pointer of result.applyResult.pointers) {
        logger.info(pointer);
      }
    }

    return;
  }

  if (result.command === "apply" && result.dryRun) {
    logger.info("Calavera apply dry run complete. No files were changed.");
    logger.info(`Package manager: ${result.packageManager}`);

    if (result.integrations.length > 0) {
      logger.info(`Integrations: ${result.integrations.join(", ")}`);
    }

    if (result.dependencies.length > 0) {
      logger.info(`Dev dependencies: ${result.dependencies.join(", ")}`);
    } else {
      logger.info("Dev dependencies: none");
    }

    for (const finding of result.projectInspection.findings) {
      logger.info(`Inspection ${finding.severity}: ${finding.message}`);
    }

    for (const change of result.changes) {
      if (change.type === "write") {
        if (change.category === "ai") {
          logger.info(`Would write AI ${change.aiType} ${change.name} to ${change.path}`);
        } else if (change.ownership === "calavera") {
          logger.info(`Would write and own ${change.path}`);
        } else if (change.action === "scaffold") {
          logger.info(`Would scaffold ${change.path}`);
        } else if (change.action === "merge") {
          logger.info(`Would merge ${change.path}`);
        } else {
          logger.info(`Would write ${change.path}`);
        }
      }

      if (change.type === "update") {
        logger.info(`Would update ${change.path}`);

        if (change.scripts && change.scripts.length > 0) {
          logger.info(`Would add scripts: ${change.scripts.join(", ")}`);
        }

        if (change.removedDefaultTestScript) {
          logger.info("Would remove the default npm test placeholder script");
        }

        for (const omittedScript of change.omittedScripts ?? []) {
          logger.info(`Would omit script ${omittedScript.script}: ${omittedScript.reason}`);
        }
      }
    }

    for (const pointer of result.pointers ?? []) {
      logger.info(`Pointer: ${pointer}`);
    }

    return;
  }

  logger.success(`Calavera ${result.command} complete.`);

  if (result.command === "apply") {
    for (const pointer of result.pointers) {
      logger.info(pointer);
    }
  }
}

async function main() {
  const options = parseArgs(args);

  if (options.command === "help") {
    printHelp();
    return;
  }

  if (options.command === "init") {
    printResult(await initRecipe(options), options.json);
    return;
  }

  if (options.command === "agent-init" || options.command === "bootstrap") {
    printResult(await agentBootstrap(options), options.json);
    return;
  }

  if (options.command === "apply") {
    printResult(await applyRecipe(options), options.json);
    return;
  }

  if (options.command === "doctor") {
    printResult(await doctor(options), options.json);
    return;
  }

  if (options.command === "update") {
    printResult(await applyRecipe(options), options.json);
    return;
  }

  if (options.command === "clean") {
    printResult(await clean(options), options.json);
    return;
  }

  if (options.command === "artifacts") {
    printResult(
      /** @type {ArtifactCommandResult} */ (await runArtifactCommand(options)),
      options.json,
    );
    return;
  }

  logger.error(`Unknown command: ${options.command}`);
  process.exitCode = 1;
}

function isDirectEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntryPoint()) {
  main().catch((error) => {
    if (error instanceof FileWriteError) {
      logger.error(error.message);
      logger.error(error.cause);
    } else {
      logger.error(error);
    }
    process.exitCode = 1;
  });
}
