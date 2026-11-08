// @ts-check
import { artifactForId } from "@schalkneethling/calavera-artifact-core";

import { describeInputValue, resolveInputValue } from "./ai/artifact-inputs.js";
import { GITHUB_REPOSITORY_CONTROLS_ID } from "./github-repository-controls-options.js";
import { normalizeIntegrationOptions } from "./recipe.js";

/**
 * @typedef {import("@schalkneethling/calavera-artifact-core").ArtifactInput} InputDeclaration
 * @typedef {import("./ai/artifact-inputs.js").InputValue} InputValue
 * @typedef {import("./ai/artifact-inputs.js").InputDescription} InputDescription
 *
 * @typedef {{ integration: string, name: string, path: string }} IntegrationInputSubject
 * @typedef {IntegrationInputSubject & InputValue} ResolvedIntegrationInput
 * @typedef {IntegrationInputSubject & InputDescription} DescribedIntegrationInput
 *
 * @typedef {object} IntegrationInputRequest
 * @property {string} integration
 * @property {string} name
 * @property {string} prompt
 * @property {string | undefined} defaultValue
 * @property {string | undefined} error
 *
 * @typedef {(request: IntegrationInputRequest) => Promise<string>} AskForIntegrationInput
 *
 * @typedef {{ integrations?: string[], integrationOptions?: Record<string, unknown>, ai?: unknown }} RecipeShape
 */

/**
 * The integration options whose value Calavera suggests, declared as an artifact declares an input.
 * defaultBranch shares the guard's default, the repository's default branch (#844, #846).
 *
 * @type {Readonly<Record<string, Readonly<Record<string, InputDeclaration>>>>}
 */
const INTEGRATION_INPUTS = Object.freeze({
  [GITHUB_REPOSITORY_CONTROLS_ID]: Object.freeze({
    defaultBranch: Object.freeze({
      prompt:
        "Which branch is the repository's default branch on GitHub, the branch pull requests merge into?",
      default: /** @type {const} */ ("repository-default-branch"),
      check: /** @type {const} */ ("branch-name"),
    }),
  }),
});

/**
 * Each declared input of each integration whose options the recipe holds. Recipe validation
 * requires the options of every selected integration that has inputs, so options mean selection.
 *
 * @param {RecipeShape} recipe
 */
function declaredInputs(recipe) {
  return Object.entries(INTEGRATION_INPUTS).flatMap(([integration, declarations]) => {
    const options = recipe.integrationOptions?.[integration];
    if (!options || typeof options !== "object") return [];
    const recorded = /** @type {Record<string, unknown>} */ (options);
    return Object.entries(declarations).map(([name, declaration]) => ({
      integration,
      name,
      path: `integrationOptions.${integration}.${name}`,
      declaration,
      recorded:
        typeof recorded[name] === "string" ? /** @type {string} */ (recorded[name]) : undefined,
    }));
  });
}

/**
 * Reports each integration input with the recorded value and the default, so an agent can confirm
 * the value with the person before it runs dry_run_apply.
 *
 * @param {RecipeShape} recipe
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<DescribedIntegrationInput[]>}
 */
export async function describeIntegrationInputs(recipe, { cwd = process.cwd() } = {}) {
  /** @type {DescribedIntegrationInput[]} */
  const described = [];
  for (const { integration, name, path, declaration, recorded } of declaredInputs(recipe)) {
    described.push({
      integration,
      name,
      path,
      ...(await describeInputValue(declaration, recorded, cwd)),
    });
  }
  return described;
}

/**
 * Fills in every integration input, as resolveInputValue does for an artifact input: a recorded
 * value is kept, an interactive run asks with the default suggested, and any other run uses the
 * default or stops when there is none. The options are normalized again, so values that follow an
 * input, such as a release environment's branches, follow the filled-in value.
 *
 * @template {RecipeShape} R
 * @param {R} recipe
 * @param {{ cwd?: string, ask?: AskForIntegrationInput }} [options]
 * @returns {Promise<{ recipe: R, inputs: ResolvedIntegrationInput[] }>}
 */
export async function resolveIntegrationInputs(recipe, { cwd = process.cwd(), ask } = {}) {
  const inputs = declaredInputs(recipe);
  if (inputs.length === 0) return { recipe, inputs: [] };

  /** @type {ResolvedIntegrationInput[]} */
  const resolved = [];
  /** @type {Record<string, unknown>} */
  const integrationOptions = { ...recipe.integrationOptions };

  for (const { integration, name, path, declaration, recorded } of inputs) {
    const input = await resolveInputValue(
      declaration,
      recorded,
      { owner: integration, name, path },
      { cwd, ask: ask && ((request) => ask({ integration, name, ...request })) },
    );
    integrationOptions[integration] = {
      .../** @type {Record<string, unknown>} */ (integrationOptions[integration]),
      [name]: input.value,
    };
    resolved.push({ integration, name, path, ...input });
  }

  return {
    recipe: {
      ...recipe,
      integrationOptions: normalizeIntegrationOptions(integrationOptions, recipe.integrations),
    },
    inputs: resolved,
  };
}

/**
 * Warnings for the dry run and apply when an artifact input that suggests the repository's default
 * branch records another branch than github-repository-controls.defaultBranch, as when #749
 * protected master locally and described main to GitHub. A project can protect a release branch
 * on purpose, so the warning never stops apply.
 *
 * @param {RecipeShape} recipe The recipe with every input value filled in.
 * @param {{ declarationsFor?: (id: string) => Record<string, InputDeclaration> | undefined }} [options]
 * @returns {string[]}
 */
export function defaultBranchWarnings(
  recipe,
  { declarationsFor = (id) => artifactForId(id)?.inputs } = {},
) {
  const controls = /** @type {{ defaultBranch?: unknown } | undefined} */ (
    recipe.integrationOptions?.[GITHUB_REPOSITORY_CONTROLS_ID]
  );
  const defaultBranch = controls?.defaultBranch;
  if (typeof defaultBranch !== "string" || !Array.isArray(recipe.ai)) return [];

  return recipe.ai.flatMap((item, index) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string") return [];
    const values = /** @type {Record<string, unknown>} */ (item.inputs ?? {});
    return Object.entries(declarationsFor(item.id) ?? {}).flatMap(([name, declaration]) => {
      const value = values[name];
      return declaration.default === "repository-default-branch" &&
        typeof value === "string" &&
        value !== defaultBranch
        ? [
            `${item.id} protects ${value} (ai[${index}].inputs.${name}), but ${GITHUB_REPOSITORY_CONTROLS_ID} describes ${defaultBranch} to GitHub as the default branch (integrationOptions.${GITHUB_REPOSITORY_CONTROLS_ID}.defaultBranch). If both mean the branch pull requests merge into, record the same branch for both.`,
          ]
        : [];
    });
  });
}
