// Issue #1137: `artifacts install` and `artifacts update` validate the recipe before anything else,
// so an unknown `id` or legacy `src` stops them with the message apply gives, naming the entry by
// its position, instead of "Unknown artifact selection." that names no entry. The entry's value is
// text from the person's file, so no message repeats it. The commands refuse every recipe apply
// refuses, including a legacy entry that selects an artifact needing wiring or inputs (#1125), and
// they refuse it before anything is written or resolved.
import assert from "node:assert/strict";
import { mkdtempDisposable, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";

const UNKNOWN_VALUE = "not-in-catalog-value";

const cases = [
  {
    name: "an unknown id",
    entry: { id: UNKNOWN_VALUE },
    message:
      "AI item at index 1 (ai[1]) names an artifact ID that Calavera does not know. Remove the item from ai, or replace its id with an artifact ID that the list_ai_artifacts MCP tool lists.",
  },
  {
    name: "an unknown legacy src",
    entry: { type: "skill", src: ` skills/${UNKNOWN_VALUE} ` },
    message:
      "AI item at index 1 (ai[1]) names a legacy src that Calavera does not know. Remove the item from ai, or replace it with an id entry that the list_ai_artifacts MCP tool lists.",
  },
];

const commands = [
  { name: "artifacts install", options: { artifactAction: "install" } },
  { name: "artifacts update --all", options: { artifactAction: "update", artifactAll: true } },
  {
    name: "artifacts update <id>",
    options: { artifactAction: "update", artifactId: "skill-project-goal" },
  },
];

/** @param {{ id?: string, type?: string, src?: string }} entry */
function recipeWith(entry) {
  return { ...buildRecipe("minimal", [], "npm"), ai: [{ id: "skill-project-goal" }, entry] };
}

/**
 * Every file under `root` with its exact bytes, keyed by its path relative to `root`, so a test
 * notices a write that changes a file as well as one that adds a file.
 *
 * @param {string} root
 * @returns {Promise<Map<string, Buffer>>}
 */
async function projectSnapshot(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return new Map(
    await Promise.all(
      files.map(
        async (path) => /** @type {const} */ ([relative(root, path), await readFile(path)]),
      ),
    ),
  );
}

/**
 * Writes `recipe` and a `.gitignore` into the project, runs `command`, and asserts that it
 * rejects with `message`, that the registry received no request, and that every file in the
 * project is byte-identical afterward.
 *
 * @param {string} projectPath
 * @param {unknown} recipe
 * @param {{ options: object }} command
 * @param {boolean} dryRun
 * @param {string | RegExp} message
 */
async function assertRefusedWithoutWrites(projectPath, recipe, command, dryRun, message) {
  await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
  await writeFile(".gitignore", "node_modules/\n");
  const before = await projectSnapshot(projectPath);
  const registry = stubRegistry(
    new Map([
      ["skill-project-goal", "0.1.0"],
      ["skill-protected-branch-guard", "0.1.0"],
    ]),
  );
  await assert.rejects(
    runArtifactCommand({ config: "calavera.config.json", dryRun, ...command.options }, registry),
    typeof message === "string" ? { message } : message,
  );
  assert.deepEqual(registry.requests, []);
  assert.deepEqual(await projectSnapshot(projectPath), before);
}

/** @param {(projectPath: string) => Promise<void>} callback */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-artifacts-validation-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);
  try {
    await writeFile("package.json", `${JSON.stringify({ name: "fixture", scripts: {} })}\n`);
    await callback(project.path);
  } finally {
    process.chdir(originalDirectory);
  }
}

for (const { name, entry, message } of cases) {
  test(`apply refuses ${name} by its position, without its value`, async () => {
    await inProject(async () => {
      await assert.rejects(
        applyRecipeObject(
          recipeWith(entry),
          { json: true, noInstall: true, assumeYes: true, dryRun: true },
          stubRegistry(new Map([["skill-project-goal", "0.1.0"]])),
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, message);
          assert.ok(!error.message.includes(UNKNOWN_VALUE));
          return true;
        },
      );
    });
  });

  for (const command of commands) {
    for (const dryRun of [true, false]) {
      test(`${command.name}${dryRun ? " --dry-run" : ""} refuses ${name} with apply's message before anything resolves`, async () => {
        await inProject(async (projectPath) => {
          await assertRefusedWithoutWrites(
            projectPath,
            recipeWith(entry),
            command,
            dryRun,
            message,
          );
        });
      });
    }
  }
}

// #1125: apply refuses a legacy entry that selects an artifact needing wiring or inputs, so install
// and update refuse it too, with apply's message, instead of installing the artifact unwired.
const LEGACY_GUARD = { type: "skill", src: "skills/protected-branch-guard" };

/** @returns {Promise<string>} */
async function applyLegacyGuardMessage() {
  let message = "";
  await inProject(async () => {
    await applyRecipeObject(
      recipeWith(LEGACY_GUARD),
      { json: true, noInstall: true, assumeYes: true, dryRun: true },
      stubRegistry(new Map([["skill-protected-branch-guard", "0.1.0"]])),
    ).catch((/** @type {Error} */ error) => {
      message = error.message;
    });
  });
  return message;
}

test("apply refuses a legacy entry that selects an artifact needing wiring", async () => {
  const message = await applyLegacyGuardMessage();
  assert.match(
    message,
    /^Calavera stopped before writing anything, because these legacy AI entries select artifacts that need wiring or inputs:\n- ai\[1\] .* selects skill-protected-branch-guard by its legacy type and src/,
  );
});

/** @type {{ name: string, recipe: () => unknown, message: () => Promise<string> }[]} */
const refusedRecipes = [
  {
    name: "a legacy entry that selects an artifact needing wiring",
    recipe: () => recipeWith(LEGACY_GUARD),
    message: applyLegacyGuardMessage,
  },
  {
    name: "a recipe without version 1",
    recipe: () => {
      const { version: _version, ...recipe } = recipeWith({ id: "skill-project-goal" });
      return { ...recipe, ai: [{ id: "skill-project-goal" }] };
    },
    message: async () => "Recipe version must be 1.",
  },
  {
    name: "a recipe with an unknown integration",
    recipe: () => ({
      ...buildRecipe("minimal", [], "npm"),
      integrations: ["not-an-integration"],
      ai: [{ id: "skill-project-goal" }],
    }),
    message: async () => "Unknown integrations: not-an-integration.",
  },
];

for (const { name, recipe, message } of refusedRecipes) {
  for (const command of commands) {
    for (const dryRun of [true, false]) {
      test(`${command.name}${dryRun ? " --dry-run" : ""} refuses ${name} with apply's message and leaves the project byte-identical`, async () => {
        const expected = await message();
        assert.notEqual(expected, "");
        await inProject(async (projectPath) => {
          await assertRefusedWithoutWrites(projectPath, recipe(), command, dryRun, expected);
        });
      });
    }
  }
}
