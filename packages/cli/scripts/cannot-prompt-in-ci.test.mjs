// #1079: `--new` treated a set `CI` variable as a run that cannot prompt, but `init` only checked
// for a terminal. In a CI job with a pseudo-terminal, `init` could therefore wait on a prompt
// forever. Both commands now share one rule: Calavera cannot ask when stdin is not a terminal or
// `CI` is set. These tests set `process.stdin.isTTY` to true, as a pseudo-terminal does, so only
// `CI` stands between each command and its prompt.
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { initRecipe, newProject } from "../src/index.js";
import { createTemporaryFixture, json, plainViteManifest } from "./vite-plus-fixtures.mjs";

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
 * Runs `callback` in `directory` with a terminal on stdin and `CI` set to `ci`, or unset when `ci`
 * is undefined.
 *
 * @template T
 * @param {string} directory
 * @param {string | undefined} ci
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inTerminal(directory, ci, callback) {
  const originalDirectory = process.cwd();
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const originalCI = process.env.CI;
  process.chdir(directory);
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
  try {
    return await callback();
  } finally {
    process.chdir(originalDirectory);
    if (originalIsTTY) Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    else delete (/** @type {any} */ (process.stdin).isTTY);
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
  }
}

/** @type {import("../src/index.js").CliOptions} */
const initOptions = {
  command: "init",
  config: "calavera.config.json",
  dryRun: true,
  json: false,
  noInstall: true,
  apply: false,
  assumeYes: false,
  integrations: [],
  aiArtifacts: [],
};

test("init in CI without --yes refuses the first prompt with the #998 message", async () => {
  await using fixture = await createTemporaryFixture("init-refuses-in-ci", {
    "package.json": json(plainViteManifest),
  });

  // Not a dry run, so the check below fails if init writes the recipe instead of refusing.
  await inTerminal(fixture.root, "true", () =>
    assert.rejects(
      initRecipe({ ...initOptions, dryRun: false }),
      new RegExp(
        String.raw`^Error: init refused: Calavera cannot ask "Choose a tooling profile" because CI is set\. Pass --yes to use the defaults, or answer it with --profile\.$`,
      ),
    ),
  );
  assert.equal(await exists(join(fixture.root, "calavera.config.json")), false);
});

test("init in CI refuses each prompt it would show, and names every reason", async () => {
  await using fixture = await createTemporaryFixture("init-refuses-each-prompt-in-ci", {
    "package.json": json(plainViteManifest),
  });
  const aiArtifacts = [{ id: "skill-frontend-engineering" }];

  /** @type {[Partial<import("../src/index.js").CliOptions>, RegExp][]} */
  const cases = [
    [{ profile: "minimal" }, /cannot ask "Choose a package manager" because CI is set\./],
    [
      { profile: "minimal", packageManager: "npm" },
      /cannot ask "Choose AI artifacts" because CI is set\./,
    ],
    [
      { profile: "minimal", packageManager: "npm", aiArtifacts, apply: true },
      /cannot ask "Apply these Calavera-managed changes now\?" because CI is set\./,
    ],
    [
      { json: true },
      /because --json was given, so the prompt would corrupt the JSON output, and CI is set\./,
    ],
  ];
  for (const [given, message] of cases) {
    await inTerminal(fixture.root, "true", () =>
      assert.rejects(initRecipe({ ...initOptions, ...given }), message, JSON.stringify(given)),
    );
  }
});

test("init with every recipe prompt answered asks nothing more in CI and keeps the defaults", async () => {
  await using fixture = await createTemporaryFixture("init-asks-nothing-in-ci", {
    "package.json": json(plainViteManifest),
  });

  // Stryker lists test runners, so an interactive run would ask which one it drives (#890). In CI
  // the wizard must not ask, so the recipe records no runner and Stryker keeps its default.
  const { recipe } = await inTerminal(fixture.root, "true", () =>
    initRecipe({
      ...initOptions,
      profile: "minimal",
      packageManager: "npm",
      integrations: ["stryker"],
      aiArtifacts: [{ id: "skill-frontend-engineering" }],
    }),
  );
  assert.deepEqual(recipe.integrations, ["stryker"]);
  assert.equal(recipe.integrationOptions?.stryker, undefined);

  // --json still stops the wizard asking when CI is unset, so the shared rule adds to that check
  // and does not replace it.
  const { recipe: jsonRecipe } = await inTerminal(fixture.root, undefined, () =>
    initRecipe({
      ...initOptions,
      json: true,
      profile: "minimal",
      packageManager: "npm",
      integrations: ["stryker"],
      aiArtifacts: [{ id: "skill-frontend-engineering" }],
    }),
  );
  assert.equal(jsonRecipe.integrationOptions?.stryker, undefined);
});

test("init with CI unset or empty does not give CI as a reason", async () => {
  await using fixture = await createTemporaryFixture("init-asks-outside-ci", {
    "package.json": json(plainViteManifest),
  });

  // CI set to an empty string counts as unset, as it does for --new and for Vite+. With --json the
  // refusal names only --json, so the prompt check ran and found no other reason.
  for (const ci of [undefined, ""]) {
    await inTerminal(fixture.root, ci, () =>
      assert.rejects(
        initRecipe({ ...initOptions, json: true }),
        /because --json was given, so the prompt would corrupt the JSON output\. /,
        JSON.stringify({ ci }),
      ),
    );
  }
});

test("--new in CI without --yes refuses with the same reason init gives", async () => {
  await using fixture = await createTemporaryFixture("new-refuses-in-ci", {});

  await inTerminal(fixture.root, "true", () =>
    assert.rejects(
      newProject({
        ...initOptions,
        command: "new",
        dryRun: false,
        newArgs: ["vite:library"],
      }),
      /^Error: --new refused: Calavera cannot ask for confirmation because CI is set\. /,
    ),
  );
});
