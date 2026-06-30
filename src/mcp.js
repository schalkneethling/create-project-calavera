#!/usr/bin/env node
// @ts-check
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import * as z from "zod";

import { applyRecipeObject } from "./index.js";
import {
  aiArtifactsResponse,
  composeRecipe,
  explainRecipeIntegrations,
  listAiArtifactOptions,
  listIntegrationOptions,
  packageManagerCatalog,
  packageManagerIdsForRecipe,
  profileCatalog,
  profileDefaults,
  profileIdsForRecipe,
  resolveRecipeIntegrations,
  validateRecipe,
} from "./recipe.js";
import { assertPlainObject } from "./utils/assertions.js";
import { writeJSON } from "./utils/fs.js";

/**
 * @typedef {import("./index.js").PackageManager} PackageManager
 * @typedef {import("./index.js").Recipe} Recipe
 */

const SERVER_NAME = "create-project-calavera";
const SERVER_VERSION = packageJson.version;
const SERVER_INSTRUCTIONS =
  "Compose Calavera recipes for the current project. Start with list_profiles, list_integrations, and list_ai_artifacts to discover valid IDs, then call compose_recipe, validate_recipe, explain_recipe, and dry_run_apply. Present the dry-run summary to the user and call apply_recipe only after explicit approval.";

const profileIds = profileIdsForRecipe();
const packageManagerIds = packageManagerIdsForRecipe();
const recipeSchema = z.record(z.string(), z.unknown()).describe("A Calavera recipe object.");
const aiArtifactInputSchema = z.object({
  id: z.string().describe("AI artifact ID, source, or label from list_ai_artifacts."),
  target: z.string().optional().describe("Optional target directory for hook and agent artifacts."),
});

const toolAnnotations = {
  read: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  apply: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const toolConfigs = {
  list_profiles: {
    description:
      "List Calavera profiles, package managers, and default integrations. Use this first when composing a recipe.",
    inputSchema: {},
    annotations: toolAnnotations.read,
  },
  list_integrations: {
    description:
      "List available Calavera integration options. Pass a profile to see only integrations valid for that profile.",
    inputSchema: {
      profile: z.enum(profileIds).optional().describe("Optional profile filter."),
    },
    annotations: toolAnnotations.read,
  },
  describe_integration: {
    description:
      "Describe one Calavera integration, including its profile availability, dependency packages, and included parent integrations.",
    inputSchema: {
      id: z.string().describe("Integration ID or label from list_integrations."),
    },
    annotations: toolAnnotations.read,
  },
  list_ai_artifacts: {
    description:
      "List bundled AI skills, hooks, and agents that can be included in a Calavera recipe.",
    inputSchema: {},
    annotations: toolAnnotations.read,
  },
  compose_recipe: {
    description:
      "Compose a schema-valid Calavera recipe from a profile, package manager, integration IDs or labels, and optional AI artifacts.",
    inputSchema: {
      profile: z.enum(profileIds).describe("Base Calavera tooling profile."),
      packageManager: z
        .enum(packageManagerIds)
        .default("npm")
        .describe("Package manager used for dependency installation and generated scripts."),
      tools: z
        .array(z.string())
        .optional()
        .describe(
          "Integration IDs or labels. Omit to use the selected profile defaults from list_profiles.",
        ),
      aiArtifacts: z
        .array(aiArtifactInputSchema)
        .optional()
        .describe("Bundled AI skills, hooks, and agents to include in the recipe."),
    },
    annotations: toolAnnotations.read,
  },
  validate_recipe: {
    description:
      "Validate a Calavera recipe object before previewing or applying it. Returns validation status and errors instead of writing files.",
    inputSchema: {
      recipe: recipeSchema,
    },
    annotations: toolAnnotations.read,
  },
  explain_recipe: {
    description:
      "Explain the integrations selected by a Calavera recipe, including profile defaults and automatically included parent integrations.",
    inputSchema: {
      recipe: recipeSchema,
    },
    annotations: toolAnnotations.read,
  },
  dry_run_apply: {
    description:
      "Preview applying a Calavera recipe in the current project. This does not write files or install packages, and should be shown to the user before apply_recipe.",
    inputSchema: {
      recipe: recipeSchema,
      packageManager: z
        .enum(packageManagerIds)
        .optional()
        .describe("Optional package manager override."),
    },
    annotations: toolAnnotations.read,
  },
  apply_recipe: {
    description:
      "Apply an approved Calavera recipe in the current project. Call only after presenting dry_run_apply output and receiving explicit user approval.",
    inputSchema: {
      recipe: recipeSchema,
      packageManager: z
        .enum(packageManagerIds)
        .optional()
        .describe("Optional package manager override."),
      config: z
        .string()
        .default("calavera.config.json")
        .describe("Recipe file path to write before applying."),
      writeConfig: z
        .boolean()
        .default(true)
        .describe("Write the approved recipe to the config path before applying."),
      noInstall: z
        .boolean()
        .default(false)
        .describe("Skip package manager dependency installation."),
    },
    annotations: toolAnnotations.apply,
  },
};

/**
 * @param {unknown} input
 * @param {string} toolName
 * @returns {Record<string, unknown>}
 */
function assertToolInput(input, toolName) {
  assertPlainObject(`${toolName} input`, input);
  return input;
}

/**
 * @param {unknown} value
 * @returns {Recipe}
 */
function assertRecipeInput(value) {
  validateRecipe(value);
  return /** @type {Recipe} */ (value);
}

/**
 * @param {unknown} value
 */
function matchIntegration(value) {
  const token = String(value).trim().toLowerCase();
  return listIntegrationOptions().find(
    ({ id, label }) => id.toLowerCase() === token || label.toLowerCase() === token,
  );
}

/**
 * @param {Recipe} recipe
 */
function dependencyListForRecipe(recipe) {
  return [
    ...new Set(
      resolveRecipeIntegrations(recipe).flatMap((integration) => integration.dependencies ?? []),
    ),
  ];
}

/**
 * @param {unknown} requestedPath
 */
function projectConfigPath(requestedPath) {
  const projectRoot = process.cwd();
  const configPath = resolve(
    projectRoot,
    typeof requestedPath === "string" ? requestedPath : "calavera.config.json",
  );
  const relativeConfigPath = relative(projectRoot, configPath);

  if (
    !relativeConfigPath ||
    relativeConfigPath === ".." ||
    relativeConfigPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeConfigPath)
  ) {
    throw new Error("apply_recipe config path must stay inside the current project workspace.");
  }

  return configPath;
}

function listProfilesTool() {
  return {
    profiles: profileCatalog.map(({ id, label, description }) => ({
      id,
      label,
      description,
      defaultIntegrations: profileDefaults[id],
    })),
    packageManagers: packageManagerCatalog,
    workflow: recipeWorkflow(),
  };
}

/**
 * @param {Record<string, unknown>} args
 */
function listIntegrationsTool(args) {
  return {
    profile: args.profile ?? null,
    integrations: listIntegrationOptions(/** @type {string | undefined} */ (args.profile)),
  };
}

/**
 * @param {Record<string, unknown>} args
 */
function describeIntegrationTool(args) {
  const integration = matchIntegration(args.id);

  if (!integration) {
    throw new Error(`Unknown integration: ${String(args.id)}.`);
  }

  return integration;
}

function listAiArtifactsTool() {
  return aiArtifactsResponse();
}

/**
 * @param {Record<string, unknown>} args
 */
function composeRecipeTool(args) {
  const recipe = composeRecipe(args);

  return {
    recipe,
    workflow: recipeWorkflow(),
  };
}

/**
 * @param {unknown} recipe
 */
function validateRecipeTool(recipe) {
  try {
    validateRecipe(recipe);
    return { ok: true, recipe };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * @param {Record<string, unknown>} args
 */
function explainRecipeTool(args) {
  const recipe = assertRecipeInput(args.recipe);

  return {
    integrations: explainRecipeIntegrations(recipe),
    dependencies: dependencyListForRecipe(recipe),
    aiArtifacts: listAiArtifactOptions().filter((artifact) =>
      Array.isArray(recipe.ai)
        ? recipe.ai.some((item) => item.type === artifact.type && item.src === artifact.src)
        : false,
    ),
  };
}

/**
 * @param {Record<string, unknown>} args
 */
async function dryRunApplyTool(args) {
  const recipe = assertRecipeInput(args.recipe);

  return {
    approvalBoundary:
      "Review this dry-run result with the user before calling apply_recipe. No files were changed.",
    result: await applyRecipeObject(recipe, {
      dryRun: true,
      json: true,
      noInstall: true,
      assumeYes: true,
      packageManager: /** @type {PackageManager | undefined} */ (args.packageManager),
    }),
  };
}

/**
 * @param {Record<string, unknown>} args
 * @returns {Promise<Record<string, unknown>>}
 */
async function applyRecipeTool(args) {
  const recipe = assertRecipeInput(args.recipe);
  const config = projectConfigPath(args.config);
  const writeConfig = args.writeConfig !== false;

  if (writeConfig) {
    await writeJSON(config, recipe, false);
  }

  return {
    approvalBoundary:
      "apply_recipe is intended for use only after explicit user approval of dry_run_apply output.",
    configWritten: writeConfig ? config : null,
    result: await applyRecipeObject(recipe, {
      dryRun: false,
      json: true,
      noInstall: Boolean(args.noInstall),
      assumeYes: true,
      packageManager: /** @type {PackageManager | undefined} */ (args.packageManager),
    }),
  };
}

/**
 * @returns {string[]}
 */
function recipeWorkflow() {
  return [
    "list_profiles",
    "list_integrations",
    "list_ai_artifacts",
    "compose_recipe",
    "validate_recipe",
    "explain_recipe",
    "dry_run_apply",
    "apply_recipe after explicit user approval",
  ];
}

/**
 * @param {Record<string, unknown>} payload
 */
function toolResult(payload) {
  return {
    content: [
      {
        type: /** @type {"text"} */ ("text"),
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [input]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function callMcpTool(name, input = {}) {
  const args = assertToolInput(input, name);

  switch (name) {
    case "list_profiles":
      return listProfilesTool();
    case "list_integrations":
      return listIntegrationsTool(args);
    case "describe_integration":
      return describeIntegrationTool(args);
    case "list_ai_artifacts":
      return listAiArtifactsTool();
    case "compose_recipe":
      return composeRecipeTool(args);
    case "validate_recipe":
      return validateRecipeTool(args.recipe);
    case "explain_recipe":
      return explainRecipeTool(args);
    case "dry_run_apply":
      return dryRunApplyTool(args);
    case "apply_recipe":
      return applyRecipeTool(args);
    default:
      throw new Error(`Unknown tool: ${name}.`);
  }
}

export function createMcpServer() {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  for (const [name, config] of Object.entries(toolConfigs)) {
    server.registerTool(name, config, async (input) => toolResult(await callMcpTool(name, input)));
  }

  return server;
}

export async function startMcpServer(transport = new StdioServerTransport()) {
  const server = createMcpServer();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
