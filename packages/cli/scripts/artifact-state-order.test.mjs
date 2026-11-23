// Issue #1139: `artifacts install` and `artifacts update` wrote the artifacts they installed after
// every other record in `.calavera/state.json`, while apply writes the selected artifacts first and
// keeps the records of deselected artifacts after them (#829). A run that changed nothing still
// reordered `aiArtifacts`, so `git status` showed the state as modified.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { copyReleaseFixture } from "./vite-plus-fixtures.mjs";

const STATE_PATH = ".calavera/state.json";
const CONFIG_PATH = "calavera.config.json";
const recipe = buildRecipe("default", ["editorconfig"], "pnpm", []);
const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: CONFIG_PATH,
};

/**
 * Runs `callback` with `directory` as the working directory, as the CLI runs.
 *
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, callback) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await callback();
  } finally {
    process.chdir(previous);
  }
}

test("Given a state apply wrote with a deselected artifact's record, when artifacts install and update each run twice with nothing to change, then state.json stays byte-identical", async () => {
  await using project = await copyReleaseFixture("library");
  const registry = stubRegistry(
    new Map([
      ["skill-project-goal", "0.1.0"],
      ["hook-block-dangerous-commands", "0.4.0"],
    ]),
  );
  const both = {
    ...recipe,
    ai: [{ id: "skill-project-goal" }, { id: "hook-block-dangerous-commands" }],
  };
  const goalOnly = { ...recipe, ai: [{ id: "skill-project-goal" }] };

  // The second apply deselects the hook, so apply keeps its record after the selected skill.
  await inDirectory(project.root, async () => {
    await applyRecipeObject(both, applyOptions, registry);
    await applyRecipeObject(goalOnly, applyOptions, registry);
  });
  const statePath = join(project.root, STATE_PATH);
  const applied = await readFile(statePath);
  const appliedPaths = JSON.parse(applied.toString("utf8")).aiArtifacts.map(
    (/** @type {{ path: string }} */ { path }) => path,
  );
  // The deselected hook's record stays, after the selected skill, so an install that wrote the
  // records it installs last would move the skill behind it.
  assert.match(appliedPaths[0], /project-goal/, appliedPaths.join(", "));
  assert.ok(
    appliedPaths.some((path) => /block-dangerous-commands/.test(path)),
    appliedPaths.join(", "),
  );

  await writeFile(join(project.root, CONFIG_PATH), `${JSON.stringify(goalOnly, null, 2)}\n`);
  const runs = [
    { artifactAction: "install" },
    { artifactAction: "install" },
    { artifactAction: "update", artifactAll: true },
    { artifactAction: "update", artifactAll: true },
    { artifactAction: "update", artifactId: "skill-project-goal" },
  ];
  for (const run of runs) {
    await inDirectory(project.root, () =>
      runArtifactCommand({ config: CONFIG_PATH, dryRun: false, ...run }, registry),
    );
    const after = await readFile(statePath);
    assert.ok(
      after.equals(applied),
      `artifacts ${run.artifactAction} changed state.json:\n${after.toString("utf8")}`,
    );
  }
});
