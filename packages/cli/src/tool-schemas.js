// @ts-check
// The input and output schemas of every tool that the MCP server and the Composer's WebMCP tools
// share by name (ADR-0018, Decisions 2 and 5). Each schema is defined once, here, in Zod: the MCP
// server registers the Zod form, and the Composer registers the JSON Schema form that
// `webMcpToolSchemas` generates from it. A part only Node.js can serve is wrapped in `nodeOnly`,
// and the JSON Schema form refuses it.
//
// Each schema declares only what the core accepts at runtime, and no less: a declared schema that
// refuses an input the core accepts is a breaking change under ADR-0018 Decision 6. That is why a
// field the core reads with `??`, such as severity, also accepts null, which selects the default.
import * as z from "zod";

import {
  CODEQL_LANGUAGES,
  CODEQL_QUERY_SUITES,
  DEPENDABOT_ECOSYSTEMS,
  GITHUB_REPOSITORY_CONTROLS_ID,
  MERGE_METHODS,
  RELEASE_ENVIRONMENT_MAX_WAIT_TIMER,
  REPOSITORY_NAME_PATTERN,
} from "./github-repository-controls-options.js";
import {
  STYLELINT_BASELINE_SEVERITIES,
  assertKnownProfile,
  packageManagerIdsForRecipe,
  profileIdsForRecipe,
  recipeToolInputDescriptions,
} from "./recipe.js";
import { STRYKER_ID, strykerTestRunners } from "./stryker-options.js";

const nodeOnlyRegistry = z.registry();

/**
 * Marks a property schema as one only the Node.js MCP server can serve, such as the artifact
 * `inputs` of `compose_recipe`. Wrap the property's final schema, after `.optional()` and
 * `.describe()`, because each of those returns a new schema.
 *
 * @template {z.ZodType} T
 * @param {T} schema
 * @returns {T}
 */
function nodeOnly(schema) {
  nodeOnlyRegistry.add(schema, {});
  return schema;
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A string from `values`. The core trims each value before it checks it against the list, so the
 * schema also accepts the value with surrounding whitespace; the enum stays first so an agent
 * reads the choices from it.
 *
 * @param {readonly string[]} values
 */
function trimmedEnum(values) {
  return z.union([
    z.enum(values),
    z.string().regex(new RegExp(`^\\s*(?:${values.map(escapeRegExp).join("|")})\\s*$`)),
  ]);
}

// The core checks these strings after trimming them, and refuses one that is empty.
const nonBlankString = z.string().regex(/\S/);

const profileIds = profileIdsForRecipe();
// A removed profile id fails the enum like any other value; the error map hands back the same
// message validateRecipe gives, naming the replacement, so an MCP client sees it too (ADR-0011).
const profileSchema = z.enum(profileIds, {
  error: (issue) => {
    if (typeof issue.input !== "string") return undefined;
    try {
      assertKnownProfile(issue.input);
    } catch (error) {
      return error instanceof Error ? error.message : undefined;
    }
    return undefined;
  },
});

export const packageManagerSchema = z.enum(packageManagerIdsForRecipe());

export const recipeSchema = z
  .record(z.string(), z.unknown())
  .describe(recipeToolInputDescriptions.recipe);

const baselineTargetSchema = z.union([z.enum(["widely", "newly"]), z.number().int()]);

const stylelintBaselineOptionsSchema = z.strictObject({
  // normalizeBaselineTarget also reads a four-digit year written as a string.
  available: z.union([baselineTargetSchema, z.string().regex(/^\d{4}$/)]),
  severity: z.enum(STYLELINT_BASELINE_SEVERITIES).nullable().optional(),
});

const htmlValidateOptionsSchema = z.strictObject({
  quality: z.boolean().nullable().optional(),
});

const strykerOptionsSchema = z.strictObject({
  testRunner: z.enum(strykerTestRunners().map(({ id }) => id)).optional(),
  testFiles: z.array(z.string().min(1)).min(1).optional(),
});

const releaseEnvironmentSchema = z.union([
  z.literal(false),
  z.null(),
  z.strictObject({
    name: nonBlankString.optional(),
    reviewers: z.array(nonBlankString).min(1),
    waitTimer: z
      .number()
      .int()
      .min(0)
      .max(RELEASE_ENVIRONMENT_MAX_WAIT_TIMER)
      .nullable()
      .optional(),
    preventSelfReview: z.boolean().optional(),
    branches: z.array(nonBlankString).min(1).optional(),
  }),
]);

const githubRepositoryControlsOptionsSchema = z.strictObject({
  repository: z.string().regex(new RegExp(`^\\s*${REPOSITORY_NAME_PATTERN}\\s*$`)),
  defaultBranch: nonBlankString.optional(),
  requiredChecks: z.array(nonBlankString).optional(),
  requireCodeqlResults: z.boolean().optional(),
  mergeMethods: z.array(trimmedEnum(MERGE_METHODS)).min(1).optional(),
  wiki: z.boolean().optional(),
  projects: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
  deleteBranchOnMerge: z.boolean().optional(),
  updateBranch: z.boolean().optional(),
  dependabotEcosystems: z.array(trimmedEnum(DEPENDABOT_ECOSYSTEMS)).min(1).optional(),
  codeqlLanguages: z.array(trimmedEnum(CODEQL_LANGUAGES)).min(1).optional(),
  codeqlQuerySuite: z.enum(CODEQL_QUERY_SUITES).nullable().optional(),
  releaseEnvironment: releaseEnvironmentSchema.optional(),
});

// normalizeIntegrationOptions refuses an ID other than these four, and a field an option does not
// define, so the objects are strict. Whether the integration is selected is a check across
// fields that the schema does not express.
const integrationOptionsSchema = z.strictObject({
  "stylelint-baseline": stylelintBaselineOptionsSchema.optional(),
  "html-validate": htmlValidateOptionsSchema.optional(),
  [GITHUB_REPOSITORY_CONTROLS_ID]: githubRepositoryControlsOptionsSchema.optional(),
  [STRYKER_ID]: strykerOptionsSchema.optional(),
});

const aiArtifactInputSchema = z.object({
  id: z.string().describe(recipeToolInputDescriptions.aiArtifactId),
  target: z.string().optional().describe(recipeToolInputDescriptions.aiArtifactTarget),
  // ADR-0018 Decision 4: only the MCP server reports the inputs an artifact declares.
  inputs: nodeOnly(
    z
      .record(z.string(), z.string())
      .optional()
      .describe(recipeToolInputDescriptions.aiArtifactInputs),
  ),
});

// Shared output schema for a catalog integration as returned by list_integrations and
// describe_integration. Loose, because some catalog entries carry per-platform config blocks
// (stylelint, htmlValidate) beyond this shape: a strict object is advertised with
// additionalProperties: false, and clients that validate structured results reject those entries.
const integrationOutputSchema = z.looseObject({
  id: z.string().describe("Stable integration ID used in recipes."),
  label: z.string().describe("Human-readable integration name."),
  summary: z.string().describe("One-sentence plain-language summary of what the tool does."),
  homepage: z.string().describe("The https URL to the tool's own site or repository."),
  group: z.string().describe("Catalog group the integration belongs to."),
  platform: z.string().describe("Tool family the integration's generation code keys off."),
  status: z
    .string()
    .describe(
      "Whether the integration is recommended, optional, experimental, or framework-specific.",
    ),
  statusLabel: z
    .string()
    .describe("Display label for status, such as Recommended or Framework-specific."),
  dependencies: z
    .array(z.string())
    .describe(
      "Development packages installed for the integration. An integration with testRunners also installs the dependencies of the runner the recipe selects.",
    ),
  profiles: z.array(z.string()).describe("Profiles the integration is available in."),
  description: z.string().describe("Generated description prefixed with the integration summary."),
  minimumCliVersion: z.string().optional(),
  optionsMinimumCliVersion: z
    .string()
    .optional()
    .describe("The first CLI version that accepts this integration's integrationOptions entry."),
  appliesAt: z.string().optional(),
  notes: z
    .array(z.string())
    .describe(
      "Plain-language conditions to tell the user before selecting the integration, such as that it needs a project that Vite+ manages or applies in a workspace member, not at a workspace root.",
    ),
  testRunners: z
    .array(
      z.looseObject({
        id: z.string().describe("The value of integrationOptions[id].testRunner."),
        label: z.string(),
        dependencies: z
          .array(z.string())
          .describe("Development packages installed with dependencies when this runner is chosen."),
        testFiles: z.array(z.string()).describe("The test files the runner reads by default."),
      }),
    )
    .optional()
    .describe(
      "The test runners the integration can drive, chosen with integrationOptions[id].testRunner. The first is the default.",
    ),
  includes: z.array(z.string()).optional(),
});

/**
 * @typedef {{ input: z.ZodObject, output?: z.ZodObject }} SharedToolSchemas
 */

/**
 * The input schema, and the output schema where one is declared, of each tool the MCP server and
 * the Composer's WebMCP tools share by name.
 *
 * @satisfies {Record<string, SharedToolSchemas>}
 */
export const sharedToolSchemas = Object.freeze({
  list_profiles: { input: z.object({}) },
  list_integrations: {
    input: z.object({
      profile: profileSchema.optional().describe(recipeToolInputDescriptions.profileFilter),
    }),
    output: z.object({
      profile: z.string().nullable(),
      integrations: z.array(integrationOutputSchema),
    }),
  },
  describe_integration: {
    input: z.object({
      id: z.string().describe(recipeToolInputDescriptions.integrationId),
    }),
    output: integrationOutputSchema,
  },
  list_ai_artifacts: { input: z.object({}) },
  list_baseline_targets: { input: z.object({}) },
  describe_baseline_target: {
    input: z.object({
      target: baselineTargetSchema.describe(recipeToolInputDescriptions.baselineTarget),
    }),
  },
  search_baseline_features: {
    input: z.object({
      query: z.string().describe(recipeToolInputDescriptions.baselineQuery),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(recipeToolInputDescriptions.baselineLimit),
    }),
  },
  recommend_baseline_target: {
    input: z.object({
      features: z.array(z.string()).min(1).describe(recipeToolInputDescriptions.baselineFeatures),
    }),
  },
  compose_recipe: {
    input: z.object({
      profile: profileSchema.describe(recipeToolInputDescriptions.profile),
      packageManager: packageManagerSchema
        .default("npm")
        .describe(recipeToolInputDescriptions.packageManager),
      tools: z.array(z.string()).optional().describe(recipeToolInputDescriptions.tools),
      aiArtifacts: z
        .array(aiArtifactInputSchema)
        .optional()
        .describe(recipeToolInputDescriptions.aiArtifacts),
      integrationOptions: integrationOptionsSchema
        .optional()
        .describe(recipeToolInputDescriptions.integrationOptions),
    }),
  },
  validate_recipe: { input: z.object({ recipe: recipeSchema }) },
  explain_recipe: { input: z.object({ recipe: recipeSchema }) },
});

/**
 * The JSON Schema form of a Zod schema, as the MCP SDK advertises it in `tools/list`: draft 7,
 * read as an input or as an output. With `browser`, a property marked `nodeOnly` becomes `false`,
 * the JSON Schema that no value matches, so the WebMCP form refuses it.
 *
 * @param {z.ZodType} schema
 * @param {{ io: "input" | "output", browser?: boolean }} options
 */
export function toolJsonSchema(schema, { io, browser = false }) {
  return z.toJSONSchema(schema, {
    target: "draft-7",
    io,
    override: browser
      ? ({ zodSchema, jsonSchema }) => {
          if (!(zodSchema instanceof z.ZodObject) || !jsonSchema.properties) return;
          for (const [key, property] of Object.entries(zodSchema.shape)) {
            if (!nodeOnlyRegistry.has(property)) continue;
            // A Node.js-only part is optional, so `required` never names it.
            jsonSchema.properties[key] = false;
          }
        }
      : undefined,
  });
}

/**
 * The JSON Schema `inputSchema`, and `outputSchema` where one is declared, that the Composer
 * passes to `navigator.modelContext.registerTool` for each shared tool.
 *
 * @returns {Record<string, { inputSchema: object, outputSchema?: object }>}
 */
export function webMcpToolSchemas() {
  const entries = /** @type {[string, SharedToolSchemas][]} */ (Object.entries(sharedToolSchemas));
  return Object.fromEntries(
    entries.map(([name, { input, output }]) => [
      name,
      {
        inputSchema: toolJsonSchema(input, { io: "input", browser: true }),
        ...(output ? { outputSchema: toolJsonSchema(output, { io: "output" }) } : {}),
      },
    ]),
  );
}
