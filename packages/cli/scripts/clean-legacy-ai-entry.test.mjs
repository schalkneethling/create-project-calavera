// Issue #1119: clean resolves a legacy AI entry (`{ "type": "skill", "src": "skills/protected-branch-guard" }`)
// to its catalog ID before it compares the entry against the wiring records, as doctor does since
// #1101. apply records wiring under the catalog ID, so clean compared the legacy path against
// `skill-protected-branch-guard`, treated the guard as deselected, and planned to remove its
// .vite-hooks blocks and .claude/settings.json groups and to drop its aiWiring record.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const GUARD_ID = "skill-protected-branch-guard";
const WIRED_FILES = [
  ".vite-hooks/pre-commit",
  ".vite-hooks/prepare-commit-msg",
  ".vite-hooks/pre-push",
  ".claude/settings.json",
];

/** @param {object[]} ai */
function recipeWith(ai) {
  return { ...buildRecipe("minimal", [], "npm"), ai };
}

/**
 * Runs `callback` in a new Git repository on a feature branch, after apply installed and wired the
 * protected branch guard, selected by its catalog ID.
 *
 * @param {() => Promise<void>} callback
 */
async function inWiredProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-clean-legacy-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"]);
    execFileSync("git", ["switch", "--quiet", "-c", "1119-legacy"]);
    await writeFile("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    await callMcpTool(
      "apply_recipe",
      {
        recipe: recipeWith([{ id: GUARD_ID, inputs: { protectedBranch: "main" } }]),
        noInstall: true,
      },
      stubRegistry(new Map([[GUARD_ID, "0.1.0"]])),
    );
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {object} recipe */
async function writeRecipe(recipe) {
  await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
}

/** @param {string[]} args */
function runClean(args) {
  const result = spawnSync(process.execPath, [cli, "clean", "--json", ...args], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `clean exited ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

async function readWiredFiles() {
  return Promise.all(WIRED_FILES.map((path) => readFile(path, "utf8")));
}

async function readAiWiring() {
  return JSON.parse(await readFile(".calavera/state.json", "utf8")).aiWiring;
}

test("Given a legacy entry selects the wired guard, clean --dry-run plans no wiring removal", async () => {
  await inWiredProject(async () => {
    await writeRecipe(recipeWith([{ type: "skill", src: "skills/protected-branch-guard" }]));

    const result = runClean(["--dry-run"]);
    assert.deepEqual(result.wiringChanges, []);
    assert.deepEqual(result.changes, []);
  });
});

test("Given a legacy entry selects the wired guard, clean --yes keeps its wiring and its state record", async () => {
  await inWiredProject(async () => {
    await writeRecipe(recipeWith([{ type: "skill", src: "skills/protected-branch-guard" }]));
    const filesBefore = await readWiredFiles();
    const wiringBefore = await readAiWiring();
    assert.deepEqual(
      wiringBefore.map((/** @type {{ artifact: string }} */ { artifact }) => artifact),
      [GUARD_ID],
    );

    runClean(["--yes"]);
    assert.deepEqual(await readWiredFiles(), filesBefore);
    assert.deepEqual(await readAiWiring(), wiringBefore);
  });
});

test("Given the recipe no longer selects the wired guard, clean --yes removes its wiring and its state record", async () => {
  await inWiredProject(async () => {
    await writeRecipe(recipeWith([]));

    const planned = runClean(["--dry-run"]);
    assert.deepEqual(
      planned.wiringChanges.map(
        (/** @type {{ artifact: string, path: string, deselected: boolean }} */ change) => [
          change.artifact,
          change.path,
          change.deselected,
        ],
      ),
      WIRED_FILES.map((path) => [GUARD_ID, path, true]),
    );

    runClean(["--yes"]);
    const [preCommit] = await readWiredFiles();
    assert.doesNotMatch(preCommit, /protected-branch-guard/);
    assert.deepEqual(await readAiWiring(), []);
  });
});
