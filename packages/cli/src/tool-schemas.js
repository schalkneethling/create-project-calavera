// @ts-check
// The input and output schemas of every tool that the MCP server and the Composer's WebMCP tools
// share by name (ADR-0018, Decisions 2 and 5). Each schema is defined once, here, in Zod: the MCP
// server registers the Zod form, and the Composer registers the JSON Schema form that
// `webMcpToolSchemas` generates from it. A part only Node.js can serve is wrapped in `nodeOnly`,
// and the JSON Schema form refuses it.
//
// Each schema refuses no input the core accepts: a declared schema that refuses such an input is a
// breaking change under ADR-0018 Decision 6. That is why a field the core reads with `??`, such as
// severity, also accepts null, which selects the default. A few schemas accept less than the core,
// as they did before they moved here; tightening one to what the core enforces is not breaking.
//
// Where a Zod message would only say "Invalid input", the schema's error map runs the core's own
// check on the value and returns its message, so an MCP client reads the same explanation, with
// its remedy, that the core gives.
import * as z from "zod";
import { normalizeBaselineTarget } from "@schalkneethling/calavera-baseline-core";

import {
  CODEQL_LANGUAGES,
  CODEQL_QUERY_SUITES,
  DEPENDABOT_ECOSYSTEMS,
  GITHUB_REPOSITORY_CONTROLS_ID,
  MERGE_METHODS,
  RELEASE_ENVIRONMENT_MAX_WAIT_TIMER,
  REPOSITORY_NAME_PATTERN,
  normalizeGithubRepositoryControlsOptions,
} from "./github-repository-controls-options.js";
import {
  STYLELINT_BASELINE_SEVERITIES,
  assertKnownProfile,
  normalizeIntegrationOptions,
  packageManagerIdsForRecipe,
  profileIdsForRecipe,
  recipeToolInputDescriptions,
} from "./recipe.js";
import { STRYKER_ID, normalizeStrykerOptions, strykerTestRunners } from "./stryker-options.js";

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

/**
 * An error map that runs `check`, a core check, on the refused value and returns the message it
 * throws. When the check passes, the schema's own message stays.
 *
 * @param {(value: unknown) => unknown} check
 * @returns {{ error: (issue: { input?: unknown }) => string | undefined }}
 */
function coreMessage(check) {
  return {
    error: (issue) => {
      try {
        check(issue.input);
      } catch (error) {
        return error instanceof Error ? error.message : undefined;
      }
      return undefined;
    },
  };
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
 * @param {(value: unknown) => unknown} check
 */
function trimmedEnum(values, check) {
  return z.union(
    [
      z.enum(values, coreMessage(check)),
      z
        .string(coreMessage(check))
        .regex(
          new RegExp(`^\\s*(?:${values.map(escapeRegExp).join("|")})\\s*$`),
          coreMessage(check),
        ),
    ],
    coreMessage(check),
  );
}

/**
 * A string that is not empty once trimmed, as the core requires of these strings.
 *
 * @param {(value: unknown) => unknown} check
 */
function nonBlankString(check) {
  return z.string(coreMessage(check)).regex(/\S/, coreMessage(check));
}

// A removed profile id fails the enum like any other value; the error map hands back the same
// message validateRecipe gives, naming the replacement, so an MCP client sees it too (ADR-0011).
const profileSchema = z.enum(
  profileIdsForRecipe(),
  coreMessage((value) => {
    if (typeof value === "string") assertKnownProfile(value);
  }),
);

export const packageManagerSchema = z.enum(packageManagerIdsForRecipe());

export const recipeSchema = z
  .record(z.string(), z.unknown())
  .describe(recipeToolInputDescriptions.recipe);

const baselineTargetSchema = z.union([z.enum(["widely", "newly"]), z.number().int()]);

/** @param {string} field */
const stylelintBaselineCheck = (field) => (/** @type {unknown} */ value) =>
  normalizeIntegrationOptions({ "stylelint-baseline": { available: "widely", [field]: value } }, [
    "stylelint-baseline",
  ]);

const stylelintBaselineOptionsSchema = z.strictObject({
  // normalizeBaselineTarget also reads a four-digit year written as a string.
  available: z.union(
    [
      z.enum(["widely", "newly"], coreMessage(normalizeBaselineTarget)),
      z.number(coreMessage(normalizeBaselineTarget)).int(coreMessage(normalizeBaselineTarget)),
      z.string().regex(/^\d{4}$/, coreMessage(normalizeBaselineTarget)),
    ],
    coreMessage(normalizeBaselineTarget),
  ),
  severity: z
    .enum(STYLELINT_BASELINE_SEVERITIES, coreMessage(stylelintBaselineCheck("severity")))
    .nullable()
    .optional(),
});

const htmlValidateOptionsSchema = z.strictObject({
  quality: z.boolean().nullable().optional(),
});

/** @param {(value: unknown) => Record<string, unknown>} options */
const strykerCheck = (options) => (/** @type {unknown} */ value) =>
  normalizeStrykerOptions(options(value));
const testFilesCheck = strykerCheck((testFiles) => ({ testRunner: "node:test", testFiles }));

const strykerOptionsSchema = z.strictObject({
  testRunner: z
    .enum(
      strykerTestRunners().map(({ id }) => id),
      coreMessage(strykerCheck((testRunner) => ({ testRunner }))),
    )
    .optional(),
  testFiles: z
    .array(
      z.string(coreMessage((glob) => testFilesCheck([glob]))).min(
        1,
        coreMessage((glob) => testFilesCheck([glob])),
      ),
    )
    .min(1, coreMessage(testFilesCheck))
    .optional(),
});

/**
 * Runs the core's repository-controls check with a valid repository and `field` set to `value`.
 *
 * @param {string} field
 * @param {(value: unknown) => unknown} [wrap] Turns a refused list item into the list.
 */
const repositoryControlsCheck =
  (field, wrap = (value) => value) =>
  (/** @type {unknown} */ value) =>
    normalizeGithubRepositoryControlsOptions({ repository: "owner/name", [field]: wrap(value) });
/** @param {unknown} value */
const asList = (value) => [value];

/**
 * @param {string} field
 * @param {readonly string[]} values
 */
const repositoryControlsEnumList = (field, values) =>
  z
    .array(trimmedEnum(values, repositoryControlsCheck(field, asList)))
    .min(1, coreMessage(repositoryControlsCheck(field)));

const waitTimerMessage = coreMessage(
  repositoryControlsCheck("releaseEnvironment", (waitTimer) => ({
    reviewers: ["octocat"],
    waitTimer,
  })),
);

const releaseEnvironmentSchema = z.union(
  [
    z.literal(false),
    z.null(),
    z.strictObject({
      name: nonBlankString(
        repositoryControlsCheck("releaseEnvironment", (name) => ({ name, reviewers: ["octocat"] })),
      ).optional(),
      reviewers: z
        .array(
          nonBlankString(
            repositoryControlsCheck("releaseEnvironment", (reviewer) => ({
              reviewers: [reviewer],
            })),
          ),
        )
        .min(
          1,
          coreMessage(
            repositoryControlsCheck("releaseEnvironment", (reviewers) => ({ reviewers })),
          ),
        ),
      waitTimer: z
        .number(waitTimerMessage)
        .int(waitTimerMessage)
        .min(0, waitTimerMessage)
        .max(RELEASE_ENVIRONMENT_MAX_WAIT_TIMER, waitTimerMessage)
        .nullable()
        .optional(),
      preventSelfReview: z.boolean().optional(),
      branches: z
        .array(
          nonBlankString(
            repositoryControlsCheck("releaseEnvironment", (branch) => ({
              reviewers: ["octocat"],
              branches: [branch],
            })),
          ),
        )
        .min(
          1,
          coreMessage(
            repositoryControlsCheck("releaseEnvironment", (branches) => ({
              reviewers: ["octocat"],
              branches,
            })),
          ),
        )
        .optional(),
    }),
  ],
  coreMessage(repositoryControlsCheck("releaseEnvironment")),
);

const githubRepositoryControlsOptionsSchema = z.strictObject({
  repository: z
    .string(coreMessage(repositoryControlsCheck("repository")))
    .regex(
      new RegExp(`^\\s*${REPOSITORY_NAME_PATTERN}\\s*$`),
      coreMessage(repositoryControlsCheck("repository")),
    ),
  defaultBranch: nonBlankString(repositoryControlsCheck("defaultBranch")).optional(),
  requiredChecks: z
    .array(nonBlankString(repositoryControlsCheck("requiredChecks", asList)))
    .optional(),
  requireCodeqlResults: z.boolean().optional(),
  mergeMethods: repositoryControlsEnumList("mergeMethods", MERGE_METHODS).optional(),
  wiki: z.boolean().optional(),
  projects: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
  deleteBranchOnMerge: z.boolean().optional(),
  updateBranch: z.boolean().optional(),
  dependabotEcosystems: repositoryControlsEnumList(
    "dependabotEcosystems",
    DEPENDABOT_ECOSYSTEMS,
  ).optional(),
  codeqlLanguages: repositoryControlsEnumList("codeqlLanguages", CODEQL_LANGUAGES).optional(),
  codeqlQuerySuite: z
    .enum(CODEQL_QUERY_SUITES, coreMessage(repositoryControlsCheck("codeqlQuerySuite")))
    .nullable()
    .optional(),
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
