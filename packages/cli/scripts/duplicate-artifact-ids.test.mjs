// Issue #607: a recipe that selects the same artifact ID twice fails validation with an error that
// names the ID, before any resolution or write, on the CLI and MCP paths alike.
import assert from "node:assert/strict";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, composeRecipe, validateRecipe } from "../src/recipe.js";
import { snapshotDirectory as snapshot } from "./project-snapshot.mjs";

const HOOK = "hook-block-dangerous-commands";
const DUPLICATE_ID =
  /Duplicate artifact id "hook-block-dangerous-commands" at AI item indexes 0 and 1\./;

const LEGACY = { type: "hook", src: "hooks/block-dangerous-commands" };

const duplicateRecipes = {
  "same ID and same target": [
    { id: HOOK, target: "codex" },
    { id: HOOK, target: "codex" },
  ],
  "same ID and different targets": [
    { id: HOOK, target: "codex" },
    { id: HOOK, target: "cursor" },
  ],
  "same ID with and without a target": [{ id: HOOK }, { id: HOOK, target: "codex" }],
  "legacy type and src twice": [LEGACY, { ...LEGACY, target: "codex" }],
  "an ID and its legacy src": [{ id: HOOK }, LEGACY],
};

/** Fails the test if the code under test resolves or extracts a package. */
const forbiddenRegistry = {
  resolve: async () => assert.fail("a duplicate recipe must not reach artifact resolution"),
  extract: async () => assert.fail("a duplicate recipe must not reach artifact extraction"),
};

const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};

/** @param {() => Promise<void>} callback */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-duplicate-ids-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);
  try {
    await writeFile("package.json", `${JSON.stringify({ name: "fixture", scripts: {} })}\n`);
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

for (const [name, ai] of Object.entries(duplicateRecipes)) {
  const recipe = () => ({ ...buildRecipe("minimal", [], "npm"), ai: structuredClone(ai) });

  test(`validateRecipe rejects ${name}`, () => {
    assert.throws(() => validateRecipe(recipe()), DUPLICATE_ID);
  });

  test(`CLI apply rejects ${name} before resolution or writes`, async () => {
    await inProject(async () => {
      const before = await snapshot();
      for (const dryRun of [true, false]) {
        await assert.rejects(
          applyRecipeObject(recipe(), { ...applyOptions, dryRun }, forbiddenRegistry),
          DUPLICATE_ID,
        );
      }
      assert.deepEqual(await snapshot(), before);
    });
  });

  test(`artifacts install and update reject ${name} before resolution or writes`, async () => {
    await inProject(async () => {
      await writeFile("calavera.config.json", `${JSON.stringify(recipe(), null, 2)}\n`);
      const before = await snapshot();
      for (const artifactAction of ["install", "update"]) {
        for (const dryRun of [true, false]) {
          await assert.rejects(
            runArtifactCommand(
              { config: "calavera.config.json", dryRun, artifactAction, artifactAll: true },
              forbiddenRegistry,
            ),
            DUPLICATE_ID,
          );
        }
      }
      assert.deepEqual(await snapshot(), before);
    });
  });

  test(`MCP dry_run_apply and apply_recipe reject ${name} before resolution or writes`, async () => {
    await inProject(async () => {
      const before = await snapshot();
      await assert.rejects(
        callMcpTool("dry_run_apply", { recipe: recipe() }, forbiddenRegistry),
        DUPLICATE_ID,
      );
      await assert.rejects(
        callMcpTool("apply_recipe", { recipe: recipe(), noInstall: true }, forbiddenRegistry),
        DUPLICATE_ID,
      );
      assert.deepEqual(await snapshot(), before);
    });
  });
}

test("validate_recipe reports the duplicate ID", async () => {
  const recipe = {
    ...buildRecipe("minimal", [], "npm"),
    ai: duplicateRecipes["same ID and same target"],
  };
  const response = await callMcpTool("validate_recipe", { recipe });
  assert.equal(response.ok, false);
  assert.match(response.errors[0], DUPLICATE_ID);
});

test("compose_recipe rejects a duplicate ID with the aiArtifacts index", () => {
  assert.throws(
    () =>
      composeRecipe({
        profile: "minimal",
        aiArtifacts: [{ id: HOOK }, { id: HOOK, target: "codex" }],
      }),
    /Invalid aiArtifacts\[1\]\.id: duplicate artifact id "hook-block-dangerous-commands"/,
  );
});
