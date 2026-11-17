// #940: `init --yes` without `--profile` and without a terminal used to show the profile prompt,
// which ended when standard input closed, so the run exited 0 and wrote no recipe. `--yes` means
// "use defaults and skip prompts", so it takes the default profile.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initRecipe } from "../src/index.js";
import { profileDefaults } from "../src/recipe.js";
import { createTemporaryFixture, json, plainViteManifest } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../bin/create-project-calavera.js", import.meta.url));

test("init --yes without --profile and without a terminal writes the default profile's recipe", async () => {
  await using fixture = await createTemporaryFixture("init-yes-default-profile", {
    "package.json": json(plainViteManifest),
  });

  // Standard input is /dev/null, not a terminal, as in CI or an agent's shell.
  const result = spawnSync(process.execPath, [cliPath, "init", "--yes"], {
    cwd: fixture.root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
  });

  assert.equal(result.signal, null, `init timed out or was killed:\n${result.stdout}`);
  assert.equal(result.status, 0, `init failed:\n${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /Choose a tooling profile/);

  const recipe = JSON.parse(await readFile(join(fixture.root, "calavera.config.json"), "utf8"));
  assert.equal(recipe.profile, "default");
  assert.deepEqual(recipe.integrations, profileDefaults.default);
});

/**
 * Composes a recipe in-process, without writing it, so Stryker sees which tests reach the profile
 * choice; it cannot see into the child process the test above starts.
 *
 * @param {string} directory
 * @param {{ assumeYes: boolean, profile?: string }} choice
 */
async function composeInDirectory(directory, { assumeYes, profile }) {
  const originalDirectory = process.cwd();
  process.chdir(directory);
  try {
    const { recipe } = await initRecipe({
      command: "init",
      config: "calavera.config.json",
      dryRun: true,
      json: true,
      noInstall: true,
      apply: false,
      assumeYes,
      ...(profile === undefined ? {} : { profile }),
      // Given, so that a run without --yes does not stop at these two prompts.
      packageManager: "npm",
      integrations: [],
      aiArtifacts: [{ id: "skill-frontend-engineering" }],
    });
    return recipe;
  } finally {
    process.chdir(originalDirectory);
  }
}

test("init chooses the profile from --profile first, then the default under --yes", async () => {
  await using fixture = await createTemporaryFixture("init-yes-profile-choice", {
    "package.json": json(plainViteManifest),
  });

  // --yes without --profile: the default profile and its integrations.
  const defaulted = await composeInDirectory(fixture.root, { assumeYes: true });
  assert.equal(defaulted.profile, "default");
  assert.deepEqual(defaulted.integrations, profileDefaults.default);

  // --profile wins over the default, with --yes and without it.
  for (const assumeYes of [true, false]) {
    const chosen = await composeInDirectory(fixture.root, { assumeYes, profile: "minimal" });
    assert.equal(chosen.profile, "minimal", `--yes ${assumeYes}`);
    assert.deepEqual(chosen.integrations, profileDefaults.minimal, `--yes ${assumeYes}`);
  }
});
