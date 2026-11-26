// The child process of interrupted-dry-run.test.mjs (#1081). It runs, in the project folder its
// first argument names, an apply dry run of a recipe with one locked artifact whose package is
// missing from .calavera/packages/ and one unlocked artifact. The registry stub blocks when the
// dry run resolves the unlocked artifact, after the locked package is rebuilt and the staging
// folder exists, and prints "ready", so the test can interrupt the dry run while both of its
// temporary folders exist.
import { rm, writeFile } from "node:fs/promises";

import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";

const [project] = process.argv.slice(2);
process.chdir(project);

const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};

/** @param {string[]} ids */
const recipeWith = (ids) => ({
  ...buildRecipe("minimal", [], "npm"),
  ai: ids.map((id) => ({ id })),
});

await writeFile("package.json", `${JSON.stringify({ name: "fixture", scripts: {} }, null, 2)}\n`);
const releases = new Map([
  ["skill-project-goal", "0.1.0"],
  ["skill-code-review", "0.3.0"],
]);
const registry = stubRegistry(releases);
await applyRecipeObject(recipeWith(["skill-project-goal"]), applyOptions, registry);
await rm(".calavera/packages", { recursive: true });

await applyRecipeObject(
  recipeWith(["skill-project-goal", "skill-code-review"]),
  { ...applyOptions, dryRun: true },
  {
    ...registry,
    resolve: async (/** @type {Parameters<typeof registry.resolve>[0]} */ request) => {
      if (request.id !== "skill-code-review") return registry.resolve(request);
      process.stdout.write("ready\n");
      // Waits here, as a slow registry would, until the test interrupts the dry run. The timer keeps
      // the event loop alive, because a promise alone would let the process exit on its own.
      return new Promise(() => setInterval(() => {}, 60_000));
    },
  },
);
