#!/usr/bin/env node
// @ts-check
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import * as z from "zod";

import { applyRecipeObject, inspectProject } from "./index.js";
import {
  composeRecipeResponse,
  describeIntegrationResponse,
  explainRecipeResponse,
  listAiArtifactsResponse,
  listIntegrationsResponse,
  listProfilesResponse,
  packageManagerIdsForRecipe,
  profileIdsForRecipe,
  recipeToolDescriptions,
  recipeToolInputDescriptions,
  validateRecipe,
  validateRecipeResponse,
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
  "Compose Calavera recipes for the current project. Start with inspect_project, list_profiles, list_integrations, describe_integration when details are needed, and list_ai_artifacts to discover valid IDs, then call compose_recipe, validate_recipe, explain_recipe, and dry_run_apply. Present the dry-run summary to the user and call apply_recipe only after explicit approval.";

const profileIds = profileIdsForRecipe();
const packageManagerIds = packageManagerIdsForRecipe();
const recipeSchema = z.record(z.string(), z.unknown()).describe("A Calavera recipe object.");
const aiArtifactInputSchema = z.object({
  id: z.string().describe(recipeToolInputDescriptions.aiArtifactId),
  target: z.string().optional().describe(recipeToolInputDescriptions.aiArtifactTarget),
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
    description: recipeToolDescriptions.list_profiles,
    inputSchema: {},
    annotations: toolAnnotations.read,
  },
  inspect_project: {
    description: recipeToolDescriptions.inspect_project,
    inputSchema: {
      recipe: recipeSchema.optional().describe(recipeToolInputDescriptions.recipe),
    },
    annotations: toolAnnotations.read,
  },
  list_integrations: {
    description: recipeToolDescriptions.list_integrations,
    inputSchema: {
      profile: z.enum(profileIds).optional().describe(recipeToolInputDescriptions.profileFilter),
    },
    annotations: toolAnnotations.read,
  },
  describe_integration: {
    description: recipeToolDescriptions.describe_integration,
    inputSchema: {
      id: z.string().describe(recipeToolInputDescriptions.integrationId),
    },
    annotations: toolAnnotations.read,
  },
  list_ai_artifacts: {
    description: recipeToolDescriptions.list_ai_artifacts,
    inputSchema: {},
    annotations: toolAnnotations.read,
  },
  compose_recipe: {
    description: recipeToolDescriptions.compose_recipe,
    inputSchema: {
      profile: z.enum(profileIds).describe(recipeToolInputDescriptions.profile),
      packageManager: z
        .enum(packageManagerIds)
        .default("npm")
        .describe(recipeToolInputDescriptions.packageManager),
      tools: z.array(z.string()).optional().describe(recipeToolInputDescriptions.tools),
      aiArtifacts: z
        .array(aiArtifactInputSchema)
        .optional()
        .describe(recipeToolInputDescriptions.aiArtifacts),
    },
    annotations: toolAnnotations.read,
  },
  validate_recipe: {
    description: recipeToolDescriptions.validate_recipe,
    inputSchema: {
      recipe: recipeSchema,
    },
    annotations: toolAnnotations.read,
  },
  explain_recipe: {
    description: recipeToolDescriptions.explain_recipe,
    inputSchema: {
      recipe: recipeSchema,
    },
    annotations: toolAnnotations.read,
  },
  dry_run_apply: {
    description: recipeToolDescriptions.dry_run_apply,
    inputSchema: {
      recipe: recipeSchema,
      packageManager: z
        .enum(packageManagerIds)
        .optional()
        .describe(recipeToolInputDescriptions.packageManagerOverride),
    },
    annotations: toolAnnotations.read,
  },
  apply_recipe: {
    description: recipeToolDescriptions.apply_recipe,
    inputSchema: {
      recipe: recipeSchema,
      packageManager: z
        .enum(packageManagerIds)
        .optional()
        .describe(recipeToolInputDescriptions.packageManagerOverride),
      config: z
        .string()
        .default("calavera.config.json")
        .describe(recipeToolInputDescriptions.config),
      writeConfig: z.boolean().default(true).describe(recipeToolInputDescriptions.writeConfig),
      noInstall: z.boolean().default(false).describe(recipeToolInputDescriptions.noInstall),
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
  return listProfilesResponse();
}

/**
 * @param {Record<string, unknown>} args
 */
async function inspectProjectTool(args) {
  const recipe = args.recipe === undefined ? undefined : assertRecipeInput(args.recipe);
  return inspectProject(recipe);
}

/**
 * @param {Record<string, unknown>} args
 */
function listIntegrationsTool(args) {
  return listIntegrationsResponse({ profile: /** @type {string | undefined} */ (args.profile) });
}

/**
 * @param {Record<string, unknown>} args
 */
function describeIntegrationTool(args) {
  return describeIntegrationResponse(args.id);
}

function listAiArtifactsTool() {
  return listAiArtifactsResponse();
}

/**
 * @param {Record<string, unknown>} args
 */
function composeRecipeTool(args) {
  return composeRecipeResponse(args);
}

/**
 * @param {unknown} recipe
 */
function validateRecipeTool(recipe) {
  return validateRecipeResponse(recipe);
}

/**
 * @param {Record<string, unknown>} args
 */
function explainRecipeTool(args) {
  return explainRecipeResponse(args.recipe);
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
    case "inspect_project":
      return inspectProjectTool(args);
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

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatStartupError(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

/**
 * @param {{
 *   cwd?: string,
 *   startServer?: () => Promise<void>,
 *   stderr?: Pick<NodeJS.WriteStream, "write">,
 *   setExitCode?: (code: number) => void,
 * }} [options]
 */
export async function runMcpEntrypoint(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const startServer = options.startServer ?? (() => startMcpServer());
  const stderr = options.stderr ?? process.stderr;
  const setExitCode =
    options.setExitCode ??
    ((code) => {
      process.exitCode = code;
    });

  stderr.write(
    `[${SERVER_NAME}] starting MCP server v${SERVER_VERSION} (mode=stdio, cwd=${cwd})\n`,
  );

  try {
    await startServer();
  } catch (error) {
    stderr.write(`[${SERVER_NAME}] failed to start MCP server\n${formatStartupError(error)}\n`);
    setExitCode(1);
  }
}

function isDirectEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }

  // Package-manager bins are symlinks. Compare realpaths so npx/npm exec/global
  // installs still start the MCP server instead of silently exiting.
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isDirectEntryPoint()) {
  await runMcpEntrypoint();
}
