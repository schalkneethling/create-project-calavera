// @ts-check
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import * as z from "zod";
import {
  baselineMetadata,
  describeBaselineTarget,
  listBaselineTargets,
  recommendBaselineTarget,
  searchBaselineFeatures,
} from "@schalkneethling/calavera-baseline-core";

import { applyRecipeObject, inspectProject, reportVitePlus } from "./index.js";
import {
  CONFIG_FILE,
  composeRecipeResponse,
  describeIntegrationResponse,
  explainRecipeResponse,
  listAiArtifactsResponse,
  listIntegrationsResponse,
  listProfilesResponse,
  mcpComposeRecipeDescription,
  recipeToolDescriptions,
  recipeToolInputDescriptions,
  validateRecipe,
  validateRecipeResponse,
} from "./recipe.js";
import { packageManagerSchema, recipeSchema, sharedToolSchemas } from "./tool-schemas.js";
import { describeArtifactInputs } from "./ai/artifact-inputs.js";
import { describeIntegrationInputs } from "./integration-inputs.js";
import { manifestChoices, pathAtAncestor } from "./manifest-decision.js";
import { assertKnownValue, assertPlainObject, assertStringArray } from "./utils/assertions.js";
import { errorChain, fallbackErrorText, formatErrorChain } from "./utils/error-chain.js";
import { redactSecrets } from "./utils/redact.js";
import { assertWorkspacePath } from "./utils/fs.js";

/**
 * @typedef {import("./index.js").PackageManager} PackageManager
 * @typedef {import("./index.js").Recipe} Recipe
 * @typedef {import("./artifact-lifecycle.js").ArtifactServices} ArtifactServices
 * @typedef {import("./manifest-decision.js").ManifestChoice} ManifestChoice
 */

const SERVER_NAME = "create-project-calavera";
const SERVER_VERSION = packageJson.version;
const SERVER_INSTRUCTIONS =
  "Compose Calavera recipes for the current project. Start with inspect_project, list_profiles, list_integrations, describe_integration when details are needed, and list_ai_artifacts to discover valid IDs, then call compose_recipe, validate_recipe, explain_recipe, and dry_run_apply. Present the dry-run summary to the user and call apply_recipe only after explicit approval.";

const packageManagerOverrideSchema = packageManagerSchema
  .optional()
  .describe(recipeToolInputDescriptions.packageManagerOverride);
const manifestChoiceSchema = z
  .enum(manifestChoices)
  .optional()
  .describe(recipeToolInputDescriptions.manifestChoice);
const reownManagedFilesSchema = z
  .array(z.string())
  .optional()
  .describe(recipeToolInputDescriptions.reownManagedFiles);

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

/**
 * @typedef {{
 *   description: string,
 *   inputSchema: z.ZodObject,
 *   outputSchema?: z.ZodObject,
 *   annotations: typeof toolAnnotations.read | typeof toolAnnotations.apply,
 * }} ToolConfig
 */

/** @type {Record<string, ToolConfig>} */
const toolConfigs = {
  list_profiles: {
    description: recipeToolDescriptions.list_profiles,
    inputSchema: sharedToolSchemas.list_profiles.input,
    annotations: toolAnnotations.read,
  },
  inspect_project: {
    description: recipeToolDescriptions.inspect_project,
    inputSchema: z.object({
      recipe: recipeSchema.optional().describe(recipeToolInputDescriptions.recipe),
      reownManagedFiles: reownManagedFilesSchema,
    }),
    annotations: toolAnnotations.read,
  },
  list_integrations: {
    description: recipeToolDescriptions.list_integrations,
    inputSchema: sharedToolSchemas.list_integrations.input,
    outputSchema: sharedToolSchemas.list_integrations.output,
    annotations: toolAnnotations.read,
  },
  describe_integration: {
    description: recipeToolDescriptions.describe_integration,
    inputSchema: sharedToolSchemas.describe_integration.input,
    outputSchema: sharedToolSchemas.describe_integration.output,
    annotations: toolAnnotations.read,
  },
  list_ai_artifacts: {
    description: recipeToolDescriptions.list_ai_artifacts,
    inputSchema: sharedToolSchemas.list_ai_artifacts.input,
    annotations: toolAnnotations.read,
  },
  list_baseline_targets: {
    description: recipeToolDescriptions.list_baseline_targets,
    inputSchema: sharedToolSchemas.list_baseline_targets.input,
    annotations: toolAnnotations.read,
  },
  describe_baseline_target: {
    description: recipeToolDescriptions.describe_baseline_target,
    inputSchema: sharedToolSchemas.describe_baseline_target.input,
    annotations: toolAnnotations.read,
  },
  search_baseline_features: {
    description: recipeToolDescriptions.search_baseline_features,
    inputSchema: sharedToolSchemas.search_baseline_features.input,
    annotations: toolAnnotations.read,
  },
  recommend_baseline_target: {
    description: recipeToolDescriptions.recommend_baseline_target,
    inputSchema: sharedToolSchemas.recommend_baseline_target.input,
    annotations: toolAnnotations.read,
  },
  compose_recipe: {
    description: mcpComposeRecipeDescription,
    inputSchema: sharedToolSchemas.compose_recipe.input,
    annotations: toolAnnotations.read,
  },
  validate_recipe: {
    description: recipeToolDescriptions.validate_recipe,
    inputSchema: sharedToolSchemas.validate_recipe.input,
    annotations: toolAnnotations.read,
  },
  explain_recipe: {
    description: recipeToolDescriptions.explain_recipe,
    inputSchema: sharedToolSchemas.explain_recipe.input,
    annotations: toolAnnotations.read,
  },
  dry_run_apply: {
    description: recipeToolDescriptions.dry_run_apply,
    inputSchema: z.object({
      recipe: recipeSchema,
      packageManager: packageManagerOverrideSchema,
      config: z.string().default(CONFIG_FILE).describe(recipeToolInputDescriptions.config),
      writeConfig: z.boolean().default(true).describe(recipeToolInputDescriptions.writeConfig),
      reownManagedFiles: reownManagedFilesSchema,
      manifestChoice: manifestChoiceSchema,
    }),
    // Loose, as the integration output schema in tool-schemas.js is: the result carries more than
    // this declares, and a strict object is advertised with additionalProperties: false.
    outputSchema: z.object({
      approvalBoundary: z.string(),
      result: z.looseObject({
        autoInstalledArtifacts: z
          .array(
            z.looseObject({
              id: z.string().describe("The catalog ID of the artifact."),
              version: z.string().describe("The version apply locks."),
              filesAlreadyMatch: z
                .boolean()
                .describe(
                  'True when the files in the project already match the payload apply locks, so apply writes none of the artifact\'s outputs. Apply still locks the version, stores the package under .calavera/packages, and records the artifact in .calavera/state.json. The `changes` entries with `type: "unchanged"` name those files.',
                ),
            }),
          )
          .describe(
            "Selected artifacts without a lock entry, which apply installs and locks before it applies the recipe.",
          ),
      }),
    }),
    annotations: toolAnnotations.read,
  },
  apply_recipe: {
    description: recipeToolDescriptions.apply_recipe,
    inputSchema: z.object({
      recipe: recipeSchema,
      packageManager: packageManagerOverrideSchema,
      config: z.string().default(CONFIG_FILE).describe(recipeToolInputDescriptions.config),
      writeConfig: z.boolean().default(true).describe(recipeToolInputDescriptions.writeConfig),
      noInstall: z.boolean().default(false).describe(recipeToolInputDescriptions.noInstall),
      reownManagedFiles: reownManagedFilesSchema,
      manifestChoice: manifestChoiceSchema,
    }),
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
 * @returns {string[]}
 */
function optionalReownManagedFiles(value) {
  if (value === undefined) {
    return [];
  }

  assertStringArray("reownManagedFiles", value);
  return value;
}

/**
 * @param {unknown} value
 * @returns {ManifestChoice | undefined}
 */
function optionalManifestChoice(value) {
  if (value === undefined) {
    return undefined;
  }

  assertKnownValue("manifestChoice", value, [...manifestChoices]);
  return /** @type {ManifestChoice} */ (value);
}

/**
 * @param {unknown} requestedPath
 */
async function projectConfigPath(requestedPath) {
  return assertWorkspacePath(
    typeof requestedPath === "string" ? requestedPath : CONFIG_FILE,
    process.cwd(),
    "apply_recipe config path",
  );
}

function listProfilesTool() {
  return listProfilesResponse();
}

/**
 * @param {Record<string, unknown>} args
 */
async function inspectProjectTool(args) {
  const recipe = args.recipe === undefined ? undefined : assertRecipeInput(args.recipe);
  return inspectProject(recipe, {
    reownManagedFiles: optionalReownManagedFiles(args.reownManagedFiles),
  });
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

function listBaselineTargetsTool() {
  return { metadata: baselineMetadata, targets: listBaselineTargets() };
}

/** @param {Record<string, unknown>} args */
function describeBaselineTargetTool(args) {
  return describeBaselineTarget(args.target);
}

/** @param {Record<string, unknown>} args */
function searchBaselineFeaturesTool(args) {
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  return {
    metadata: baselineMetadata,
    features: searchBaselineFeatures(args.query, { limit }),
  };
}

/** @param {Record<string, unknown>} args */
function recommendBaselineTargetTool(args) {
  assertStringArray("features", args.features);
  return recommendBaselineTarget(args.features);
}

/**
 * @param {Record<string, unknown>} args
 */
async function composeRecipeTool(args) {
  const response = composeRecipeResponse(args);
  return {
    ...response,
    // ADR-0015, Decision 6: the agent confirms each value with the user before dry_run_apply.
    artifactInputs: await describeArtifactInputs(response.recipe),
    integrationInputs: await describeIntegrationInputs(response.recipe),
    vitePlus: await reportVitePlus(),
  };
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
async function explainRecipeTool(args) {
  const explanation = explainRecipeResponse(args.recipe);
  return { ...explanation, vitePlus: await reportVitePlus() };
}

/**
 * @param {Record<string, unknown>} args
 * @param {ArtifactServices} artifactServices
 */
async function dryRunApplyTool(args, artifactServices) {
  const recipe = assertRecipeInput(args.recipe);
  const writeConfig = args.writeConfig !== false;

  return {
    approvalBoundary:
      "Review this dry-run result with the user before calling apply_recipe. No files were changed.",
    result: await applyRecipeObject(
      recipe,
      {
        dryRun: true,
        json: true,
        noInstall: true,
        assumeYes: true,
        packageManager: /** @type {PackageManager | undefined} */ (args.packageManager),
        reownManagedFiles: optionalReownManagedFiles(args.reownManagedFiles),
        manifestChoice: optionalManifestChoice(args.manifestChoice),
        config: await projectConfigPath(args.config),
        writeConfig,
      },
      artifactServices,
    ),
  };
}

/**
 * @param {Record<string, unknown>} args
 * @param {ArtifactServices} artifactServices
 * @returns {Promise<Record<string, unknown>>}
 */
async function applyRecipeTool(args, artifactServices) {
  const recipe = assertRecipeInput(args.recipe);
  const config = await projectConfigPath(args.config);
  const writeConfig = args.writeConfig !== false;

  const result = await applyRecipeObject(
    recipe,
    {
      dryRun: false,
      json: true,
      noInstall: Boolean(args.noInstall),
      assumeYes: true,
      packageManager: /** @type {PackageManager | undefined} */ (args.packageManager),
      reownManagedFiles: optionalReownManagedFiles(args.reownManagedFiles),
      manifestChoice: optionalManifestChoice(args.manifestChoice),
      config,
      writeConfig,
    },
    artifactServices,
  );
  // #430: abandon writes nothing, and apply-at-ancestor writes the recipe in the ancestor's
  // directory.
  const decision = result.manifestDecision;
  const configWritten =
    !writeConfig || decision?.choice === "abandon"
      ? null
      : decision?.choice === "apply-at-ancestor"
        ? pathAtAncestor(decision, config)
        : config;

  return {
    approvalBoundary:
      "apply_recipe is intended for use only after explicit user approval of dry_run_apply output.",
    configWritten,
    result,
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
 * The result of a tool call that threw: the error and its causes, redacted
 * and each shown once, as JSON text in `content`, as a successful result
 * carries its payload. The result has no `structuredContent`, because a client
 * validates `structuredContent` against a tool's declared output schema even
 * when `isError` is set.
 *
 * @param {unknown} error
 * @param {Record<string, string | undefined>} [env] The environment whose secret values are redacted.
 */
export function toolErrorResult(error, env = process.env) {
  const [first, ...causes] = errorChain(error, env);

  return {
    content: [
      {
        type: /** @type {"text"} */ ("text"),
        text: JSON.stringify({ error: { ...first, causes } }, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [input]
 * @param {ArtifactServices} [artifactServices] Registry access for artifacts that are not yet locked.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function callMcpTool(name, input = {}, artifactServices = {}) {
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
    case "list_baseline_targets":
      return listBaselineTargetsTool();
    case "describe_baseline_target":
      return describeBaselineTargetTool(args);
    case "search_baseline_features":
      return searchBaselineFeaturesTool(args);
    case "recommend_baseline_target":
      return recommendBaselineTargetTool(args);
    case "compose_recipe":
      return composeRecipeTool(args);
    case "validate_recipe":
      return validateRecipeTool(args.recipe);
    case "explain_recipe":
      return explainRecipeTool(args);
    case "dry_run_apply":
      return dryRunApplyTool(args, artifactServices);
    case "apply_recipe":
      return applyRecipeTool(args, artifactServices);
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

  // Tools read the project from the working directory, and apply-at-ancestor changes it while it
  // runs (#430), so this server runs one tool call at a time: a call made in parallel would
  // otherwise inspect or apply in the wrong directory.
  /** @type {Promise<unknown>} */
  let previousCall = Promise.resolve();

  for (const [name, config] of Object.entries(toolConfigs)) {
    server.registerTool(name, config, (input) => {
      const call = previousCall.then(async () => {
        try {
          return toolResult(await callMcpTool(name, input));
        } catch (error) {
          return toolErrorResult(error);
        }
      });
      previousCall = call;
      return call;
    });
  }

  return server;
}

export async function startMcpServer(transport = new StdioServerTransport()) {
  const server = createMcpServer();
  await server.connect(transport);
}

/**
 * @param {{
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   startServer?: () => Promise<void>,
 *   stderr?: Pick<NodeJS.WriteStream, "write">,
 *   setExitCode?: (code: number) => void,
 * }} [options]
 */
export async function runMcpEntrypoint(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
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
    // The error chain, redacted, as the CLI prints it: each cause on its own
    // line, and the stack frames of each error when CALAVERA_DEBUG is on.
    let text;
    try {
      text = formatErrorChain(error, env);
    } catch {
      text = redactSecrets(fallbackErrorText(error), env);
    }
    stderr.write(`[${SERVER_NAME}] failed to start MCP server\n${text}\n`);
    setExitCode(1);
  }
}

// Running this module directly, as local development does, skips the bin's
// Node.js version check. Package-manager bins are symlinks, so compare realpaths.
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
  await runMcpEntrypoint();
}
