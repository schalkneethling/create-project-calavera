// DOM-free recipe construction for the Composer. The page adapts its form into the plain
// selection state these functions take, so a Node test can build the same recipe the page builds.
import {
  buildRecipe,
  listAiArtifactOptions,
  listIntegrationOptions,
  normalizeAiTarget,
  profileCatalog,
  projectLocalCommandNotes,
  projectLocalCommandSteps,
  validateRecipe,
} from "../../packages/cli/src/recipe.js";
import { DEFAULT_AI_TARGET } from "../../packages/cli/src/ai/catalog.js";
import {
  assertRecipeArtifactsSupported,
  assertRecipeIntegrationsSupported,
  assertRecipeProfileSupported,
} from "./cli-compatibility.js";

const allAiArtifactOptions = listAiArtifactOptions();

/**
 * Splits a comma-separated form value into trimmed, non-empty items.
 *
 * @param {unknown} value
 */
export function commaSeparatedValues(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} available
 */
function baselineAvailability(available) {
  return /^\d{4}$/.test(String(available)) ? Number(available) : available;
}

/**
 * @param {string[]} integrations
 * @param {{ available: unknown, severity: unknown } | undefined} baseline
 * @param {{ repository: unknown, requiredChecks: string[] } | undefined} repositoryControls
 */
function composerIntegrationOptions(integrations, baseline, repositoryControls) {
  const hasBaseline = integrations.includes("stylelint-baseline");
  const hasRepositoryControls = integrations.includes("github-repository-controls");

  if (!hasBaseline && !hasRepositoryControls) return undefined;

  return {
    ...(hasBaseline
      ? {
          "stylelint-baseline": {
            available: baselineAvailability(baseline?.available),
            severity: baseline?.severity,
          },
        }
      : {}),
    ...(hasRepositoryControls
      ? {
          "github-repository-controls": {
            repository: repositoryControls?.repository,
            requiredChecks: repositoryControls?.requiredChecks ?? [],
          },
        }
      : {}),
  };
}

/**
 * Keeps a target only for artifacts that install through a target adapter, defaulting an empty
 * target to the catalog default.
 *
 * @param {{ id: string, target?: string }[]} aiArtifacts
 */
function composerAiItems(aiArtifacts) {
  return aiArtifacts.map(({ id, target }, index) => {
    const artifact = allAiArtifactOptions.find((candidate) => candidate.id === id);
    if (!artifact) throw new Error(`Unknown AI artifact: ${id}.`);

    /** @type {{ id: string, target?: string }} */
    const item = { id: artifact.id };
    if (artifact.defaultTarget) {
      item.target = normalizeAiTarget(target ?? DEFAULT_AI_TARGET, index) || DEFAULT_AI_TARGET;
    }
    return item;
  });
}

/**
 * Builds the recipe the Composer shows, saves, and downloads.
 *
 * @param {{
 *   profile?: string,
 *   packageManager?: string,
 *   integrations?: string[],
 *   aiArtifacts?: { id: string, target?: string }[],
 *   baseline?: { available: unknown, severity: unknown },
 *   repositoryControls?: { repository: unknown, requiredChecks: string[] },
 * }} selection
 */
export function composerRecipe({
  profile = "",
  packageManager,
  integrations = [],
  aiArtifacts = [],
  baseline,
  repositoryControls,
}) {
  return buildRecipe(
    profile,
    integrations,
    packageManager || undefined,
    composerAiItems(aiArtifacts),
    composerIntegrationOptions(integrations, baseline, repositoryControls),
  );
}

/**
 * Validates a recipe and refuses any profile, integration, or AI artifact the given published
 * CLI version cannot apply.
 *
 * @param {unknown} recipeInput
 * @param {string} cliVersion
 */
export function assertPublishedCliCompatibility(recipeInput, cliVersion) {
  const validatedRecipe = validateRecipe(recipeInput);
  assertRecipeProfileSupported(validatedRecipe, profileCatalog, cliVersion);
  assertRecipeIntegrationsSupported(validatedRecipe, listIntegrationOptions(), cliVersion);
  return assertRecipeArtifactsSupported(validatedRecipe, allAiArtifactOptions, cliVersion);
}

/**
 * The commands to run from the project folder after saving the recipe.
 *
 * @param {string} [packageManager]
 */
export function composerNextCommands(packageManager) {
  return {
    note: projectLocalCommandNotes.projectDirectory,
    steps: projectLocalCommandSteps(packageManager || "npm"),
  };
}
