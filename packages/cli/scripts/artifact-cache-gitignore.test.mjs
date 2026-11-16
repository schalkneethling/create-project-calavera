// Issue #841: apply resolves artifact packages through an npm cache in `.calavera/cache/`. The
// owner decided on 2026-11-14 that the cache is not committed. Apply keeps it out of Git with a
// marked `.gitignore` block, the ADR-0016 approach, and the apply summary says so.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtempDisposable, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { integrationCatalog } from "../src/catalog.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { fixture } from "./ignore-fixture-integration.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const applyOptions = { json: true, noInstall: true, assumeYes: true };
const cacheBlock =
  "# calavera:artifact-cache:start\n.calavera/cache/\n# calavera:artifact-cache:end\n";
const cacheChange = (/** @type {string} */ type) => ({
  path: ".gitignore",
  integration: "artifact-cache",
  type,
  lines: [".calavera/cache/"],
});

/** @param {string[]} ids */
function recipeWith(ids) {
  return { ...buildRecipe("minimal", [], "npm"), ai: ids.map((id) => ({ id })) };
}

const registry = () => stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));

/** @param {{ pointers?: string[] }} result */
const cachePointers = (result) =>
  (result.pointers ?? []).filter((pointer) => pointer.includes(".calavera/cache/"));

/**
 * Runs `callback` in a new temporary project that holds a package.json and, when given, the
 * person's own .gitignore.
 *
 * @param {string | undefined} gitignore
 * @param {(directory: string) => Promise<void>} callback
 */
async function inProject(gitignore, callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-cache-gitignore-"));
  const directory = await realpath(project.path);
  const originalDirectory = process.cwd();
  process.chdir(directory);

  try {
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    if (gitignore !== undefined) await writeFile(".gitignore", gitignore);
    await callback(directory);
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string[]} args */
function git(args) {
  const run = spawnSync("git", args, { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  return run.stdout;
}

test("the dry run plans the cache block and says why, and writes nothing", async () => {
  await inProject("node_modules/\n", async () => {
    const recipe = recipeWith(["skill-project-goal"]);
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry());

    assert.deepEqual(dryRun.ignoreChanges, [cacheChange("update")]);
    const [pointer, ...others] = cachePointers(dryRun);
    assert.deepEqual(others, []);
    assert.match(pointer ?? "", /does not belong in Git/);
    assert.match(
      pointer ?? "",
      /Commit \.calavera\/artifacts\.lock\.json and \.calavera\/packages\//,
    );
    assert.equal(await readFile(".gitignore", "utf8"), "node_modules/\n");

    const mcpDryRun = await callMcpTool("dry_run_apply", { recipe }, registry());
    assert.deepEqual(mcpDryRun.result.ignoreChanges, dryRun.ignoreChanges);
  });
});

test("after apply, git status does not list the cache but lists the files to commit", async () => {
  await inProject(undefined, async () => {
    git(["init", "--quiet"]);
    const recipe = recipeWith(["skill-project-goal"]);
    const applied = await applyRecipeObject(recipe, applyOptions, registry());

    assert.equal(await readFile(".gitignore", "utf8"), cacheBlock);
    assert.equal(cachePointers(applied).length, 1);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.gitignoreBlocks, [
      { integration: "artifact-cache", lines: [".calavera/cache/"] },
    ]);

    // The folders npm writes into its cache, as the #749 run found them.
    for (const folder of ["content-v2", "index-v5", "tmp"]) {
      await mkdir(`.calavera/cache/npm/${folder}`, { recursive: true });
      await writeFile(`.calavera/cache/npm/${folder}/entry`, "cached\n");
    }
    await writeFile(
      ".calavera/cache/npm/CACHEDIR.TAG",
      "Signature: 8a477f597d28d172789f06886806bc55\n",
    );

    const untracked = git(["status", "--porcelain", "--untracked-files=all"]).split("\n");
    assert.deepEqual(
      untracked.filter((line) => line.includes(".calavera/cache")),
      [],
    );
    assert.ok(untracked.includes("?? .calavera/artifacts.lock.json"), untracked.join("\n"));
    assert.ok(
      untracked.some((line) => line.startsWith("?? .calavera/packages/")),
      untracked.join("\n"),
    );

    // A second dry run reports the block as unchanged and does not repeat the explanation.
    const again = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry());
    assert.deepEqual(again.ignoreChanges, [cacheChange("unchanged")]);
    assert.deepEqual(cachePointers(again), []);
  });
});

test("a recipe without artifacts plans no cache block while no cache folder exists", async () => {
  await inProject(undefined, async () => {
    const dryRun = await applyRecipeObject(recipeWith([]), { ...applyOptions, dryRun: true });

    assert.deepEqual(dryRun.ignoreChanges, []);
    assert.deepEqual(cachePointers(dryRun), []);
  });
});

test("a cache folder an earlier apply left behind keeps its block when the recipe drops artifacts", async () => {
  await inProject(undefined, async () => {
    await mkdir(".calavera/cache/npm", { recursive: true });

    const dryRun = await applyRecipeObject(recipeWith([]), { ...applyOptions, dryRun: true });

    assert.deepEqual(dryRun.ignoreChanges, [cacheChange("write")]);
  });
});

test("the block leaves with the cache, and the dry run says why", async () => {
  await inProject(`node_modules/\n${cacheBlock}`, async (directory) => {
    await mkdir(".calavera");
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify({
        version: 1,
        integrations: [],
        managedFiles: [],
        gitignoreBlocks: [{ integration: "artifact-cache", lines: [".calavera/cache/"] }],
      })}\n`,
    );
    await writeFile("calavera.config.json", `${JSON.stringify(recipeWith([]), null, 2)}\n`);

    const run = spawnSync(process.execPath, [cli, "apply", "--dry-run", "--yes", "--no-install"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(
      `${run.stdout}${run.stderr}`,
      /Would remove the artifact-cache block from \.gitignore, because the recipe selects no artifacts and \.calavera\/cache\/ does not exist: "\.calavera\/cache\/"/,
    );

    await applyRecipeObject(recipeWith([]), applyOptions);
    assert.equal(await readFile(".gitignore", "utf8"), "node_modules/\n");
  });
});

test("with Varlock, apply keeps the cache block and appends the Varlock lines after it", async () => {
  await inProject(undefined, async () => {
    const recipe = {
      ...buildRecipe("minimal", ["varlock"], "npm"),
      ai: [{ id: "skill-project-goal" }],
    };
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry());
    assert.deepEqual(dryRun.ignoreChanges, [cacheChange("write")]);
    assert.equal(dryRun.changes.filter(({ path }) => path === ".gitignore").length, 1);

    await applyRecipeObject(recipe, applyOptions, registry());
    const gitignore = await readFile(".gitignore", "utf8");
    assert.ok(gitignore.startsWith(cacheBlock), gitignore);
    assert.match(gitignore.slice(cacheBlock.length), /\.env\.local/);

    const again = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry());
    assert.deepEqual(again.ignoreChanges, [cacheChange("unchanged")]);
  });
});

test("an integration's own block, without an artifact, adds no pointer", async () => {
  await inProject(undefined, async () => {
    const recipe = buildRecipe("minimal", [fixture.id], "npm");
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });

    assert.deepEqual(
      dryRun.ignoreChanges.map(({ integration, type }) => ({ integration, type })),
      [{ integration: fixture.id, type: "write" }],
    );
    assert.deepEqual(dryRun.pointers, []);
  });
});

test("no catalog integration takes the id of Calavera's own cache block", () => {
  assert.equal(
    integrationCatalog.some(({ id }) => id === "artifact-cache"),
    false,
  );
});
