// #998: `init` without a terminal and without `--yes` used to show the profile prompt, which ended
// when standard input closed, so the run exited 0 and wrote no recipe. `init --json` without
// `--yes` did the same and printed the prompt into its JSON output. Both now refuse, as `--new`
// does, and name the flags that answer the prompt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initRecipe } from "../src/index.js";
import { createTemporaryFixture, json, plainViteManifest } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../bin/create-project-calavera.js", import.meta.url));

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
 * Runs the CLI with standard input on /dev/null, not a terminal, as in CI or an agent's shell.
 *
 * @param {string} cwd
 * @param {string[]} args
 */
function runWithoutTerminal(cwd, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.signal, null, `init timed out or was killed:\n${result.stdout}`);
  return result;
}

test("init without a terminal and without --yes refuses, names --yes and --profile, and writes nothing", async () => {
  await using fixture = await createTemporaryFixture("init-refuses-without-terminal", {
    "package.json": json(plainViteManifest),
  });

  const result = runWithoutTerminal(fixture.root, ["init"]);

  assert.equal(result.status, 1, `init did not fail:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /init refused: .*stdin is not a terminal/);
  assert.match(result.stderr, /--yes/);
  assert.match(result.stderr, /--profile/);
  assert.doesNotMatch(result.stdout, /Choose a tooling profile/);
  assert.equal(await exists(join(fixture.root, "calavera.config.json")), false);
});

test("init --json without --yes refuses and keeps the prompt out of standard output", async () => {
  await using fixture = await createTemporaryFixture("init-json-refuses-without-yes", {
    "package.json": json(plainViteManifest),
  });

  const result = runWithoutTerminal(fixture.root, ["init", "--json"]);

  assert.equal(result.status, 1, `init did not fail:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /init refused: .*--json/);
  assert.match(result.stderr, /--yes/);
  assert.match(result.stderr, /--profile/);
  // The error goes to standard error, as for every other --json failure, so standard output holds
  // no prompt text that would corrupt a JSON reader.
  assert.equal(result.stdout, "");
  assert.equal(await exists(join(fixture.root, "calavera.config.json")), false);
});

test("init --apply --json without --yes refuses the apply confirmation before it writes the recipe", async () => {
  await using fixture = await createTemporaryFixture("init-apply-refuses-without-yes", {
    "package.json": json(plainViteManifest),
  });

  // Every recipe prompt is answered, so only the apply confirmation is left to ask.
  const result = runWithoutTerminal(fixture.root, [
    "init",
    "--profile",
    "minimal",
    "--package-manager",
    "npm",
    "--ai-artifact",
    "skill-frontend-engineering",
    "--apply",
    "--json",
    "--no-install",
  ]);

  assert.equal(result.status, 1, `init did not fail:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /cannot ask "Apply these Calavera-managed changes now\?"/);
  assert.match(result.stderr, /Pass --yes to apply after the dry run without asking/);
  assert.equal(result.stdout, "");
  assert.equal(await exists(join(fixture.root, "calavera.config.json")), false);
});

/**
 * Composes a recipe in-process with --json and without --yes, so Stryker sees which tests reach
 * each prompt's refusal; it cannot see into the child processes the tests above start.
 *
 * @param {string} directory
 * @param {Partial<import("../src/index.js").CliOptions>} given
 */
async function composeWithoutYes(directory, given) {
  const originalDirectory = process.cwd();
  process.chdir(directory);
  try {
    return await initRecipe({
      command: "init",
      config: "calavera.config.json",
      dryRun: true,
      json: true,
      noInstall: true,
      apply: false,
      assumeYes: false,
      integrations: [],
      aiArtifacts: [],
      ...given,
    });
  } finally {
    process.chdir(originalDirectory);
  }
}

test("init --json without --yes names the flag that answers each prompt it cannot show", async () => {
  await using fixture = await createTemporaryFixture("init-json-refusal-flags", {
    "package.json": json(plainViteManifest),
  });
  const aiArtifacts = [{ id: "skill-frontend-engineering" }];

  /** @type {[Partial<import("../src/index.js").CliOptions>, RegExp][]} */
  const cases = [
    [{}, /cannot ask "Choose a tooling profile".*--yes.*--profile/],
    [{ profile: "minimal" }, /cannot ask "Choose a package manager".*--yes.*--package-manager/],
    [
      { profile: "minimal", packageManager: "npm" },
      /cannot ask "Choose AI artifacts".*--yes.*--ai-artifact/,
    ],
    [
      { profile: "minimal", packageManager: "npm", aiArtifacts, apply: true },
      /cannot ask "Apply these Calavera-managed changes now\?".*--yes.*remove --apply/,
    ],
  ];
  for (const [given, message] of cases) {
    await assert.rejects(composeWithoutYes(fixture.root, given), message, JSON.stringify(given));
  }

  // The message names each reason Calavera cannot ask, and only those. CI is unset, so a CI
  // runner does not add "CI is set" (#1079); cannot-prompt-in-ci.test.mjs covers that reason.
  const originalIsTTY = process.stdin.isTTY;
  const originalCI = process.env.CI;
  delete process.env.CI;
  try {
    process.stdin.isTTY = false;
    await assert.rejects(
      composeWithoutYes(fixture.root, {}),
      /because --json was given, so the prompt would corrupt the JSON output, and stdin is not a terminal\./,
    );
    await assert.rejects(
      composeWithoutYes(fixture.root, { json: false }),
      /because stdin is not a terminal\./,
    );
    process.stdin.isTTY = true;
    await assert.rejects(
      composeWithoutYes(fixture.root, {}),
      /because --json was given, so the prompt would corrupt the JSON output\./,
    );
  } finally {
    process.stdin.isTTY = originalIsTTY;
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
  }

  // Every prompt answered by a flag: nothing to refuse.
  const { recipe } = await composeWithoutYes(fixture.root, {
    profile: "minimal",
    packageManager: "npm",
    aiArtifacts,
  });
  assert.equal(recipe.profile, "minimal");
  assert.equal(await exists(join(fixture.root, "calavera.config.json")), false);
});
