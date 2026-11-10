// @ts-check
// #890: an interactive apply asks which test runner Stryker drives when the recipe selects stryker
// and records no runner. The prompts are injected here, so these tests run without a terminal.
import assert from "node:assert/strict";
import test from "node:test";

import { integrationCatalog } from "../src/catalog.js";
import { buildRecipe, resolveRecipeIntegrations } from "../src/recipe.js";
import { resolveStrykerTestRunner } from "../src/stryker-options.js";

const stryker = integrationCatalog.find(({ id }) => id === "stryker");
const defaultRunner = stryker?.testRunners?.[0];
const nodeTestRunner = stryker?.testRunners?.find(({ id }) => id === "node:test");

/**
 * Runs the choice for a recipe with the given integrations, recording each question asked.
 *
 * @param {{ integrations?: string[], integrationOptions?: Record<string, unknown> }} setup
 * @param {{ runner?: string, testFiles?: string[] }} answers
 */
async function choose({ integrations = ["stryker"], integrationOptions }, answers) {
  const recipe = {
    ...buildRecipe("minimal", integrations, "pnpm"),
    ...(integrationOptions ? { integrationOptions } : {}),
  };
  /** @type {any[]} */
  const runnerQuestions = [];
  /** @type {any[]} */
  const testFilesQuestions = [];
  const result = await resolveStrykerTestRunner(recipe, resolveRecipeIntegrations(recipe), {
    ask: {
      testRunner: async (question) => {
        runnerQuestions.push(question);
        return answers.runner ?? question.defaultId;
      },
      testFiles: async (question) => {
        testFilesQuestions.push(question);
        return answers.testFiles ?? [];
      },
    },
  });
  return { recipe, result, runnerQuestions, testFilesQuestions };
}

test("the runner question lists the catalog's runners, with the first one preselected", async () => {
  const { runnerQuestions } = await choose({}, {});

  assert.equal(runnerQuestions.length, 1);
  assert.deepEqual(
    runnerQuestions[0].runners,
    stryker?.testRunners?.map(({ id, label }) => ({ id, label })),
  );
  assert.equal(runnerQuestions[0].defaultId, defaultRunner?.id);
});

test("keeping the preselected runner records nothing and asks no more", async () => {
  const { recipe, result, testFilesQuestions } = await choose({}, {});

  assert.deepEqual(result.recipe, recipe);
  assert.equal(result.recipe.integrationOptions, undefined);
  assert.equal(result.answered, false);
  assert.equal(testFilesQuestions.length, 0);
});

test("choosing node:test records the runner and asks for the test files, offering the catalog's defaults", async () => {
  const { result, testFilesQuestions } = await choose({}, { runner: "node:test", testFiles: [] });

  assert.deepEqual(result.recipe.integrationOptions, { stryker: { testRunner: "node:test" } });
  assert.equal(result.answered, true);
  assert.equal(testFilesQuestions.length, 1);
  assert.deepEqual(testFilesQuestions[0].defaultTestFiles, nodeTestRunner?.testFiles);
});

test("test file paths the person enters are recorded with the runner", async () => {
  const { result } = await choose(
    {},
    { runner: "node:test", testFiles: ["scripts/*.test.mjs", "src/**/*.test.js"] },
  );

  assert.deepEqual(result.recipe.integrationOptions, {
    stryker: { testRunner: "node:test", testFiles: ["scripts/*.test.mjs", "src/**/*.test.js"] },
  });
});

test("test files that equal the runner's defaults are not recorded", async () => {
  const { result } = await choose(
    {},
    { runner: "node:test", testFiles: [...(nodeTestRunner?.testFiles ?? [])] },
  );

  assert.deepEqual(result.recipe.integrationOptions, { stryker: { testRunner: "node:test" } });
});

test("test files that only partly match the runner's defaults are recorded", async () => {
  const defaults = nodeTestRunner?.testFiles ?? [];
  for (const testFiles of [defaults.slice(0, 1), [defaults[0], "tests/*.test.js"]]) {
    const { result } = await choose({}, { runner: "node:test", testFiles });

    assert.deepEqual(result.recipe.integrationOptions, {
      stryker: { testRunner: "node:test", testFiles },
    });
  }
});

test("the test files question checks an answer with the rule the recipe applies", async () => {
  const { testFilesQuestions } = await choose({}, { runner: "node:test" });
  const { validate } = testFilesQuestions[0];

  assert.equal(validate([]), undefined, "an empty answer keeps the default files");
  assert.equal(validate(["tests/*.test.ts"]), undefined);
  assert.equal(
    validate(["tests/*.test.ts", "../shared/*.test.ts"]),
    'integrationOptions.stryker.testFiles must stay inside the project, but "../shared/*.test.ts" starts at the file system root or leaves the project through "..". Write each glob relative to the folder that holds package.json, such as "tests/**/*.test.ts".',
  );
});

test("answers keep the other recorded options and integrations", async () => {
  const { result } = await choose(
    {
      integrations: ["stryker", "html-validate"],
      integrationOptions: { "html-validate": { quality: false } },
    },
    { runner: "node:test" },
  );

  assert.deepEqual(result.recipe.integrationOptions, {
    "html-validate": { quality: false },
    stryker: { testRunner: "node:test" },
  });
});

test("a run that cannot prompt never asks and keeps the recipe as it is", async () => {
  const recipe = buildRecipe("minimal", ["stryker"], "pnpm");
  const result = await resolveStrykerTestRunner(recipe, resolveRecipeIntegrations(recipe), {});

  assert.deepEqual(result, { recipe, answered: false });
});

test("a recipe that records a runner is never asked, whichever runner it records", async () => {
  for (const testRunner of ["vitest", "node:test"]) {
    const { recipe, result, runnerQuestions } = await choose(
      { integrationOptions: { stryker: { testRunner } } },
      { runner: "node:test" },
    );

    assert.equal(runnerQuestions.length, 0, testRunner);
    assert.deepEqual(result, { recipe, answered: false }, testRunner);
  }
});

test("a recipe that does not select stryker is never asked", async () => {
  const { recipe, result, runnerQuestions } = await choose({ integrations: ["knip"] }, {});

  assert.equal(runnerQuestions.length, 0);
  assert.deepEqual(result, { recipe, answered: false });
});
