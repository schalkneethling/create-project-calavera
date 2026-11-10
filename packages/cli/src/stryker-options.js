// @ts-check
// integrationOptions.stryker (#736): which test runner Stryker drives, read from the catalog's
// `testRunners` metadata of the stryker entry, and the test files of the node:test runner.
import { integrationCatalog } from "./catalog.js";
import { assertPlainObject } from "./utils/assertions.js";

export const STRYKER_ID = "stryker";

const NODE_TEST_RUNNER_ID = "node:test";

/**
 * @typedef {{ id: string, label: string, strykerTestRunner: string, dependencies: string[], testFiles: string[] }} TestRunner
 * @typedef {TestRunner & { testFilesSource: "default" | "recipe" }} SelectedTestRunner The runner
 *   with the test files Stryker reads: the runner's default files, or the recipe's `testFiles`.
 */

/** @returns {TestRunner[]} */
function strykerTestRunners() {
  return integrationCatalog.find(({ id }) => id === STRYKER_ID)?.testRunners ?? [];
}

const testFilesMessage = `integrationOptions.${STRYKER_ID}.testFiles must list at least one glob, and each must be a non-empty string. Record the paths that the project's test script passes to node --test, or remove testFiles to use the files node --test runs by default.`;

/**
 * Validates `integrationOptions.stryker` and returns the value the recipe records, or undefined
 * when the options choose the default runner, so a recipe that keeps Vitest stays valid for a CLI
 * release that predates the option.
 *
 * @param {unknown} value
 * @returns {{ testRunner: string, testFiles?: string[] } | undefined}
 */
export function normalizeStrykerOptions(value) {
  const name = `integrationOptions.${STRYKER_ID}`;
  assertPlainObject(name, value);
  const unknownFields = Object.keys(value).filter(
    (field) => field !== "testRunner" && field !== "testFiles",
  );
  if (unknownFields.length > 0) {
    throw new Error(`Unknown ${name} fields: ${unknownFields.join(", ")}.`);
  }

  const runners = strykerTestRunners();
  const defaultRunnerId = runners[0]?.id;
  // Only an absent field selects the default runner; null is rejected below, as the schema does.
  const testRunner = Object.hasOwn(value, "testRunner") ? value.testRunner : defaultRunnerId;
  if (typeof testRunner !== "string" || !runners.some(({ id }) => id === testRunner)) {
    throw new Error(
      `${name}.testRunner is ${JSON.stringify(testRunner)}, but Calavera sets Stryker up for these test runners only: ${runners.map(({ id }) => JSON.stringify(id)).join(", ")}. Use one of them, or remove ${STRYKER_ID} from this recipe.`,
    );
  }

  if (value.testFiles === undefined) {
    return testRunner === defaultRunnerId ? undefined : { testRunner };
  }
  if (testRunner !== NODE_TEST_RUNNER_ID) {
    throw new Error(
      `${name}.testFiles applies only when testRunner is "${NODE_TEST_RUNNER_ID}", because Stryker's Vitest runner reads the test files from the Vite config. Remove testFiles, or set testRunner to "${NODE_TEST_RUNNER_ID}".`,
    );
  }
  const { testFiles } = value;
  if (
    !Array.isArray(testFiles) ||
    testFiles.length === 0 ||
    testFiles.some((glob) => typeof glob !== "string" || glob.length === 0)
  ) {
    throw new Error(testFilesMessage);
  }
  // The tap runner runs every match with node, so a glob outside the project would run files the
  // project does not own, and the dry run would search the whole disk for it.
  const outside = testFiles.find(
    (glob) => /^([/\\]|[A-Za-z]:)/.test(glob) || glob.split(/[/\\]/).includes(".."),
  );
  if (outside !== undefined) {
    throw new Error(
      `${name}.testFiles must stay inside the project, but ${JSON.stringify(outside)} starts at the file system root or leaves the project through "..". Write each glob relative to the folder that holds package.json, such as "tests/**/*.test.ts".`,
    );
  }

  return { testRunner, testFiles };
}

/**
 * The test runner that `integrationOptions` selects for an integration whose catalog entry lists
 * `testRunners`, or undefined for any other integration. The options need not be normalized: a
 * recorded default runner selects the same runner as no option.
 *
 * @param {{ id: string, testRunners?: TestRunner[] }} integration
 * @param {Record<string, unknown>} [integrationOptions]
 * @returns {SelectedTestRunner | undefined}
 */
export function selectedTestRunner(integration, integrationOptions) {
  const runners = integration.testRunners ?? [];
  const options = /** @type {{ testRunner?: string, testFiles?: string[] } | undefined} */ (
    integrationOptions?.[integration.id]
  );
  const runner = runners.find(({ id }) => id === options?.testRunner) ?? runners[0];
  if (!runner) {
    return undefined;
  }

  return options?.testFiles
    ? { ...runner, testFiles: options.testFiles, testFilesSource: "recipe" }
    : { ...runner, testFilesSource: "default" };
}

/**
 * The development packages an integration installs: its own, and those of the test runner the
 * recipe selects.
 *
 * @param {{ id: string, dependencies?: string[], testRunners?: TestRunner[] }} integration
 * @param {Record<string, unknown>} [integrationOptions]
 * @returns {string[]}
 */
export function integrationDependencies(integration, integrationOptions) {
  return [
    ...(integration.dependencies ?? []),
    ...(selectedTestRunner(integration, integrationOptions)?.dependencies ?? []),
  ];
}

/**
 * @typedef {object} TestRunnerQuestion
 * @property {{ id: string, label: string }[]} runners The runners the catalog lists.
 * @property {string} defaultId The preselected runner, the catalog's first, which keeps today's behavior.
 *
 * @typedef {object} TestFilesQuestion
 * @property {string[]} defaultTestFiles The files the runner reads when the recipe records none.
 * @property {(testFiles: string[]) => string | undefined} validate The reason the recipe would reject the files, or undefined.
 *
 * @typedef {object} AskForTestRunner
 * @property {(question: TestRunnerQuestion) => Promise<string>} testRunner The ID of the chosen runner.
 * @property {(question: TestFilesQuestion) => Promise<string[]>} testFiles The globs the person entered; an empty list keeps the runner's default files.
 */

/**
 * Asks which test runner Stryker drives when the recipe selects an integration that lists
 * `testRunners` and records no runner (#890, owner decision of 2026-11-10). The first runner is
 * preselected, so accepting it keeps today's behavior and records nothing. A run without `ask`,
 * which is any run that cannot prompt, never asks and keeps the recipe as it is. A recipe that
 * records a runner, the default one included, is never asked.
 *
 * @template {{ integrations?: string[], integrationOptions?: Record<string, unknown> }} R
 * @param {R} recipe A recipe that recipe validation accepted.
 * @param {{ id: string, testRunners?: TestRunner[] }[]} integrations The integrations the recipe selects.
 * @param {{ ask?: AskForTestRunner }} [options]
 * @returns {Promise<{ recipe: R, answered: boolean }>} `answered` is true when the answer changed the recipe.
 */
export async function resolveStrykerTestRunner(recipe, integrations, { ask } = {}) {
  const runners = integrations.find(({ id }) => id === STRYKER_ID)?.testRunners ?? [];
  const recorded = /** @type {Record<string, unknown> | undefined} */ (
    recipe.integrationOptions?.[STRYKER_ID]
  );
  const [defaultRunner] = runners;
  if (!ask || !defaultRunner || (recorded && Object.hasOwn(recorded, "testRunner"))) {
    return { recipe, answered: false };
  }

  const id = await ask.testRunner({
    runners: runners.map(({ id, label }) => ({ id, label })),
    defaultId: defaultRunner.id,
  });
  const runner = runners.find((candidate) => candidate.id === id);
  if (!runner || runner === defaultRunner) {
    return { recipe, answered: false };
  }

  const testFiles = await ask.testFiles({
    defaultTestFiles: runner.testFiles,
    validate: (files) => {
      // An empty answer keeps the runner's default files, which need no checking.
      if (files.length === 0) return undefined;
      try {
        normalizeStrykerOptions({ testRunner: runner.id, testFiles: files });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  // Files that equal the defaults add nothing, so they are not recorded either.
  const entersOwnFiles =
    testFiles.length > 0 &&
    !(
      testFiles.length === runner.testFiles.length &&
      testFiles.every((glob, index) => glob === runner.testFiles[index])
    );
  const options = normalizeStrykerOptions({
    testRunner: runner.id,
    ...(entersOwnFiles ? { testFiles } : {}),
  });
  return {
    recipe: {
      ...recipe,
      integrationOptions: { ...recipe.integrationOptions, [STRYKER_ID]: options },
    },
    answered: true,
  };
}
