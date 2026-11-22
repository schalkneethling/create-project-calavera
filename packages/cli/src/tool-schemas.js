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
// Each schema's error map runs the core's own check on a refused value and returns its message, so
// an MCP client reads the same explanation, with its remedy, that the core gives. The refusals of
// search_baseline_features keep Zod's messages, because the core reads any query and falls back to
// its default limit; both surfaces refused those inputs before #1051.
import * as z from "zod";
import {
  describeBaselineTarget,
  normalizeBaselineTarget,
  recommendBaselineTarget,
} from "@schalkneethling/calavera-baseline-core";

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
  assertAiArtifactInputsObject,
  assertKnownProfile,
  describeIntegrationResponse,
  normalizeAiTarget,
  normalizeIntegrationOptions,
  packageManagerIdsForRecipe,
  profileIdsForRecipe,
  recipeToolInputDescriptions,
  validateRecipe,
  validateRecipeCompositionInput,
} from "./recipe.js";
import { CONFIG_FILE } from "./project-local-commands.js";
import { STRYKER_ID, strykerTestRunners } from "./stryker-options.js";
import { assertString } from "./utils/assertions.js";

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
export function nodeOnly(schema) {
  nodeOnlyRegistry.add(schema, {});
  return schema;
}

/**
 * @typedef {{ input?: unknown, path?: PropertyKey[] }} RefusedValue What Zod hands an error map: the
 *   refused value and its full path from the tool input.
 * @typedef {(value: unknown, issue: RefusedValue) => unknown} CoreCheck
 */

/**
 * An error map that runs `check`, the core's own check, on the refused value and returns the
 * message it throws, so a refusal carries the core's explanation and remedy (#1051, owner
 * decision of 2026-11-22). A schema's map also covers the refusals of its checks, such as `.min`,
 * and its unknown keys. When the check passes, the schema's own message stays. Wrap a core
 * function in an arrow that passes only the value: `check` also receives the issue, which a core
 * function would read as its own optional second parameter, such as normalizeBaselineTarget's data.
 *
 * @param {CoreCheck} check
 */
function coreMessage(check) {
  return {
    /** @param {RefusedValue} issue */
    error: (issue) => {
      try {
        check(issue.input, issue);
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
 * @param {CoreCheck} check
 */
function trimmedEnum(values, check) {
  return z.union(
    [
      z.enum(values, coreMessage(check)),
      z
        .string(coreMessage(check))
        .regex(new RegExp(`^\\s*(?:${values.map(escapeRegExp).join("|")})\\s*$`)),
    ],
    coreMessage(check),
  );
}

/**
 * A string that is not empty once trimmed, as the core requires of these strings.
 *
 * @param {CoreCheck} check
 */
function nonBlankString(check) {
  return z.string(coreMessage(check)).regex(/\S/);
}

/**
 * The position of the refused artifact in aiArtifacts, which the core names in its messages.
 *
 * @param {RefusedValue} issue
 */
const artifactIndex = (issue) => Number(issue.path?.[1]);

/**
 * Runs the core's composition check on a recipe whose only fault is the refused value.
 *
 * @param {(value: unknown) => Record<string, unknown>} fields
 * @returns {CoreCheck}
 */
const compositionCheck = (fields) => (value) =>
  validateRecipeCompositionInput(
    // The core reads untyped tool input, so it takes the refused value as it came.
    /** @type {Parameters<typeof validateRecipeCompositionInput>[0]} */ ({
      profile: "default",
      ...fields(value),
    }),
  );

/**
 * Runs the core's integrationOptions check on the option `id` built from the refused value.
 *
 * @param {string} id
 * @param {(value: unknown) => unknown} [options]
 * @returns {CoreCheck}
 */
const optionCheck =
  (id, options = (value) => value) =>
  (value) =>
    normalizeIntegrationOptions({ [id]: options(value) }, [id]);

// A removed profile id fails the enum like any other value; the error map hands back the same
// message validateRecipe gives, naming the replacement, so an MCP client sees it too (ADR-0011).
const profileSchema = z.enum(
  profileIdsForRecipe(),
  coreMessage((value) => assertKnownProfile(value)),
);

export const packageManagerSchema = z.enum(
  packageManagerIdsForRecipe(),
  coreMessage(compositionCheck((packageManager) => ({ packageManager }))),
);

export const recipeSchema = z
  .record(
    z.string(),
    z.unknown(),
    coreMessage((value) => validateRecipe(value)),
  )
  .describe(recipeToolInputDescriptions.recipe);

/**
 * A Baseline target as normalizeBaselineTarget reads it: widely, newly, or a year, also written as
 * a four-digit string.
 *
 * @param {CoreCheck} check
 */
const baselineTarget = (check) =>
  z.union(
    [
      z.enum(["widely", "newly"], coreMessage(check)),
      z.number(coreMessage(check)).int(),
      z.string(coreMessage(check)).regex(/^\d{4}$/),
    ],
    coreMessage(check),
  );

const STYLELINT_BASELINE = "stylelint-baseline";
const stylelintBaselineOptionsSchema = z.strictObject(
  {
    available: baselineTarget((value) => normalizeBaselineTarget(value)),
    severity: z
      .enum(
        STYLELINT_BASELINE_SEVERITIES,
        coreMessage(
          optionCheck(STYLELINT_BASELINE, (severity) => ({ available: "widely", severity })),
        ),
      )
      .nullable()
      .optional(),
  },
  coreMessage(optionCheck(STYLELINT_BASELINE)),
);

const HTML_VALIDATE = "html-validate";
const htmlValidateOptionsSchema = z.strictObject(
  {
    quality: z
      .boolean(coreMessage(optionCheck(HTML_VALIDATE, (quality) => ({ quality }))))
      .nullable()
      .optional(),
  },
  coreMessage(optionCheck(HTML_VALIDATE)),
);

/** @param {unknown} testFiles */
const nodeTestFiles = (testFiles) => ({ testRunner: "node:test", testFiles });
const strykerOptionsSchema = z.strictObject(
  {
    testRunner: z
      .enum(
        strykerTestRunners().map(({ id }) => id),
        coreMessage(optionCheck(STRYKER_ID, (testRunner) => ({ testRunner }))),
      )
      .optional(),
    testFiles: z
      .array(
        z.string(coreMessage(optionCheck(STRYKER_ID, (glob) => nodeTestFiles([glob])))).min(1),
        coreMessage(optionCheck(STRYKER_ID, nodeTestFiles)),
      )
      .min(1)
      .optional(),
  },
  coreMessage(optionCheck(STRYKER_ID)),
);

/**
 * Runs the core's repository-controls check on options with a valid repository and the fields
 * built from the refused value.
 *
 * @param {(value: unknown) => Record<string, unknown>} fields
 */
const repositoryControlsCheck = (fields) =>
  optionCheck(GITHUB_REPOSITORY_CONTROLS_ID, (value) => ({
    repository: "owner/name",
    ...fields(value),
  }));
/** @param {string} field */
const fieldCheck = (field) => repositoryControlsCheck((value) => ({ [field]: value }));
/** @param {string} field */
const itemCheck = (field) => repositoryControlsCheck((value) => ({ [field]: [value] }));
/** @param {string} field */
const repositoryControlsBoolean = (field) => z.boolean(coreMessage(fieldCheck(field))).optional();

/**
 * @param {string} field
 * @param {readonly string[]} values
 */
const repositoryControlsEnumList = (field, values) =>
  z.array(trimmedEnum(values, itemCheck(field)), coreMessage(fieldCheck(field))).min(1);

/**
 * Runs the core's check on a release environment built from the refused value.
 *
 * @param {(value: unknown) => unknown} environment
 */
const releaseEnvironmentCheck = (environment) =>
  repositoryControlsCheck((value) => ({ releaseEnvironment: environment(value) }));
/** @param {string} field */
const environmentFieldCheck = (field) =>
  releaseEnvironmentCheck((value) => ({ reviewers: ["octocat"], [field]: value }));

const releaseEnvironmentSchema = z.union(
  [
    z.literal(false),
    z.null(),
    z.strictObject(
      {
        name: nonBlankString(environmentFieldCheck("name")).optional(),
        reviewers: z
          .array(
            nonBlankString(releaseEnvironmentCheck((reviewer) => ({ reviewers: [reviewer] }))),
            coreMessage(releaseEnvironmentCheck((reviewers) => ({ reviewers }))),
          )
          .min(1),
        waitTimer: z
          .number(coreMessage(environmentFieldCheck("waitTimer")))
          .int()
          .min(0)
          .max(RELEASE_ENVIRONMENT_MAX_WAIT_TIMER)
          .nullable()
          .optional(),
        // A value of the wrong type fails the whole union, whose error map below runs the core's
        // check on the environment, so this field needs no map of its own.
        preventSelfReview: z.boolean().optional(),
        branches: z
          .array(
            nonBlankString(
              releaseEnvironmentCheck((branch) => ({ reviewers: ["octocat"], branches: [branch] })),
            ),
            coreMessage(environmentFieldCheck("branches")),
          )
          .min(1)
          .optional(),
      },
      coreMessage(releaseEnvironmentCheck((environment) => environment)),
    ),
  ],
  coreMessage(releaseEnvironmentCheck((environment) => environment)),
);

const githubRepositoryControlsOptionsSchema = z.strictObject(
  {
    repository: z
      .string(
        coreMessage(optionCheck(GITHUB_REPOSITORY_CONTROLS_ID, (repository) => ({ repository }))),
      )
      .regex(new RegExp(`^\\s*${REPOSITORY_NAME_PATTERN}\\s*$`)),
    defaultBranch: nonBlankString(fieldCheck("defaultBranch")).optional(),
    requiredChecks: z
      .array(nonBlankString(itemCheck("requiredChecks")), coreMessage(fieldCheck("requiredChecks")))
      .optional(),
    requireCodeqlResults: repositoryControlsBoolean("requireCodeqlResults"),
    mergeMethods: repositoryControlsEnumList("mergeMethods", MERGE_METHODS).optional(),
    wiki: repositoryControlsBoolean("wiki"),
    projects: repositoryControlsBoolean("projects"),
    autoMerge: repositoryControlsBoolean("autoMerge"),
    deleteBranchOnMerge: repositoryControlsBoolean("deleteBranchOnMerge"),
    updateBranch: repositoryControlsBoolean("updateBranch"),
    dependabotEcosystems: repositoryControlsEnumList(
      "dependabotEcosystems",
      DEPENDABOT_ECOSYSTEMS,
    ).optional(),
    codeqlLanguages: repositoryControlsEnumList("codeqlLanguages", CODEQL_LANGUAGES).optional(),
    codeqlQuerySuite: z
      .enum(CODEQL_QUERY_SUITES, coreMessage(fieldCheck("codeqlQuerySuite")))
      .nullable()
      .optional(),
    releaseEnvironment: releaseEnvironmentSchema.optional(),
  },
  coreMessage(optionCheck(GITHUB_REPOSITORY_CONTROLS_ID)),
);

// normalizeIntegrationOptions refuses an ID other than these four, and a field an option does not
// define, so the objects are strict. Whether the integration is selected is a check across
// fields that the schema does not express.
const integrationOptionsSchema = z.strictObject(
  {
    [STYLELINT_BASELINE]: stylelintBaselineOptionsSchema.optional(),
    [HTML_VALIDATE]: htmlValidateOptionsSchema.optional(),
    [GITHUB_REPOSITORY_CONTROLS_ID]: githubRepositoryControlsOptionsSchema.optional(),
    [STRYKER_ID]: strykerOptionsSchema.optional(),
  },
  coreMessage((options) => normalizeIntegrationOptions(options, [])),
);

const aiArtifactInputSchema = z.object(
  {
    id: z
      .string(
        coreMessage((id, issue) => assertString(`aiArtifacts[${artifactIndex(issue)}].id`, id)),
      )
      .describe(recipeToolInputDescriptions.aiArtifactId),
    target: z
      .string(coreMessage((target, issue) => normalizeAiTarget(target, artifactIndex(issue))))
      .optional()
      .describe(recipeToolInputDescriptions.aiArtifactTarget),
    // ADR-0018 Decision 4: only the MCP server reports the inputs an artifact declares.
    inputs: nodeOnly(
      z
        .record(
          z.string(),
          z.string(
            coreMessage((value, issue) =>
              assertString(
                `aiArtifacts[${artifactIndex(issue)}].inputs.${String(issue.path?.[3])}`,
                value,
              ),
            ),
          ),
          coreMessage((inputs, issue) =>
            assertAiArtifactInputsObject(inputs, artifactIndex(issue)),
          ),
        )
        .optional()
        .describe(recipeToolInputDescriptions.aiArtifactInputs),
    ),
  },
  coreMessage(compositionCheck((item) => ({ aiArtifacts: [item] }))),
);

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
      id: z
        .string(coreMessage((value) => describeIntegrationResponse(value)))
        .describe(recipeToolInputDescriptions.integrationId),
    }),
    output: integrationOutputSchema,
  },
  list_ai_artifacts: { input: z.object({}) },
  list_baseline_targets: { input: z.object({}) },
  describe_baseline_target: {
    input: z.object({
      target: baselineTarget((value) => describeBaselineTarget(value)).describe(
        recipeToolInputDescriptions.baselineTarget,
      ),
    }),
  },
  search_baseline_features: {
    // The core reads any query and falls back to its default limit, so these refusals, which both
    // surfaces declared before #1051, have no core message to carry.
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
      features: z
        .array(
          z.string(
            coreMessage((feature) => recommendBaselineTarget(/** @type {string[]} */ ([feature]))),
          ),
          coreMessage((value) => recommendBaselineTarget(/** @type {string[]} */ (value))),
        )
        .min(1)
        .describe(recipeToolInputDescriptions.baselineFeatures),
    }),
  },
  compose_recipe: {
    input: z.object({
      profile: profileSchema.describe(recipeToolInputDescriptions.profile),
      packageManager: packageManagerSchema
        .default("npm")
        .describe(recipeToolInputDescriptions.packageManager),
      tools: z
        .array(
          z.string(coreMessage(compositionCheck((tool) => ({ tools: [tool] })))),
          coreMessage(compositionCheck((tools) => ({ tools }))),
        )
        // The core reads any falsy tools as absent, as it does aiArtifacts; the schema widens only
        // to null, so false, 0, and "" still get the schema's message (they were refused before too).
        .nullable()
        .optional()
        .describe(recipeToolInputDescriptions.tools),
      aiArtifacts: z
        .array(
          aiArtifactInputSchema,
          coreMessage(compositionCheck((aiArtifacts) => ({ aiArtifacts }))),
        )
        .nullable()
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

// The failed registry lookup of one artifact, as `artifacts status --check-updates` reports it (#993).
const updateCheckFailureSchema = z.looseObject({
  code: z.string().describe("The registry error's code, such as ETARGET for a missing dist-tag."),
  type: z.string().nullable(),
  statusCode: z.number().nullable().describe("The registry's HTTP status, when it answered."),
  reason: z.string(),
  remedy: z.string().nullable(),
  npmDiagnostics: z.array(z.string()),
  unsetVariables: z.array(z.string()),
});

// One artifact in the artifact status report. Loose, because the report also carries each lock
// entry's fields, and ADR-0018 Decision 6 lets the report gain fields, such as the condition that
// ADR-0020 adds, without a breaking change.
const artifactStatusEntrySchema = z.looseObject({
  id: z.string().describe("The catalog ID of the artifact."),
  version: z
    .string()
    .nullable()
    .describe(
      "The locked version, or null when the recipe selects the artifact but the lock has no entry.",
    ),
  tag: z.enum(["latest", "next"]).describe("The release channel the artifact follows."),
  installed: z.boolean(),
  managed: z.boolean(),
  locallyEdited: z.boolean(),
  latestVersion: z
    .string()
    .nullable()
    .describe("The release on the artifact's channel, or null when no update check ran."),
  updateAvailable: z.boolean(),
  releaseNotesUrl: z.string().nullable(),
  updateCommand: z
    .string()
    .nullable()
    .describe("The CLI command that applies the update. The person runs it; this tool does not."),
  installCommand: z.string().nullable(),
  selected: z
    .boolean()
    .nullable()
    .describe(
      "False for a lock entry the recipe no longer selects, and null when there is no recipe to compare the lock with.",
    ),
  updateCheckFailure: updateCheckFailureSchema
    .nullable()
    .describe("Why the update check could not look up this artifact's channel, or null."),
});

/**
 * The input and output schemas of each tool only the MCP server offers, because it reports on the
 * project in the working directory, which the Composer's WebMCP tools in the browser cannot read
 * (ADR-0018, Decisions 3 and 4). The Composer registers none of them.
 */
export const mcpOnlyToolSchemas = Object.freeze({
  artifact_status: {
    input: z.object({
      config: z
        .string()
        .default(CONFIG_FILE)
        .describe(
          "The recipe file path, relative to the project, as `artifacts status --config` names it.",
        ),
      checkUpdates: z
        .boolean()
        .default(false)
        .describe(
          "Resolve each artifact on its channel in the npm registry to report available updates, as `artifacts status --check-updates` does. The lookup contacts the registry and writes nothing into the project.",
        ),
    }),
    // Loose, so the report can gain fields without a breaking change (ADR-0018 Decision 6).
    output: z.looseObject({
      command: z.string(),
      dryRun: z.boolean(),
      offline: z.boolean().describe("True when no update check ran."),
      updateAllCommand: z.string().nullable(),
      checkUpdatesCommand: z.string().nullable(),
      updateAllBlockedBy: z.array(z.string()),
      ok: z.boolean().describe("True when every installed artifact is healthy."),
      artifacts: z.array(artifactStatusEntrySchema),
      ignoreChanges: z
        .array(z.looseObject({}))
        .describe("The .gitignore changes the call made. This tool makes none, so it is empty."),
      pointers: z.array(z.string()),
    }),
  },
});

/**
 * The JSON Schema form of a Zod schema, as the MCP SDK advertises it in `tools/list`: draft 7,
 * read as an input or as an output.
 *
 * With `browser`, the form is the one the Composer registers. ADR-0018 Decision 2 says the WebMCP
 * adapter leaves a Node.js-only part out, so a property marked `nodeOnly` is removed from
 * `properties`, and `propertyNames` refuses its name, so the browser form still refuses it rather
 * than treating it as an unknown key. The `$schema` key is left out too, as the hand-written WebMCP
 * schemas did, because `registerTool` takes the schema object itself.
 *
 * @param {z.ZodType} schema
 * @param {{ io: "input" | "output", browser?: boolean }} options
 */
export function toolJsonSchema(schema, { io, browser = false }) {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-7",
    io,
    override: browser
      ? ({ zodSchema, jsonSchema }) => {
          if (!(zodSchema instanceof z.ZodObject) || !jsonSchema.properties) return;
          const nodeOnlyKeys = Object.keys(zodSchema.shape).filter((key) =>
            nodeOnlyRegistry.has(zodSchema.shape[key]),
          );
          if (nodeOnlyKeys.length === 0) return;
          // The browser form refuses a Node.js-only part, so a required one would make the whole
          // object impossible to satisfy there.
          const required = nodeOnlyKeys.filter((key) => jsonSchema.required?.includes(key));
          if (required.length > 0) {
            throw new Error(`A Node.js-only property must be optional: ${required.join(", ")}.`);
          }
          for (const key of nodeOnlyKeys) delete jsonSchema.properties[key];
          jsonSchema.propertyNames = { not: { enum: nodeOnlyKeys } };
        }
      : undefined,
  });
  if (browser) delete jsonSchema.$schema;
  return jsonSchema;
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
        ...(output
          ? { outputSchema: toolJsonSchema(output, { io: "output", browser: true }) }
          : {}),
      },
    ]),
  );
}
