// Issue #1024: recipe validation trims a legacy `src`, so apply, the `artifacts` commands, and
// `artifacts migrate` trim it too. A legacy entry such as `" skills/project-goal "` selects the
// same artifact as `"skills/project-goal"` everywhere, instead of passing validation and then
// stopping apply with "Unknown artifact selection." that names no entry.
import assert from "node:assert/strict";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizePackageSelections, runArtifactCommand } from "../src/artifact-lifecycle.js";
import { applyRecipeObject } from "../src/index.js";
import { buildRecipe, validateRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";

const PADDED = { type: "skill", src: " skills/project-goal " };

const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};

function paddedRecipe() {
  return { ...buildRecipe("minimal", [], "npm"), ai: [structuredClone(PADDED)] };
}

/** @param {() => Promise<void>} callback */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-padded-legacy-src-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);
  try {
    await writeFile("package.json", `${JSON.stringify({ name: "fixture", scripts: {} })}\n`);
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

test("validation and the package selections agree on a padded legacy src", () => {
  assert.doesNotThrow(() => validateRecipe(paddedRecipe()));
  assert.deepEqual(normalizePackageSelections([PADDED]), [{ id: "skill-project-goal" }]);
});

test("apply --dry-run selects the artifact a padded legacy src names", async () => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
    const result = await applyRecipeObject(
      paddedRecipe(),
      { ...applyOptions, dryRun: true },
      registry,
    );
    assert.deepEqual(
      result.autoInstalledArtifacts.map(({ id }) => id),
      ["skill-project-goal"],
    );
  });
});

test("artifacts install --dry-run selects the artifact a padded legacy src names", async () => {
  await inProject(async () => {
    await writeFile("calavera.config.json", `${JSON.stringify(paddedRecipe(), null, 2)}\n`);
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
    const result = await runArtifactCommand(
      { config: "calavera.config.json", dryRun: true, artifactAction: "install" },
      registry,
    );
    assert.deepEqual(
      result.artifacts.map(({ id }) => id),
      ["skill-project-goal"],
    );
  });
});

test("artifacts migrate rewrites a padded legacy src to its artifact ID", async () => {
  await inProject(async () => {
    await writeFile("calavera.config.json", `${JSON.stringify(paddedRecipe(), null, 2)}\n`);
    const result = await runArtifactCommand({
      config: "calavera.config.json",
      dryRun: false,
      artifactAction: "migrate",
    });
    const migrated = JSON.parse(await readFile("calavera.config.json", "utf8"));
    assert.equal(result.migrated, 1);
    assert.deepEqual(migrated.ai, [{ id: "skill-project-goal" }]);
  });
});

test("artifacts migrate names an unknown padded legacy src without its white space", async () => {
  await inProject(async () => {
    const recipe = {
      ...buildRecipe("minimal", [], "npm"),
      ai: [{ type: "skill", src: " skills/not-in-catalog " }],
    };
    await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
    await assert.rejects(
      runArtifactCommand({
        config: "calavera.config.json",
        dryRun: false,
        artifactAction: "migrate",
      }),
      { message: "Unknown legacy artifact path: skills/not-in-catalog." },
    );
  });
});
