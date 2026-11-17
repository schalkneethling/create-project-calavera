// Owner decision of 2026-11-17 on PR #1017 (#960): apply decides that it applied to a project
// before from a record that only apply writes, not from the existence of .calavera/state.json.
// `artifacts install`, `artifacts update`, `artifacts status --check-updates`, and the bootstrap
// also write that file, and only after an earlier apply is a script under its old name
// Calavera's to rename (ADR-0013, Decision 6). The record is the state's `profile`, which no other
// command writes. The tests below cover install and status; update and the bootstrap build their
// state the same way, by carrying the earlier state through.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { applyRecipeObject, inspectProject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { createTemporaryFixture } from "./vite-plus-fixtures.mjs";

const dryRunOptions = { dryRun: true, json: true, noInstall: true, assumeYes: true };
const applyOptions = { json: true, noInstall: true, assumeYes: true };

// The values Calavera writes for Stylelint, which ADR-0013 moved from `lint` to `lint:styles`.
// A person can hold the same values under the old names without Calavera having written them.
const stylelintLint = 'stylelint "**/*.{css,scss}" --allow-empty-input';
const stylelintFix = 'stylelint "**/*.{css,scss}" --allow-empty-input --fix';
const ownScripts = { lint: stylelintLint, "lint:fix": stylelintFix };

const recipe = {
  ...buildRecipe("default", ["stylelint", "knip"], "npm"),
  ai: [{ id: "skill-project-goal" }],
};
const registry = () => stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));

/**
 * Runs `callback` in a new project whose package.json holds `scripts` and whose recipe is
 * `recipe`.
 *
 * @param {Record<string, string>} scripts
 * @param {() => Promise<void>} callback
 */
async function inProject(scripts, callback) {
  await using fixture = await createTemporaryFixture("applied-before", {
    "package.json": `${JSON.stringify({ name: "project", scripts }, null, 2)}\n`,
    "calavera.config.json": `${JSON.stringify(recipe, null, 2)}\n`,
  });
  const originalDirectory = process.cwd();
  process.chdir(fixture.root);
  try {
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {{ path: string }[]} changes */
const packageChange = (changes) => changes.find(({ path }) => path === "package.json");

const readJSON = async (/** @type {string} */ path) => JSON.parse(await readFile(path, "utf8"));

const commandsThatWriteState = [
  {
    name: "artifacts install",
    run: () =>
      runArtifactCommand(
        { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
        registry(),
      ),
  },
  {
    name: "artifacts status --check-updates",
    run: () =>
      runArtifactCommand(
        {
          config: "calavera.config.json",
          dryRun: false,
          artifactAction: "status",
          checkUpdates: true,
        },
        registry(),
      ),
  },
];

for (const { name, run } of commandsThatWriteState) {
  test(`a project whose only state came from ${name} keeps its own lint scripts on the first apply`, async () => {
    await inProject(ownScripts, async () => {
      await run();
      // The command wrote the state file, which used to count as an earlier apply.
      const state = await readJSON(".calavera/state.json");
      assert.equal(state.profile, undefined);

      const dryRun = await applyRecipeObject(recipe, dryRunOptions, registry());
      assert.equal(packageChange(dryRun.changes)?.renamedScripts, undefined);

      await applyRecipeObject(recipe, applyOptions, registry());
      const { scripts } = await readJSON("package.json");
      assert.equal(scripts.lint, stylelintLint);
      assert.equal(scripts["lint:fix"], stylelintFix);
      assert.equal(scripts["lint:styles"], stylelintLint);
    });
  });
}

/**
 * Applies `recipe`, then puts the Stylelint scripts back under the names releases before
 * ADR-0013 wrote, as a project applied by such a release holds them.
 *
 * @param {(state: Record<string, unknown>) => Record<string, unknown>} [rewriteState]
 */
async function applyAsBeforeTheRename(rewriteState = (state) => state) {
  await applyRecipeObject(recipe, applyOptions, registry());
  const packageJSON = await readJSON("package.json");
  const { "lint:styles": lint, "lint:styles:fix": lintFix, ...rest } = packageJSON.scripts;
  packageJSON.scripts = { lint, "lint:fix": lintFix, ...rest };
  await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);
  const state = await readJSON(".calavera/state.json");
  await writeFile(".calavera/state.json", `${JSON.stringify(rewriteState(state), null, 2)}\n`);
}

/** @param {{ path: string, renamedScripts?: unknown }[]} changes */
function assertRenamed(changes) {
  assert.deepEqual(packageChange(changes)?.renamedScripts, [
    { from: "lint", to: "lint:styles" },
    { from: "lint:fix", to: "lint:styles:fix" },
  ]);
}

test("a project this release applied still has the scripts Calavera wrote renamed", async () => {
  await inProject({}, async () => {
    await applyAsBeforeTheRename();

    assertRenamed((await applyRecipeObject(recipe, dryRunOptions, registry())).changes);
  });
});

test("a project applied by an earlier release, whose state file lacks newer records, still has its scripts renamed", async () => {
  await inProject({}, async () => {
    // A state file from before #230, ADR-0015, and ADR-0016: no qualityScript, aiWiring, or
    // gitignoreBlocks, but the profile and integrations every apply has recorded.
    await applyAsBeforeTheRename(({ version, profile, integrations, files, managedFiles }) => ({
      version,
      profile,
      integrations,
      files,
      managedFiles,
    }));

    assertRenamed((await applyRecipeObject(recipe, dryRunOptions, registry())).changes);
  });
});

test("an apply that installs only artifacts over state another command wrote records the profile", async () => {
  const artifactsOnly = { ...buildRecipe("minimal", [], "npm"), ai: recipe.ai };
  await inProject({}, async () => {
    await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      registry(),
    );

    await applyRecipeObject(artifactsOnly, applyOptions, registry());

    const state = await readJSON(".calavera/state.json");
    assert.equal(state.profile, "minimal");
  });
});

test("inspection of a project whose only state came from artifacts install reports no legacy lint script", async () => {
  // A lint script of the person's own, under the name Calavera used before ADR-0013.
  await inProject({ lint: "eslint ." }, async () => {
    await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      registry(),
    );

    const inspection = await inspectProject(recipe);

    assert.deepEqual(
      inspection.findings.filter(({ kind }) => kind.startsWith("legacy-package-script")),
      [],
    );
  });
});

test("inspection of a project this release applied still reports a lint script of the person's own", async () => {
  await inProject({ lint: "eslint ." }, async () => {
    await applyRecipeObject(recipe, applyOptions, registry());

    const inspection = await inspectProject(recipe);

    assert.deepEqual(
      inspection.findings.filter(({ kind }) => kind === "legacy-package-script").length,
      1,
    );
  });
});
