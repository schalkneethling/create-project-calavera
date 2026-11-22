// Issue #1078: `artifacts migrate` writes the whole recipe back from the parsed JSON, so a
// duplicate key keeps only its last value and a number comes back in the formatter's spelling
// (1.50 becomes 1.5). The migration checks the recipe's text first, and a rewrite that would lose
// something stops before anything is written, in a dry run too, naming the file and the line.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { buildRecipe } from "../src/recipe.js";
import { snapshotDirectory } from "./project-snapshot.mjs";
import { copyReleaseFixture } from "./vite-plus-fixtures.mjs";

const recipe = buildRecipe("default", ["editorconfig", "knip"], "pnpm", []);
const legacy = { type: "skill", src: "skills/project-goal" };

/**
 * Writes `text` as the recipe of a Vite+ fixture project, runs the migration in it as a dry run
 * and as a real run, and returns what each run threw, with the project snapshot before and after.
 *
 * @param {string} text
 */
async function migrateRecipeText(text) {
  await using project = await copyReleaseFixture("library");
  await writeFile(join(project.root, "calavera.config.json"), text);
  const previous = process.cwd();
  process.chdir(project.root);
  try {
    const before = await snapshotDirectory();
    /** @type {unknown[]} */
    const errors = [];
    for (const dryRun of [true, false]) {
      try {
        await runArtifactCommand({
          config: "calavera.config.json",
          dryRun,
          artifactAction: "migrate",
        });
        errors.push(undefined);
      } catch (error) {
        errors.push(error);
      }
    }
    return {
      errors,
      before,
      after: await snapshotDirectory(),
      recipeText: await readFile("calavera.config.json", "utf8"),
    };
  } finally {
    process.chdir(previous);
  }
}

test("Given a recipe that holds a key twice in one object, when artifacts migrate runs, then the dry run and the migration stop before writing and name the file and the line", async () => {
  const text = `{
  "preset": "default",
  "integrations": ["editorconfig", "knip"],
  "packageManager": "pnpm",
  "packageManager": "npm",
  "ai": [${JSON.stringify(legacy)}]
}
`;
  const { errors, before, after } = await migrateRecipeText(text);
  for (const error of errors) {
    assert.ok(error instanceof Error, "artifacts migrate did not stop");
    assert.match(
      error.message,
      /^calavera\.config\.json holds the key "packageManager" more than once in one object, again on line 5, and only the last value would be kept\. artifacts migrate rewrites the whole recipe/,
    );
  }
  assert.deepEqual(after, before, "artifacts migrate wrote files before it stopped");
});

test("Given a recipe that holds a number Calavera would spell differently, when artifacts migrate runs, then the dry run and the migration stop before writing and name the file and the line", async () => {
  const text = `{
  "preset": "default",
  "integrations": ["editorconfig", "knip"],
  "packageManager": "pnpm",
  "ai": [
    ${JSON.stringify(legacy)},
    { "id": "skill-protected-branch-guard", "inputs": { "weight": 1.50 } }
  ]
}
`;
  const { errors, before, after } = await migrateRecipeText(text);
  for (const error of errors) {
    assert.ok(error instanceof Error, "artifacts migrate did not stop");
    assert.match(
      error.message,
      /^calavera\.config\.json holds a number on line 7 that Calavera would write in another spelling\. artifacts migrate rewrites the whole recipe/,
    );
    assert.doesNotMatch(error.message, /1\.50?/);
  }
  assert.deepEqual(after, before, "artifacts migrate wrote files before it stopped");
});

test("Given a recipe whose rewrite loses nothing, when artifacts migrate runs, then it migrates as before", async () => {
  const text = `${JSON.stringify({ ...recipe, ai: [legacy, { id: "skill-protected-branch-guard", inputs: { weight: 1.5 } }] }, null, 2)}\n`;
  const { errors, recipeText } = await migrateRecipeText(text);
  assert.deepEqual(errors, [undefined, undefined]);
  assert.deepEqual(JSON.parse(recipeText).ai, [
    { id: "skill-project-goal" },
    { id: "skill-protected-branch-guard", inputs: { weight: 1.5 } },
  ]);
});

test("Given a recipe named without .json that holds numbers, when artifacts migrate runs, then the check judges the spelling the migration writes, which is not formatted", async () => {
  // The migration formats only a recipe whose name ends in .json (formatGeneratedText), so the
  // check must not ask vp fmt about any other name. JSON.stringify writes 1e+21, so that spelling
  // loses nothing here, and 1e21 would be written in another spelling.
  await using project = await copyReleaseFixture("library");
  const previous = process.cwd();
  process.chdir(project.root);
  try {
    for (const [number, stops] of [
      ["1e+21", false],
      ["1e21", true],
    ]) {
      await writeFile(
        "recipe",
        `{\n  "preset": "default",\n  "n": ${number},\n  "ai": [${JSON.stringify(legacy)}]\n}\n`,
      );
      const run = runArtifactCommand({ config: "recipe", dryRun: true, artifactAction: "migrate" });
      if (stops) {
        await assert.rejects(
          run,
          /^Error: recipe holds a number on line 3 that Calavera would write in another spelling\./,
        );
      } else {
        assert.equal((await run).migrated, 1);
      }
    }
  } finally {
    process.chdir(previous);
  }
});
