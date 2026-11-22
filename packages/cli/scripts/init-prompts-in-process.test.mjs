// #1092: init asks for its recipe through prompts that tests can answer in-process, so Stryker can
// see which tests reach each prompt and kill a mutant that changes what init asks or what it does
// with the answer. A child process started on a terminal is out of Stryker's sight.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { mock } from "node:test";

import { confirm } from "@clack/prompts";

import { initRecipe } from "../src/index.js";
import { listIntegrationOptions, profileDefaults } from "../src/recipe.js";
import { groupedPromptOptions } from "../src/utils/prompt-options.js";
import { createTemporaryFixture, json, plainViteManifest } from "./vite-plus-fixtures.mjs";

// A regression that reaches a real terminal prompt leaves a listener on stdin, which would keep
// the test process alive until the CI job times out. Closing stdin lets the failure report at once.
test.after(() => process.stdin.destroy());

/**
 * @param {string} path
 */
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * The value a clack prompt resolves to when the person cancels it, taken from a real prompt that
 * an aborted signal cancels before it shows anything.
 */
const cancelled = await confirm({
  message: "cancelled",
  signal: AbortSignal.abort(),
  input: new PassThrough(),
  output: new PassThrough(),
});

/**
 * Prompts that answer from `answers` in order and record each request they were given, so a test
 * can check both what init asked and what it did with the answer.
 *
 * @param {unknown[]} answers
 */
function scriptedPrompts(answers) {
  /** @type {{ kind: string, request: any }[]} */
  const asked = [];
  const remaining = [...answers];
  /**
   * @param {string} kind
   * @returns {(request: any) => Promise<any>}
   */
  const answer = (kind) => async (request) => {
    asked.push({ kind, request });
    assert.ok(remaining.length > 0, `init asked an unexpected question: ${request.message}`);
    return remaining.shift();
  };
  return {
    asked,
    remaining,
    prompts: {
      select: answer("select"),
      groupMultiselect: answer("groupMultiselect"),
      confirm: answer("confirm"),
    },
  };
}

/**
 * Runs `callback` in `directory` with standard input reported as a terminal and `CI` unset, as an
 * interactive init sees them (#1079), and restores all three afterwards.
 *
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inTerminal(directory, callback) {
  const originalDirectory = process.cwd();
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const originalCI = process.env.CI;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  delete process.env.CI;
  process.chdir(directory);
  try {
    return await callback();
  } finally {
    process.chdir(originalDirectory);
    if (originalCI !== undefined) {
      process.env.CI = originalCI;
    }
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    } else {
      delete process.stdin.isTTY;
    }
  }
}

const baseOptions = {
  command: "init",
  config: "calavera.config.json",
  json: false,
  noInstall: true,
  assumeYes: false,
  dryRun: false,
  integrations: [],
  aiArtifacts: [],
};

test("init asks for the profile, package manager, integrations, and AI artifacts and writes the answers", async () => {
  await using fixture = await createTemporaryFixture("init-prompts-recipe", {
    "package.json": json({ ...plainViteManifest, packageManager: "pnpm@10.0.0" }),
  });
  // The minimal profile is not the default one, so the prompts after it show whether init used
  // the answer; the integrations answer differs from minimal's defaults for the same reason.
  assert.notDeepEqual(profileDefaults.minimal, profileDefaults.default);
  const { asked, remaining, prompts } = scriptedPrompts([
    "minimal",
    "yarn",
    ["editorconfig", "stylelint"],
    ["skill-frontend-engineering", "hook-block-dangerous-commands"],
    "codex",
  ]);

  const result = await inTerminal(fixture.root, () =>
    initRecipe({ ...baseOptions, apply: false, initPrompts: prompts }),
  );

  assert.deepEqual(remaining, [], "init asked fewer questions than expected");
  assert.deepEqual(
    asked.map(({ kind, request }) => `${kind}: ${request.message}`),
    [
      "select: Choose a tooling profile",
      "select: Choose a package manager",
      "groupMultiselect: Choose integration packs",
      "groupMultiselect: Choose AI artifacts",
      "select: Target for Block dangerous commands",
    ],
  );
  const [profile, packageManager, integrations, artifacts, target] = asked.map(
    ({ request }) => request,
  );
  // The profile prompt offers every profile with its number of defaults, and suggests none.
  assert.deepEqual(
    profile.options,
    Object.entries(profileDefaults).map(([id, defaults]) => ({
      value: id,
      label: id[0].toUpperCase() + id.slice(1),
      hint: `${defaults.length} default integrations`,
    })),
  );
  assert.equal("initialValue" in profile, false);
  // The package manager prompt suggests and marks the detected one, and the answer wins over it.
  assert.equal(packageManager.initialValue, "pnpm");
  assert.deepEqual(
    packageManager.options.filter(({ hint }) => hint !== undefined),
    [{ value: "pnpm", label: "pnpm", hint: "detected" }],
  );
  assert.ok(packageManager.options.some(({ value }) => value === "yarn"));
  // The integration prompt offers the chosen profile's integrations, preselects its defaults, not
  // the default profile's, and needs at least one; the AI artifact prompt preselects none and
  // needs none.
  assert.deepEqual(integrations.options, groupedPromptOptions(listIntegrationOptions("minimal")));
  assert.deepEqual(integrations.initialValues, profileDefaults.minimal);
  assert.equal(integrations.required, true);
  assert.deepEqual(artifacts.initialValues, []);
  assert.equal(artifacts.required, false);
  // The target prompt offers the artifact's targets and suggests its default target.
  assert.deepEqual(
    target.options.map(({ value }) => value),
    ["claude-code", "codex", "cursor", "opencode"],
  );
  assert.equal(target.initialValue, "claude-code");

  const written = JSON.parse(await readFile(join(fixture.root, "calavera.config.json"), "utf8"));
  assert.deepEqual(written, result.recipe);
  assert.equal(written.profile, "minimal");
  assert.equal(written.packageManager, "yarn");
  assert.deepEqual(written.integrations, ["editorconfig", "stylelint"]);
  assert.deepEqual(written.ai, [
    { id: "skill-frontend-engineering" },
    { id: "hook-block-dangerous-commands", target: "codex" },
  ]);
  assert.equal(result.applyResult, undefined);
});

test("init --apply asks before applying, suggests no, and applies only on yes", async () => {
  for (const approve of [false, true]) {
    await using fixture = await createTemporaryFixture(`init-prompts-apply-${approve}`, {
      "package.json": json(plainViteManifest),
    });
    const { asked, remaining, prompts } = scriptedPrompts([
      "minimal",
      "npm",
      ["editorconfig"],
      [],
      approve,
    ]);

    const result = await inTerminal(fixture.root, () =>
      initRecipe({ ...baseOptions, apply: true, initPrompts: prompts }),
    );

    assert.deepEqual(remaining, [], `approve ${approve}: init asked fewer questions than expected`);
    const confirmation = asked.at(-1);
    assert.equal(confirmation?.kind, "confirm");
    assert.equal(confirmation?.request.message, "Apply these Calavera-managed changes now?");
    assert.equal(confirmation?.request.initialValue, false);
    // The dry run comes before the question in both cases, and only a yes applies it.
    assert.equal(result.applyDryRun?.dryRun, true, `approve ${approve}`);
    assert.equal(result.applyResult !== undefined, approve, `approve ${approve}`);
    assert.equal(await exists(join(fixture.root, ".editorconfig")), approve, `approve ${approve}`);
    // The recipe is written before the question, so a no keeps it.
    assert.equal(await exists(join(fixture.root, "calavera.config.json")), true);
  }
});

test("cancelling any init prompt ends the run without writing or applying", async () => {
  // Each case answers the prompts before the cancelled one.
  const cases = [
    { at: "profile", answers: [cancelled], apply: false },
    { at: "package manager", answers: ["minimal", cancelled], apply: false },
    { at: "integrations", answers: ["default", "npm", cancelled], apply: false },
    { at: "AI artifacts", answers: ["minimal", "npm", ["editorconfig"], cancelled], apply: false },
    {
      at: "artifact target",
      answers: ["minimal", "npm", ["editorconfig"], ["hook-block-dangerous-commands"], cancelled],
      apply: false,
    },
    {
      at: "apply confirmation",
      answers: ["minimal", "npm", ["editorconfig"], [], cancelled],
      apply: true,
    },
  ];
  const exit = mock.method(process, "exit", (/** @type {number} */ code) => {
    throw Object.assign(new Error("process.exit"), { exitCode: code });
  });
  try {
    for (const { at, answers, apply } of cases) {
      await using fixture = await createTemporaryFixture("init-prompts-cancel", {
        "package.json": json(plainViteManifest),
      });
      const { remaining, prompts } = scriptedPrompts(answers);

      await assert.rejects(
        inTerminal(fixture.root, () => initRecipe({ ...baseOptions, apply, initPrompts: prompts })),
        { message: "process.exit", exitCode: 0 },
        at,
      );

      assert.deepEqual(remaining, [], at);
      // A cancel before the recipe is written leaves no recipe; the apply confirmation comes
      // after it, so only that cancel keeps one, and nothing is applied either way.
      assert.equal(await exists(join(fixture.root, "calavera.config.json")), apply, at);
      assert.equal(await exists(join(fixture.root, ".editorconfig")), false, at);
    }
  } finally {
    exit.mock.restore();
  }
});

test("init refuses an integration or AI artifact answer that is not a list of strings", async () => {
  const cases = [
    {
      answers: ["default", "npm", "editorconfig"],
      message: "Selected integration values must be strings.",
    },
    {
      answers: ["default", "npm", ["editorconfig", 1]],
      message: "Selected integration values must be strings.",
    },
    {
      answers: ["minimal", "npm", ["editorconfig"], "skill-frontend-engineering"],
      message: "Selected AI artifact values must be strings.",
    },
    {
      answers: ["minimal", "npm", ["editorconfig"], ["skill-frontend-engineering", 1]],
      message: "Selected AI artifact values must be strings.",
    },
  ];
  for (const { answers, message } of cases) {
    await using fixture = await createTemporaryFixture("init-prompts-invalid", {
      "package.json": json(plainViteManifest),
    });
    const { prompts } = scriptedPrompts(answers);

    await assert.rejects(
      inTerminal(fixture.root, () =>
        initRecipe({ ...baseOptions, apply: false, initPrompts: prompts }),
      ),
      { message },
      JSON.stringify(answers),
    );
    assert.equal(await exists(join(fixture.root, "calavera.config.json")), false);
  }
});

test("init keeps the default when a prompt answers with something other than a string", async () => {
  await using fixture = await createTemporaryFixture("init-prompts-fallback", {
    "package.json": json({ ...plainViteManifest, packageManager: "pnpm@10.0.0" }),
  });
  const { remaining, prompts } = scriptedPrompts([
    undefined,
    undefined,
    ["editorconfig"],
    ["hook-block-dangerous-commands"],
    undefined,
  ]);

  const { recipe } = await inTerminal(fixture.root, () =>
    initRecipe({ ...baseOptions, apply: false, initPrompts: prompts }),
  );

  assert.deepEqual(remaining, []);
  assert.equal(recipe.profile, "default");
  assert.equal(recipe.packageManager, "pnpm");
  assert.deepEqual(recipe.ai, [{ id: "hook-block-dangerous-commands", target: "claude-code" }]);
});

test("init asks only the questions its flags leave open", async () => {
  await using fixture = await createTemporaryFixture("init-prompts-flags", {
    "package.json": json(plainViteManifest),
  });
  // --integration answers the integration prompt, so only the profile, package manager, and AI
  // artifact prompts remain.
  const { asked, remaining, prompts } = scriptedPrompts(["default", "npm", []]);

  const { recipe } = await inTerminal(fixture.root, () =>
    initRecipe({
      ...baseOptions,
      apply: false,
      integrations: ["editorconfig"],
      initPrompts: prompts,
    }),
  );

  assert.deepEqual(remaining, []);
  assert.deepEqual(
    asked.map(({ request }) => request.message),
    ["Choose a tooling profile", "Choose a package manager", "Choose AI artifacts"],
  );
  assert.deepEqual(recipe.integrations, ["editorconfig"]);
});
