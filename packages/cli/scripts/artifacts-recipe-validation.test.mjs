// Issue #1137: `artifacts install` and `artifacts update` validate the recipe before anything else,
// so an unknown `id` or legacy `src` stops them with the message apply gives, naming the entry by
// its position, instead of "Unknown artifact selection." that names no entry. The entry's value is
// text from the person's file, so no message repeats it.
import assert from "node:assert/strict";
import { mkdtempDisposable, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
          await writeFile(
            "calavera.config.json",
            `${JSON.stringify(recipeWith(entry), null, 2)}\n`,
          );
          const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
          await assert.rejects(
            runArtifactCommand(
              { config: "calavera.config.json", dryRun, ...command.options },
              registry,
            ),
            { message },
          );
          assert.deepEqual(registry.requests, []);
          assert.deepEqual((await readdir(projectPath)).sort(), [
            "calavera.config.json",
            "package.json",
          ]);
        });
      });
    }
  }
}
